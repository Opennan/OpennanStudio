import { LocalBackend } from "../backend/local-backend";
import { createMemoryPersistence } from "../backend/persistence";
import { parseTimelineKeyframes } from "../lib/timeline-editing-properties";
import { easingCode } from "../motion/easing";
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
    await controller.execute({
        type: "scene.add", input: { afterOrder: -1, cardType: "source_clip", sourceVideoUrl: "s.mp4", trackIndex: 1, timelinePositionSeconds: 0, duration: 4 },
    });
    await controller.execute({ type: "clip.create", input: { trackType: "video", trackIndex: 2, startTime: 1, endTime: 5, mediaType: "video", mediaUrl: "a.mp4" } });
    const scenes = () => selectLiveScenes(store.getState());
    const clip = () => store.getState().timelineData!.clips[0];
    const points = () => parseTimelineKeyframes(clip().keyframesJson);
    return { store, controller, scenes, clip, points };
}

describe("planKeyframes keyframe.retime", () => {
    const json = JSON.stringify({ keyframes: [{ time: 0, scale: 1 }, { time: 1, scale: 2, opacity: 0.5, easing: 2 }, { time: 3, scale: 3 }] });

    it("moves the point and clamps the target into the item", () => {
        const moved = planKeyframes(json, 4, { type: "keyframe.retime", from: 1, to: 2.5 });
        expect(moved.ok && parseTimelineKeyframes(moved.value).map((p) => p.time)).toEqual([0, 2.5, 3]);
        const late = planKeyframes(json, 4, { type: "keyframe.retime", from: 1, to: 9 });
        expect(late.ok && parseTimelineKeyframes(late.value).map((p) => p.time)).toEqual([0, 3, 4]);
        const early = planKeyframes(json, 4, { type: "keyframe.retime", from: 3, to: -1 });
        expect(early.ok && parseTimelineKeyframes(early.value)[0]).toEqual({ time: 0, scale: 3 });
    });

    it("refuses a missing point, bad times, and channels the point lacks", () => {
        expect(planKeyframes(json, 4, { type: "keyframe.retime", from: 2, to: 1 })).toMatchObject({ ok: false });
        expect(planKeyframes(json, 4, { type: "keyframe.retime", from: 1, to: Number.NaN })).toMatchObject({ ok: false });
        expect(planKeyframes(json, 4, { type: "keyframe.retime", from: 1, to: 2, channels: ["volume"] })).toMatchObject({ ok: false });
        expect(planKeyframes(json, 4, { type: "keyframe.retime", from: 1, to: 2, channels: ["easing"] })).toMatchObject({ ok: false });
        expect(planKeyframes(json, 4, { type: "keyframe.retime", from: 1, to: 2, channels: [] })).toMatchObject({ ok: false });
    });
});

describe("keyframe.retime", () => {
    it("retimes a clip keyframe in one undo step; undo and redo restore it", async () => {
        const { controller, clip, points } = await setup();
        const id = clip().id;
        await controller.execute({ type: "keyframe.set", clipId: id, time: 0, values: { scale: 1 } });
        await controller.execute({ type: "keyframe.set", clipId: id, time: 2, values: { scale: 2, opacity: 0.5 }, easing: "ease_in" });
        const before = clip().keyframesJson;
        const result = await controller.execute({ type: "keyframe.retime", clipId: id, from: 2, to: 3.2 });
        expect(result.ok).toBe(true);
        expect(points()).toEqual([{ time: 0, scale: 1 }, { time: 3.2, scale: 2, opacity: 0.5, easing: easingCode("ease_in") }]);
        await controller.execute({ type: "history.undo" });
        expect(clip().keyframesJson).toBe(before);
        await controller.execute({ type: "history.redo" });
        expect(points()[1].time).toBe(3.2);
        await controller.execute({ type: "history.undo" });
        await controller.execute({ type: "history.undo" });
        // The undo before the retime removes the second keyframe.set, not part of the retime.
        expect(points()).toEqual([{ time: 0, scale: 1 }]);
    });

    it("moves only the given channels", async () => {
        const { controller, clip, points } = await setup();
        const id = clip().id;
        await controller.execute({ type: "keyframe.set", clipId: id, time: 1, values: { position_x: 0.2, position_y: 0.3, opacity: 1 } });
        await controller.execute({ type: "keyframe.retime", clipId: id, from: 1, to: 1.5, channels: ["position_x", "position_y"] });
        expect(points()).toEqual([{ time: 1, opacity: 1 }, { time: 1.5, position_x: 0.2, position_y: 0.3 }]);
    });

    it("writes values at the destination in the same step (a diagonal graph drag)", async () => {
        const { controller, clip, points } = await setup();
        const id = clip().id;
        await controller.execute({ type: "keyframe.set", clipId: id, time: 1, values: { scale: 2, opacity: 1 } });
        const before = clip().keyframesJson;
        await controller.execute({ type: "keyframe.retime", clipId: id, from: 1, to: 2, channels: ["scale"], values: { scale: 2.5 } });
        expect(points()).toEqual([{ time: 1, opacity: 1 }, { time: 2, scale: 2.5 }]);
        await controller.execute({ type: "history.undo" });
        expect(clip().keyframesJson).toBe(before);
        expect((await controller.execute({ type: "keyframe.retime", clipId: id, from: 1, to: 2, values: { nope: 1 } })).ok).toBe(false);
    });

    it("retimes scene keyframes", async () => {
        const { controller, scenes } = await setup();
        const id = scenes()[0].id;
        await controller.execute({ type: "keyframe.set", sceneId: id, time: 0.5, values: { scale: 1.2 } });
        expect((await controller.execute({ type: "keyframe.retime", sceneId: id, from: 0.5, to: 1.25 })).ok).toBe(true);
        expect(parseTimelineKeyframes(scenes()[0].keyframesJson)).toEqual([{ time: 1.25, scale: 1.2 }]);
    });

    it("refuses items on locked tracks and missing items", async () => {
        const { controller, store, clip, points } = await setup();
        const id = clip().id;
        await controller.execute({ type: "keyframe.set", clipId: id, time: 1, values: { scale: 2 } });
        const tracks = [...store.getState().timelineData!.tracks, { type: "video" as const, index: 2, label: "V2", muted: false, locked: true, visible: true, volume: 1 }];
        await controller.execute({ type: "track.update", tracks });
        const refused = await controller.execute({ type: "keyframe.retime", clipId: id, from: 1, to: 2 });
        expect(refused.ok).toBe(false);
        expect(refused.error).toMatch(/locked/);
        expect(points()[0].time).toBe(1);
        expect((await controller.execute({ type: "keyframe.retime", clipId: "nope", from: 1, to: 2 })).ok).toBe(false);
    });
});
