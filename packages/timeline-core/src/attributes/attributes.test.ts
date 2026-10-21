import type { TimelineClip, TimelineTrack } from "../model/timeline";
import type { SceneData } from "../timeline/canvas/types";
import { optimisticTimelineClipFromInput } from "../lib/timeline-optimistic";
import { parseTimelineKeyframes } from "../lib/timeline-editing-properties";
import { parseAdjustments } from "../looks/adjust";
import {
    ATTRIBUTE_KINDS, acceptedAttributeKinds, planAttributePaste, snapshotAttributes, type AttributePasteState,
} from "./attributes";

const clip = (id: string, input: Record<string, unknown> = {}): TimelineClip => ({
    ...optimisticTimelineClipFromInput({ trackType: "video", trackIndex: 2, startTime: 0, endTime: 4, mediaType: "video", mediaUrl: `${id}.mp4`, ...input }, "p1", id),
    ...(input.effects ? { effects: input.effects as TimelineClip["effects"] } : {}),
});

const scene = (id: string, partial: Partial<SceneData> = {}): SceneData => ({
    id, order: 0, caption: id, startTime: "00:00:00", endTime: "00:00:04", startImageUrl: null, endImageUrl: null,
    videoUrl: null, status: "ready", transition: "cut", frameConsistencyScore: null, audioUrl: null, audioText: null,
    cardConfig: null, cardType: "source_clip", duration: 4, trackIndex: 1, timelinePositionSeconds: 0.001, ...partial,
});

const track = (type: TimelineTrack["type"], index: number, locked = false): TimelineTrack => ({ type, index, label: `${type}${index}`, muted: false, locked, visible: true, volume: 1 });
const TRACKS = [track("video", 1), track("video", 2), track("video", 3, true), track("text", 1), track("audio", 1), track("sticker", 1)];

const effect = (id: string, effectId: string, order: number, owner: { clipId?: string; sceneId?: string }, extra: Partial<{ paramsJson: string | null; enabled: boolean }> = {}) => ({
    id, clipId: owner.clipId ?? null, sceneId: owner.sceneId ?? null, effectId, order, paramsJson: extra.paramsJson ?? null, enabled: extra.enabled ?? true, ownerScope: "project",
});

/** A styled video clip: filter, Adjust (legacy and JSON), two effects, an animation, 2× speed, and keyframes. */
function styledClip(): TimelineClip {
    return clip("a", {
        visualFilter: "warm", filterIntensity: 0.6,
        brightness: 0.2, contrast: 1.3, saturation: 0.8, adjustmentsJson: JSON.stringify({ exposure: 0.25, vignette: 0.4 }),
        animationJson: JSON.stringify({ in: { id: "fade_in", duration: 0.8 } }),
        playbackSpeed: 2, endTime: 2, positionX: 0.3, scale: 1.2,
        keyframesJson: JSON.stringify({ keyframes: [
            { time: 0, adj_exposure: 0, scale: 1 },
            { time: 1.5, adj_exposure: 0.5, scale: 1.4, easing: 2 },
            { time: 1.9, filter_intensity: 0.2 },
        ] }),
        effects: [effect("e1", "fx_blur", 0, { clipId: "a" }, { paramsJson: "{\"amount\":0.3}" }), effect("e2", "fx_pixelate", 1, { clipId: "a" }, { enabled: false })],
    });
}

function state(clips: TimelineClip[], scenes: SceneData[] = []): AttributePasteState {
    return { clips, scenes, tracks: TRACKS };
}

