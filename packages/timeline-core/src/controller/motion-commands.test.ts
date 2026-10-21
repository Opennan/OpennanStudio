import { createRecordingBackend } from "../testing";
import { LocalBackend } from "../backend/local-backend";
import { createMemoryPersistence } from "../backend/persistence";
import { parseTimelineKeyframes } from "../lib/timeline-editing-properties";
import { parseAnimationSpec } from "../motion/animation-spec";
import { createEditorStore } from "../store/editor-store";
import { selectLiveScenes } from "../store/live-scenes";
import { TimelineController } from "./timeline-controller";
import { planKeyframes } from "./motion-commands";

async function setup() {
    let n = 0;
    const local = new LocalBackend({ persistence: createMemoryPersistence(), idFactory: () => `id-${++n}` });
    const store = createEditorStore();
    const controller = new TimelineController({ backend: local, store, projectId: "p1", onToast: vi.fn() });
    await controller.load();
    const add = (at: number, duration: number, order: number) => controller.execute({
        type: "scene.add", input: { afterOrder: order, cardType: "source_clip", sourceVideoUrl: "s.mp4", trackIndex: 1, timelinePositionSeconds: at, duration },
    });
    await add(0, 4, -1);
    await add(4, 3, 0);
    await add(7, 2, 1);
    await controller.execute({ type: "clip.create", input: { trackType: "video", trackIndex: 2, startTime: 0, endTime: 4, mediaType: "video", mediaUrl: "a.mp4" } });
    await controller.execute({ type: "clip.create", input: { trackType: "video", trackIndex: 2, startTime: 4, endTime: 6, mediaType: "video", mediaUrl: "b.mp4" } });
    await controller.execute({ type: "clip.create", input: { trackType: "text", trackIndex: 1, startTime: 1, endTime: 3, mediaType: "text", textContent: "Hello world", textStyle: '{"fontSize":40,"captionKind":"caption"}' } });
    const scenes = () => selectLiveScenes(store.getState());
    const clips = () => store.getState().timelineData!.clips;
    const clip = (i: number) => clips()[i];
    return { local, store, controller, scenes, clips, clip };
}

describe("animation.set", () => {
    it("sets in, out, and combo on clips and scenes, each one undo step", async () => {
        const { controller, clip, scenes } = await setup();
        const id = clip(0).id;
        expect((await controller.execute({ type: "animation.set", clipId: id, slot: "in", animationId: "zoom_in", duration: 0.8 })).ok).toBe(true);
        expect(parseAnimationSpec(clip(0).animationJson)).toEqual({ in: { id: "zoom_in", duration: 0.8 } });
        await controller.execute({ type: "animation.set", clipId: id, slot: "out", animationId: "fade_out" });
        expect(parseAnimationSpec(clip(0).animationJson).out?.id).toBe("fade_out");
        await controller.execute({ type: "animation.set", clipId: id, slot: "combo", animationId: "combo_swing" });
        expect(parseAnimationSpec(clip(0).animationJson)).toEqual({ combo: { id: "combo_swing" } });
        await controller.execute({ type: "history.undo" });
        expect(parseAnimationSpec(clip(0).animationJson).in?.id).toBe("zoom_in");
        await controller.execute({ type: "animation.set", sceneId: scenes()[0].id, slot: "in", animationId: "slide_left" });
        expect(parseAnimationSpec(scenes()[0].animationJson).in?.id).toBe("slide_left");
        await controller.execute({ type: "animation.set", sceneId: scenes()[0].id, slot: "in", animationId: null });
        expect(scenes()[0].animationJson ?? null).toBeNull();
    });

    it("refuses unknown animations and slots that do not fit the item", async () => {
        const { controller, clip } = await setup();
        expect((await controller.execute({ type: "animation.set", clipId: clip(0).id, slot: "in", animationId: "nope" })).ok).toBe(false);
        expect((await controller.execute({ type: "animation.set", clipId: clip(0).id, slot: "loop", animationId: "pulse" })).ok).toBe(false);
        expect((await controller.execute({ type: "animation.set", clipId: clip(2).id, slot: "loop", animationId: "pulse" })).ok).toBe(true);
    });
});

