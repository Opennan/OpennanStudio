import { createRecordingBackend } from "../testing";
import { LocalBackend } from "../backend/local-backend";
import { createMemoryPersistence } from "../backend/persistence";
import { createEditorStore } from "../store/editor-store";
import { selectLiveScenes } from "../store/live-scenes";
import { TimelineController } from "./timeline-controller";
import { planSourceClipSceneSplit } from "../timeline/scene-split-plan";
import { getSceneStart } from "../timeline/scene-timing";

async function setup(options: { timeoutMs?: number } = {}) {
  let n = 0;
  const local = new LocalBackend({ persistence: createMemoryPersistence(), idFactory: () => `id-${++n}` });
  const recording = createRecordingBackend(local);
  const store = createEditorStore();
  const onToast = vi.fn();
  const controller = new TimelineController({
    backend: recording.backend, store, projectId: "p1", onToast, requestTimeoutMs: options.timeoutMs ?? 1000,
  });
  await controller.load();
  recording.reset();
  return { local, recording, store, onToast, controller };
}

const text = (startTime = 0, endTime = 4) => ({ trackType: "text", trackIndex: 1, startTime, endTime, mediaType: "text", textContent: "Hi" });
const clips = (store: ReturnType<typeof createEditorStore>) => store.getState().timelineData?.clips ?? [];

afterEach(() => vi.useRealTimers());

