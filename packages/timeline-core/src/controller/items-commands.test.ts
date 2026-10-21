// Multi-item selection and batch commands (phase 10c): every command is one undo entry for all its items.
import { LocalBackend } from "../backend/local-backend";
import { createMemoryPersistence } from "../backend/persistence";
import { createEditorStore } from "../store/editor-store";
import { selectLiveScenes } from "../store/live-scenes";
import { createRecordingBackend } from "../testing";
import { getSceneDuration, getSceneStart } from "../timeline/scene-timing";
import { TimelineController } from "./timeline-controller";
import { copyItemsToClipboard, transformDeltaPatch, type TransformDelta } from "./items-plan";

async function setup() {
    let n = 0;
    const local = new LocalBackend({ persistence: createMemoryPersistence(), idFactory: () => `id-${++n}` });
    const recording = createRecordingBackend(local);
    const store = createEditorStore();
    const onToast = vi.fn();
    const controller = new TimelineController({ backend: recording.backend, store, projectId: "p1", onToast, requestTimeoutMs: 1000 });
    await controller.load();
    const add = (at: number, duration: number, order: number, trackIndex = 1) => controller.execute({
        type: "scene.add", input: { afterOrder: order, cardType: "source_clip", sourceVideoUrl: "s.mp4", trackIndex, timelinePositionSeconds: at, duration },
    });
    await add(0.001, 4, -1);
    await add(4.001, 3, 0);
    await add(7.001, 2, 1);
    await controller.execute({
        type: "clip.create",
        input: [
            { trackType: "video", trackIndex: 2, startTime: 0, endTime: 2, mediaType: "video", mediaUrl: "a.mp4" },
            { trackType: "text", trackIndex: 1, startTime: 1, endTime: 3, mediaType: "text", textContent: "Hi" },
            { trackType: "audio", trackIndex: 1, startTime: 0, endTime: 5, mediaType: "audio", mediaUrl: "m.mp3" },
        ],
    });
    recording.reset();
    const scenes = () => selectLiveScenes(store.getState());
    const clips = () => store.getState().timelineData?.clips ?? [];
    const [video, text, audio] = clips();
    return { local, recording, store, controller, onToast, scenes, clips, video, text, audio };
}

const ids = (items: Array<{ id: string }>) => items.map((item) => item.id);

/** Locks video track `index` (the scenes sit on V1), adding it to the track list when it is missing. */
async function lockVideoTrack(controller: TimelineController, store: ReturnType<typeof createEditorStore>, index: number) {
    const tracks = store.getState().timelineData!.tracks;
    const has = tracks.some((t) => t.type === "video" && t.index === index);
    const next = has
        ? tracks.map((t) => (t.type === "video" && t.index === index ? { ...t, locked: true } : t))
        : [...tracks, { type: "video" as const, index, label: `V${index}`, muted: false, locked: true, visible: true, volume: 1 }];
    const result = await controller.execute({ type: "track.update", tracks: next });
    expect(result.ok).toBe(true);
}

describe("selection.set with scenes", () => {
    it("selects clips and scenes together and reports them in the snapshot", async () => {
        const { controller, store, scenes, video } = await setup();
        const [a, b] = scenes();
        await controller.execute({ type: "selection.set", clipIds: [video.id], sceneIds: [a.id, b.id] });
        expect([...store.getState().selectedSceneIds]).toEqual([a.id, b.id]);
        expect(store.getState().selectedClipId).toBe(video.id);
        expect(controller.snapshot().selection).toMatchObject({ clipIds: [video.id], sceneIds: [a.id, b.id], sceneId: null });
        await controller.execute({ type: "selection.set", sceneIds: [] });
        expect(controller.snapshot().selection).toMatchObject({ clipIds: [], sceneIds: [] });
    });
});

