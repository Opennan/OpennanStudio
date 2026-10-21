import { describe, expect, it } from "vitest";
import { evaluateScalar } from "../looks/expr";
import { itemLook } from "../looks/look-plan";
import type { TimelineKeyframePoint } from "../lib/timeline-editing-properties";
import {
    IDENTITY_LUT_KEY, LOOK_KEYFRAME_LIMIT, keyframeLookSource, keyframeLut, keyframedLook, lookKeyframeMix, lookKeyframeTimes,
    lookMixLevel, lookMixWeight, lookSegmentWeight,
} from "./look-keyframes";

describe("lookKeyframeMix (Adjust keyframes as CLUT cross-fades)", () => {
    const points: TimelineKeyframePoint[] = [{ time: 1, adj_exposure: 0.2 }, { time: 3, adj_exposure: 0.6, easing: 1 }, { time: 5, adj_exposure: 0, easing: 4 }, { time: 7, adj_exposure: 0.4 }];

    it("holds the first and last keyframes outside and blends with the starting point's easing inside", () => {
        expect(lookKeyframeMix([], 2)).toBeNull();
        expect(lookKeyframeMix([{ time: 1, scale: 2 }, { time: 2, opacity: 0 }], 1.5)).toBeNull();
        expect(lookKeyframeMix(points, 0)).toEqual({ from: 1, to: 1, w: 0 });
        expect(lookKeyframeMix(points, 9)).toEqual({ from: 7, to: 7, w: 0 });
        expect(lookKeyframeMix(points, 2)).toEqual({ from: 1, to: 3, w: 0.5 });
        // Segments cover (t_k, t_k+1] like channelValueAt.
        expect(lookKeyframeMix(points, 3)).toEqual({ from: 1, to: 3, w: 1 });
        expect(lookKeyframeMix(points, 4)!.w).toBeCloseTo(0.125, 12);
        expect(lookKeyframeMix(points, 6.99)).toEqual({ from: 5, to: 7, w: 0 });
    });

    it("takes filter_intensity keyframes too and ignores transform-only points between them", () => {
        const mixed: TimelineKeyframePoint[] = [{ time: 0, filter_intensity: 0 }, { time: 1, scale: 3 }, { time: 2, filter_intensity: 1 }];
        expect(lookKeyframeTimes(mixed)).toEqual([0, 2]);
        expect(lookKeyframeMix(mixed, 1)).toEqual({ from: 0, to: 2, w: 0.5 });
    });
});

describe("keyframeLookSource / keyframeLut", () => {
    it("substitutes each keyframe's channel values (other channels from their own curves, the rest from the item)", () => {
        const points: TimelineKeyframePoint[] = [{ time: 0, adj_exposure: 0.2 }, { time: 2, adj_contrast: -0.4 }, { time: 4, adj_exposure: 0.6, filter_intensity: 0.5 }];
        const scene = { kind: "scene" as const, visualFilter: "noir", filterIntensity: 1, adjustmentsJson: '{"vignette":0.3,"exposure":0.9}' };
        const at2 = keyframeLookSource(scene, points, 2);
        expect(JSON.parse(at2.adjustmentsJson!)).toEqual({ exposure: 0.4, contrast: -0.4, vignette: 0.3 });
        expect(at2.filterIntensity).toBe(0.5);
        const clip = keyframeLookSource({ kind: "clip", brightness: 0.1, contrast: 1.2, saturation: 1 }, [{ time: 0, adj_contrast: -0.5, adj_brightness: 0.3 }], 0);
        expect(clip).toMatchObject({ brightness: 0.3, contrast: 0.5, saturation: 1 });
    });

    it("gives a neutral keyframe the identity CLUT and a graded one the item's own adjust CLUT", () => {
        const points: TimelineKeyframePoint[] = [{ time: 1, adj_exposure: 0 }, { time: 3, adj_exposure: 0.5 }];
        expect(keyframeLut({ kind: "scene" }, points, 1).key).toBe(IDENTITY_LUT_KEY);
        const expected = itemLook({ kind: "scene", adjustmentsJson: '{"exposure":0.5}' })!.steps[0] as { key: string };
        expect(keyframeLut({ kind: "scene" }, points, 3).key).toBe(expected.key);
    });
});

