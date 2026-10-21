import { describe, expect, it } from "vitest";
import type { LaneScene } from "./lane-look-plan";
import { itemLook } from "@opennan/timeline-core/looks/look-plan";
import type { TimelineKeyframePoint } from "@opennan/timeline-core/lib/timeline-editing-properties";
import { IDENTITY_LUT_KEY, cssTransitionRanges, keyframeLookSource, laneLookFrame, laneSceneSource, lookKeyframeMix, type LaneRange } from "./lane-look-plan";

const range = (id: string, start: number, end: number, patch: Partial<LaneScene> = {}, transitionType = "none", transitionDuration = 0): LaneRange => ({
    scene: { id, ...patch } as LaneScene, start, end, trackIndex: 1, transitionType, transitionDuration,
});

describe("laneLookFrame", () => {
    const ranges = [
        range("a", 0, 2, { visualFilter: "noir" }, "wipe_left", 1),
        range("b", 2, 4),
        range("c", 4, 5, {}, "spin", 0.5),
        range("d", 5, 6, { adjustmentsJson: '{"exposure":0.3}' }),
    ];

    it("draws nothing for a plain scene and the scene's look otherwise", () => {
        expect(laneLookFrame(ranges, 3)).toEqual({ kind: "none" });
        const frame = laneLookFrame(ranges, 0.5);
        expect(frame.kind === "scene" && frame.side.scene.id).toBe("a");
        expect(frame.kind === "scene" && frame.side.local).toBe(0.5);
    });

    it("centers windows on cuts: live outgoing then held, held incoming then live", () => {
        const before = laneLookFrame(ranges, 1.75);
        expect(before).toMatchObject({ kind: "window", transitionId: "wipe_left", p: 0.25, a: { local: 1.75, live: true }, b: { local: 0, live: false } });
        const after = laneLookFrame(ranges, 2.25);
        expect(after.kind === "window" && after.a).toMatchObject({ live: false });
        expect(after.kind === "window" && after.a.local).toBeCloseTo(2 - 1 / 30, 9);
        expect(after.kind === "window" && after.b).toMatchObject({ local: 0.25, live: true });
        // c→d: 0.5 s spin, half 0.25 (min of 0.25, 0.5, 0.5)
        expect(laneLookFrame(ranges, 4.8)).toMatchObject({ kind: "window", transitionId: "spin" });
        expect(laneLookFrame(ranges, 4.7).kind).toBe("none");
    });
});

describe("laneLookFrame live handles", () => {
    const trims = (start: number, end: number, content: number) => JSON.stringify({ timelineTrimStart: start, timelineTrimEnd: end, timelineSourceDuration: content });
    // a: media 1..3 of 3.1 s (0.1 s = 3 frames after its end); b: media 0.2..2.2 (0.2 s before its start).
    const lane = [
        range("a", 0, 2, { videoUrl: "a.mp4", cardConfig: trims(1, 3, 3.1) }, "wipe_left", 1),
        range("b", 2, 4, { videoUrl: "b.mp4", cardConfig: trims(0.2, 2.2, 9) }),
    ];

    it("after the cut the outgoing side plays real media through the decoder, then holds the last real frame", () => {
        const inside = laneLookFrame(lane, 2.05);
        expect(inside.kind === "window" && inside.a).toMatchObject({ live: false, decoder: true });
        expect(inside.kind === "window" && inside.a.local).toBeCloseTo(2.05, 9);
        expect(inside.kind === "window" && laneSceneSource(inside.a.scene, inside.a.local, inside.a.length)?.time).toBeCloseTo(3.05, 9);
        const held = laneLookFrame(lane, 2.3);
        expect(held.kind === "window" && held.a).toMatchObject({ live: false, decoder: false });
        expect(held.kind === "window" && held.a.local).toBeCloseTo(2.1 - 1 / 30, 9);
        expect(held.kind === "window" && held.a.heldLocal).toBeCloseTo(2.1 - 1 / 30, 9);
        expect(held.kind === "window" && laneSceneSource(held.a.scene, held.a.local, held.a.length)?.time).toBeCloseTo(3.1 - 1 / 30, 9);
    });

    it("before the cut the incoming side holds its first real frame, then plays real media up to its start", () => {
        const early = laneLookFrame(lane, 1.6);
        expect(early.kind === "window" && early.b).toMatchObject({ live: false, decoder: false });
        expect(early.kind === "window" && early.b.local).toBeCloseTo(-0.2, 9);
        expect(early.kind === "window" && laneSceneSource(early.b.scene, early.b.local, early.b.length)?.time).toBeCloseTo(0, 9);
        const late = laneLookFrame(lane, 1.85);
        expect(late.kind === "window" && late.b).toMatchObject({ live: false, decoder: true });
        expect(late.kind === "window" && late.b.local).toBeCloseTo(-0.15, 9);
        expect(late.kind === "window" && late.b.heldLocal).toBeCloseTo(-0.2, 9);
        expect(late.kind === "window" && laneSceneSource(late.b.scene, late.b.local, late.b.length)?.time).toBeCloseTo(0.05, 9);
    });

    it("sides without handle media keep the 10a held frames", () => {
        const plain = laneLookFrame([range("a", 0, 2, {}, "wipe_left", 1), range("b", 2, 4)], 2.25);
        expect(plain.kind === "window" && plain.a).toMatchObject({ live: false, decoder: false });
        expect(plain.kind === "window" && plain.a.local).toBeCloseTo(2 - 1 / 30, 9);
    });
});