describe("keyframes", () => {
    it("sets, eases, and removes keyframes per channel", async () => {
        const { controller, clip } = await setup();
        const id = clip(0).id;
        await controller.execute({ type: "keyframe.set", clipId: id, time: 0, values: { scale: 1 } });
        await controller.execute({ type: "keyframe.set", clipId: id, time: 2, values: { scale: 2, opacity: 0.5 }, easing: "ease_in_out" });
        let points = parseTimelineKeyframes(clip(0).keyframesJson);
        expect(points.map((p) => p.time)).toEqual([0, 2]);
        expect(points[1]).toMatchObject({ scale: 2, opacity: 0.5, easing: 3 });
        await controller.execute({ type: "keyframe.easing", clipId: id, time: 0, easing: "bezier", bezier: [0.1, 0.2, 0.3, 1] });
        points = parseTimelineKeyframes(clip(0).keyframesJson);
        expect(points[0]).toMatchObject({ easing: 5, bx1: 0.1, by1: 0.2, bx2: 0.3, by2: 1 });
        await controller.execute({ type: "keyframe.remove", clipId: id, time: 2, channels: ["opacity"] });
        expect(parseTimelineKeyframes(clip(0).keyframesJson)[1]).not.toHaveProperty("opacity");
        await controller.execute({ type: "keyframe.remove", clipId: id, time: 2 });
        await controller.execute({ type: "keyframe.remove", clipId: id, time: 0 });
        expect(clip(0).keyframesJson).toBeNull();
        await controller.execute({ type: "history.undo" });
        expect(parseTimelineKeyframes(clip(0).keyframesJson)).toHaveLength(1);
    });

    it("keyframes scenes with scene units", async () => {
        const { controller, scenes } = await setup();
        const id = scenes()[1].id;
        await controller.execute({ type: "keyframe.set", sceneId: id, time: 0.5, values: { scale: 1.2, position_x: 10 } });
        expect(parseTimelineKeyframes(scenes()[1].keyframesJson)[0]).toMatchObject({ time: 0.5, scale: 1.2, position_x: 10 });
    });

    it("refuses unknown channels and times outside the item", async () => {
        const { controller, clip } = await setup();
        expect((await controller.execute({ type: "keyframe.set", clipId: clip(0).id, time: 1, values: { nope: 1 } })).ok).toBe(false);
        expect((await controller.execute({ type: "keyframe.set", clipId: clip(0).id, time: 9, values: { scale: 1 } })).ok).toBe(false);
    });
});

describe("speed.set", () => {
    it("changes a clip's length with its speed, pushes the next clip on the track, and undoes in one step", async () => {
        const { controller, clip, clips } = await setup();
        const id = clip(0).id;
        await controller.execute({ type: "keyframe.set", clipId: id, time: 2, values: { scale: 2 } });
        expect((await controller.execute({ type: "speed.set", clipId: id, speed: 0.5 })).ok).toBe(true);
        expect(clip(0)).toMatchObject({ startTime: 0, endTime: 8, playbackSpeed: 0.5 });
        expect(parseTimelineKeyframes(clip(0).keyframesJson)[0].time).toBeCloseTo(4, 6);
        // The next clip on V2 started at 4: pushed to 8.
        expect(clips()[1]).toMatchObject({ startTime: 8, endTime: 10 });
        await controller.execute({ type: "history.undo" });
        expect(clip(0)).toMatchObject({ endTime: 4, playbackSpeed: 1 });
        expect(clips()[1]).toMatchObject({ startTime: 4, endTime: 6 });
    });

    it("applies a curve and keeps the source span", async () => {
        const { controller, clip } = await setup();
        const id = clip(0).id;
        await controller.execute({ type: "speed.set", clipId: id, curve: { id: "custom", points: [[0, 2], [1, 2]] } });
        expect(clip(0).endTime).toBeCloseTo(2, 6);
        expect(clip(0).speedCurveJson).toContain("custom");
        await controller.execute({ type: "speed.set", clipId: id, curve: null, preservePitch: false });
        expect(clip(0).endTime).toBeCloseTo(4, 6);
        expect(clip(0).speedCurveJson ?? null).toBeNull();
        expect(clip(0).preservePitch).toBe(false);
    });

    it("ripples later scenes on the track when a scene's speed changes", async () => {
        const { controller, scenes } = await setup();
        await controller.execute({ type: "speed.set", sceneId: scenes()[0].id, speed: 2 });
        expect(scenes()[0].playbackSpeed).toBe(2);
        expect(scenes()[1].timelinePositionSeconds).toBeCloseTo(2, 6);
        expect(scenes()[2].timelinePositionSeconds).toBeCloseTo(5, 6);
        await controller.execute({ type: "history.undo" });
        expect(scenes()[1].timelinePositionSeconds).toBeCloseTo(4, 6);
        expect(scenes()[0].playbackSpeed ?? 1).toBe(1);
    });
});