describe("keyframedLook", () => {
    it("is null without look keyframes and keeps the steps after the adjust CLUT", () => {
        expect(keyframedLook({ kind: "scene", visualFilter: "noir" }, [{ time: 0, scale: 2 }])).toBeNull();
        const look = keyframedLook({ kind: "scene", adjustmentsJson: '{"vignette":0.4,"brightness":0.2}' }, [{ time: 0, adj_brightness: -0.2 }, { time: 2, adj_brightness: 0.2 }])!;
        expect(look.rest?.steps.map((s) => s.kind)).toEqual(["vignette"]);
        expect(look.times).toEqual([0, 2]);
        expect(look.luts).toHaveLength(2);
        expect(look.dropped).toBe(0);
        // A keyframed item without spatial steps or effects has no rest.
        expect(keyframedLook({ kind: "scene" }, [{ time: 0, adj_exposure: 0 }, { time: 1, adj_exposure: 1 }])!.rest).toBeNull();
    });

    it(`uses the first ${LOOK_KEYFRAME_LIMIT} keyframes and counts the dropped ones`, () => {
        const points = Array.from({ length: 11 }, (_, i) => ({ time: i, adj_exposure: (i % 3) / 4 }));
        const look = keyframedLook({ kind: "scene" }, points)!;
        expect(look.times).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
        expect(look.dropped).toBe(3);
    });
});

describe("lookSegmentWeight (the export's sequential blend weights)", () => {
    const points: TimelineKeyframePoint[] = [
        { time: 0.5, adj_exposure: 0.1 }, { time: 1, adj_exposure: 0.6, easing: 2 }, { time: 1.6, adj_exposure: 0.2, easing: 5, bx1: 0.4, by1: -0.3, bx2: 0.6, by2: 1.4 },
        { time: 2.2, adj_exposure: 0.7, easing: 4 }, { time: 2.5, adj_exposure: 0 },
    ];
    const times = lookKeyframeTimes(points);

    it("is 0 before its segment, the eased weight inside, 1 after; sequential mixing reproduces lookKeyframeMix exactly", () => {
        for (let n = 0; n <= 90; n += 1) {
            const t = n / 30;
            const at = lookKeyframeMix(points, t)!;
            // acc_0 = LUT_0; acc_k = mix(acc_{k-1}, LUT_k, s_k): on levels, every keyframe a distinct level.
            const levels = times.map((_, i) => 30 + 47 * i);
            let acc = levels[0];
            for (let k = 1; k < times.length; k += 1) acc = lookMixLevel(acc, levels[k], evaluateScalar(lookSegmentWeight(points, times, k), t));
            const a = levels[times.indexOf(at.from)];
            const b = levels[times.indexOf(at.to)];
            expect(acc, `t=${t}`).toBe(lookMixLevel(a, b, at.w));
            const k = times.indexOf(at.to);
            if (k > 0 && at.from !== at.to) expect(evaluateScalar(lookSegmentWeight(points, times, k), t), `t=${t}`).toBe(at.w);
        }
    });
});

describe("lookMixWeight / lookMixLevel", () => {
    it("clamps, quantizes to k/1024, and truncates like blend's 8-bit store", () => {
        expect(lookMixWeight(-0.2)).toBe(0);
        expect(lookMixWeight(1.3)).toBe(1);
        expect(lookMixWeight(Number.NaN)).toBe(0);
        expect(lookMixWeight(0.30004)).toBe(307 / 1024);
        expect(lookMixLevel(10, 20, 0.5)).toBe(15);
        expect(lookMixLevel(20, 10, 0.05)).toBe(19);
        expect(lookMixLevel(10, 9, 0.5)).toBe(9);
    });
});
