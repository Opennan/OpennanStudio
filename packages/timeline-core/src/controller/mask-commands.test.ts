import { LocalBackend } from "../backend/local-backend";
import { createMemoryPersistence } from "../backend/persistence";
import { parseTimelineKeyframes } from "../lib/timeline-editing-properties";
import { parseMask } from "../looks/masks";
import { createEditorStore } from "../store/editor-store";
import { selectLiveScenes } from "../store/live-scenes";
import { planMask } from "./mask-commands";
import { planKeyframes } from "./motion-commands";
import { TimelineController } from "./timeline-controller";

const circle = '{"shape":"circle","x":0.5,"y":0.5,"width":0.6,"height":0.6,"rotation":0,"feather":0,"roundness":0,"invert":false}';

describe("mask keyframes written through keyframe.set / keyframe.retime", () => {
    it("clamp mask_* values to the mask ranges (other channels untouched)", () => {
        const set = planKeyframes(null, 5, {
            type: "keyframe.set", time: 1,
            values: { mask_x: -1e9, mask_y: 1e9, mask_w: 1e12, mask_h: -3, mask_rotation: 1e300, mask_feather: 7, scale: 40 },
        });
        expect(set.ok).toBe(true);
        if (!set.ok) return;
        expect(parseTimelineKeyframes(set.value)).toEqual([{ time: 1, mask_x: -2, mask_y: 3, mask_w: 5, mask_h: 0.01, mask_rotation: 3600, mask_feather: 1, scale: 40 }]);
        const retimed = planKeyframes(set.value, 5, { type: "keyframe.retime", from: 1, to: 2, values: { mask_w: 1e9, mask_feather: -1 } });
        expect(retimed.ok).toBe(true);
        if (!retimed.ok) return;
        expect(parseTimelineKeyframes(retimed.value)[0]).toMatchObject({ time: 2, mask_w: 5, mask_feather: 0, mask_x: -2 });
        expect(planKeyframes(null, 5, { type: "keyframe.set", time: 1, values: { mask_x: Number.NaN } }).ok).toBe(false);
    });
});