describe("TimelineController", () => {
  it("loads the project into the store", async () => {
    const { store } = await setup();
    expect(store.getState().timelineData?.tracks.map((t) => `${t.type}${t.index}`)).toEqual(["video1", "audio1"]);
    expect(store.getState().projectMeta?.id).toBe("p1");
    expect(store.getState().serverScenes).toEqual([]);
  });

  it("shows a temp clip immediately, then the server clip, and records history", async () => {
    const { controller, store } = await setup();
    const started = controller.start({ type: "clip.create", input: text() });
    expect(started.optimistic.clipIds[0]).toMatch(/^temp-/);
    expect(clips(store).map((c) => c.id)).toEqual(started.optimistic.clipIds);
    const result = await started.settled;
    expect(result).toMatchObject({ ok: true, createdClipIds: ["id-1"] });
    expect(clips(store).map((c) => c.id)).toEqual(["id-1"]);
    expect(store.getState().canUndo).toBe(true);
  });

  it("rolls back and toasts when the backend rejects", async () => {
    const { controller, store, recording, onToast } = await setup();
    recording.failNext("createClips");
    const result = await controller.execute({ type: "clip.create", input: text() });
    expect(result.ok).toBe(false);
    expect(clips(store)).toEqual([]);
    expect(onToast).toHaveBeenCalledWith({ kind: "error", message: "Failed to create clip" });
    expect(store.getState().canUndo).toBe(false);
  });

  it("tracks active saves while a request is in flight", async () => {
    const { controller, store, recording } = await setup();
    await controller.execute({ type: "clip.create", input: text() });
    const release = recording.hold("updateClips");
    const settled = controller.execute({ type: "clip.update", clipIds: ["id-1"], patch: { positionX: 0.1 } });
    expect(clips(store)[0].positionX).toBe(0.1);
    await Promise.resolve();
    expect(store.getState().activeTimelineSaves).toBe(1);
    release();
    await settled;
    expect(store.getState().activeTimelineSaves).toBe(0);
  });

  it("retries an idempotent request once after a timeout", async () => {
    const { controller, recording } = await setup({ timeoutMs: 100 });
    await controller.execute({ type: "clip.create", input: text() });
    vi.useFakeTimers();
    recording.hold("updateClips");
    const settled = controller.execute({ type: "clip.update", clipIds: ["id-1"], patch: { opacity: 0.5 } });
    await vi.advanceTimersByTimeAsync(100);
    const result = await settled;
    expect(result.ok).toBe(true);
    expect(recording.callsTo("updateClips")).toHaveLength(2);
  });

  it("does not retry a create after a timeout and rolls it back", async () => {
    const { controller, recording, store } = await setup({ timeoutMs: 100 });
    vi.useFakeTimers();
    recording.hold("createClips");
    const settled = controller.execute({ type: "clip.create", input: text() });
    await vi.advanceTimersByTimeAsync(100);
    expect((await settled).ok).toBe(false);
    expect(recording.callsTo("createClips")).toHaveLength(1);
    expect(clips(store)).toEqual([]);
  });

  it("debounces coalesced scene moves: latest wins, earlier ones are superseded", async () => {
    const { controller, recording, store, local } = await setup();
    const scene = await local.addScene("p1", { afterOrder: -1, duration: 5, timelinePositionSeconds: 0.001 });
    await controller.load();
    recording.reset();
    vi.useFakeTimers();
    const first = controller.execute({ type: "scene.move", moves: [{ sceneId: scene.id, timelinePositionSeconds: 2 }] }, { coalesceKey: `scene:${scene.id}`, debounceMs: 500 });
    const second = controller.execute({ type: "scene.move", moves: [{ sceneId: scene.id, timelinePositionSeconds: 3 }] }, { coalesceKey: `scene:${scene.id}`, debounceMs: 500 });
    expect(selectLiveScenes(store.getState())[0].timelinePositionSeconds).toBe(3);
    expect(await first).toMatchObject({ ok: false, superseded: true });
    await vi.advanceTimersByTimeAsync(500);
    expect(await second).toMatchObject({ ok: true });
    expect(recording.callsTo("moveScenes")).toHaveLength(1);
    expect(store.getState().serverScenes[0].timelinePositionSeconds).toBe(3);
  });

  it("cancels pending debounced saves and rolls back when the tab hides", async () => {
    const { controller, recording, store, local } = await setup();
    const scene = await local.addScene("p1", { afterOrder: -1, duration: 5, timelinePositionSeconds: 0.001 });
    await controller.load();
    recording.reset();
    vi.useFakeTimers();
    const pending = controller.execute({ type: "scene.move", moves: [{ sceneId: scene.id, timelinePositionSeconds: 4 }] }, { coalesceKey: "m", debounceMs: 500 });
    controller.setActive(false);
    expect(await pending).toMatchObject({ ok: false, cancelled: true });
    await vi.advanceTimersByTimeAsync(1000);
    expect(recording.callsTo("moveScenes")).toHaveLength(0);
    expect(selectLiveScenes(store.getState())[0].timelinePositionSeconds).toBe(0.001);
  });

  it("undoes locally first, then once on the backend with summed steps", async () => {
    const { controller, recording, store, local } = await setup();
    const scene = await local.addScene("p1", { afterOrder: -1, duration: 5, timelinePositionSeconds: 0.001 });
    await controller.execute({ type: "clip.create", input: text(6, 8) });
    await controller.load();
    recording.reset();
    await controller.execute({
      type: "scene.trim", sceneId: scene.id, mode: "duration", duration: 3, timelinePositionSeconds: 1,
      ripple: { moves: [], clipUpdates: [{ clipId: clips(store)[0].id, startTime: 4, endTime: 6 }] },
    });
    const release = recording.hold("undo");
    const undo = controller.execute({ type: "history.undo" });
    expect(clips(store)[0].startTime).toBe(6);
    release();
    expect((await undo).ok).toBe(true);
    expect(recording.callsTo("undo")[0].args).toEqual(["p1", 3]);
    expect(store.getState().canRedo).toBe(true);
    await controller.execute({ type: "history.redo" });
    expect(clips(store)[0].startTime).toBe(4);
  });

  it("keeps recordHistory:false writes out of the backend undo steps", async () => {
    const { controller, recording, store } = await setup();
    await controller.execute({ type: "clip.create", input: text() });
    await controller.execute({ type: "clip.update", clipIds: ["id-1"], patch: { positionX: 0.2 } });
    // A preview drag (editor-layout.tsx:3923 silentUndo) after a recorded edit.
    await controller.execute({ type: "clip.update", clipIds: ["id-1"], patch: { opacity: 0.4 } }, { recordHistory: false });
    expect(recording.callsTo("updateClips").map((call) => call.silent ?? false)).toEqual([false, true]);
    await controller.execute({ type: "history.undo" });
    expect(recording.callsTo("undo")[0].args).toEqual(["p1", 1]);
    // The backend popped the recorded edit, not the silent write, and the store took its answer.
    expect(clips(store)[0].positionX).toBe(0.5);
  });

  it("deletes a clip that is still being created once its create settles", async () => {
    const { controller, recording, store } = await setup();
    const release = recording.hold("createClips");
    const started = controller.start({ type: "clip.create", input: text() });
    const deleted = controller.execute({ type: "clip.delete", clipIds: started.optimistic.clipIds });
    release();
    expect(await deleted).toMatchObject({ ok: true });
    expect(recording.callsTo("deleteClips")[0].args).toEqual(["p1", ["id-1"]]);
    expect(clips(store)).toEqual([]);
  });

  it("describes the timeline as text for agents", async () => {
    const { controller, local } = await setup();
    await local.addScene("p1", { afterOrder: -1, duration: 5, timelinePositionSeconds: 0.001, caption: "Intro" });
    await controller.load();
    await controller.execute({ type: "clip.create", input: text(1, 3) });
    const summary = controller.describeTimeline();
    expect(summary).toContain("Scenes (1):");
    expect(summary).toContain('"Intro"');
    expect(summary).toContain("Clips (1):");
    expect(summary).toContain("text1 1s-3s");
  });

  it("restores state and toasts when the backend undo fails", async () => {
    const { controller, recording, store, onToast } = await setup();
    await controller.execute({ type: "clip.create", input: text() });
    recording.failNext("undo");
    const result = await controller.execute({ type: "history.undo" });
    expect(result.ok).toBe(false);
    expect(clips(store)).toHaveLength(1);
    expect(store.getState().canUndo).toBe(true);
    expect(onToast).toHaveBeenCalledWith({ kind: "error", message: "Undo failed" });
  });

  it("applies an optimistic scene split and commits it to the server id", async () => {
    const { controller, store, local } = await setup();
    const scene = await local.addScene("p1", { afterOrder: -1, cardType: "source_clip", videoUrl: "v.mp4", duration: 6, timelinePositionSeconds: 0.001 });
    await controller.load();
    const settled = controller.execute({
      type: "scene.split", sceneId: scene.id, atSeconds: 2,
      optimistic: { sourceSceneId: scene.id, tempSceneId: "optimistic-scene-1", firstScene: { duration: 2 }, secondScene: { ...scene, id: "optimistic-scene-1", duration: 4 }, splitTime: 2 },
    });
    expect(selectLiveScenes(store.getState()).map((s) => s.id)).toContain("optimistic-scene-1");
    expect(store.getState().selectedSceneId).toBe("optimistic-scene-1");
    const result = await settled;
    expect(result.createdSceneIds).toHaveLength(1);
    expect(store.getState().selectedSceneId).toBe(result.createdSceneIds![0]);
    expect(selectLiveScenes(store.getState()).map((s) => s.id)).toEqual([scene.id, result.createdSceneIds![0]]);
  });

  it("keeps later scenes in place after a scene split", async () => {
    const { controller, store, local } = await setup();
    const a = await local.addScene("p1", { afterOrder: -1, cardType: "source_clip", videoUrl: "a.mp4", duration: 4 });
    const b = await local.addScene("p1", { afterOrder: 0, duration: 6 });
    const c = await local.addScene("p1", { afterOrder: 1, duration: 5 });
    await controller.load();
    const plan = planSourceClipSceneSplit(selectLiveScenes(store.getState()), a.id, 2, { tempSceneId: "optimistic-scene-a", fallbackCaption: "" });
    const result = await controller.execute({ type: "scene.split", sceneId: a.id, atSeconds: 2, optimistic: plan! });
    const scenes = selectLiveScenes(store.getState());
    expect(scenes.map((s) => s.id)).toEqual([a.id, result.createdSceneIds![0], b.id, c.id]);
    expect(scenes.map((s, i) => getSceneStart(s, scenes, i))).toEqual([0, 2, 4, 10]);
    expect(new Set(scenes.map((s) => s.order)).size).toBe(4);
  });

  it("keeps the store's scene list equal to the backend's after scene commands", async () => {
    const { controller, store, local } = await setup();
    const a = await local.addScene("p1", { afterOrder: -1, duration: 4 });
    const b = await local.addScene("p1", { afterOrder: 0, duration: 6 });
    await local.addScene("p1", { afterOrder: 1, duration: 5 });
    await controller.load();
    const live = () => selectLiveScenes(store.getState());
    const inSync = async () => {
      expect(live().map((s) => `${s.id}#${s.order}`)).toEqual((await local.loadScenes("p1")).map((s) => `${s.id}#${s.order}`));
      expect(new Set(live().map((s) => s.order)).size).toBe(live().length);
    };
    await controller.execute({ type: "scene.duplicate", sceneId: a.id });
    await inSync();
    await controller.execute({ type: "scene.add", input: { afterOrder: 0, duration: 2 } });
    await inSync();
    await controller.execute({ type: "scene.delete", sceneId: b.id });
    await inSync();
    const reversed = [...live()].sort((x, y) => x.order - y.order).map((s) => s.id).reverse();
    await controller.execute({ type: "scene.reorder", sceneIds: reversed });
    await inSync();
    expect(live().map((s) => s.id)).toEqual(reversed);
  });

  it("reports history depth with a running count of recorded entries", async () => {
    const { controller } = await setup();
    expect(controller.historyDepth()).toEqual({ undo: 0, redo: 0, recorded: 0, limit: 50 });
    await controller.execute({ type: "clip.create", input: text() });
    await controller.execute({ type: "clip.create", input: text(5, 8) });
    await controller.execute({ type: "history.undo" });
    expect(controller.historyDepth()).toEqual({ undo: 1, redo: 1, recorded: 2, limit: 50 });
  });

  it("runs store-only commands without backend calls", async () => {
    const { controller, recording, store } = await setup();
    await controller.execute({ type: "playhead.seek", seconds: 4 });
    await controller.execute({ type: "selection.set", clipIds: ["x"] });
    await controller.execute({ type: "view.update", zoom: 80, tool: "blade", snap: false });
    const s = store.getState();
    expect([s.currentTime, s.seekRequest, s.shuttleSpeed]).toEqual([4, 4, 0]);
    expect([...s.selectedClipIds]).toEqual(["x"]);
    expect([s.timelineZoom, s.toolMode, s.snapEnabled]).toEqual([80, "blade", false]);
    expect(recording.calls).toEqual([]);
  });

  it("reports unavailable capabilities and invalid edits without toasts", async () => {
    const { controller, onToast, recording } = await setup();
    expect(await controller.execute({ type: "shot.merge", input: { sourceSceneId: "a", shotIndex: 0, targetSceneId: "b" } })).toMatchObject({ ok: false, unavailable: true });
    expect(await controller.execute({ type: "ai.run", capability: "video.text-to-video", input: {} })).toMatchObject({ ok: false, unavailable: true });
    expect(await controller.execute({ type: "clip.split", clipIds: ["missing"], atSeconds: 1 })).toMatchObject({ ok: false });
    expect(onToast).not.toHaveBeenCalled();
    expect(recording.calls).toEqual([]);
  });

  it("does not count project.update as a backend undo step", async () => {
    const { controller, recording, store } = await setup();
    await controller.execute({ type: "clip.create", input: text() });
    await controller.execute({ type: "project.update", patch: { aspectRatio: "9:16" } });
    await controller.execute({ type: "history.undo" });
    expect(recording.callsTo("undo")[0].args).toEqual(["p1", 1]);
    expect(clips(store)).toEqual([]);
    expect(store.getState().projectMeta?.aspectRatio).toBe("9:16");
  });
});