describe("text and caption styles", () => {
    it("merges a style patch, deletes null keys, and applies templates and caption styles in one step", async () => {
        const { controller, clip } = await setup();
        const id = clip(2).id;
        await controller.execute({ type: "text.style.set", clipIds: [id], patch: { color: "#ff0000", fontSize: null } });
        const style = JSON.parse(clip(2).textStyle!);
        expect(style.color).toBe("#ff0000");
        expect(style).not.toHaveProperty("fontSize");
        await controller.execute({ type: "text.template.apply", clipIds: [id], templateId: "neon_pink" });
        expect(JSON.parse(clip(2).textStyle!).captionKind).toBe("caption");
        await controller.execute({ type: "caption.style.apply", styleId: "karaoke_highlight" });
        expect(JSON.parse(clip(2).textStyle!).karaoke).toBe("highlight");
        await controller.execute({ type: "history.undo" });
        expect(JSON.parse(clip(2).textStyle!).karaoke ?? null).toBeNull();
        expect((await controller.execute({ type: "text.template.apply", clipIds: [id], templateId: "nope" })).ok).toBe(false);
    });
});

describe("effect.layer.add", () => {
    it("adds a track, an effect clip, and its effect row as one undo step", async () => {
        const { controller, store } = await setup();
        const before = store.getState().timelineData!.tracks.length;
        const result = await controller.execute({ type: "effect.layer.add", effectId: "fx_shake", startTime: 1, endTime: 4 });
        expect(result.ok).toBe(true);
        const layer = store.getState().timelineData!.clips.find((c) => c.trackType === "effect")!;
        expect(layer).toMatchObject({ startTime: 1, endTime: 4 });
        expect(layer.effects?.map((e) => e.effectId)).toEqual(["fx_shake"]);
        expect(store.getState().timelineData!.tracks.length).toBe(before + 1);
        await controller.execute({ type: "history.undo" });
        expect(store.getState().timelineData!.clips.some((c) => c.trackType === "effect")).toBe(false);
        expect(store.getState().timelineData!.tracks.length).toBe(before);
    });
});

describe("clip.create with a new track", () => {
    it("writes the track and the clip as one undo step", async () => {
        const { controller, store } = await setup();
        const tracks = store.getState().timelineData!.tracks;
        const sticker = { type: "sticker" as const, index: 1, label: "S1", muted: false, locked: false, visible: true, volume: 1 };
        const result = await controller.execute({
            type: "clip.create", tracks: [...tracks, sticker],
            input: { trackType: "sticker", trackIndex: 1, startTime: 0, endTime: 3, mediaType: "sticker", stickerId: "twemoji:1f525" },
        });
        expect(result.ok).toBe(true);
        expect(store.getState().timelineData!.tracks.some((t) => t.type === "sticker")).toBe(true);
        expect(store.getState().timelineData!.clips.find((c) => c.stickerId)).toBeTruthy();
        await controller.execute({ type: "history.undo" });
        expect(store.getState().timelineData!.tracks.some((t) => t.type === "sticker")).toBe(false);
        expect(store.getState().timelineData!.clips.some((c) => c.stickerId)).toBe(false);
    });
});