describe("planMask (pure)", () => {
    it("adds a mask from a shape, merges patches, and keeps the geometry on a shape change", () => {
        const added = planMask({ maskJson: null, keyframesJson: null }, 5, { mask: { shape: "star" }, time: 0 });
        expect(added.ok && parseMask(added.value.maskJson)).toMatchObject({ shape: "star", width: 0.6 });
        const merged = planMask({ maskJson: circle, keyframesJson: null }, 5, { mask: { x: 0.2, feather: 0.4 }, time: 0 });
        expect(merged.ok && parseMask(merged.value.maskJson)).toMatchObject({ shape: "circle", x: 0.2, feather: 0.4, width: 0.6 });
        expect(merged.ok && merged.value.keyframesJson).toBeUndefined();
        const reshaped = planMask({ maskJson: merged.ok ? merged.value.maskJson : null, keyframesJson: null }, 5, { mask: { shape: "rectangle", roundness: 0.3 }, time: 0 });
        expect(reshaped.ok && parseMask(reshaped.value.maskJson)).toMatchObject({ shape: "rectangle", x: 0.2, roundness: 0.3 });
    });

    it("writes a keyframe at `time` for a keyed channel instead of the static value", () => {
        const keyframesJson = JSON.stringify({ keyframes: [{ time: 0, mask_x: 0.2, scale: 1 }, { time: 2, mask_x: 0.8 }] });
        const plan = planMask({ maskJson: circle, keyframesJson }, 5, { mask: { x: 0.5, y: 0.3 }, time: 1 });
        expect(plan.ok).toBe(true);
        if (!plan.ok) return;
        expect(parseMask(plan.value.maskJson)).toMatchObject({ x: 0.5, y: 0.3 });
        const points = parseTimelineKeyframes(plan.value.keyframesJson);
        expect(points.find((p) => p.time === 1)).toEqual({ time: 1, mask_x: 0.5 });
        expect(points.find((p) => p.time === 0)).toMatchObject({ mask_x: 0.2, scale: 1 });
    });

    it("null removes the mask and its keyframes, keeping other channels", () => {
        const keyframesJson = JSON.stringify({ keyframes: [{ time: 0, mask_x: 0.2, scale: 1 }, { time: 2, mask_w: 0.8 }] });
        const plan = planMask({ maskJson: circle, keyframesJson }, 5, { mask: null, time: 0 });
        expect(plan.ok && plan.value).toEqual({ maskJson: null, keyframesJson: JSON.stringify({ keyframes: [{ time: 0, scale: 1 }] }) });
        const none = planMask({ maskJson: circle, keyframesJson: null }, 5, { mask: null, time: 0 });
        expect(none.ok && none.value).toEqual({ maskJson: null });
    });

    it("replace resets the mask to the shape's defaults plus the patch and drops its keyframes (Reset)", () => {
        const keyframesJson = JSON.stringify({ keyframes: [{ time: 0, mask_x: 0.2, scale: 1 }, { time: 2, mask_x: 0.8 }] });
        const moved = '{"shape":"star","x":0.1,"y":0.9,"width":2,"height":1,"rotation":45,"feather":0.5,"roundness":0,"invert":true}';
        const plan = planMask({ maskJson: moved, keyframesJson }, 5, { mask: { shape: "star" }, time: 1, replace: true });
        expect(plan.ok && parseMask(plan.value.maskJson)).toEqual(parseMask('{"shape":"star"}'));
        expect(plan.ok && plan.value.keyframesJson).toBe(JSON.stringify({ keyframes: [{ time: 0, scale: 1 }] }));
    });

    it("refuses unknown shapes, empty patches, and times outside the item", () => {
        expect(planMask({ maskJson: null }, 5, { mask: { shape: "blob" as never }, time: 0 }).ok).toBe(false);
        expect(planMask({ maskJson: circle }, 5, { mask: {}, time: 0 }).ok).toBe(false);
        const keyed = JSON.stringify({ keyframes: [{ time: 0, mask_x: 0.2 }] });
        expect(planMask({ maskJson: circle, keyframesJson: keyed }, 5, { mask: { x: 0.4 }, time: 9 }).ok).toBe(false);
    });
});

async function setup() {
    let n = 0;
    const local = new LocalBackend({ persistence: createMemoryPersistence(), idFactory: () => `id-${++n}` });
    const store = createEditorStore();
    const controller = new TimelineController({ backend: local, store, projectId: "p1", onToast: vi.fn() });
    await controller.load();
    await controller.execute({
        type: "scene.add", input: { afterOrder: -1, cardType: "source_clip", sourceVideoUrl: "s.mp4", trackIndex: 1, timelinePositionSeconds: 0.001, duration: 4 },
    });
    const created = await controller.execute({ type: "clip.create", input: { trackType: "video", trackIndex: 2, startTime: 1, endTime: 5, mediaType: "video", mediaUrl: "a.mp4" } });
    await controller.execute({ type: "clip.create", input: { trackType: "text", trackIndex: 1, startTime: 0, endTime: 2, textContent: "hi" } });
    const scenes = () => selectLiveScenes(store.getState());
    const clips = () => store.getState().timelineData!.clips;
    return { local, store, controller, scenes, clips, clipId: created.createdClipIds![0] };
}

