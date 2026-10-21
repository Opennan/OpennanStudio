import { createMemoryPersistence } from "@opennan/timeline-core";
import { urlKey } from "@opennan/cloud-backend";
import { fakeLocks, fakeStorage } from "./fake-opfs";
import { CACHE_ID_PREFIX, LIMIT_PREFERENCE, createWebMediaCache, defaultWebLimit } from "./media-cache";

const MB = 1024 ** 2;
const GB = 1024 ** 3;
const CDN = "https://cdn.opennan.com/";
const url = (n: number) => `${CDN}media/${n}.mp4`;

function memoryPreferences() {
    const values = new Map<string, string>();
    return { get: (key: string) => values.get(key) ?? null, set: (key: string, value: string | null) => (value === null ? values.delete(key) : values.set(key, value)), values };
}

function setup(options: { quota?: number | null; opfs?: boolean; locks?: ReturnType<typeof fakeLocks>; storage?: ReturnType<typeof fakeStorage>; references?: Set<string>; onReferences?: () => void } = {}) {
    const storage = options.storage ?? fakeStorage({ quota: options.quota === undefined ? 100 * GB : options.quota });
    const fetches: string[] = [];
    const sizes = new Map<string, number>();
    let clock = 1_000_000;
    const doFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const href = String(input);
        fetches.push(href);
        expect(init).toMatchObject({ credentials: "omit", redirect: "error" });
        const size = sizes.get(href) ?? 100;
        return new Response(new Uint8Array(size).fill(href.length % 251), { status: 200, headers: { "content-type": "video/mp4", "content-length": String(size) } });
    }) as typeof globalThis.fetch;
    const fallback = createMemoryPersistence();
    const preferences = memoryPreferences();
    const locks = options.locks ?? fakeLocks();
    let ids = 0;
    const make = () => createWebMediaCache({
        isAllowed: (u) => u.startsWith(CDN), fallback, fetch: doFetch, storage: options.opfs === false ? { estimate: async () => ({ quota: 10 * GB, usage: 0 }) } as unknown as StorageManager : storage.manager,
        locks: locks.manager(), preferences, now: () => clock, newSuffix: () => (++ids).toString(16).padStart(8, "0"), minLimitBytes: 1,
        localReferences: async () => {
            options.onReferences?.();
            return options.references ?? new Set();
        },
    });
    const cache = make();
    return {
        cache, make, storage, fetches, sizes, fallback, preferences, locks,
        advance: (ms: number) => (clock += ms),
        files: async () => (await storage.cacheDir()).files(),
        signal: new AbortController().signal,
    };
}