describe("snapshotAttributes", () => {
    it("copies every configured kind of a video clip, with keyframes of those kinds only", () => {
        const snap = snapshotAttributes({ kind: "clip", clip: styledClip() });
        expect(snap.version).toBe(1);
        expect(snap.source).toMatchObject({ itemType: "clip", id: "a", trackType: "video", mediaType: "video" });
        expect(snap.kinds).toEqual(["filter", "adjust", "effects", "animation", "speed", "transform"]);
        expect(snap.values.filter).toEqual({ visualFilter: "warm", filterIntensity: 0.6 });
        expect(snap.values.adjust?.adjustments).toMatchObject({ brightness: 0.2, contrast: 0.3, saturation: -0.2, exposure: 0.25, vignette: 0.4 });
        expect(snap.values.effects?.rows).toEqual([
            { effectId: "fx_blur", paramsJson: "{\"amount\":0.3}", enabled: true },
            { effectId: "fx_pixelate", paramsJson: null, enabled: false },
        ]);
        expect(snap.values.speed).toEqual({ speed: 2, curve: null, preservePitch: true });
        expect(snap.duration).toBe(2);
        // scale keyframes belong to "transform", adj_ to "adjust", filter_intensity to "filter".
        expect(snap.keyframes.map((p) => Object.keys(p).sort())).toEqual([["adj_exposure", "scale", "time"], ["adj_exposure", "easing", "scale", "time"], ["filter_intensity", "time"]]);
    });

    it("has no kinds for a plain clip, and text clips only offer animation, mask (phase 10d), and transform", () => {
        expect(snapshotAttributes({ kind: "clip", clip: clip("p") }).kinds).toEqual([]);
        const text = clip("t", { trackType: "text", trackIndex: 1, mediaType: "text", positionY: 0.8, visualFilter: "warm", animationJson: JSON.stringify({ loop: { id: "pulse", period: 1 } }) });
        expect(snapshotAttributes({ kind: "clip", clip: text }).kinds).toEqual(["animation", "transform"]);
        expect(acceptedAttributeKinds({ kind: "clip", clip: text })).toEqual(["animation", "mask", "transform"]);
    });

    it("lists which kinds each item type takes", () => {
        expect(acceptedAttributeKinds({ kind: "scene", scene: scene("s") })).toEqual([...ATTRIBUTE_KINDS]);
        expect(acceptedAttributeKinds({ kind: "clip", clip: clip("v") })).toEqual([...ATTRIBUTE_KINDS]);
        expect(acceptedAttributeKinds({ kind: "clip", clip: clip("i", { mediaType: "image" }) })).toEqual(["filter", "adjust", "effects", "animation", "mask", "transform"]);
        expect(acceptedAttributeKinds({ kind: "clip", clip: clip("s", { trackType: "sticker", trackIndex: 1, mediaType: "sticker" }) })).toEqual(["filter", "adjust", "effects", "animation", "mask", "transform"]);
        expect(acceptedAttributeKinds({ kind: "clip", clip: clip("au", { trackType: "audio", trackIndex: 1, mediaType: "audio" }) })).toEqual(["speed"]);
        expect(acceptedAttributeKinds({ kind: "clip", clip: clip("fx", { trackType: "effect", trackIndex: 1, mediaType: "effect" }) })).toEqual([]);
    });

    it("graphics clips take animation and transform (phase 10c) and paste them onto each other", () => {
        const graphic = (id: string, input: Record<string, unknown> = {}) => clip(id, { trackType: "remotion", trackIndex: 1, mediaType: "remotion", ...input });
        expect(acceptedAttributeKinds({ kind: "clip", clip: graphic("g") })).toEqual(["animation", "transform"]);
        const source = graphic("g1", { rotationDegrees: 30, scale: 1.5, animationJson: JSON.stringify({ in: { id: "fade_in", duration: 0.5 } }) });
        const plan = planAttributePaste(state([source, graphic("g2")]), snapshotAttributes({ kind: "clip", clip: source }), [{ clipId: "g2" }], ["animation", "transform"]);
        expect(plan.clipUpdates[0]).toMatchObject({ clipId: "g2", rotationDegrees: 30, scale: 1.5, animationJson: JSON.stringify({ in: { id: "fade_in", duration: 0.5 } }) });
    });

    it("copies a mask only when the item has one (maskJson and mask_ channels)", () => {
        const masked = { ...clip("m"), maskJson: "{\"shape\":\"circle\"}", keyframesJson: JSON.stringify({ keyframes: [{ time: 0.5, mask_x: 0.2 }] }) } as TimelineClip;
        const snap = snapshotAttributes({ kind: "clip", clip: masked });
        expect(snap.kinds).toEqual(["mask"]);
        expect(snap.values.mask).toEqual({ maskJson: "{\"shape\":\"circle\"}" });
        expect(snap.keyframes).toEqual([{ time: 0.5, mask_x: 0.2 }]);
    });

    it("snapshots a scene's look, effects, animation, and speed", () => {
        const s = scene("s", {
            visualFilter: "warm", filterIntensity: 0.5, adjustmentsJson: JSON.stringify({ brightness: 0.1, grain: 0.3 }),
            effects: [effect("se", "fx_blur", 0, { sceneId: "s" })], animationJson: JSON.stringify({ combo: { id: "combo_swing" } }), playbackSpeed: 0.5,
        });
        const snap = snapshotAttributes({ kind: "scene", scene: s });
        expect(snap.kinds).toEqual(["filter", "adjust", "effects", "animation", "speed"]);
        expect(snap.source).toEqual({ itemType: "scene", id: "s", label: "s" });
        expect(snap.duration).toBe(8);
        expect(JSON.parse(JSON.stringify(snap))).toEqual(snap);
    });
});

