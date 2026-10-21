import { describe, expect, it } from "vitest";
import { createMemoryStore, STORE_NAMESPACES, type CloudStore } from "./store";
import { migrateStore, migratingStore } from "./store-migration";

async function fill(store: CloudStore, records: Record<string, Record<string, unknown>>): Promise<void> {
    for (const [namespace, values] of Object.entries(records)) for (const [key, value] of Object.entries(values)) await store.put(namespace as never, key, value);
}

describe("migrateStore", () => {
    it("moves every namespace's records from the email store to the account id store", async () => {
        const from = createMemoryStore();
        const to = createMemoryStore();
        await fill(from, { sync: { "cloud-a": { q: 1 } }, mirror: { "cloud-a": { doc: 1 } }, urls: { "u-1": { local: "x" } }, lists: { active: [1] }, snapshots: { s: 1 }, uploads: { up: 1 } });
        const result = await migrateStore(from, to);
        expect(result.moved).toBe(6);
        expect(to.dump()).toEqual({ sync: { "cloud-a": { q: 1 } }, mirror: { "cloud-a": { doc: 1 } }, urls: { "u-1": { local: "x" } }, lists: { active: [1] }, snapshots: { s: 1 }, uploads: { up: 1 } });
        for (const namespace of STORE_NAMESPACES) expect(await from.keys(namespace)).toEqual([]);
    });

    it("keeps the id store's own records (they are newer) and still empties the email store", async () => {
        const from = createMemoryStore();
        const to = createMemoryStore();
        await fill(from, { sync: { "cloud-a": { from: "email" }, "cloud-b": { from: "email" } } });
        await fill(to, { sync: { "cloud-a": { from: "id" } } });
        await migrateStore(from, to);
        expect(await to.get("sync", "cloud-a")).toEqual({ from: "id" });
        expect(await to.get("sync", "cloud-b")).toEqual({ from: "email" });
        expect(await from.keys("sync")).toEqual([]);
    });

    it("finishes on the next start after an interrupted run (nothing lost, nothing doubled)", async () => {
        const from = createMemoryStore();
        const to = createMemoryStore();
        await fill(from, { sync: { a: 1, b: 2, c: 3 } });
        let puts = 0;
        const flaky: CloudStore = {
            ...to,
            async put(namespace, key, value) {
                if (++puts === 2) throw new Error("crash");
                return to.put(namespace, key, value);
            },
        };
        await expect(migrateStore(from, flaky)).rejects.toThrow("crash");
        // The source still has whatever was not copied yet.
        expect((await from.keys("sync")).length).toBeGreaterThan(0);
        await migrateStore(from, to);
        expect(to.dump().sync).toEqual({ a: 1, b: 2, c: 3 });
        expect(await from.keys("sync")).toEqual([]);
    });
});

describe("migratingStore", () => {
    it("lets no call reach the target before the migration (and the old backend's dispose) finished", async () => {
        const from = createMemoryStore();
        const to = createMemoryStore();
        await fill(from, { sync: { "cloud-a": { q: 1 } } });
        let disposed!: () => void;
        const waitFor = new Promise<void>((resolve) => (disposed = resolve));
        const store = migratingStore(to, from, { waitFor });
        const read = store.get("sync", "cloud-a");
        let settled = false;
        void read.then(() => (settled = true));
        await new Promise((r) => setTimeout(r, 5));
        expect(settled).toBe(false);
        // The old backend persists one last write before it is gone: it moves too.
        await from.put("sync", "cloud-b", { late: true });
        disposed();
        expect(await read).toEqual({ q: 1 });
        expect(await store.get("sync", "cloud-b")).toEqual({ late: true });
        expect(await from.keys("sync")).toEqual([]);
    });

    it("is the target itself when there is nothing to migrate from", async () => {
        const to = createMemoryStore();
        expect(migratingStore(to, null)).toBe(to);
    });

    it("still opens the target when the migration fails (and tries again next time)", async () => {
        const to = createMemoryStore();
        const broken: CloudStore = { ...createMemoryStore(), keys: async () => { throw new Error("unreadable"); } };
        const warnings: unknown[] = [];
        const store = migratingStore(to, broken, { logger: { warn: (...args) => warnings.push(args) } });
        await store.put("sync", "x", 1);
        expect(await store.get("sync", "x")).toBe(1);
        expect(warnings).toHaveLength(1);
    });
});

describe("migratingStore after review (9a.1)", () => {
    it("leaves records another tab is using where they are, and moves each one on first read once it is free", async () => {
        const from = createMemoryStore();
        const to = createMemoryStore();
        await fill(from, { sync: { "cloud-open": { q: "tab A" }, "cloud-free": { q: 1 } }, mirror: { "cloud-open": { doc: "A" } } });
        const busy = new Set(["cloud-open"]);
        const store = migratingStore(to, from, { skip: async (_namespace, key) => busy.has(key) });
        expect(await store.get("sync", "cloud-free")).toEqual({ q: 1 });
        expect(await from.get("sync", "cloud-open")).toEqual({ q: "tab A" });
        expect(await to.get("sync", "cloud-open")).toBeNull();
        // Listed (so the catalog shows it), not read while busy.
        expect((await store.keys("sync")).sort()).toEqual(["cloud-free", "cloud-open"]);
        expect(await store.get("sync", "cloud-open")).toBeNull();
        // Tab A closed the project (and wrote once more): the next read moves its latest record.
        await from.put("sync", "cloud-open", { q: "tab A, last" });
        busy.clear();
        expect(await store.get("sync", "cloud-open")).toEqual({ q: "tab A, last" });
        expect(await store.get("mirror", "cloud-open")).toEqual({ doc: "A" });
        expect(await from.keys("sync")).toEqual([]);
    });

    it("reads a record from the old store when an interrupted move left it there", async () => {
        const from = createMemoryStore();
        const to = createMemoryStore();
        await fill(from, { urls: { "u-1": { local: "x" } } });
        let failing = true;
        const flaky: typeof from = { ...from, keys: async (namespace) => {
            if (failing && namespace === "sync") throw new Error("interrupted");
            return from.keys(namespace);
        } };
        const store = migratingStore(to, flaky, { logger: { warn: () => undefined } });
        expect(await store.get("urls", "u-1")).toEqual({ local: "x" });
        failing = false;
        expect(await store.keys("urls")).toEqual(["u-1"]);
    });

    it("deletes a record from both stores (a forgotten project never comes back from the old one)", async () => {
        const from = createMemoryStore();
        const to = createMemoryStore();
        await fill(from, { sync: { "cloud-gone": { q: 1 } } });
        const store = migratingStore(to, from, { skip: async () => true });
        await store.delete("sync", "cloud-gone");
        expect(await from.get("sync", "cloud-gone")).toBeNull();
        expect(await store.get("sync", "cloud-gone")).toBeNull();
    });
});