// ── review fixes (phase 10b) ─────────────────────────────

async function recordedSetup() {
    let n = 0;
    const local = new LocalBackend({ persistence: createMemoryPersistence(), idFactory: () => `id-${++n}` });
    const recording = createRecordingBackend(local);
    const store = createEditorStore();
    const controller = new TimelineController({ backend: recording.backend, store, projectId: "p1", onToast: vi.fn(), requestTimeoutMs: 1000 });
    await controller.load();
    const add = (at: number, duration: number, order: number) => controller.execute({
        type: "scene.add", input: { afterOrder: order, cardType: "source_clip", sourceVideoUrl: "s.mp4", trackIndex: 1, timelinePositionSeconds: at, duration },
    });
    await add(0, 4, -1);
    await add(4, 3, 0);
    await add(7, 2, 1);
    await controller.execute({ type: "clip.create", input: { trackType: "video", trackIndex: 2, startTime: 0, endTime: 4, mediaType: "video", mediaUrl: "a.mp4" } });
    await controller.execute({ type: "clip.create", input: { trackType: "video", trackIndex: 2, startTime: 4, endTime: 6, mediaType: "video", mediaUrl: "b.mp4" } });
    recording.reset();
    const scenes = () => selectLiveScenes(store.getState());
    const clips = () => store.getState().timelineData!.clips;
    const tracks = () => store.getState().timelineData!.tracks.map((t) => `${t.type}${t.index}`);
    const backendTracks = async () => (await local.loadTimeline("p1")).tracks.map((t) => `${t.type}${t.index}`);
    const positions = (list: Array<{ id: string; startTime: number; endTime: number }>) => list.map((c) => [c.id, c.startTime, c.endTime]);
    return { local, recording, store, controller, scenes, clips, tracks, backendTracks, positions };
}

describe("speed.set during a slider gesture (H1)", () => {
    const SLIDE = { coalesceKey: "speed-gesture", debounceMs: 60 };

    it("persists the gesture's final state when a slower step pushed later clips and a faster one undid it", async () => {
        const { controller, clips, local, positions } = await recordedSetup();
        const id = clips()[0].id;
        const first = controller.execute({ type: "speed.set", clipId: id, speed: 0.5 }, SLIDE);
        expect(clips()[1]).toMatchObject({ startTime: 8, endTime: 10 });
        const second = controller.execute({ type: "speed.set", clipId: id, speed: 2 }, SLIDE);
        await Promise.all([first, second]);
        expect(clips()[0]).toMatchObject({ startTime: 0, endTime: 2, playbackSpeed: 2 });
        // The next clip goes back to where it was: the gesture as a whole never pushed it.
        expect(clips()[1]).toMatchObject({ startTime: 4, endTime: 6 });
        const stored = (await local.loadTimeline("p1")).clips;
        expect(positions(stored)).toEqual(positions(clips()));
        await controller.execute({ type: "history.undo" });
        expect(clips()[0]).toMatchObject({ endTime: 4, playbackSpeed: 1 });
        expect(positions((await local.loadTimeline("p1")).clips)).toEqual(positions(clips()));
    });

    it("plans every step of a gesture from the speed before the gesture (no compounding)", async () => {
        const { controller, clips, local } = await recordedSetup();
        const id = clips()[0].id;
        await controller.execute({ type: "keyframe.set", clipId: id, time: 1, values: { scale: 2 } });
        const steps = [0.7, 3.3, 0.21, 9.9, 1.37, 1].map((speed) => controller.execute({ type: "speed.set", clipId: id, speed }, SLIDE));
        await Promise.all(steps);
        expect(clips()[0]).toMatchObject({ startTime: 0, endTime: 4, playbackSpeed: 1 });
        expect(parseTimelineKeyframes(clips()[0].keyframesJson)[0].time).toBeCloseTo(1, 9);
        expect((await local.loadTimeline("p1")).clips[0]).toMatchObject({ endTime: 4, playbackSpeed: 1 });
    });

    it("keeps a gesture's other fields: a curve then a speed in one gesture keep both", async () => {
        const { controller, clips } = await recordedSetup();
        const id = clips()[0].id;
        const a = controller.execute({ type: "speed.set", clipId: id, preservePitch: false }, SLIDE);
        const b = controller.execute({ type: "speed.set", clipId: id, speed: 2 }, SLIDE);
        await Promise.all([a, b]);
        expect(clips()[0]).toMatchObject({ playbackSpeed: 2, preservePitch: false, endTime: 2 });
    });

    it("a scene gesture persists the same ripple it shows and leaves items before the scene's end alone", async () => {
        const { controller, scenes, clips, local, positions } = await recordedSetup();
        await controller.execute({ type: "clip.create", input: { trackType: "video", trackIndex: 3, startTime: 2.5, endTime: 3.5, mediaType: "video", mediaUrl: "c.mp4" } });
        const id = scenes()[0].id;
        const first = controller.execute({ type: "speed.set", sceneId: id, speed: 2 }, SLIDE);
        const second = controller.execute({ type: "speed.set", sceneId: id, speed: 1 }, SLIDE);
        await Promise.all([first, second]);
        expect(scenes().map((s) => s.timelinePositionSeconds)).toEqual([0, 4, 7]);
        const late = clips().find((c) => c.trackIndex === 3)!;
        expect(late).toMatchObject({ startTime: 2.5, endTime: 3.5 });
        expect(positions((await local.loadTimeline("p1")).clips)).toEqual(positions(clips()));
        expect((await local.loadScenes("p1")).map((s) => s.timelinePositionSeconds ?? 0)).toEqual(scenes().map((s) => s.timelinePositionSeconds ?? 0));
    });
});