describe("mask.set (controller)", () => {
    it("sets, edits, and removes a clip mask, one undo step each", async () => {
        const { controller, clips, clipId, local } = await setup();
        expect((await controller.execute({ type: "mask.set", clipId, mask: { shape: "heart" } })).ok).toBe(true);
        expect(parseMask(clips().find((c) => c.id === clipId)!.maskJson)).toMatchObject({ shape: "heart" });
        await controller.execute({ type: "mask.set", clipId, mask: { invert: true, rotation: 30 } });
        expect(parseMask(clips().find((c) => c.id === clipId)!.maskJson)).toMatchObject({ shape: "heart", invert: true, rotation: 30 });
        expect(parseMask((await local.loadTimeline("p1")).clips.find((c) => c.id === clipId)!.maskJson)).toMatchObject({ invert: true });
        await controller.execute({ type: "history.undo" });
        expect(parseMask(clips().find((c) => c.id === clipId)!.maskJson)).toMatchObject({ shape: "heart", invert: false, rotation: 0 });
        await controller.execute({ type: "history.redo" });
        expect(parseMask(clips().find((c) => c.id === clipId)!.maskJson)).toMatchObject({ invert: true });
        await controller.execute({ type: "mask.set", clipId, mask: null });
        expect(clips().find((c) => c.id === clipId)!.maskJson ?? null).toBeNull();
        await controller.execute({ type: "history.undo" });
        expect(parseMask(clips().find((c) => c.id === clipId)!.maskJson)).toMatchObject({ shape: "heart" });
    });

    it("writes keyframes at the playhead (item-local) for keyed channels on a scene", async () => {
        const { controller, scenes, store } = await setup();
        const sceneId = scenes()[0].id;
        await controller.execute({ type: "mask.set", sceneId, mask: { shape: "circle" } });
        await controller.execute({ type: "keyframe.set", sceneId, time: 0, values: { mask_x: 0.3 } });
        store.getState().setCurrentTime(2.5);
        expect((await controller.execute({ type: "mask.set", sceneId, mask: { x: 0.7 } })).ok).toBe(true);
        const points = parseTimelineKeyframes(scenes()[0].keyframesJson);
        expect(points.map((p) => [p.time, p.mask_x])).toEqual([[0, 0.3], [2.499, 0.7]]);
        expect(parseMask(scenes()[0].maskJson)!.x).toBe(0.7);
        await controller.execute({ type: "history.undo" });
        expect(parseTimelineKeyframes(scenes()[0].keyframesJson).map((p) => p.time)).toEqual([0]);
    });

    it("masks text and sticker clips (phase 10d); refuses audio clips, unknown targets, and locked tracks", async () => {
        const { controller, clips, clipId, store } = await setup();
        const text = clips().find((c) => c.trackType === "text")!;
        expect((await controller.execute({ type: "mask.set", clipId: text.id, mask: { shape: "circle" } })).ok).toBe(true);
        expect(parseMask(clips().find((c) => c.id === text.id)!.maskJson)).toMatchObject({ shape: "circle" });
        const sticker = await controller.execute({ type: "clip.create", input: { trackType: "sticker", trackIndex: 1, startTime: 0, endTime: 2, textContent: "😀" } });
        const stickerId = sticker.createdClipIds![0];
        expect((await controller.execute({ type: "mask.set", clipId: stickerId, mask: { shape: "star", invert: true } })).ok).toBe(true);
        expect(parseMask(clips().find((c) => c.id === stickerId)!.maskJson)).toMatchObject({ shape: "star", invert: true });
        const audio = await controller.execute({ type: "clip.create", input: { trackType: "audio", trackIndex: 1, startTime: 0, endTime: 2, mediaType: "audio", mediaUrl: "a.mp3" } });
        expect((await controller.execute({ type: "mask.set", clipId: audio.createdClipIds![0], mask: { shape: "circle" } })).ok).toBe(false);
        expect((await controller.execute({ type: "mask.set", clipId: "nope", mask: { shape: "circle" } })).ok).toBe(false);
        expect((await controller.execute({ type: "mask.set", mask: { shape: "circle" } })).ok).toBe(false);
        const current = store.getState().timelineData!.tracks.filter((t) => !(t.type === "video" && t.index === 2) && !(t.type === "text" && t.index === 1));
        const locked = (type: "video" | "text", index: number) => ({ type, index, label: `${type}${index}`, muted: false, locked: true, visible: true, volume: 1 });
        await controller.execute({ type: "track.update", tracks: [...current, locked("video", 2), locked("text", 1)] });
        const result = await controller.execute({ type: "mask.set", clipId, mask: { shape: "circle" } });
        expect(result.ok).toBe(false);
        expect(result.error).toMatch(/locked/);
        expect((await controller.execute({ type: "mask.set", clipId: text.id, mask: { shape: "heart" } })).error).toMatch(/locked/);
    });

    it("targets (group mode, phase 10d): one patch on every maskable item in ONE undo step, keyed channels keyed per item", async () => {
        const { controller, clips, clipId, scenes, store } = await setup();
        const text = clips().find((c) => c.trackType === "text")!;
        const sceneId = scenes()[0].id;
        const audio = (await controller.execute({ type: "clip.create", input: { trackType: "audio", trackIndex: 1, startTime: 0, endTime: 2, mediaType: "audio", mediaUrl: "a.mp3" } })).createdClipIds![0];
        await controller.execute({ type: "mask.set", clipId, mask: { shape: "star", x: 0.2 } });
        await controller.execute({ type: "keyframe.set", sceneId, time: 0, values: { mask_x: 0.3 } });
        store.getState().setCurrentTime(1.5);
        const targets = [{ clipId }, { clipId: text.id }, { sceneId }, { clipId: audio }];
        const result = await controller.execute({ type: "mask.set", targets, mask: { shape: "circle", width: 0.4, x: 0.6 } });
        expect(result.ok).toBe(true);
        // The star keeps its other geometry and becomes a circle; the text gets a new circle; the audio clip is skipped.
        expect(parseMask(clips().find((c) => c.id === clipId)!.maskJson)).toMatchObject({ shape: "circle", width: 0.4, x: 0.6 });
        expect(parseMask(clips().find((c) => c.id === text.id)!.maskJson)).toMatchObject({ shape: "circle", width: 0.4, x: 0.6 });
        expect(clips().find((c) => c.id === audio)!.maskJson ?? null).toBeNull();
        // The scene's keyed mask_x is written as a keyframe at its own playhead time (scene-local 1.499).
        expect(parseTimelineKeyframes(scenes()[0].keyframesJson).map((p) => [p.time, p.mask_x])).toEqual([[0, 0.3], [1.499, 0.6]]);
        expect(parseMask(scenes()[0].maskJson)).toMatchObject({ shape: "circle", width: 0.4 });
        // ONE undo step restores every item.
        await controller.execute({ type: "history.undo" });
        expect(parseMask(clips().find((c) => c.id === clipId)!.maskJson)).toMatchObject({ shape: "star", x: 0.2 });
        expect(clips().find((c) => c.id === text.id)!.maskJson ?? null).toBeNull();
        expect(parseTimelineKeyframes(scenes()[0].keyframesJson).map((p) => p.time)).toEqual([0]);
        // null removes every mask (and the mask keyframes) at once.
        await controller.execute({ type: "history.redo" });
        await controller.execute({ type: "mask.set", targets, mask: null });
        expect([clipId, text.id].map((id) => clips().find((c) => c.id === id)!.maskJson ?? null)).toEqual([null, null]);
        expect(scenes()[0].maskJson ?? null).toBeNull();
        expect(parseTimelineKeyframes(scenes()[0].keyframesJson)).toEqual([]);
    });

    it("targets: refuses a group with no maskable item and bad targets", async () => {
        const { controller } = await setup();
        const audio = (await controller.execute({ type: "clip.create", input: { trackType: "audio", trackIndex: 1, startTime: 0, endTime: 2, mediaType: "audio", mediaUrl: "a.mp3" } })).createdClipIds![0];
        expect((await controller.execute({ type: "mask.set", targets: [{ clipId: audio }], mask: { shape: "circle" } })).ok).toBe(false);
        expect((await controller.execute({ type: "mask.set", targets: [{ clipId: "nope" }], mask: { shape: "circle" } })).ok).toBe(false);
        expect((await controller.execute({ type: "mask.set", targets: [], mask: { shape: "circle" } })).ok).toBe(false);
    });

    it("keyframe.set accepts the mask channels", async () => {
        const { controller, clipId, clips } = await setup();
        expect((await controller.execute({ type: "keyframe.set", clipId, time: 1, values: { mask_w: 0.4, mask_rotation: 15 } })).ok).toBe(true);
        expect(parseTimelineKeyframes(clips().find((c) => c.id === clipId)!.keyframesJson)).toEqual([{ time: 1, mask_w: 0.4, mask_rotation: 15 }]);
    });
});