describe("laneSceneSource", () => {
    it("reads a scene video at its trim offset", () => {
        expect(laneSceneSource({ id: "a", videoUrl: "v.mp4", cardConfig: '{"timelineTrimStart":1.5}' }, 2, 4)).toEqual({ url: "v.mp4", video: true, time: 3.5 });
    });

    it("reads a shot-sequenced scene from the shot under the playhead, at shot-local time (the export's ScenePiece rule)", () => {
        const scene = { id: "s", shotBreakdown: JSON.stringify([{ video_url: "one.mp4", duration: 2 }, { video_url: "two.mp4", duration: 2 }]) };
        // Shots total 4 s over a 2 s scene: timeScale 2, shot two covers scene-local [1, 2).
        expect(laneSceneSource(scene, 0.5, 2)).toEqual({ url: "one.mp4", video: true, time: 1 });
        expect(laneSceneSource(scene, 1.25, 2)).toEqual({ url: "two.mp4", video: true, time: 0.5 });
        // The held last frame stays inside the last shot.
        expect(laneSceneSource(scene, 2, 2)?.url).toBe("two.mp4");
    });

    it("maps a sped-up scene's local time through its time map (2× and a curve)", () => {
        // 2×: 3 s of source over a 1.5 s scene; local 1 s shows source 2 s past the trim.
        expect(laneSceneSource({ id: "f", videoUrl: "v.mp4", playbackSpeed: 2, cardConfig: '{"timelineTrimStart":1,"timelineTrimEnd":4}' }, 1, 1.5)?.time).toBeCloseTo(3, 9);
        // A slow-middle curve: the held last frame (local ≈ length) lands at the end of the source span.
        const curve = { id: "c", videoUrl: "v.mp4", speedCurveJson: JSON.stringify({ id: "custom", points: [[0, 2], [0.5, 2], [0.5, 0.5], [1, 0.5]] }) };
        // mean 1.25: a 5 s source span lasts 4 s; the first half (2 s at 2×) covers 4 s of source.
        expect(laneSceneSource(curve, 2, 4)?.time).toBeCloseTo(4, 9);
        expect(laneSceneSource(curve, 4, 4)?.time).toBeCloseTo(5, 9);
        expect(laneSceneSource(curve, 1, 4)?.time).toBeCloseTo(2, 9);
    });

    it("warps a shot-sequenced scene's local time by its curve", () => {
        const scene = {
            id: "s",
            shotBreakdown: JSON.stringify([{ video_url: "one.mp4", duration: 4 }, { video_url: "two.mp4", duration: 1 }]),
            speedCurveJson: JSON.stringify({ id: "custom", points: [[0, 2], [0.5, 2], [0.5, 0.5], [1, 0.5]] }),
        };
        // 5 s of shots over a 4 s scene; the 2× first half plays all of shot one.
        expect(laneSceneSource(scene, 1.9, 4)).toMatchObject({ url: "one.mp4" });
        expect(laneSceneSource(scene, 1.9, 4)?.time).toBeCloseTo(3.8, 9);
        expect(laneSceneSource(scene, 3, 4)).toMatchObject({ url: "two.mp4" });
        expect(laneSceneSource(scene, 3, 4)?.time).toBeCloseTo(0.5, 9);
    });

    it("falls back to the start image", () => {
        expect(laneSceneSource({ id: "i", startImageUrl: "a.png" }, 1, 3)).toEqual({ url: "a.png", video: false, time: 0 });
        expect(laneSceneSource({ id: "n" }, 1, 3)).toBeNull();
    });
});

