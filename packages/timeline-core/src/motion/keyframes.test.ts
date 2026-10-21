import { describe, expect, it } from "vitest";
import { POINTWISE_ADJUSTMENTS } from "../looks/adjust";
import { add, emitFfmpeg, evaluateScalar, mul, v } from "../looks/expr";
import type { TimelineKeyframePoint } from "../lib/timeline-editing-properties";
import { parseTimelineKeyframes } from "../lib/timeline-editing-properties";
import { easeValue, easingCode, type EasingId } from "./easing";
import {
    ADJUST_KEYFRAME_CHANNELS, KEYFRAME_CHANNELS, channelExpr, channelValueAt, hasChannel, keyframeTimes, pointAt, pointEasing,
    removeKeyframe, serializeKeyframes, setKeyframe, setKeyframeEasing,
} from "./keyframes";

const P = (point: Record<string, number>) => point as TimelineKeyframePoint;

/** The phase 10a preview rule (lib/keyframe-interpolation.ts before 10b), kept verbatim as the reference. */
function legacyValue(points: TimelineKeyframePoint[], channel: string, time: number): number | undefined {
    const defined = points.filter((point) => typeof point[channel] === "number");
    if (defined.length === 0) return undefined;
    if (time <= defined[0].time) return defined[0][channel];
    const last = defined[defined.length - 1];
    if (time >= last.time) return last[channel];
    for (let i = 0; i < defined.length - 1; i += 1) {
        const a = defined[i];
        const b = defined[i + 1];
        if (time < a.time || time > b.time) continue;
        const span = b.time - a.time;
        const t = span > 0 ? (time - a.time) / span : 0;
        return a[channel] + (b[channel] - a[channel]) * t;
    }
    return last[channel];
}

const grid = (from: number, to: number, step: number) => {
    const out: number[] = [];
    for (let t = from; t <= to + 1e-9; t += step) out.push(Math.round(t * 1e6) / 1e6);
    return out;
};

describe("keyframe channels", () => {
    it("lists transform, volume, filter intensity, and the ten pointwise Adjust controls", () => {
        expect(ADJUST_KEYFRAME_CHANNELS).toEqual(POINTWISE_ADJUSTMENTS.map((key) => `adj_${key}`));
        expect(ADJUST_KEYFRAME_CHANNELS).toHaveLength(10);
        expect(KEYFRAME_CHANNELS).toEqual([
            "position_x", "position_y", "scale", "rotation_degrees", "opacity", "volume", "filter_intensity", ...ADJUST_KEYFRAME_CHANNELS,
        ]);
        expect(KEYFRAME_CHANNELS).not.toContain("adj_sharpen");
    });
});