describe("overlapping saves on one item (phase 10c review)", () => {
    it("a slow earlier save does not undo a newer optimistic edit when it returns", async () => {
        const { local, store, controller } = await setup();
        await controller.execute({ type: "clip.create", input: text() });
        const id = store.getState().timelineData!.clips[0].id;
        // The first save is held until the second edit has been made.
        let release: () => void = () => undefined;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const updateClips = local.updateClips.bind(local);
        let calls = 0;
        // The backend applies the first save at once but its answer arrives late (stale by then).
        local.updateClips = async (...args: Parameters<typeof local.updateClips>) => {
            calls += 1;
            const answer = await updateClips(...args);
            if (calls === 1) await gate;
            return answer;
        };
        const first = controller.execute({ type: "clip.update", clipIds: [id], patch: { positionX: 0.2 } }, { coalesceKey: "x", debounceMs: 5 });
        await vi.waitFor(() => expect(calls).toBe(1));
        // A second edit of another field, prepared from the optimistic state (x = 0.2), saved under another key.
        const second = controller.execute({ type: "clip.update", clipIds: [id], patch: { positionY: 0.7 } }, { coalesceKey: "y", debounceMs: 5 });
        await vi.waitFor(() => expect(calls).toBe(2));
        await second;
        release();
        await first;
        const clip = store.getState().timelineData!.clips.find((c) => c.id === id)!;
        expect([clip.positionX, clip.positionY]).toEqual([0.2, 0.7]);
    });
});

