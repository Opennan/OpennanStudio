import "fake-indexeddb/auto";
import {
  DexieSnapshotStore,
  DexieSyncQueueStore,
  __resetLocalDBSingletonForTests,
  getLocalDB,
  isLocalDBAvailable,
} from "../dexie";

if (typeof window !== "undefined" && !window.indexedDB) {
  Object.assign(window, { indexedDB: globalThis.indexedDB, IDBKeyRange: globalThis.IDBKeyRange });
}

beforeEach(async () => {
  await getLocalDB().delete();
  __resetLocalDBSingletonForTests();
});

describe("dexie sub-entry", () => {
  it("keeps the source database name and schema version", () => {
    const db = getLocalDB();
    expect(isLocalDBAvailable()).toBe(true);
    expect(db.name).toBe("opennan-local");
    expect(db.verno).toBe(1);
    expect(db.tables.map((t) => t.name).sort()).toEqual(["mediaBlobs", "syncQueue", "timelineSnapshots"]);
  });

  it("round-trips timeline snapshots", async () => {
    const store = new DexieSnapshotStore();
    await store.save("p1", { tracks: [], clips: [{ id: "c1" }] });
    expect(await store.load("p1")).toEqual({ tracks: [], clips: [{ id: "c1" }] });
    await store.clear("p1");
    expect(await store.load("p1")).toBeNull();
  });

  it("stores, supersedes, updates, and removes sync-queue rows", async () => {
    const queue = new DexieSyncQueueStore();
    const base = { projectId: "p1", op: "updateClips" as const, payload: {}, createdAt: 1, attempts: 0, nextAttemptAt: 0 };
    const first = await queue.enqueue({ ...base, coalesceKey: "clip:a" });
    const second = await queue.enqueue({ ...base, coalesceKey: "clip:a" });
    await queue.supersede("p1", "clip:a", second);
    expect((await queue.list("p1")).map((r) => r.id)).toEqual([second]);
    await queue.update(second, { attempts: 2 });
    expect((await queue.list("p1"))[0].attempts).toBe(2);
    await queue.remove(second);
    expect(await queue.list("p1")).toEqual([]);
    expect(first).toBeLessThan(second);
  });
});
