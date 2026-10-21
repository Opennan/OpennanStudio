import { describe, expect, it } from "vitest";
import { CACHE_GRACE_MS, MediaCacheIndex, parseCacheIndex, planEviction, type CacheEntry, type CacheIndexFile, type CacheIndexStorage } from "./cache-index";

const entry = (id: string, sizeBytes: number, lastUsed: number, extra: Partial<CacheEntry> = {}): CacheEntry => ({
    id, url: `https://cdn.opennan.com/${id}.mp4`, sizeBytes, lastUsed, state: "ready", ...extra,
});

function memoryStorage(initial: unknown = null) {
    let raw: unknown = initial === null ? null : JSON.parse(JSON.stringify(initial));
    const writes: CacheIndexFile[] = [];
    let locks = 0;
    let failNext = false;
    const storage: CacheIndexStorage = {
        async read() {
            return raw === null ? null : JSON.parse(JSON.stringify(raw));
        },
        async write(file) {
            if (failNext) {
                failNext = false;
                throw new Error("disk full");
            }
            writes.push(file);
            raw = JSON.parse(JSON.stringify(file));
        },
        async lock(run) {
            locks += 1;
            return run();
        },
    };
    return { storage, writes, locks: () => locks, failNextWrite: () => (failNext = true), raw: () => raw, setRaw: (value: unknown) => (raw = value) };
}

describe("parseCacheIndex", () => {
    it("reads version 2 entries and drops malformed ones one by one", () => {
        const good = entry("a", 10, 5);
        const entries = parseCacheIndex({
            version: 2,
            entries: [good, { ...good, id: "" }, { ...good, id: "b", sizeBytes: -1 }, { ...good, id: "c", state: "weird" }, { id: "d" }, null, 7, { ...good, id: "e", state: "partial", mimeType: "video/mp4" }],
        });
        expect(entries.map((e) => e.id)).toEqual(["a", "e"]);
        expect(entries[1]).toMatchObject({ state: "partial", mimeType: "video/mp4" });
    });

    it("migrates the 9a desktop map {version 1, entries: {url: id}} as old, size-unknown entries", () => {
        const entries = parseCacheIndex({ version: 1, entries: { "https://cdn.opennan.com/x.mp4": "id-1", bad: 3 } });
        expect(entries).toEqual([{ id: "id-1", url: "https://cdn.opennan.com/x.mp4", sizeBytes: 0, lastUsed: 0, state: "ready" }]);
    });

    it("treats anything unreadable as an empty index", () => {
        for (const raw of [null, undefined, "x", 3, [], { version: 9, entries: [] }, { version: 2, entries: "no" }]) expect(parseCacheIndex(raw)).toEqual([]);
    });

    it("keeps one entry per id (the newest use wins)", () => {
        const entries = parseCacheIndex({ version: 2, entries: [entry("a", 10, 5), entry("a", 10, 9)] });
        expect(entries).toEqual([entry("a", 10, 9)]);
    });
});