describe("channelValueAt", () => {
    const legacy = parseTimelineKeyframes(JSON.stringify({
        keyframes: [
            { time: 0, opacity: 0, scale: 1, position_x: 0.2 },
            { time: 0.7, opacity: 0.3 },
            { time: 2, opacity: 1, scale: 1.5, position_x: 0.8 },
            { time: 2, opacity: 0.9 },
            { time: 4, volume: 0.5, opacity: 0.25 },
        ],
    }));

    it("gives exactly the old linear interpolation for legacy points", () => {
        for (const channel of ["opacity", "scale", "position_x", "volume", "rotation_degrees"]) {
            for (const t of grid(-1, 5, 0.05)) {
                const expected = legacyValue(legacy, channel, t) ?? 7;
                expect(channelValueAt(legacy, channel, t, 7)).toBe(expected);
            }
        }
    });

    it("holds the first and last values outside the keyframes and uses the fallback without any", () => {
        expect(channelValueAt(legacy, "opacity", -3, 9)).toBe(0);
        expect(channelValueAt(legacy, "opacity", 99, 9)).toBe(0.25);
        expect(channelValueAt(legacy, "rotation_degrees", 1, 9)).toBe(9);
        expect(channelValueAt([], "scale", 1, 2)).toBe(2);
    });

    it("shapes each segment with the easing of its left point", () => {
        const bezier = [0.42, 0, 0.58, 1] as const;
        for (const id of ["linear", "ease_in", "ease_out", "ease_in_out", "hold", "bezier"] as EasingId[]) {
            const extra: Record<string, number> = id === "bezier" ? { bx1: bezier[0], by1: bezier[1], bx2: bezier[2], by2: bezier[3] } : {};
            const points = [P({ time: 1, scale: 2, easing: easingCode(id), ...extra }), P({ time: 3, scale: 4 })];
            for (const t of grid(1, 3, 0.01)) {
                const u = (t - 1) / 2;
                const expected = 2 + 2 * easeValue(id, u, id === "bezier" ? bezier : null);
                expect(channelValueAt(points, "scale", t, 0)).toBeCloseTo(expected, 12);
            }
        }
    });

    it("hold keeps the left value until the next point", () => {
        const points = [P({ time: 0, opacity: 0, easing: easingCode("hold") }), P({ time: 1, opacity: 1 })];
        expect(channelValueAt(points, "opacity", 0.999, 5)).toBe(0);
        expect(channelValueAt(points, "opacity", 1, 5)).toBe(1);
    });

    it("applies the easing to the next point that defines the same channel", () => {
        const points = [
            P({ time: 0, scale: 1, easing: easingCode("ease_in") }),
            P({ time: 1, opacity: 0.5 }),
            P({ time: 2, scale: 3 }),
        ];
        expect(channelValueAt(points, "scale", 1, 0)).toBeCloseTo(1 + 2 * easeValue("ease_in", 0.5), 12);
        // The opacity point carries no easing and is a single value.
        expect(channelValueAt(points, "opacity", 1.5, 0)).toBe(0.5);
    });

    it("per-channel points do not disturb other channels", () => {
        const base = [P({ time: 0, position_x: 0.1 }), P({ time: 4, position_x: 0.9 })];
        const withScale = setKeyframe(base, 1, { scale: 2 }, { easing: "ease_out" });
        const withMore = setKeyframe(withScale, 3, { scale: 1 });
        for (const t of grid(-1, 5, 0.1)) {
            expect(channelValueAt(withMore, "position_x", t, 0)).toBe(channelValueAt(base, "position_x", t, 0));
        }
    });
});