describe("items.delete", () => {
    it("deletes clips and scenes in one undo step and undo restores all of them", async () => {
        const { controller, local, scenes, clips, video, text } = await setup();
        const [a, , c] = scenes();
        const result = await controller.execute({ type: "items.delete", clipIds: [video.id, text.id], sceneIds: [a.id, c.id] });
        expect(result.ok).toBe(true);
        expect(clips().map((clip) => clip.trackType)).toEqual(["audio"]);
        expect(scenes()).toHaveLength(1);
        expect((await local.loadScenes("p1"))).toHaveLength(1);
        expect(controller.historyDepth().undo).toBe(5);
        await controller.execute({ type: "history.undo" });
        expect(clips()).toHaveLength(3);
        expect(ids(scenes()).sort()).toEqual([a.id, c.id, scenes()[1].id].sort());
        expect((await local.loadScenes("p1"))).toHaveLength(3);
        expect((await local.loadTimeline("p1")).clips).toHaveLength(3);
        await controller.execute({ type: "history.redo" });
        expect(clips()).toHaveLength(1);
        expect(scenes()).toHaveLength(1);
    });

    it("skips items on locked tracks and fails when nothing is left", async () => {
        const { controller, clips, video, text } = await setup();
        await controller.execute({ type: "clip.update", clipIds: [text.id], patch: { locked: true } });
        await controller.execute({ type: "items.delete", clipIds: [video.id, text.id], sceneIds: [] });
        expect(ids(clips())).toContain(text.id);
        expect(ids(clips())).not.toContain(video.id);
        expect((await controller.execute({ type: "items.delete", clipIds: [text.id] })).ok).toBe(false);
    });

    it("rolls the store back when a delete fails", async () => {
        const { controller, recording, scenes, clips, video } = await setup();
        const [a, b] = scenes();
        recording.failNext("deleteScene");
        const result = await controller.execute({ type: "items.delete", clipIds: [video.id], sceneIds: [a.id, b.id] });
        expect(result.ok).toBe(false);
        expect(clips()).toHaveLength(3);
        expect(scenes()).toHaveLength(3);
    });
});

describe("items.duplicate", () => {
    it("copies clips and scenes after the selection, keeping their relative timing, in one undo step", async () => {
        const { controller, scenes, clips, video, text } = await setup();
        const [, b] = scenes();
        // Selection spans 0..7 (video 0-2, text 1-3, scene b 4.001-7.001); the copies start at 7.001... but scene c
        // sits at 7.001-9.001 on V1, so the group moves on until the scene copy no longer overlaps it.
        const result = await controller.execute({ type: "items.duplicate", clipIds: [video.id, text.id], sceneIds: [b.id] });
        expect(result.ok).toBe(true);
        expect(result.createdClipIds).toHaveLength(2);
        expect(result.createdSceneIds).toHaveLength(1);
        const copy = scenes().find((s) => s.id === result.createdSceneIds![0])!;
        const all = scenes();
        const copyStart = getSceneStart(copy, all, all.indexOf(copy));
        const offset = copyStart - 4.001;
        expect(copyStart).toBeGreaterThanOrEqual(9.001 - 1e-6);
        const created = clips().filter((clip) => result.createdClipIds!.includes(clip.id));
        expect(created.map((clip) => clip.startTime).sort((x, y) => x - y)).toEqual([0 + offset, 1 + offset].map((x) => expect.closeTo(x, 3)));
        expect(getSceneDuration(copy)).toBeCloseTo(3, 3);
        await controller.execute({ type: "history.undo" });
        expect(clips()).toHaveLength(3);
        expect(scenes()).toHaveLength(3);
    });

    it("places the group at `at` when given", async () => {
        const { controller, clips, video, text } = await setup();
        const result = await controller.execute({ type: "items.duplicate", clipIds: [video.id, text.id], at: 20 });
        const created = clips().filter((clip) => result.createdClipIds!.includes(clip.id));
        expect(created.map((clip) => clip.startTime).sort((x, y) => x - y)).toEqual([20, 21]);
    });
});