describe("speed.set keeps the source span exact (H2)", () => {
    it("clamps the speed instead of the length, so 100x and back restores the length", async () => {
        const { controller, clips } = await recordedSetup();
        const id = clips()[0].id;
        await controller.execute({ type: "speed.set", clipId: id, speed: 100 });
        // 4 s of source at 100x would be 0.04 s: the speed stops at 80x (0.05 s).
        expect(clips()[0].playbackSpeed).toBe(80);
        expect(clips()[0].endTime).toBeCloseTo(0.05, 9);
        await controller.execute({ type: "speed.set", clipId: id, speed: 1 });
        expect(clips()[0].endTime).toBeCloseTo(4, 9);
    });

    it("does not leak span through rounding over many edits", async () => {
        const { controller, clips } = await recordedSetup();
        const id = clips()[0].id;
        for (const speed of [7, 1, 13.37, 0.33, 61, 2.345678, 1]) await controller.execute({ type: "speed.set", clipId: id, speed });
        expect(Math.abs(clips()[0].endTime - 4)).toBeLessThan(1e-4);
    });

    it("stores a length that matches the stored (rounded) speed", async () => {
        const { controller, clips } = await recordedSetup();
        const id = clips()[0].id;
        await controller.execute({ type: "speed.set", clipId: id, speed: 2.345678 });
        const clip = clips()[0];
        expect(clip.playbackSpeed).toBe(2.3457);
        expect(clip.playbackSpeed * (clip.endTime - clip.startTime)).toBeCloseTo(4, 5);
    });

    it("never merges distinct keyframes at high speed", async () => {
        const { controller, clips } = await recordedSetup();
        const id = clips()[0].id;
        await controller.execute({ type: "keyframe.set", clipId: id, time: 0, values: { scale: 1 } });
        await controller.execute({ type: "keyframe.set", clipId: id, time: 0.03, values: { scale: 2 } });
        await controller.execute({ type: "speed.set", clipId: id, speed: 80 });
        const fast = parseTimelineKeyframes(clips()[0].keyframesJson).map((p) => p.time);
        expect(fast).toHaveLength(2);
        expect(fast[1]).toBeGreaterThan(fast[0]);
        await controller.execute({ type: "speed.set", clipId: id, speed: 1 });
        // Keyframe times are stored in ms, so 0.03 s at 80x (0.375 ms) is kept 1 ms after the first one.
        const times = parseTimelineKeyframes(clips()[0].keyframesJson).map((p) => p.time);
        expect(times).toHaveLength(2);
        expect(times[0]).toBe(0);
        expect(times[1]).toBeGreaterThan(0);
    });

    it("ripples a scene by its real stored length when the speed is clamped", async () => {
        const { controller, scenes } = await recordedSetup();
        await controller.execute({ type: "speed.set", sceneId: scenes()[0].id, speed: 100 });
        expect(scenes()[0].playbackSpeed).toBe(80);
        expect(scenes()[1].timelinePositionSeconds).toBeCloseTo(0.05, 6);
    });
});