describe("TimelineController.recordExternalStep (phase 9b: an AI turn is one undo step)", () => {
  async function external(local: LocalBackend, store: ReturnType<typeof createEditorStore>, patch: { clipId: string; textContent: string }) {
    const before = { tracks: store.getState().timelineData!.tracks, clips: store.getState().timelineData!.clips, scenes: selectLiveScenes(store.getState()) };
    // Another writer (the server's director, arriving through sync) changes the backend: one backend history step.
    await local.updateClips("p1", [patch]);
    const after = { tracks: before.tracks, clips: (await local.loadTimeline("p1")).clips, scenes: before.scenes };
    return { before, after };
  }

  it("records the step after the change landed; undo takes it back, redo brings it again", async () => {
    const { controller, store, local } = await setup();
    await controller.execute({ type: "clip.create", input: text() });
    expect(await controller.recordExternalStep(() => external(local, store, { clipId: "id-1", textContent: "From the AI" }))).toBe(true);
    expect(clips(store)[0].textContent).toBe("From the AI");
    expect(controller.historyDepth().undo).toBe(2);
    await controller.execute({ type: "history.undo" });
    expect(clips(store)[0].textContent).toBe("Hi");
    expect((await local.loadTimeline("p1")).clips[0].textContent).toBe("Hi");
    await controller.execute({ type: "history.redo" });
    expect(clips(store)[0].textContent).toBe("From the AI");
    // The person's own clip is the step before it.
    await controller.execute({ type: "history.undo", steps: 2 });
    expect(clips(store)).toEqual([]);
  });

  it("waits for writes in flight so both histories keep the same order", async () => {
    const { controller, store, local, recording } = await setup();
    await controller.execute({ type: "clip.create", input: text() });
    const release = recording.hold("updateClips");
    const edit = controller.execute({ type: "clip.update", clipIds: ["id-1"], patch: { opacity: 0.5 } });
    let recorded = false;
    const step = controller.recordExternalStep(async () => {
      recorded = true;
      return external(local, store, { clipId: "id-1", textContent: "AI" });
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(recorded).toBe(false);
    release();
    await edit;
    expect(await step).toBe(true);
    await controller.execute({ type: "history.undo" });
    expect(clips(store)[0]).toMatchObject({ textContent: "Hi", opacity: 0.5 });
  });

  it("a step that changes nothing on screen has no undo of its own (it joins the newest entry)", async () => {
    const { controller, store } = await setup();
    await controller.execute({ type: "clip.create", input: text() });
    const same = { tracks: store.getState().timelineData!.tracks, clips: store.getState().timelineData!.clips, scenes: [] };
    expect(await controller.recordExternalStep(async () => ({ before: same, after: same }))).toBe(false);
    expect(controller.historyDepth().undo).toBe(1);
  });

  it("records nothing when the backend has nothing to record", async () => {
    const { controller } = await setup();
    expect(await controller.recordExternalStep(async () => null)).toBe(false);
    expect(controller.historyDepth().undo).toBe(0);
  });
});