describe("web media cache (OPFS, 9a.1)", () => {
    it("downloads a cloud file once, indexes it, and answers from the index afterwards", async () => {
        const t = setup();
        const local = await t.cache.cache(url(1), 100, t.signal);
        expect(local).toMatch(/^opennan-local:\/\/media\/c-[0-9a-f]{16}-\d+-[0-9a-f]{8}$/);
        expect(await t.cache.cache(url(1), 100, t.signal)).toBe(local);
        expect(t.fetches).toEqual([url(1)]);
        const id = local.slice("opennan-local://media/".length);
        expect((await t.cache.getBlob(id))!.size).toBe(100);
        expect(t.cache.isCacheId(id)).toBe(true);
        expect(await t.cache.usage()).toMatchObject({ usedBytes: 100, entries: 1 });
        // Another tab (a new cache over the same OPFS) finds it too.
        expect(await t.make().cache(url(1), 100, t.signal)).toBe(local);
        expect(t.fetches).toHaveLength(1);
    });

    it("evicts the least recently used files over the limit, never a pinned one, another tab's pin, or one a local project names", async () => {
        const locks = fakeLocks();
        const t = setup({ locks, references: new Set() });
        await t.cache.setLimit(250);
        const ids: string[] = [];
        for (const n of [1, 2]) {
            ids.push((await t.cache.cache(url(n), 100, t.signal)).slice(22));
            t.advance(120_000);
        }
        // 1 is older; another tab pins it (a shared Web Lock), so 2 goes instead... unless 2 is pinned here.
        const other = setup({ locks, storage: t.storage }).make();
        other.setPinned([ids[0]!]);
        await new Promise((r) => setTimeout(r, 0));
        t.cache.setPinned([ids[1]!]);
        await t.cache.cache(url(3), 100, t.signal);
        t.advance(120_000);
        // Nothing could go: both old files are pinned (the limit is a target).
        expect(Object.keys(await t.files()).filter((f) => f.startsWith(CACHE_ID_PREFIX))).toHaveLength(3);
        t.cache.setPinned([]);
        await t.cache.cache(url(4), 100, t.signal);
        const left = Object.keys(await t.files());
        expect(left).not.toContain(ids[1]);
        expect(left).toContain(ids[0]);
    });

    it("reads local projects only when something has to go (not on every download under the limit)", async () => {
        let reads = 0;
        const t = setup({ onReferences: () => (reads += 1) });
        for (const n of [1, 2, 3]) await t.cache.cache(url(n), 100, t.signal);
        expect(reads).toBe(0);
        await t.cache.setLimit(150);
        expect(reads).toBe(1);
    });

    it("never evicts a file a local project names", async () => {
        const references = new Set<string>();
        const t = setup({ references });
        await t.cache.setLimit(150);
        const first = (await t.cache.cache(url(1), 100, t.signal)).slice(22);
        references.add(first);
        t.advance(120_000);
        await t.cache.cache(url(2), 100, t.signal);
        expect(Object.keys(await t.files())).toContain(first);
    });

    it("downloads an evicted file again under a new id (the working copy re-hydrates it)", async () => {
        const t = setup();
        const first = await t.cache.cache(url(1), 100, t.signal);
        t.advance(120_000);
        expect(await t.cache.clear()).toEqual({ freedBytes: 100, keptBytes: 0 });
        const again = await t.cache.cache(url(1), 100, t.signal);
        expect(again).not.toBe(first);
        expect(t.fetches).toEqual([url(1), url(1)]);
    });

    it("adopts a 9a file (c-<urlKey>) with its URL instead of downloading it again", async () => {
        const t = setup();
        const legacy = `${CACHE_ID_PREFIX}${urlKey(url(7)).slice(2)}`;
        const dir = await t.storage.cacheDir();
        const writable = await (await dir.getFileHandle(legacy, { create: true })).createWritable();
        await writable.write(new Uint8Array(42));
        await writable.close();
        expect(await t.cache.cache(url(7), 42, t.signal)).toBe(`opennan-local://media/${legacy}`);
        expect(t.fetches).toEqual([]);
        expect(await t.cache.usage()).toMatchObject({ usedBytes: 42, entries: 1 });
    });

    it("Clear cache keeps what open projects use and says how much stayed", async () => {
        const t = setup();
        const a = (await t.cache.cache(url(1), 100, t.signal)).slice(22);
        t.sizes.set(url(2), 60);
        await t.cache.cache(url(2), 60, t.signal);
        t.cache.setPinned([a]);
        expect(await t.cache.clear()).toEqual({ freedBytes: 60, keptBytes: 100 });
        expect(await t.cache.usage()).toMatchObject({ usedBytes: 100, pinnedBytes: 100, entries: 1 });
    });

    it("survives a crash: an index write that failed keeps the old index; a vanished file is dropped; a stale half download is removed", async () => {
        const t = setup();
        const a = (await t.cache.cache(url(1), 100, t.signal)).slice(22);
        const dir = await t.storage.cacheDir();
        dir.failWritesFor = "index.json";
        await expect(t.cache.cache(url(2), 100, t.signal)).rejects.toThrow();
        dir.failWritesFor = null;
        // The failed download left no file behind and the index still lists only the first one.
        expect(Object.keys(dir.files()).sort()).toEqual([a, "index.json"].sort());
        await dir.removeEntry(a);
        expect(await t.make().usage()).toMatchObject({ usedBytes: 0, entries: 0 });
        // An unindexed recent file (another tab mid-download) is left alone.
        const writable = await (await dir.getFileHandle("c-0000000000000000-1-deadbeef", { create: true })).createWritable();
        await writable.write(new Uint8Array(5));
        await writable.close();
        await t.make().usage();
        expect(Object.keys(dir.files())).toContain("c-0000000000000000-1-deadbeef");
    });

    it("refuses anything but OpenNan storage and a download larger than listed", async () => {
        const t = setup();
        await expect(t.cache.cache("https://evil.example/x.mp4", 10, t.signal)).rejects.toThrow("OpenNan's storage");
        t.sizes.set(url(5), 5 * MB);
        await expect(t.cache.cache(url(5), 10, t.signal)).rejects.toThrow("larger");
        expect(await t.cache.usage()).toMatchObject({ entries: 0 });
    });

    it("keeps files in the IndexedDB blob store where OPFS is missing, and evicts them there", async () => {
        const t = setup({ opfs: false });
        const local = await t.cache.cache(url(1), 100, t.signal);
        const id = local.slice(22);
        expect((await t.fallback.getBlob(id))!.size).toBe(100);
        t.advance(120_000);
        await t.cache.clear();
        expect(await t.fallback.getBlob(id)).toBeNull();
    });
});