describe("planAttributePaste", () => {
    it("writes filter, Adjust (legacy clip fields), animation, and keyframe channels onto another clip", () => {
        const source = styledClip();
        const target = clip("b", { startTime: 5, endTime: 9, keyframesJson: JSON.stringify({ keyframes: [{ time: 0, adj_contrast: 0.4, position_x: 0.1 }] }) });
        const plan = planAttributePaste(state([source, target]), snapshotAttributes({ kind: "clip", clip: source }), [{ clipId: "b" }], ["filter", "adjust", "animation"]);
        expect(plan.applied).toEqual([{ clipId: "b", kinds: ["filter", "adjust", "animation"] }]);
        expect(plan.skipped).toEqual([]);
        expect(plan.effectStacks).toEqual([]);
        expect(plan.clipUpdates).toHaveLength(1);
        const update = plan.clipUpdates[0];
        expect(update).toMatchObject({ clipId: "b", startTime: 5, endTime: 9, visualFilter: "warm", filterIntensity: 0.6, brightness: 0.2, contrast: 1.3, saturation: 0.8, animationJson: source.animationJson });
        expect(parseAdjustments(update.adjustmentsJson)).toMatchObject({ exposure: 0.25, vignette: 0.4, brightness: 0 });
        // The target's adj_contrast keyframe is replaced by the source's Adjust channels; its position keyframe stays.
        expect(parseTimelineKeyframes(update.keyframesJson)).toEqual([
            { time: 0, position_x: 0.1, adj_exposure: 0 },
            { time: 1.5, adj_exposure: 0.5, easing: 2 },
            { time: 1.9, filter_intensity: 0.2 },
        ]);
    });

    it("maps Adjust between clips and scenes, and copies effects with the target as owner", () => {
        const source = styledClip();
        const s = scene("s", { effects: [effect("old", "fx_zoom_blur", 0, { sceneId: "s" })] });
        const plan = planAttributePaste(state([source], [s]), snapshotAttributes({ kind: "clip", clip: source }), [{ sceneId: "s" }], ["adjust", "effects"]);
        expect(plan.scenePatches).toHaveLength(1);
        expect(parseAdjustments(plan.scenePatches[0].patch.adjustmentsJson)).toMatchObject({ brightness: 0.2, contrast: 0.3, saturation: -0.2, exposure: 0.25, vignette: 0.4 });
        expect(plan.effectStacks).toEqual([{ sceneId: "s", rows: [
            { effectId: "fx_blur", paramsJson: "{\"amount\":0.3}", enabled: true },
            { effectId: "fx_pixelate", paramsJson: null, enabled: false },
        ] }]);

        const back = planAttributePaste(state([clip("c")], [{ ...s, adjustmentsJson: JSON.stringify({ brightness: -0.4, contrast: 0.5, fade: 0.2 }) }]),
            snapshotAttributes({ kind: "scene", scene: { ...s, adjustmentsJson: JSON.stringify({ brightness: -0.4, contrast: 0.5, fade: 0.2 }) } }), [{ clipId: "c" }], ["adjust"]);
        expect(back.clipUpdates[0]).toMatchObject({ brightness: -0.4, contrast: 1.5, saturation: 1 });
        expect(parseAdjustments(back.clipUpdates[0].adjustmentsJson)).toMatchObject({ fade: 0.2, brightness: 0 });
    });

    it("leaves an equal effect stack alone", () => {
        const source = styledClip();
        const twin = clip("b", { effects: [effect("x1", "fx_blur", 0, { clipId: "b" }, { paramsJson: "{\"amount\":0.3}" }), effect("x2", "fx_pixelate", 1, { clipId: "b" }, { enabled: false })] });
        const plan = planAttributePaste(state([source, twin]), snapshotAttributes({ kind: "clip", clip: source }), [{ clipId: "b" }], ["effects"]);
        expect(plan.applied).toEqual([{ clipId: "b", kinds: ["effects"] }]);
        expect(plan.effectStacks).toEqual([]);
        expect(plan.clipUpdates).toEqual([]);
    });

    it("pastes speed with speed.set rules: the length follows, keyframes rescale, and later clips are pushed", () => {
        const source = styledClip();
        const target = clip("b", { startTime: 4, endTime: 8, keyframesJson: JSON.stringify({ keyframes: [{ time: 2, position_x: 0.2 }] }) });
        const next = clip("n", { startTime: 8, endTime: 9 });
        const plan = planAttributePaste(state([source, target, next]), snapshotAttributes({ kind: "clip", clip: source }), [{ clipId: "b" }], ["speed"]);
        const own = plan.clipUpdates.find((u) => u.clipId === "b")!;
        expect(own).toMatchObject({ startTime: 4, endTime: 6, playbackSpeed: 2, speedCurveJson: null, preservePitch: true, speedRamp: "none" });
        expect(parseTimelineKeyframes(own.keyframesJson)).toEqual([{ time: 1, position_x: 0.2 }]);
        // 2× halves b: n is not overlapped, and speed.set only pushes on overlap (no gap closing off the main track).
        expect(plan.clipUpdates.find((u) => u.clipId === "n")).toBeUndefined();

        const slow = { ...source, playbackSpeed: 0.5, endTime: 8 };
        const slower = planAttributePaste(state([slow, target, next]), snapshotAttributes({ kind: "clip", clip: slow }), [{ clipId: "b" }], ["speed"]);
        expect(slower.clipUpdates.find((u) => u.clipId === "b")).toMatchObject({ endTime: 12 });
        expect(slower.clipUpdates.find((u) => u.clipId === "n")).toMatchObject({ startTime: 12, endTime: 13 });
    });

    it("pastes speed onto scenes with the ripple of later scenes and clips", () => {
        const source = styledClip();
        const a = scene("s1", { duration: 4, timelinePositionSeconds: 0.001 });
        const b = scene("s2", { duration: 2, timelinePositionSeconds: 4.001, order: 1 });
        const later = clip("late", { trackType: "text", trackIndex: 1, mediaType: "text", startTime: 5, endTime: 6 });
        const plan = planAttributePaste(state([source, later], [a, b]), snapshotAttributes({ kind: "clip", clip: source }), [{ sceneId: "s1" }], ["speed"]);
        expect(plan.scenePatches).toEqual([{ sceneId: "s1", patch: { playbackSpeed: 2, speedCurveJson: null, preservePitch: true } }]);
        expect(plan.sceneMoves).toEqual([{ sceneId: "s2", timelinePositionSeconds: 2.001 }]);
        expect(plan.clipUpdates).toEqual([{ clipId: "late", startTime: 3, endTime: 4 }]);
    });

    it("skips locked, missing, pending, and source targets, and kinds a target cannot take", () => {
        const source = styledClip();
        const text = clip("t", { trackType: "text", trackIndex: 1, mediaType: "text" });
        const locked = clip("l", { trackIndex: 3 });
        const plan = planAttributePaste(state([source, text, locked]), snapshotAttributes({ kind: "clip", clip: source }),
            [{ clipId: "t" }, { clipId: "l" }, { clipId: "nope" }, { clipId: "temp-1" }, { clipId: "a" }, { clipId: "t" }], ["filter", "effects", "speed", "animation", "mask"]);
        expect(plan.applied).toEqual([]);
        expect(plan.skipped).toEqual([
            { kind: "mask", reason: "not-in-clipboard" },
            { clipId: "t", kind: "filter", reason: "not-supported" },
            { clipId: "t", kind: "effects", reason: "not-supported" },
            { clipId: "t", kind: "speed", reason: "not-supported" },
            // fade_in is a clip animation: text has no such id.
            { clipId: "t", kind: "animation", reason: "not-supported" },
            { clipId: "l", reason: "locked" },
            { clipId: "nope", reason: "missing" },
            { clipId: "temp-1", reason: "missing" },
            { clipId: "a", reason: "source" },
        ]);
        expect(plan.clipUpdates).toEqual([]);
    });

    it("keeps only the animation slots the target family has", () => {
        const text = clip("t", { trackType: "text", trackIndex: 1, mediaType: "text", animationJson: JSON.stringify({ in: { id: "fade", duration: 0.4 }, loop: { id: "pulse", period: 1 } }) });
        const sticker = clip("st", { trackType: "sticker", trackIndex: 1, mediaType: "sticker" });
        const video = clip("v");
        const plan = planAttributePaste(state([text, sticker, video]), snapshotAttributes({ kind: "clip", clip: text }), [{ clipId: "st" }, { clipId: "v" }], ["animation"]);
        // Stickers take the motion-only text loops; "fade" is a text in animation (clips call it fade_in).
        expect(plan.clipUpdates.find((u) => u.clipId === "st")?.animationJson).toBe(JSON.stringify({ loop: { id: "pulse", period: 1 } }));
        expect(plan.skipped).toEqual([{ clipId: "v", kind: "animation", reason: "not-supported" }]);
    });

    it("pastes transform only between items of the same type, with its keyframe channels", () => {
        const source = styledClip();
        const other = clip("b");
        const s = scene("s");
        const plan = planAttributePaste(state([source, other], [s]), snapshotAttributes({ kind: "clip", clip: source }), [{ clipId: "b" }, { sceneId: "s" }], ["transform"]);
        expect(plan.clipUpdates[0]).toMatchObject({ clipId: "b", positionX: 0.3, scale: 1.2 });
        expect(parseTimelineKeyframes(plan.clipUpdates[0].keyframesJson)).toEqual([{ time: 0, scale: 1 }, { time: 1.5, scale: 1.4, easing: 2 }]);
        expect(plan.skipped).toEqual([{ sceneId: "s", kind: "transform", reason: "not-supported" }]);
    });

    it("cuts keyframes past a shorter target's end with the value the curve has there", () => {
        const source = clip("a", { endTime: 6, keyframesJson: JSON.stringify({ keyframes: [{ time: 0, adj_exposure: 0 }, { time: 4, adj_exposure: 0.8 }] }) });
        const short = clip("b", { startTime: 10, endTime: 12 });
        const plan = planAttributePaste(state([source, short]), snapshotAttributes({ kind: "clip", clip: source }), [{ clipId: "b" }], ["adjust"]);
        expect(parseTimelineKeyframes(plan.clipUpdates[0].keyframesJson)).toEqual([{ time: 0, adj_exposure: 0 }, { time: 2, adj_exposure: 0.4 }]);
    });

    it("pastes a mask only onto items that take one", () => {
        const masked = { ...clip("m"), maskJson: "{\"shape\":\"circle\"}" } as TimelineClip;
        const plan = planAttributePaste(state([masked, clip("b"), clip("au", { trackType: "audio", trackIndex: 1, mediaType: "audio" })], [scene("s")]),
            snapshotAttributes({ kind: "clip", clip: masked }), [{ clipId: "b" }, { sceneId: "s" }, { clipId: "au" }], ["mask"]);
        expect(plan.clipUpdates[0]).toMatchObject({ clipId: "b", maskJson: "{\"shape\":\"circle\"}" });
        expect(plan.scenePatches).toEqual([{ sceneId: "s", patch: { maskJson: "{\"shape\":\"circle\"}" } }]);
        expect(plan.skipped).toEqual([{ clipId: "au", kind: "mask", reason: "not-supported" }]);
    });

    it("pastes a mask (with its keyframes) between video, text, and sticker clips (phase 10d)", () => {
        const text = (id: string, input: Record<string, unknown> = {}) => clip(id, { trackType: "text", trackIndex: 1, mediaType: "text", textContent: "hi", ...input });
        const masked = text("t1", { maskJson: "{\"shape\":\"star\"}", keyframesJson: JSON.stringify({ keyframes: [{ time: 0.5, mask_x: 0.2 }] }) });
        const sticker = clip("st", { trackType: "sticker", trackIndex: 1, mediaType: "sticker", textContent: "😀" });
        const snap = snapshotAttributes({ kind: "clip", clip: masked });
        expect(snap.kinds).toEqual(["mask"]);
        const plan = planAttributePaste(state([masked, text("t2"), sticker, clip("v")]), snap, [{ clipId: "t2" }, { clipId: "st" }, { clipId: "v" }], ["mask"]);
        expect(plan.skipped).toEqual([]);
        for (const id of ["t2", "st", "v"]) {
            const update = plan.clipUpdates.find((u) => u.clipId === id)!;
            expect(update.maskJson).toBe("{\"shape\":\"star\"}");
            expect(parseTimelineKeyframes(update.keyframesJson)).toEqual([{ time: 0.5, mask_x: 0.2 }]);
        }
    });
});