describe("cssTransitionRanges", () => {
    const lanes = [range("a", 0, 2, {}, "dip_black", 1), range("b", 2, 4), { ...range("c", 0, 2, {}, "dip_black", 1), trackIndex: 2 }, { ...range("d", 2, 4), trackIndex: 2 }];

    it("leaves V1 to the looks overlay with WebGL2 and keeps CSS transitions for V2 and up", () => {
        expect(cssTransitionRanges(lanes, true).map((r) => r.scene.id)).toEqual(["c", "d"]);
    });

    it("keeps every lane on CSS without WebGL2", () => {
        expect(cssTransitionRanges(lanes, false)).toHaveLength(4);
    });
});

describe("laneLookFrame side lengths", () => {
    it("gives each side its scene length (shot timing needs it)", () => {
        const frame = laneLookFrame([range("a", 0, 2, { visualFilter: "noir" }, "wipe_left", 1), range("b", 2, 5)], 1.8);
        expect(frame).toMatchObject({ kind: "window", a: { length: 2 }, b: { length: 3 } });
    });
});

const keyframes = (points: Array<Record<string, number>>) => JSON.stringify({ keyframes: points });

describe("lookKeyframeMix (Adjust keyframes as CLUT cross-fades)", () => {
    const points: TimelineKeyframePoint[] = [{ time: 1, adj_exposure: 0.2 }, { time: 3, adj_exposure: 0.6, easing: 1 }, { time: 5, adj_exposure: 0, easing: 4 }, { time: 7, adj_exposure: 0.4 }];

    it("holds the first and last keyframes outside and blends with the starting point's easing inside", () => {
        expect(lookKeyframeMix([], 2)).toBeNull();
        expect(lookKeyframeMix([{ time: 1, scale: 2 }, { time: 2, opacity: 0 }], 1.5)).toBeNull();
        expect(lookKeyframeMix(points, 0)).toEqual({ from: 1, to: 1, w: 0 });
        expect(lookKeyframeMix(points, 9)).toEqual({ from: 7, to: 7, w: 0 });
        // Linear from 1 s.
        expect(lookKeyframeMix(points, 2)).toEqual({ from: 1, to: 3, w: 0.5 });
        // Segments cover (t_k, t_k+1] like channelValueAt: exactly on a keyframe is the end of the segment before it.
        expect(lookKeyframeMix(points, 3)).toEqual({ from: 1, to: 3, w: 1 });
        // Ease in (cubic) from 3 s.
        expect(lookKeyframeMix(points, 4)!.w).toBeCloseTo(0.125, 12);
        // Hold from 5 s: the 5 s look until 7 s.
        expect(lookKeyframeMix(points, 6.99)).toEqual({ from: 5, to: 7, w: 0 });
    });

    it("takes filter_intensity keyframes too and ignores transform-only points between them", () => {
        const mixed: TimelineKeyframePoint[] = [{ time: 0, filter_intensity: 0 }, { time: 1, scale: 3 }, { time: 2, filter_intensity: 1 }];
        expect(lookKeyframeMix(mixed, 1)).toEqual({ from: 0, to: 2, w: 0.5 });
    });
});