describe("channelExpr", () => {
    const bez = { easing: easingCode("bezier"), bx1: 0.3, by1: -0.4, bx2: 0.7, by2: 1.4 };
    const mixed = [
        P({ time: 0.25, opacity: 0, scale: 1, ...bez }),
        P({ time: 1, opacity: 1, easing: easingCode("ease_in") }),
        P({ time: 1.5, scale: 1.8, easing: easingCode("hold") }),
        P({ time: 2, opacity: 0.4, easing: easingCode("ease_in_out") }),
        P({ time: 2.5, scale: 0.6, easing: easingCode("ease_out") }),
        P({ time: 3.2, opacity: 1, scale: 1.2 }),
    ];

    it("evaluates exactly like channelValueAt on a dense grid, outside the range too", () => {
        for (const channel of ["opacity", "scale", "rotation_degrees"]) {
            const expr = channelExpr(mixed, channel, 0.5);
            for (const t of grid(-1, 4.5, 0.001)) {
                expect(evaluateScalar(expr, t)).toBe(channelValueAt(mixed, channel, t, 0.5));
            }
        }
    });

    it("folds constants and takes a time expression", () => {
        expect(channelExpr([], "scale", 1.25)).toEqual({ k: "num", v: 1.25 });
        expect(channelExpr([P({ time: 2, scale: 3 })], "scale", 1)).toEqual({ k: "num", v: 3 });
        expect(channelExpr([P({ time: 0, scale: 3 }), P({ time: 2, scale: 3 })], "scale", 1)).toEqual({ k: "num", v: 3 });
        // Constant spans with a jump between them are not one constant.
        const jump = [P({ time: 0, scale: 1 }), P({ time: 2, scale: 1 }), P({ time: 2, scale: 3 }), P({ time: 3, scale: 3 }), P({ time: 3, scale: 1 }), P({ time: 4, scale: 1 })];
        expect(evaluateScalar(channelExpr(jump, "scale", 0), 2.5)).toBe(3);
        const shifted = channelExpr(mixed, "opacity", 1, add(v("T"), 1));
        expect(evaluateScalar(shifted, 0.5)).toBe(channelValueAt(mixed, "opacity", 1.5, 1));
        const scaled = channelExpr(mixed, "opacity", 1, mul(v("T"), 2));
        expect(evaluateScalar(scaled, 0.6)).toBe(channelValueAt(mixed, "opacity", 1.2, 1));
    });

    it("emits a scalar ffmpeg expression of reasonable size for eight bezier keyframes", () => {
        const points = Array.from({ length: 8 }, (_, i) => P({ time: i * 0.75, position_x: (i % 2) * 0.8 + 0.1, ...bez }));
        const expr = channelExpr(points, "position_x", 0.5);
        const text = emitFfmpeg(expr, { target: "scalar", time: "T" });
        expect(text).not.toContain("st(");
        expect(text.length).toBeLessThan(20_000);
        for (const t of grid(-0.5, 6, 0.01)) expect(evaluateScalar(expr, t)).toBe(channelValueAt(points, "position_x", t, 0.5));
    });
});

describe("keyframe editing", () => {
    const start = [P({ time: 0, scale: 1 }), P({ time: 2, scale: 2, opacity: 1 })];

    it("reports channels and times", () => {
        expect(hasChannel(start, "opacity")).toBe(true);
        expect(hasChannel(start, "volume")).toBe(false);
        expect(keyframeTimes(start)).toEqual([0, 2]);
        expect(keyframeTimes(start, ["opacity"])).toEqual([2]);
        expect(keyframeTimes(start, ["opacity", "scale"])).toEqual([0, 2]);
    });

    it("sets values into a point within 1 ms or inserts a new point, without mutating", () => {
        const merged = setKeyframe(start, 2.0004, { opacity: 0.5, adj_brightness: 0.2 });
        expect(merged).toHaveLength(2);
        expect(merged[1]).toEqual({ time: 2, scale: 2, opacity: 0.5, adj_brightness: 0.2 });
        expect(start[1]).toEqual({ time: 2, scale: 2, opacity: 1 });
        const inserted = setKeyframe(start, 1, { scale: 1.5 }, { easing: "bezier", bezier: [0.1, 0.2, 0.3, 0.9] });
        expect(inserted.map((p) => p.time)).toEqual([0, 1, 2]);
        expect(inserted[1]).toEqual({ time: 1, scale: 1.5, easing: easingCode("bezier"), bx1: 0.1, by1: 0.2, bx2: 0.3, by2: 0.9 });
        expect(pointEasing(inserted[1])).toEqual({ id: "bezier", bezier: [0.1, 0.2, 0.3, 0.9] });
        expect(pointEasing(inserted[0])).toEqual({ id: "linear", bezier: null });
    });

    it("sets and clears easing on a point", () => {
        const eased = setKeyframeEasing(start, 0, "ease_out");
        expect(eased[0]).toEqual({ time: 0, scale: 1, easing: easingCode("ease_out") });
        const bezier = setKeyframeEasing(eased, 0, "bezier", [0.2, 0, 0.8, 1]);
        expect(pointEasing(bezier[0])).toEqual({ id: "bezier", bezier: [0.2, 0, 0.8, 1] });
        const linear = setKeyframeEasing(bezier, 0, "linear");
        expect(linear[0]).toEqual({ time: 0, scale: 1 });
        expect(setKeyframeEasing(start, 5, "hold")).toEqual(start);
    });

    it("removes channels and drops points left without any", () => {
        const eased = setKeyframeEasing(start, 2, "ease_in");
        const noOpacity = removeKeyframe(eased, 2, ["opacity"]);
        expect(noOpacity[1]).toEqual({ time: 2, scale: 2, easing: easingCode("ease_in") });
        const empty = removeKeyframe(noOpacity, 2, ["scale"]);
        expect(empty).toEqual([{ time: 0, scale: 1 }]);
        expect(removeKeyframe(start, 0)).toEqual([start[1]]);
        expect(removeKeyframe(start, 7)).toEqual(start);
    });

    it("finds points with a tolerance and serializes", () => {
        expect(pointAt(start, 1.9995)).toBe(start[1]);
        expect(pointAt(start, 1.99)).toBeUndefined();
        expect(pointAt(start, 1.99, 0.02)).toBe(start[1]);
        expect(serializeKeyframes([])).toBeNull();
        const json = serializeKeyframes([start[1], start[0]]);
        expect(json).toBe('{"keyframes":[{"time":0,"scale":1},{"time":2,"scale":2,"opacity":1}]}');
        expect(parseTimelineKeyframes(json)).toEqual(start);
    });
});