describe("copy and paste of clips and scenes", () => {
    it("copies clips and scenes with shared offsets and pastes them in one undo step", async () => {
        const { controller, store, scenes, clips, video } = await setup();
        const [, b] = scenes();
        const state = { clips: clips(), scenes: scenes(), tracks: store.getState().timelineData!.tracks };
        const clipboard = copyItemsToClipboard(state, [video.id], [b.id])!;
        expect(clipboard.groupDuration).toBeCloseTo(7.001, 3);
        expect(clipboard.clips.map((c) => c.offsetStart)).toEqual([0]);
        expect(clipboard.scenes).toEqual([{ sceneId: b.id, offsetStart: 4.001, duration: 3, trackIndex: 1 }]);
        const result = await controller.execute({ type: "items.paste", clipboard, at: 20 });
        expect(result.ok).toBe(true);
        const pasted = clips().find((c) => c.id === result.createdClipIds![0])!;
        expect(pasted.startTime).toBe(20);
        const copy = scenes().find((s) => s.id === result.createdSceneIds![0])!;
        expect(copy.timelinePositionSeconds).toBeCloseTo(24.001, 3);
        expect([...store.getState().selectedSceneIds]).toEqual([copy.id]);
        await controller.execute({ type: "history.undo" });
        expect(clips()).toHaveLength(3);
        expect(scenes()).toHaveLength(3);
    });

    it("skips scene copies onto a locked track and still pastes the clips", async () => {
        const { controller, store, scenes, clips, video } = await setup();
        const [, b] = scenes();
        const clipboard = copyItemsToClipboard({ clips: clips(), scenes: scenes(), tracks: store.getState().timelineData!.tracks }, [video.id], [b.id])!;
        await lockVideoTrack(controller, store, 1);
        const result = await controller.execute({ type: "items.paste", clipboard, at: 20 });
        expect(result.ok).toBe(true);
        expect(result.createdSceneIds ?? []).toEqual([]);
        expect(result.createdClipIds).toHaveLength(1);
        expect(scenes()).toHaveLength(3);
    });

    it("skips scenes deleted since the copy", async () => {
        const { controller, store, scenes, clips, video } = await setup();
        const [a] = scenes();
        const clipboard = copyItemsToClipboard({ clips: clips(), scenes: scenes(), tracks: store.getState().timelineData!.tracks }, [video.id], [a.id])!;
        await controller.execute({ type: "items.delete", sceneIds: [a.id] });
        const result = await controller.execute({ type: "items.paste", clipboard, at: 30 });
        expect(result.createdSceneIds ?? []).toEqual([]);
        expect(result.createdClipIds).toHaveLength(1);
    });
});

