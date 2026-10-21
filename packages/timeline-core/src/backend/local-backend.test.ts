import { IDBFactory } from "fake-indexeddb";
import { describeTimelineBackendContract } from "../testing";
import { DEFAULT_PROJECT_NAME, LOCAL_MEDIA_URL_PREFIX, LocalBackend } from "./local-backend";
import { createIndexedDbPersistence, createMemoryPersistence } from "./persistence";

let counter = 0;
const idFactory = () => `id-${++counter}`;

describeTimelineBackendContract("LocalBackend (memory)", async () => ({
  backend: new LocalBackend({ persistence: createMemoryPersistence(), idFactory }),
  projectId: "p1",
}));

describeTimelineBackendContract("LocalBackend (IndexedDB)", async () => ({
  backend: new LocalBackend({ persistence: createIndexedDbPersistence({ indexedDB: new IDBFactory() }), idFactory }),
  projectId: "p1",
}));

describe("LocalBackend specifics", () => {
  it("gives effect rows copied by duplicate and split their own ids and owners", async () => {
    const backend = new LocalBackend({ persistence: createMemoryPersistence(), idFactory });
    const scene = await backend.addScene("p1", { afterOrder: -1, cardType: "source_clip", sourceVideoUrl: "s.mp4", trackIndex: 1, timelinePositionSeconds: 0.001, duration: 4 });
    const [row] = await backend.addClipEffect("p1", { sceneId: scene.id }, "fx_blur");
    const copy = await backend.duplicateScene("p1", scene.id);
    expect(copy.effects).toHaveLength(1);
    expect(copy.effects![0].id).not.toBe(row.id);
    expect(copy.effects![0]).toMatchObject({ sceneId: copy.id, effectId: "fx_blur" });
    const [, second] = await backend.splitScene("p1", scene.id, 2);
    expect(second.effects![0].id).not.toBe(row.id);
    expect(second.effects![0].sceneId).toBe(second.id);

    const [clip] = await backend.createClips("p1", [{ trackType: "video", trackIndex: 2, startTime: 0, endTime: 4, mediaType: "video", mediaUrl: "a.mp4" }]);
    const [clipRow] = await backend.addClipEffect("p1", { clipId: clip.id }, "fx_blur");
    const [, right] = await backend.splitClips("p1", [clip.id], 2);
    expect(right.effects![0].id).not.toBe(clipRow.id);
    expect(right.effects![0].clipId).toBe(right.id);
    const ids = [...(await backend.loadScenes("p1")).flatMap((s) => s.effects ?? []), ...(await backend.loadTimeline("p1")).clips.flatMap((c) => c.effects ?? [])].map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("reloads persisted state in a new instance", async () => {
    const persistence = createMemoryPersistence();
    const first = new LocalBackend({ persistence, idFactory });
    await first.createClips("p1", [{ trackType: "text", trackIndex: 1, startTime: 0, endTime: 1 }]);
    const second = new LocalBackend({ persistence, idFactory });
    expect((await second.loadTimeline("p1")).clips).toHaveLength(1);
  });

  it("resolves the panel images of a scene's shots (storyboards, phase 9b) when a project is seeded or loaded", async () => {
    const persistence = createMemoryPersistence();
    await persistence.putBlob("c-panel", new Blob([new Uint8Array(5)], { type: "image/png" }));
    const createObjectUrl = vi.fn((blob: Blob) => `blob:test/${blob.size}`);
    const backend = new LocalBackend({ persistence, idFactory, createObjectUrl });
    const url = `${LOCAL_MEDIA_URL_PREFIX}c-panel`;
    const shots = JSON.stringify([{ duration: 2, prompt: "wide", keyframe_url: url, readOnly: true }]);
    await backend.seedProject("p1", { scenes: [{ id: "s1", order: 0, caption: "", status: "ready", shotBreakdown: shots } as never] });
    expect(backend.resolveLocalUrl(url)).toBe("blob:test/5");
    const reloaded = new LocalBackend({ persistence, idFactory, createObjectUrl });
    await reloaded.loadScenes("p1");
    expect(reloaded.resolveLocalUrl(url)).toBe("blob:test/5");
  });

  it("resolves a scene's storyboard sheet and panel images (phase 9c) and keeps the sheets through a reload", async () => {
    const persistence = createMemoryPersistence();
    await persistence.putBlob("c-sheet", new Blob([new Uint8Array(7)], { type: "image/png" }));
    await persistence.putBlob("c-panel2", new Blob([new Uint8Array(4)], { type: "image/png" }));
    const createObjectUrl = vi.fn((blob: Blob) => `blob:test/${blob.size}`);
    const backend = new LocalBackend({ persistence, idFactory, createObjectUrl });
    const sheet = `${LOCAL_MEDIA_URL_PREFIX}c-sheet`;
    const panel = `${LOCAL_MEDIA_URL_PREFIX}c-panel2`;
    const storyboardSheets = [{ imageUrl: sheet, panels: [{ index: 0, shotIndex: 0, imageUrl: panel }] }];
    await backend.seedProject("p1", { scenes: [{ id: "s1", order: 0, caption: "", status: "ready", storyboardSheets } as never] });
    expect(backend.resolveLocalUrl(sheet)).toBe("blob:test/7");
    expect(backend.resolveLocalUrl(panel)).toBe("blob:test/4");
    const reloaded = new LocalBackend({ persistence, idFactory, createObjectUrl });
    expect((await reloaded.loadScenes("p1"))[0]!.storyboardSheets).toEqual(storyboardSheets);
    expect(reloaded.resolveLocalUrl(panel)).toBe("blob:test/4");
  });

  it("resolves uploaded media to object urls, also after reload", async () => {
    const persistence = createMemoryPersistence();
    const createObjectUrl = vi.fn((blob: Blob) => `blob:test/${blob.size}`);
    const backend = new LocalBackend({ persistence, idFactory, createObjectUrl });
    const media = await backend.uploadFile("p1", new Blob([new Uint8Array(3)], { type: "image/png" }), "image");
    expect(media.url.startsWith(LOCAL_MEDIA_URL_PREFIX)).toBe(true);
    expect(backend.resolveLocalUrl(media.url)).toBe("blob:test/3");
    await backend.createClips("p1", [{ trackType: "sticker", trackIndex: 1, startTime: 0, endTime: 1, mediaUrl: media.url }]);

    const reloaded = new LocalBackend({ persistence, idFactory, createObjectUrl });
    await reloaded.loadTimeline("p1");
    expect(reloaded.resolveLocalUrl(media.url)).toBe("blob:test/3");
  });

  it("inserts a split scene right after its source", async () => {
    const backend = new LocalBackend({ persistence: createMemoryPersistence(), idFactory });
    const a = await backend.addScene("p1", { afterOrder: -1, cardType: "source_clip", videoUrl: "a.mp4", duration: 4 });
    const b = await backend.addScene("p1", { afterOrder: 0, duration: 6 });
    const c = await backend.addScene("p1", { afterOrder: 1, duration: 5 });
    const [, second] = await backend.splitScene("p1", a.id, 2);
    const scenes = await backend.loadScenes("p1");
    expect(scenes.map((s) => s.id)).toEqual([a.id, second.id, b.id, c.id]);
    expect(scenes.map((s) => s.order)).toEqual([0, 1, 2, 3]);
  });

  it("refuses ids that collide with optimistic prefixes", async () => {
    const backend = new LocalBackend({ persistence: createMemoryPersistence(), idFactory: () => "temp-1" });
    await expect(backend.createClips("p1", [{ trackType: "text", trackIndex: 1, startTime: 0, endTime: 1 }])).rejects.toThrow("reserved prefix");
  });

  it("does not implement merge or extract shot", () => {
    const backend = new LocalBackend({ persistence: createMemoryPersistence() });
    expect("mergeShot" in backend).toBe(false);
    expect("extractShot" in backend).toBe(false);
  });
});

describe("LocalBackend project catalog", () => {
  function make() {
    let n = 0;
    let clock = 1_000;
    const persistence = createMemoryPersistence();
    const revokeObjectUrl = vi.fn();
    const backend = new LocalBackend({
      persistence,
      idFactory: () => `c-${++n}`,
      now: () => (clock += 10),
      createObjectUrl: (blob) => `blob:test/${blob.size}`,
      revokeObjectUrl,
    });
    return { backend, persistence, revokeObjectUrl };
  }

  it("creates projects and lists them by last edit with a summary", async () => {
    const { backend } = make();
    const trip = await backend.createProject({ name: "  Trip  ", aspectRatio: "9:16" });
    const untitled = await backend.createProject();
    expect(trip).toMatchObject({ id: "c-1", name: "Trip", aspectRatio: "9:16", durationSeconds: 0, mediaCount: 0 });
    expect(untitled).toMatchObject({ id: "c-2", name: DEFAULT_PROJECT_NAME, aspectRatio: "16:9" });
    await backend.createClips(trip.id, [{ trackType: "text", trackIndex: 1, startTime: 1, endTime: 4 }]);
    const list = await backend.listProjects();
    expect(list.map((p) => p.id)).toEqual(["c-1", "c-2"]);
    expect(list[0].durationSeconds).toBe(4);
    expect(list[0].updatedAt).toBeGreaterThan(list[0].createdAt);
  });

  it("checks existence without creating the project", async () => {
    const { backend, persistence } = make();
    expect(await backend.hasProject("missing")).toBe(false);
    expect(await persistence.loadProject("missing")).toBeNull();
    const { id } = await backend.createProject({ name: "A" });
    expect(await backend.hasProject(id)).toBe(true);
    expect(await new LocalBackend({ persistence }).hasProject(id)).toBe(true);
  });

  it("closes a project: drops its cache and undo history and revokes its object URLs", async () => {
    const { backend, revokeObjectUrl } = make();
    const { id } = await backend.createProject({ name: "A" });
    const media = await backend.uploadFile(id, new Blob([new Uint8Array(5)], { type: "video/webm" }), "video");
    await backend.createClips(id, [{ trackType: "text", trackIndex: 1, startTime: 0, endTime: 1 }]);
    expect((await backend.loadTimeline(id)).canUndo).toBe(true);
    backend.closeProject(id);
    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:test/5");
    expect(backend.resolveLocalUrl(media.url)).toBeNull();
    const reopened = await backend.loadTimeline(id);
    expect(reopened.clips).toHaveLength(1);
    expect(reopened.canUndo).toBe(false);
  });

  it("re-seeding a project keeps its uploads and creation time", async () => {
    const { backend, persistence } = make();
    const { id, createdAt } = await backend.createProject({ name: "A" });
    const media = await backend.uploadFile(id, new Blob([new Uint8Array(2)], { type: "image/png" }), "image");
    await backend.seedProject(id, { meta: { name: "Reset" } });
    expect((await backend.listProjects())[0]).toMatchObject({ id, name: "Reset", createdAt });
    await backend.deleteProject(id);
    expect(await persistence.getBlob(media.url.slice(LOCAL_MEDIA_URL_PREFIX.length))).toBeNull();
  });

  it("deletes a project with the media it uploaded", async () => {
    const { backend, persistence, revokeObjectUrl } = make();
    const { id } = await backend.createProject({ name: "A" });
    const media = await backend.uploadFile(id, new Blob([new Uint8Array(5)], { type: "video/webm" }), "video");
    const blobId = media.url.slice(LOCAL_MEDIA_URL_PREFIX.length);
    expect(await persistence.getBlob(blobId)).not.toBeNull();
    await backend.deleteProject(id);
    expect(await backend.hasProject(id)).toBe(false);
    expect(await persistence.getBlob(blobId)).toBeNull();
    expect(backend.resolveLocalUrl(media.url)).toBeNull();
    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:test/5");
    expect(await backend.listProjects()).toEqual([]);
  });

  it("explains when the persistence has no project catalog", async () => {
    const { listProjects: _list, deleteProject: _delete, ...partial } = createMemoryPersistence();
    const backend = new LocalBackend({ persistence: partial });
    await expect(backend.listProjects()).rejects.toThrow("This persistence cannot list projects");
    await expect(backend.deleteProject("p1")).rejects.toThrow("This persistence cannot delete projects");
  });
});

describe("LocalBackend media library", () => {
  it("keeps bin entries in order, replaces by url, and survives a reload", async () => {
    const persistence = createMemoryPersistence();
    const createObjectUrl = (blob: Blob) => `blob:test/${blob.size}`;
    const backend = new LocalBackend({ persistence, idFactory, createObjectUrl });
    const video = await backend.uploadFile("lib", new Blob([new Uint8Array(2)], { type: "video/webm" }), "video");
    const image = await backend.uploadFile("lib", new Blob([new Uint8Array(3)], { type: "image/png" }), "image");
    await backend.saveToLibrary("lib", { ...video, durationSeconds: 6 });
    await backend.saveToLibrary("lib", image);
    await backend.saveToLibrary("lib", { ...video, durationSeconds: 6.5 });
    expect((await backend.listLibrary("lib")).map((m) => [m.url, m.durationSeconds])).toEqual([[image.url, undefined], [video.url, 6.5]]);

    const reloaded = new LocalBackend({ persistence, idFactory, createObjectUrl });
    expect(await reloaded.listLibrary("lib")).toHaveLength(2);
    expect(reloaded.resolveLocalUrl(video.url)).toBe("blob:test/2");
    await reloaded.removeFromLibrary("lib", image.url);
    expect((await reloaded.listLibrary("lib")).map((m) => m.url)).toEqual([video.url]);
  });

  it("does not record library writes as undo steps", async () => {
    const backend = new LocalBackend({ persistence: createMemoryPersistence(), idFactory });
    await backend.createClips("u", [{ trackType: "text", trackIndex: 1, startTime: 0, endTime: 1 }]);
    const media = await backend.uploadFile("u", new Blob([new Uint8Array(1)], { type: "image/png" }), "image");
    await backend.saveToLibrary("u", media);
    expect((await backend.undo("u")).clips).toEqual([]);
    expect(await backend.listLibrary("u")).toHaveLength(1);
  });

  it("reads stored media back as the stored Blob, and nothing for other URLs", async () => {
    const backend = new LocalBackend({ persistence: createMemoryPersistence(), idFactory });
    const file = new Blob([new Uint8Array(4)], { type: "video/webm" });
    const media = await backend.uploadFile("r", file, "video");
    expect(await backend.readMedia(media.url)).toBe(file);
    expect(await backend.readMedia("https://cdn.test/a.mp4")).toBeNull();
  });
  it("snapshots a whole project, uploads and library included, as a copy", async () => {
    const backend = new LocalBackend({ persistence: createMemoryPersistence(), idFactory });
    await backend.createClips("s", [{ trackType: "text", trackIndex: 1, startTime: 0, endTime: 1 }]);
    const media = await backend.uploadFile("s", new Blob([new Uint8Array(2)], { type: "image/png" }), "image");
    await backend.saveToLibrary("s", media);
    const snap = await backend.snapshot("s");
    expect(snap.meta.id).toBe("s");
    expect(snap.clips).toHaveLength(1);
    expect(snap.library?.map((m) => m.url)).toEqual([media.url]);
    expect(snap.uploads).toEqual([media.url.slice(LOCAL_MEDIA_URL_PREFIX.length)]);
    snap.clips[0].startTime = 0.5;
    expect((await backend.loadTimeline("s")).clips[0].startTime).toBe(0);
  });

  it("detaches a project: the document goes, its blobs stay and their ids come back", async () => {
    const persistence = createMemoryPersistence();
    const backend = new LocalBackend({ persistence, idFactory });
    const media = await backend.uploadFile("d", new Blob([new Uint8Array(3)], { type: "image/png" }), "image");
    await backend.createClips("d", [{ trackType: "video", trackIndex: 1, startTime: 0, endTime: 1, mediaType: "image", mediaUrl: media.url }]);
    const blobId = media.url.slice(LOCAL_MEDIA_URL_PREFIX.length);
    expect(await backend.detachProject("d")).toEqual([blobId]);
    expect(await backend.hasProject("d")).toBe(false);
    expect(await persistence.getBlob(blobId)).not.toBeNull();
    expect((await backend.listProjects()).map((p) => p.id)).not.toContain("d");
  });

  it("lists local projects with kind local", async () => {
    const backend = new LocalBackend({ persistence: createMemoryPersistence(), idFactory });
    await backend.createProject({ name: "A" });
    expect((await backend.listProjects())[0].kind).toBe("local");
  });

  it("gives media a seeded project references an object URL", async () => {
    const persistence = createMemoryPersistence();
    await persistence.putBlob("seeded-blob", new Blob([new Uint8Array(2)], { type: "image/png" }));
    const backend = new LocalBackend({ persistence, idFactory, createObjectUrl: () => "blob:test/1", revokeObjectUrl: () => undefined });
    const url = `${LOCAL_MEDIA_URL_PREFIX}seeded-blob`;
    await backend.seedProject("seeded", { clips: [{ ...(await backend.createClips("tmp", [{ trackType: "video", trackIndex: 1, startTime: 0, endTime: 1, mediaType: "image" }]))[0]!, mediaUrl: url }] });
    expect(backend.resolveLocalUrl(url)).toBe("blob:test/1");
  });
});