describe("speed.set on several clips", () => {
    it("sets every clip in one undo step", async () => {
        const { controller, clips } = await recordedSetup();
        const ids = [clips()[0].id, clips()[1].id];
        expect((await controller.execute({ type: "speed.set", clipIds: ids, speed: 2 })).ok).toBe(true);
        expect(clips().map((c) => [c.startTime, c.endTime, c.playbackSpeed])).toEqual([[0, 2, 2], [4, 5, 2]]);
        await controller.execute({ type: "history.undo" });
        expect(clips().map((c) => [c.startTime, c.endTime, c.playbackSpeed])).toEqual([[0, 4, 1], [4, 6, 1]]);
    });
});

describe("multi-write commands that fail half way (M2, M3)", () => {
    it("effect.layer.add takes its new track back when creating the clip fails", async () => {
        const { controller, recording, tracks, backendTracks, clips } = await recordedSetup();
        const before = tracks();
        recording.failNext("createClips");
        expect((await controller.execute({ type: "effect.layer.add", effectId: "fx_shake", startTime: 1, endTime: 4 })).ok).toBe(false);
        expect(tracks()).toEqual(before);
        expect(await backendTracks()).toEqual(before);
        expect(clips().some((c) => c.trackType === "effect")).toBe(false);
        // The newest undo entry (the second clip.create) is still exactly one backend step.
        await controller.execute({ type: "history.undo" });
        expect(recording.callsTo("undo").at(-1)!.args).toEqual(["p1", 1]);
        expect(clips()).toHaveLength(1);
        expect(await backendTracks()).toEqual(before);
    });

    it("effect.layer.add takes the clip and track back when attaching the effect fails", async () => {
        const { controller, recording, tracks, backendTracks, local } = await recordedSetup();
        const before = tracks();
        recording.failNext("addClipEffect");
        expect((await controller.execute({ type: "effect.layer.add", effectId: "fx_shake", startTime: 1, endTime: 4 })).ok).toBe(false);
        expect(await backendTracks()).toEqual(before);
        expect((await local.loadTimeline("p1")).clips.some((c) => c.trackType === "effect")).toBe(false);
        await controller.execute({ type: "history.undo" });
        expect(recording.callsTo("undo").at(-1)!.args).toEqual(["p1", 1]);
        expect((await local.loadTimeline("p1")).clips).toHaveLength(1);
    });

    it("a silent effect.layer.add that fails leaves no track and adds no backend undo steps", async () => {
        const { controller, recording, tracks, backendTracks } = await recordedSetup();
        const before = tracks();
        recording.failNext("createClips");
        expect((await controller.execute({ type: "effect.layer.add", effectId: "fx_shake", startTime: 1, endTime: 4 }, { recordHistory: false })).ok).toBe(false);
        expect(await backendTracks()).toEqual(before);
        await controller.execute({ type: "history.undo" });
        expect(recording.callsTo("undo").at(-1)!.args).toEqual(["p1", 1]);
    });

    it("a scene speed.set whose ripple fails leaves the scene's speed unchanged on the backend", async () => {
        const { controller, recording, scenes, local } = await recordedSetup();
        recording.failNext("moveScenes");
        expect((await controller.execute({ type: "speed.set", sceneId: scenes()[0].id, speed: 2 })).ok).toBe(false);
        expect(scenes()[0].playbackSpeed ?? 1).toBe(1);
        expect((await local.loadScenes("p1"))[0].playbackSpeed ?? 1).toBe(1);
        await controller.execute({ type: "history.undo" });
        expect(recording.callsTo("undo").at(-1)!.args).toEqual(["p1", 1]);
        expect((await local.loadScenes("p1"))[0].playbackSpeed ?? 1).toBe(1);
        expect((await local.loadTimeline("p1")).clips).toHaveLength(1);
    });

    it("a scene speed.set whose clip ripple fails takes back the scene and the moves", async () => {
        const { controller, recording, scenes, local } = await recordedSetup();
        recording.failNext("updateClips");
        expect((await controller.execute({ type: "speed.set", sceneId: scenes()[0].id, speed: 2 })).ok).toBe(false);
        const stored = await local.loadScenes("p1");
        expect(stored[0].playbackSpeed ?? 1).toBe(1);
        expect(stored.map((s) => s.timelinePositionSeconds)).toEqual([0, 4, 7]);
    });

    it("a silent clip.create with a new track that fails adds no backend undo steps (LOW)", async () => {
        const { controller, recording, store, backendTracks } = await recordedSetup();
        const before = await backendTracks();
        const sticker = { type: "sticker" as const, index: 1, label: "S1", muted: false, locked: false, visible: true, volume: 1 };
        recording.failNext("createClips");
        const result = await controller.execute({
            type: "clip.create", tracks: [...store.getState().timelineData!.tracks, sticker],
            input: { trackType: "sticker", trackIndex: 1, startTime: 0, endTime: 3, mediaType: "sticker", stickerId: "twemoji:1f525" },
        }, { recordHistory: false });
        expect(result.ok).toBe(false);
        expect(await backendTracks()).toEqual(before);
        await controller.execute({ type: "history.undo" });
        expect(recording.callsTo("undo").at(-1)!.args).toEqual(["p1", 1]);
    });
});