describe("items.transform", () => {
    it("patches clips and scenes in one undo step", async () => {
        const { controller, local, scenes, clips, video } = await setup();
        const [a] = scenes();
        const result = await controller.execute({
            type: "items.transform",
            clips: [{ id: video.id, patch: { positionX: 0.2, scale: 1.5, rotationDegrees: 30 } }],
            scenes: [{ id: a.id, patch: { transformOffsetX: 10, transformScale: 0.5, rotationDegrees: -15 } }],
        });
        expect(result.ok).toBe(true);
        expect(clips().find((c) => c.id === video.id)).toMatchObject({ positionX: 0.2, scale: 1.5, rotationDegrees: 30 });
        expect(scenes()[0]).toMatchObject({ transformOffsetX: 10, transformScale: 0.5, rotationDegrees: -15 });
        expect((await local.loadScenes("p1"))[0].transformScale).toBe(0.5);
        await controller.execute({ type: "history.undo" });
        expect(clips().find((c) => c.id === video.id)?.positionX ?? 0.5).toBe(0.5);
        expect(scenes()[0].transformScale ?? 1).toBe(1);
        expect((await local.loadScenes("p1"))[0].transformScale ?? 1).toBe(1);
        expect((await local.loadTimeline("p1")).clips.find((c) => c.id === video.id)?.positionX ?? 0.5).toBe(0.5);
    });

    it("writes keyframes at the given item time next to static fields", async () => {
        const { controller, scenes, clips, video } = await setup();
        const [a] = scenes();
        await controller.execute({ type: "keyframe.set", clipId: video.id, time: 0, values: { position_x: 0.1, position_y: 0.1 } });
        await controller.execute({
            type: "items.transform",
            clips: [{ id: video.id, patch: { scale: 2 }, keyframe: { time: 1, values: { position_x: 0.8, position_y: 0.4 } } }],
            scenes: [{ id: a.id, keyframe: { time: 2, values: { rotation_degrees: 45 } } }],
        });
        const clip = clips().find((c) => c.id === video.id)!;
        expect(clip.scale).toBe(2);
        expect(JSON.parse(clip.keyframesJson!).keyframes).toEqual(expect.arrayContaining([expect.objectContaining({ time: 1, position_x: 0.8, position_y: 0.4 })]));
        expect(JSON.parse(scenes()[0].keyframesJson!).keyframes).toEqual([expect.objectContaining({ time: 2, rotation_degrees: 45 })]);
    });

    it("rolls back the store and takes back the clip write when the scene write fails", async () => {
        const { controller, recording, local, scenes, clips, video } = await setup();
        const [a] = scenes();
        recording.failNext("updateScenes");
        const result = await controller.execute({
            type: "items.transform",
            clips: [{ id: video.id, patch: { positionX: 0.9 } }],
            scenes: [{ id: a.id, patch: { transformOffsetX: 40 } }],
        });
        expect(result.ok).toBe(false);
        expect(clips().find((c) => c.id === video.id)?.positionX ?? 0.5).toBe(0.5);
        expect(scenes()[0].transformOffsetX ?? 0).toBe(0);
        expect((await local.loadTimeline("p1")).clips.find((c) => c.id === video.id)?.positionX ?? 0.5).toBe(0.5);
    });

    it("needs at least one item", async () => {
        const { controller } = await setup();
        expect((await controller.execute({ type: "items.transform", clips: [], scenes: [] })).ok).toBe(false);
    });

    // Phase 10d: items not visible at the playhead follow a group gesture (transformDeltaPatch): the same move, scale,
    // and rotation about the group centre, on their own base values and on every keyframe of the channels it touches,
    // written by items.transform as absolute fields and whole keyframes (keyframesJson).
    const follow = (item: { id: string }, kind: "clip" | "scene", delta: TransformDelta) => {
        const plan = transformDeltaPatch(item as never, kind, delta);
        if (!plan.ok || !plan.value) throw new Error(plan.ok ? "no change" : plan.error);
        return { id: item.id, ...plan.value } as never;
    };

    it("a follower's move shifts its base position and every position keyframe by the same frame fractions (one undo step)", async () => {
        const { controller, scenes, clips, text } = await setup();
        await controller.execute({ type: "keyframe.set", clipId: text.id, time: 0, values: { position_x: 0.2, position_y: 0.3 }, easing: "ease_in" });
        await controller.execute({ type: "keyframe.set", clipId: text.id, time: 1, values: { position_x: 0.6, position_y: 0.3, scale: 2 } });
        const before = clips().find((c) => c.id === text.id)!;
        const easingBefore = JSON.parse(before.keyframesJson!).keyframes[0].easing;
        expect(easingBefore).toBeDefined();
        const [, b] = scenes();
        const result = await controller.execute({
            type: "items.transform",
            clips: [follow(before, "clip", { dx: 0.1, dy: -0.05 })],
            scenes: [follow(b, "scene", { dx: 0.1, dy: -0.05 })],
        });
        expect(result.ok).toBe(true);
        const moved = clips().find((c) => c.id === text.id)!;
        expect(moved).toMatchObject({ positionX: 0.6, positionY: 0.45 });
        const points = JSON.parse(moved.keyframesJson!).keyframes;
        expect(points.map((p: Record<string, number>) => [p.time, p.position_x, p.position_y, p.scale])).toEqual([[0, 0.3, 0.25, undefined], [1, 0.7, 0.25, 2]]);
        expect(points[0].easing).toBe(easingBefore);
        // Scenes: offsets in percent of the frame.
        expect(scenes()[1]).toMatchObject({ transformOffsetX: 10, transformOffsetY: -5 });
        await controller.execute({ type: "history.undo" });
        expect(clips().find((c) => c.id === text.id)).toMatchObject({ positionX: 0.5, positionY: 0.5 });
        expect(JSON.parse(clips().find((c) => c.id === text.id)!.keyframesJson!).keyframes[0]).toMatchObject({ position_x: 0.2, position_y: 0.3 });
        expect(scenes()[1].transformOffsetX ?? 0).toBe(0);
    });

    it("a follower scales and turns about the group centre: positions map through the similarity, scale and rotation follow", () => {
        const text = { id: "t", positionX: 0.75, positionY: 0.5, scale: 1, rotationDegrees: 5, keyframesJson: null };
        const scaled = transformDeltaPatch(text as never, "clip", { scale: 2, center: { x: 0.5, y: 0.5 }, aspect: 16 / 9 });
        expect(scaled.ok && scaled.value).toEqual({ patch: { positionX: 1, positionY: 0.5, scale: 2 } });
        // A keyed scale doubles with the static one; rotation keys stay (the scale gesture does not turn).
        const keyed = { id: "v", positionX: 0.5, positionY: 0.5, scale: 1, rotationDegrees: 0, keyframesJson: JSON.stringify({ keyframes: [{ time: 0, scale: 0.5, rotation_degrees: 10 }] }) };
        const keyedScaled = transformDeltaPatch(keyed as never, "clip", { scale: 2, center: { x: 0.5, y: 0.5 } });
        expect(keyedScaled.ok && keyedScaled.value).toEqual({ patch: { positionX: 0.5, positionY: 0.5, scale: 2 }, keyframesJson: JSON.stringify({ keyframes: [{ time: 0, scale: 1, rotation_degrees: 10 }] }) });
        // 90° clockwise about the centre of a 16:9 frame: 0.25 of the width right of the centre (480 px of 1920) lands
        // 480 px below it (480 / 1080 of the height).
        const turned = transformDeltaPatch(text as never, "clip", { rotation: 90, center: { x: 0.5, y: 0.5 }, aspect: 16 / 9 });
        const patch = (turned.ok && turned.value!.patch) as Record<string, number>;
        expect(patch.positionX).toBeCloseTo(0.5, 6);
        expect(patch.positionY).toBeCloseTo(0.5 + 480 / 1080, 6);
        expect(patch.rotationDegrees).toBe(95);
        // A centred scene turns in place; its offsets are percent of the frame.
        const scene = { id: "s", transformOffsetX: 0, transformOffsetY: 0, transformScale: 1, rotationDegrees: 0 };
        const sceneTurn = transformDeltaPatch(scene as never, "scene", { rotation: 90, center: { x: 0.5, y: 0.5 } });
        expect(sceneTurn.ok && sceneTurn.value).toEqual({ patch: { transformOffsetX: 0, transformOffsetY: 0, rotationDegrees: 90 } });
        const sceneMove = transformDeltaPatch({ ...scene, keyframesJson: JSON.stringify({ keyframes: [{ time: 1, position_x: 10 }] }) } as never, "scene", { dx: 0.25 });
        expect(sceneMove.ok && sceneMove.value).toEqual({ patch: { transformOffsetX: 25, transformOffsetY: 0 }, keyframesJson: JSON.stringify({ keyframes: [{ time: 1, position_x: 35 }] }) });
        // Nothing to do, or bad numbers.
        expect(transformDeltaPatch(text as never, "clip", {})).toEqual({ ok: true, value: null });
        expect(transformDeltaPatch(text as never, "clip", { dx: Number.NaN }).ok).toBe(false);
        expect(transformDeltaPatch(text as never, "clip", { scale: 0 }).ok).toBe(false);
    });

    it("keyframesJson replaces an item's keyframes (normalized); refused with a keyframe or when it is not JSON", async () => {
        const { controller, clips, text } = await setup();
        const json = JSON.stringify({ keyframes: [{ time: 1, position_x: 0.4 }, { time: 0, position_x: 0.1 }] });
        expect((await controller.execute({ type: "items.transform", clips: [{ id: text.id, keyframesJson: json }] })).ok).toBe(true);
        expect(JSON.parse(clips().find((c) => c.id === text.id)!.keyframesJson!).keyframes.map((p: { time: number }) => p.time)).toEqual([0, 1]);
        expect((await controller.execute({ type: "items.transform", clips: [{ id: text.id, keyframesJson: null }] })).ok).toBe(true);
        expect(clips().find((c) => c.id === text.id)!.keyframesJson ?? null).toBeNull();
        expect((await controller.execute({ type: "items.transform", clips: [{ id: text.id, keyframesJson: json, keyframe: { time: 0, values: { scale: 2 } } }] })).ok).toBe(false);
        expect((await controller.execute({ type: "items.transform", clips: [{ id: text.id, keyframesJson: "{oops" }] })).ok).toBe(false);
    });
});

