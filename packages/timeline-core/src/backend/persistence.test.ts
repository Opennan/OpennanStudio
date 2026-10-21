// @vitest-environment node
// Node's structuredClone keeps a Blob as browsers do; a jsdom Blob loses its bytes in fake-indexeddb.
import { IDBFactory } from "fake-indexeddb";
import { createIndexedDbPersistence, createMemoryPersistence, type LocalPersistence, type LocalProjectState } from "./persistence";

const state: LocalProjectState = {
  meta: { id: "p1", name: "Demo", musicUrl: null, musicVolume: 1, aspectRatio: "16:9" },
  tracks: [{ type: "video", index: 1, label: "V1", muted: false, locked: false, visible: true, volume: 1 }],
  clips: [],
  scenes: [],
};

const factories: Array<[string, () => LocalPersistence]> = [
  ["memory", () => createMemoryPersistence()],
  ["indexeddb", () => createIndexedDbPersistence({ indexedDB: new IDBFactory(), dbName: "test-studio" })],
];

describe.each(factories)("%s persistence", (_name, make) => {
  it("returns null for unknown projects and round-trips saved state", async () => {
    const persistence = make();
    expect(await persistence.loadProject("p1")).toBeNull();
    await persistence.saveProject("p1", state);
    expect(await persistence.loadProject("p1")).toEqual(state);
  });

  it("round-trips masks on clips and scenes and their mask keyframes (phase 10c)", async () => {
    const persistence = make();
    const { optimisticTimelineClipFromInput } = await import("../lib/timeline-optimistic");
    const maskJson = '{"shape":"heart","x":0.4,"y":0.5,"width":0.6,"height":0.6,"rotation":12,"feather":0.2,"roundness":0,"invert":true}';
    const keyframesJson = JSON.stringify({ keyframes: [{ time: 0, mask_x: 0.2 }, { time: 1, mask_x: 0.6, easing: 3 }] });
    const masked: LocalProjectState = {
      ...state,
      clips: [{ ...optimisticTimelineClipFromInput({ trackType: "video", trackIndex: 2, startTime: 0, endTime: 2, mediaType: "video", mediaUrl: "a.mp4" }, "p1", "c1"), maskJson, keyframesJson }],
      scenes: [{
        id: "s1", order: 0, caption: "", startTime: "0", endTime: "0", startImageUrl: null, endImageUrl: null, videoUrl: null, status: "ready", transition: "cut",
        frameConsistencyScore: null, audioUrl: null, audioText: null, cardConfig: null, maskJson, keyframesJson,
      }],
    };
    await persistence.saveProject("p1", masked);
    const loaded = await persistence.loadProject("p1");
    expect(loaded?.clips[0]).toMatchObject({ maskJson, keyframesJson });
    expect(loaded?.scenes[0]).toMatchObject({ maskJson, keyframesJson });
  });

  it("stores a detached copy", async () => {
    const persistence = make();
    const draft = structuredClone(state);
    await persistence.saveProject("p1", draft);
    draft.meta.name = "Changed";
    expect((await persistence.loadProject("p1"))?.meta.name).toBe("Demo");
  });

  it("round-trips blobs with their type", async () => {
    const persistence = make();
    await persistence.putBlob("b1", new Blob([new Uint8Array([1, 2, 3])], { type: "audio/wav" }));
    const blob = await persistence.getBlob("b1");
    expect(blob?.type).toBe("audio/wav");
    expect([...new Uint8Array(await blob!.arrayBuffer())]).toEqual([1, 2, 3]);
    expect(await persistence.getBlob("missing")).toBeNull();
  });

  it("keeps the Blob itself: no arrayBuffer() copy on write, same type and size on read", async () => {
    const persistence = make();
    const blob = new Blob([new Uint8Array(5)], { type: "video/webm" });
    const copy = vi.spyOn(blob, "arrayBuffer");
    await persistence.putBlob("b1", blob);
    expect(copy).not.toHaveBeenCalled();
    const read = await persistence.getBlob("b1");
    expect(read).toBeInstanceOf(Blob);
    expect(read).toMatchObject({ type: "video/webm", size: 5 });
  });

  it("lists and deletes projects", async () => {
    const persistence = make();
    await persistence.saveProject("p1", state);
    await persistence.saveProject("p2", { ...state, meta: { ...state.meta, id: "p2", name: "Second" } });
    expect((await persistence.listProjects!()).map((p) => p.meta.id).sort()).toEqual(["p1", "p2"]);
    await persistence.deleteProject!("p1");
    expect(await persistence.loadProject("p1")).toBeNull();
    expect((await persistence.listProjects!()).map((p) => p.meta.name)).toEqual(["Second"]);
  });

  it("deletes blobs", async () => {
    const persistence = make();
    await persistence.putBlob("b1", new Blob([new Uint8Array([1])], { type: "video/webm" }));
    await persistence.deleteBlob!("b1");
    expect(await persistence.getBlob("b1")).toBeNull();
  });
});

describe("indexeddb persistence with records from phase 1-2 builds", () => {
  it("still reads blobs stored as { type, data }", async () => {
    const factory = new IDBFactory();
    const persistence = createIndexedDbPersistence({ indexedDB: factory, dbName: "legacy" });
    await persistence.loadProject("p1"); // opens the database and creates both stores
    await new Promise<void>((resolve, reject) => {
      const request = factory.open("legacy", 1);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const transaction = request.result.transaction("blobs", "readwrite");
        transaction.objectStore("blobs").put({ type: "audio/wav", data: new Uint8Array([1, 2, 3]).buffer }, "old");
        transaction.oncomplete = () => {
          request.result.close();
          resolve();
        };
        transaction.onerror = () => reject(transaction.error);
      };
    });
    const blob = await persistence.getBlob("old");
    expect(blob?.type).toBe("audio/wav");
    expect([...new Uint8Array(await blob!.arrayBuffer())]).toEqual([1, 2, 3]);
  });
});