describe("long keyframe channels (ffmpeg parser limits)", () => {
    /** Deepest parenthesis nesting of an emitted expression (ffmpeg's parser recurses per level). */
    const depth = (text: string) => {
        let level = 0;
        let max = 0;
        for (const ch of text) {
            if (ch === "(") max = Math.max(max, ++level);
            else if (ch === ")") level -= 1;
        }
        return max;
    };
    const easings: EasingId[] = ["linear", "ease_in", "ease_out", "ease_in_out", "hold"];
    const bez = { easing: easingCode("bezier"), bx1: 0.3, by1: -0.4, bx2: 0.7, by2: 1.4 };

    it("emits 500 keyframes as a balanced search shallower than 60 levels that still equals the JS curve", () => {
        const points = Array.from({ length: 500 }, (_, i) => P({ time: i * 0.02, opacity: ((i * 37) % 11) / 10, easing: easingCode(easings[i % easings.length]) }));
        const expr = channelExpr(points, "opacity", 1);
        expect(depth(emitFfmpeg(expr, { target: "scalar", time: "T" }))).toBeLessThan(60);
        for (const t of grid(-0.1, 10.1, 0.0037)) expect(evaluateScalar(expr, t)).toBe(channelValueAt(points, "opacity", t, 1));
        for (const point of points) expect(evaluateScalar(expr, point.time)).toBe(channelValueAt(points, "opacity", point.time, 1));
    });

    it("emits 40 bezier keyframes shallower than 60 levels that still equal the JS curve", () => {
        const points = Array.from({ length: 40 }, (_, i) => P({ time: i * 0.25, position_x: (i % 3) * 0.4, ...bez }));
        const expr = channelExpr(points, "position_x", 0.5);
        expect(depth(emitFfmpeg(expr, { target: "scalar", time: "T" }))).toBeLessThan(60);
        for (const t of grid(-0.1, 10, 0.0013)) expect(evaluateScalar(expr, t)).toBe(channelValueAt(points, "position_x", t, 0.5));
    });

    it("evaluates a long channel per frame without rebuilding its curve", () => {
        const points = Array.from({ length: 200 }, (_, i) => P({ time: i * 0.05, scale: 1 + (i % 4) * 0.1, ...bez }));
        const started = performance.now();
        let sum = 0;
        for (let i = 0; i < 20_000; i += 1) sum += channelValueAt(points, "scale", (i % 1000) * 0.01, 1);
        expect(Number.isFinite(sum)).toBe(true);
        expect(performance.now() - started).toBeLessThan(500);
    });
});