describe("keyframeLookSource", () => {
    it("substitutes each keyframe's channel values (other channels from their own curves, the rest from the item)", () => {
        const points: TimelineKeyframePoint[] = [{ time: 0, adj_exposure: 0.2 }, { time: 2, adj_contrast: -0.4 }, { time: 4, adj_exposure: 0.6, filter_intensity: 0.5 }];
        const scene = { kind: "scene" as const, visualFilter: "noir", filterIntensity: 1, adjustmentsJson: '{"vignette":0.3,"exposure":0.9}' };
        const at2 = keyframeLookSource(scene, points, 2);
        expect(JSON.parse(at2.adjustmentsJson!)).toEqual({ exposure: 0.4, contrast: -0.4, vignette: 0.3 });
        // A channel with one point holds it everywhere (the 10a rule), whatever the item field says.
        expect(at2.filterIntensity).toBe(0.5);
        // Clips keep brightness / contrast / saturation in their own fields.
        const clip = keyframeLookSource({ kind: "clip", brightness: 0.1, contrast: 1.2, saturation: 1 }, [{ time: 0, adj_contrast: -0.5, adj_brightness: 0.3 }], 0);
        expect(clip).toMatchObject({ brightness: 0.3, contrast: 0.5, saturation: 1 });
    });
});

describe("laneLookFrame with Adjust keyframes", () => {
    it("leaves static looks unchanged (no mix)", () => {
        const frame = laneLookFrame([range("a", 0, 4, { visualFilter: "noir" })], 1);
        expect(frame.kind === "scene" && frame.side.mix).toBeNull();
        expect(frame.kind === "scene" && frame.side.plan?.steps.map((s) => s.kind)).toEqual(itemLook({ kind: "scene", visualFilter: "noir" })!.steps.map((s) => s.kind));
    });

    it("draws a keyframed scene without a static look and mixes the surrounding keyframes' CLUTs", () => {
        const scene = { keyframesJson: keyframes([{ time: 1, adj_exposure: 0 }, { time: 3, adj_exposure: 0.5 }]) };
        const frame = laneLookFrame([range("k", 10, 14, scene)], 12);
        expect(frame.kind).toBe("scene");
        if (frame.kind !== "scene") return;
        expect(frame.side.mix?.w).toBe(0.5);
        // The neutral keyframe is the identity CLUT (the export runs every keyframe through haldclut).
        expect(frame.side.mix?.a.key).toBe(IDENTITY_LUT_KEY);
        const expected = itemLook({ kind: "scene", adjustmentsJson: '{"exposure":0.5}' })!.steps[0] as { key: string };
        expect(frame.side.mix?.b.key).toBe(expected.key);
        expect(frame.side.mix?.b.fn([0.5, 0.5, 0.5])[0]).toBeGreaterThan(0.5);
        expect(frame.side.plan).toBeNull();
    });

    it("keeps the spatial steps and effects after the mixed CLUT", () => {
        const scene = { adjustmentsJson: '{"vignette":0.4,"brightness":0.2}', keyframesJson: keyframes([{ time: 0, adj_brightness: -0.2 }, { time: 2, adj_brightness: 0.2 }]) };
        const frame = laneLookFrame([range("v", 0, 4, scene)], 1);
        if (frame.kind !== "scene") throw new Error("expected a scene");
        expect(frame.side.plan?.steps.map((s) => s.kind)).toEqual(["vignette"]);
        expect(frame.side.mix?.w).toBe(0.5);
        // Each side of a transition window gets its own mix at its own local time.
        const window = laneLookFrame([range("v", 0, 4, scene, "wipe_left", 1), range("w", 4, 8, scene)], 4.25);
        expect(window).toMatchObject({ kind: "window", b: { local: 0.25 } });
        expect(window.kind === "window" && window.b.mix?.w).toBeCloseTo(0.125, 12);
        expect(window.kind === "window" && window.a.mix).toMatchObject({ from: 2, to: 2 });
    });
});

describe("masks on the main track (phase 10c)", () => {
    it("a masked scene without a look draws through the overlay with the mask step; its time is scene-local", () => {
        const masked = [range("m", 1, 4, { maskJson: '{"shape":"circle"}' })];
        const frame = laneLookFrame(masked, 2.5);
        expect(frame.kind).toBe("scene");
        expect(frame.kind === "scene" && frame.side.plan?.steps.map((s) => s.kind)).toEqual(["mask"]);
        expect(frame.kind === "scene" && frame.side.local).toBe(1.5);
    });
});