describe("group apply with targets", () => {
    it("look.set applies a filter to clips and scenes in one undo step", async () => {
        const { controller, scenes, clips, video } = await setup();
        const [a, b] = scenes();
        const result = await controller.execute({ type: "look.set", targets: [{ clipId: video.id }, { sceneId: a.id }, { sceneId: b.id }], filter: "warm", intensity: 0.5 });
        expect(result.ok).toBe(true);
        expect(clips().find((c) => c.id === video.id)).toMatchObject({ visualFilter: "warm", filterIntensity: 0.5 });
        expect(scenes().slice(0, 2).map((s) => s.visualFilter)).toEqual(["warm", "warm"]);
        expect(controller.historyDepth().undo).toBe(5);
        await controller.execute({ type: "history.undo" });
        expect(clips().find((c) => c.id === video.id)?.visualFilter ?? "none").toBe("none");
        expect(scenes().slice(0, 2).map((s) => s.visualFilter ?? "none")).toEqual(["none", "none"]);
    });

    it("look.set skips targets that are locked or on a locked track, in one undo step for the rest", async () => {
        const { controller, store, scenes, clips, video, text } = await setup();
        const [a] = scenes();
        await controller.execute({ type: "clip.update", clipIds: [text.id], patch: { locked: true } });
        await lockVideoTrack(controller, store, 1);
        const before = controller.historyDepth().undo;
        const result = await controller.execute({ type: "look.set", targets: [{ clipId: video.id }, { clipId: text.id }, { sceneId: a.id }], filter: "warm" });
        expect(result.ok).toBe(true);
        expect(clips().find((c) => c.id === video.id)?.visualFilter).toBe("warm");
        expect(clips().find((c) => c.id === text.id)?.visualFilter ?? "none").toBe("none");
        expect(scenes()[0].visualFilter ?? "none").toBe("none");
        expect(controller.historyDepth().undo).toBe(before + 1);
        expect((await controller.execute({ type: "look.set", targets: [{ clipId: text.id }, { sceneId: a.id }], filter: "cool" })).ok).toBe(false);
        expect(controller.historyDepth().undo).toBe(before + 1);
    });

    it("animation.set and clip.effect.add skip targets on locked tracks", async () => {
        const { controller, store, scenes, clips, video } = await setup();
        const [a] = scenes();
        await lockVideoTrack(controller, store, 1);
        expect((await controller.execute({ type: "animation.set", targets: [{ clipId: video.id }, { sceneId: a.id }], slot: "in", animationId: "fade_in" })).ok).toBe(true);
        expect(scenes()[0].animationJson ?? null).toBeNull();
        expect((await controller.execute({ type: "clip.effect.add", targets: [{ clipId: video.id }, { sceneId: a.id }], effectId: "fx_blur" })).ok).toBe(true);
        expect(clips().find((c) => c.id === video.id)!.effects?.map((e) => e.effectId)).toEqual(["fx_blur"]);
        expect(scenes()[0].effects ?? []).toEqual([]);
    });

    it("look.set adjusts every target from its own values", async () => {
        const { controller, scenes } = await setup();
        const [a, b] = scenes();
        await controller.execute({ type: "look.set", sceneId: a.id, adjustments: { contrast: 0.3 } });
        await controller.execute({ type: "look.set", targets: [{ sceneId: a.id }, { sceneId: b.id }], adjustments: { exposure: 0.2 } });
        expect(JSON.parse(scenes()[0].adjustmentsJson!)).toMatchObject({ contrast: 0.3, exposure: 0.2 });
        expect(JSON.parse(scenes()[1].adjustmentsJson!)).toMatchObject({ exposure: 0.2 });
        expect(JSON.parse(scenes()[1].adjustmentsJson!).contrast ?? 0).toBe(0);
    });

    it("animation.set applies to every animatable target and rejects audio", async () => {
        const { controller, scenes, clips, video, audio } = await setup();
        const [a] = scenes();
        const result = await controller.execute({ type: "animation.set", targets: [{ clipId: video.id }, { sceneId: a.id }], slot: "in", animationId: "fade_in" });
        expect(result.ok).toBe(true);
        expect(JSON.parse(clips().find((c) => c.id === video.id)!.animationJson!).in.id).toBe("fade_in");
        expect(JSON.parse(scenes()[0].animationJson!).in.id).toBe("fade_in");
        expect((await controller.execute({ type: "animation.set", targets: [{ clipId: audio.id }], slot: "in", animationId: "fade_in" })).ok).toBe(false);
    });

    it("clip.effect.add adds a row to every target in one undo step", async () => {
        const { controller, scenes, clips, video } = await setup();
        const [a] = scenes();
        const result = await controller.execute({ type: "clip.effect.add", targets: [{ clipId: video.id }, { sceneId: a.id }], effectId: "fx_blur" });
        expect(result.ok).toBe(true);
        expect(clips().find((c) => c.id === video.id)!.effects?.map((e) => e.effectId)).toEqual(["fx_blur"]);
        expect(scenes()[0].effects?.map((e) => e.effectId)).toEqual(["fx_blur"]);
        await controller.execute({ type: "history.undo" });
        expect(clips().find((c) => c.id === video.id)!.effects ?? []).toEqual([]);
        expect(scenes()[0].effects ?? []).toEqual([]);
    });
});