describe("web media cache limits", () => {
    it("defaults to min(5 GB, half the browser's quota), 2 GB without an estimate; offers up to 80 % of the quota", async () => {
        expect(defaultWebLimit(4 * GB)).toBe(2 * GB);
        expect(defaultWebLimit(100 * GB)).toBe(5 * GB);
        expect(defaultWebLimit(null)).toBe(2 * GB);
        const t = setup({ quota: 10 * GB });
        expect(await t.cache.usage()).toMatchObject({ limitBytes: 5 * GB, defaultLimitBytes: 5 * GB, maxLimitBytes: 8 * GB, custom: false });
        expect(await t.cache.setLimit(1 * GB)).toMatchObject({ limitBytes: 1 * GB, custom: true });
        expect(t.preferences.values.get(LIMIT_PREFERENCE)).toBe(String(GB));
        expect(await t.cache.setLimit(null)).toMatchObject({ limitBytes: 5 * GB, custom: false });
        await expect(t.cache.setLimit(9 * GB)).rejects.toThrow();
        await expect(t.cache.setLimit(-1)).rejects.toThrow();
    });
});

describe("web media cache after review (9a.1)", () => {
    it("never leaks a pin lock when a pin is dropped or re-added before its lock is granted", async () => {
        const locks = fakeLocks();
        const t = setup({ locks });
        const id = "c-0000000000000001-1-aaaaaaaa";
        t.cache.setPinned([id]);
        t.cache.setPinned([]);
        await new Promise((r) => setTimeout(r, 5));
        expect(locks.held()).toEqual([]);
        t.cache.setPinned([id]);
        t.cache.setPinned([]);
        t.cache.setPinned([id]);
        await new Promise((r) => setTimeout(r, 5));
        expect(locks.held()).toEqual([`shared:opennan-media-pin:${id}`]);
        t.cache.setPinned([]);
        await new Promise((r) => setTimeout(r, 5));
        expect(locks.held()).toEqual([]);
    });

    it("removes a cache file left without its entry for a day (a failed clean-up), keeps a recent one", async () => {
        const t = setup();
        const dir = await t.storage.cacheDir();
        const old = "c-00000000000000aa-5-11111111";
        const recent = "c-00000000000000bb-5-22222222";
        dir.nodes.set(old, { kind: "file", blob: new File([new Uint8Array(5)], old, { lastModified: Date.now() - 2 * 86_400_000 }) });
        dir.nodes.set(recent, { kind: "file", blob: new File([new Uint8Array(5)], recent, { lastModified: Date.now() }) });
        await t.make().usage();
        expect(Object.keys(dir.files())).not.toContain(old);
        expect(Object.keys(dir.files())).toContain(recent);
    });

    it("answers many known files from one read of the index (a project opening asks for each)", async () => {
        const t = setup();
        for (const n of [1, 2, 3, 4, 5]) await t.cache.cache(url(n), 100, t.signal);
        const dir = await t.storage.cacheDir();
        const fresh = t.make();
        await fresh.usage();
        const before = dir.reads.get("index.json") ?? 0;
        await Promise.all([1, 2, 3, 4, 5].map((n) => fresh.cache(url(n), 100, t.signal)));
        expect((dir.reads.get("index.json") ?? 0) - before).toBeLessThanOrEqual(1);
        expect(t.fetches).toHaveLength(5);
    });
});