describe("left trims re-base caption words", () => {
    it("shifts clip-local word times by the left trim and keeps every word", async () => {
        const { controller, store } = await recordedSetup();
        const words = JSON.stringify([{ start: 0, end: 0.5, text: "Hello" }, { start: 0.6, end: 1.2, text: "big" }, { start: 1.3, end: 2, text: "world" }]);
        const created = await controller.execute({
            type: "clip.create", input: { trackType: "text", trackIndex: 1, startTime: 10, endTime: 12, mediaType: "text", textContent: "Hello big world", captionWordsJson: words } as never,
        });
        const id = created.createdClipIds![0];
        const caption = () => store.getState().timelineData!.clips.find((c) => c.id === id)!;
        await controller.execute({ type: "clip.update", clipIds: [id], patch: { startTime: 10.7 } });
        expect(JSON.parse(caption().captionWordsJson!)).toEqual([
            { start: 0, end: 0, text: "Hello" }, { start: 0, end: 0.5, text: "big" }, { start: 0.6, end: 1.3, text: "world" },
        ]);
        // A move keeps clip-local words as they are.
        await controller.execute({ type: "clip.move", clipIds: [id], deltaSeconds: 1 });
        expect(JSON.parse(caption().captionWordsJson!)[2]).toEqual({ start: 0.6, end: 1.3, text: "world" });
    });
});

describe("keyframes per channel cap (M6)", () => {
    it("refuses a keyframe that would give a channel more than 200 points, with a clear error", () => {
        const full = JSON.stringify({ keyframes: Array.from({ length: 200 }, (_, i) => ({ time: i * 0.01, scale: 1 + i / 1000 })) });
        const refused = planKeyframes(full, 10, { type: "keyframe.set", time: 5, values: { scale: 2 } });
        expect(refused).toEqual({ ok: false, error: expect.stringContaining("200") });
        // Editing an existing point or another channel still works.
        expect(planKeyframes(full, 10, { type: "keyframe.set", time: 0.5, values: { scale: 2 } }).ok).toBe(true);
        expect(planKeyframes(full, 10, { type: "keyframe.set", time: 5, values: { opacity: 0.5 } }).ok).toBe(true);
    });
});