describe("planEviction", () => {
    const now = 1_000_000;
    const none = () => false;

    it("evicts the least recently used entries first until the cache fits the limit", () => {
        const entries = [entry("new", 40, now - CACHE_GRACE_MS - 1), entry("old", 40, 10), entry("mid", 40, 500)];
        expect(planEviction(entries, { limitBytes: 100, isPinned: none, now }).map((e) => e.id)).toEqual(["old"]);
        expect(planEviction(entries, { limitBytes: 50, isPinned: none, now }).map((e) => e.id)).toEqual(["old", "mid"]);
        expect(planEviction(entries, { limitBytes: 120, isPinned: none, now })).toEqual([]);
    });

    it("makes room for a download about to start", () => {
        const entries = [entry("a", 40, 10), entry("b", 40, 20)];
        expect(planEviction(entries, { limitBytes: 100, incomingBytes: 30, isPinned: none, now }).map((e) => e.id)).toEqual(["a"]);
    });

    it("never evicts a pinned entry, a partial download, or one used in the last minute — even if the limit stays exceeded", () => {
        const entries = [
            entry("pinned", 50, 1), entry("partial", 50, 2, { state: "partial" }), entry("recent", 50, now - 1000), entry("free", 50, 3),
        ];
        const victims = planEviction(entries, { limitBytes: 0, isPinned: (e) => e.id === "pinned", now });
        expect(victims.map((e) => e.id)).toEqual(["free"]);
    });

    it("clears everything that is not pinned or partial when asked to (recent entries included)", () => {
        const entries = [entry("pinned", 50, 1), entry("recent", 50, now - 1000), entry("old", 50, 3), entry("partial", 9, 2, { state: "partial" })];
        const victims = planEviction(entries, { limitBytes: Number.POSITIVE_INFINITY, isPinned: (e) => e.id === "pinned", now, all: true });
        expect(victims.map((e) => e.id).sort()).toEqual(["old", "recent"]);
    });

    it("does not count partial downloads as used bytes but counts ready ones of unknown size as zero", () => {
        const entries = [entry("p", 1_000, 1, { state: "partial" }), entry("a", 0, 2), entry("b", 60, 3)];
        expect(planEviction(entries, { limitBytes: 60, isPinned: none, now })).toEqual([]);
    });
});

describe("MediaCacheIndex", () => {
    it("reads the stored index fresh for every update, under the host's lock, and writes only when something changed", async () => {
        const mem = memoryStorage({ version: 2, entries: [entry("a", 10, 1)] });
        const index = new MediaCacheIndex(mem.storage, { now: () => 50 });
        expect((await index.entries()).map((e) => e.id)).toEqual(["a"]);
        // Another tab wrote meanwhile: the next update sees its entry.
        mem.setRaw({ version: 2, entries: [entry("a", 10, 1), entry("b", 20, 2)] });
        await index.update((entries) => {
            expect([...entries.keys()].sort()).toEqual(["a", "b"]);
        });
        expect(mem.writes).toHaveLength(0);
        await index.update((entries) => {
            entries.set("c", entry("c", 30, 50));
        });
        expect(mem.writes).toHaveLength(1);
        expect(mem.writes[0]!.version).toBe(2);
        expect(mem.writes[0]!.entries.map((e) => e.id).sort()).toEqual(["a", "b", "c"]);
        expect(mem.locks()).toBe(2);
    });

    it("keeps the old index when a write fails (the update rejects)", async () => {
        const mem = memoryStorage({ version: 2, entries: [entry("a", 10, 1)] });
        const index = new MediaCacheIndex(mem.storage, { now: () => 50 });
        mem.failNextWrite();
        await expect(index.update((entries) => entries.delete("a"))).rejects.toThrow("disk full");
        expect((await index.entries()).map((e) => e.id)).toEqual(["a"]);
    });

    it("runs updates one at a time without a host lock", async () => {
        const mem = memoryStorage(null);
        const storage: CacheIndexStorage = { read: mem.storage.read, write: mem.storage.write };
        const index = new MediaCacheIndex(storage, { now: () => 1 });
        await Promise.all(Array.from({ length: 20 }, (_, i) => index.update((entries) => {
            entries.set(`e${i}`, entry(`e${i}`, 1, i));
        })));
        expect((await index.entries())).toHaveLength(20);
    });

    it("touch() refreshes lastUsed of known ids in one batched write", async () => {
        const mem = memoryStorage({ version: 2, entries: [entry("a", 10, 1), entry("b", 10, 1)] });
        let now = 100;
        const index = new MediaCacheIndex(mem.storage, { now: () => now });
        index.touch("a");
        index.touch("b");
        index.touch("unknown");
        now = 200;
        await index.flushTouches();
        expect(mem.writes).toHaveLength(1);
        expect(Object.fromEntries((await index.entries()).map((e) => [e.id, e.lastUsed]))).toEqual({ a: 100, b: 100 });
    });
});
