import { describe, expect, it } from "vitest";
import type { TimelineKeyframePoint } from "@opennan/timeline-core/lib/timeline-editing-properties";
import { channelValueAt } from "@opennan/timeline-core/motion/keyframes";
import {
    bezierFromPointer, bezierHandlePositions, channelFormat, channelGroup, channelPoints, channelSegments, curvePath, dragTarget,
    formatValue, graphChannels, graphDomain, hitPoint, hitSegment, makeGraphScale, niceStep, ticks,
} from "./keyframe-graph-math";

const P = (point: Record<string, number>) => point as TimelineKeyframePoint;
const points = [
    P({ time: 0, scale: 1, opacity: 1 }),
    P({ time: 1, scale: 2, easing: 5, bx1: 0.2, by1: 0, bx2: 0.8, by2: 1 }),
    P({ time: 3, scale: 1.5, easing: 4 }),
    P({ time: 4, scale: 1 }),
];
// 200 x 100 px graph with the default padding: plot x 40..188, y 10..82.
const layout = { width: 200, height: 100 };

describe("scales and ticks", () => {
    it("maps time to x and value to y both ways", () => {
        const scale = makeGraphScale(layout, 4, [0, 2]);
        expect(scale.x(0)).toBe(40);
        expect(scale.x(4)).toBe(188);
        expect(scale.y(2)).toBe(10);
        expect(scale.y(0)).toBe(82);
        expect(scale.t(scale.x(1.25))).toBeCloseTo(1.25, 9);
        expect(scale.v(scale.y(0.7))).toBeCloseTo(0.7, 9);
    });

    it("picks nice steps and ticks", () => {
        expect(niceStep(1, 4)).toBe(0.25);
        expect(niceStep(97, 5)).toBe(20);
        expect(niceStep(0.03, 3)).toBe(0.01);
        expect(ticks(0.9, 2.1, 4)).toEqual([1, 1.5, 2]);
        expect(ticks(-1, 1, 4)).toEqual([-1, -0.5, 0, 0.5, 1]);
    });

    it("auto-scales the value axis over the curve with a margin, and widens flat curves", () => {
        const [lo, hi] = graphDomain(points, "scale", 1, 4);
        expect(lo).toBeLessThan(1);
        expect(hi).toBeGreaterThan(2);
        expect(hi - lo).toBeLessThan(1.6);
        const flat = graphDomain([P({ time: 0, opacity: 0.5 }), P({ time: 1, opacity: 0.5 })], "opacity", 1, 2);
        expect(flat[0]).toBeLessThan(0.5);
        expect(flat[1]).toBeGreaterThan(0.5);
        // Bezier overshoot widens the axis.
        const overshoot = [P({ time: 0, scale: 1, easing: 5, bx1: 0.3, by1: 2, bx2: 0.7, by2: 2 }), P({ time: 1, scale: 2 })];
        expect(graphDomain(overshoot, "scale", 1, 1)[1]).toBeGreaterThan(2.2);
        // Bezier handles stay inside the plot so they can be grabbed.
        const [, top] = graphDomain(overshoot, "scale", 1, 1);
        expect(top).toBeGreaterThan(3);
    });
});

describe("channels", () => {
    it("lists keyed channels in the inspector's order and groups position and Adjust", () => {
        expect(graphChannels([P({ time: 0, opacity: 1, mask_x: 0.2 }), P({ time: 1, scale: 1, adj_contrast: 0.1 })])).toEqual(["scale", "opacity", "adj_contrast", "mask_x"]);
        expect(channelGroup("position_y")).toEqual(["position_x", "position_y"]);
        expect(channelGroup("adj_tint")).toContain("filter_intensity");
        expect(channelGroup("filter_intensity")).toContain("adj_brightness");
        expect(channelGroup("opacity")).toEqual(["opacity"]);
    });

    it("formats values in the inspector's units and clamps to the channel range", () => {
        expect(formatValue(1.2, channelFormat("scale", "clip"))).toBe("120%");
        expect(formatValue(0.5, channelFormat("position_x", "clip"))).toBe("50%");
        expect(formatValue(12, channelFormat("position_x", "scene"))).toBe("12%");
        expect(formatValue(-45, channelFormat("rotation_degrees", "clip"))).toBe("-45°");
        expect(formatValue(0.25, channelFormat("adj_contrast", "clip"))).toBe("25");
        expect(channelFormat("opacity", "clip")).toMatchObject({ min: 0, max: 1, step: 0.01 });
        expect(channelFormat("position_x", "scene").step).toBe(1);
        expect(channelFormat("mask_x", "clip")).toMatchObject({ factor: 1, step: 0.01 });
    });

    it("reads a channel's points and segments with their easing", () => {
        expect(channelPoints(points, "opacity")).toEqual([{ time: 0, value: 1, easing: "linear", bezier: null }]);
        const segments = channelSegments(points, "scale");
        expect(segments.map((s) => [s.t0, s.t1, s.easing])).toEqual([[0, 1, "linear"], [1, 3, "bezier"], [3, 4, "hold"]]);
        expect(segments[1].bezier).toEqual([0.2, 0, 0.8, 1]);
    });
});

describe("curve drawing and hit tests", () => {
    const scale = makeGraphScale(layout, 4, [0.5, 2.5]);

    it("draws the curve from the preview's evaluation, steps included", () => {
        const d = curvePath(points, "scale", 1, scale);
        expect(d.startsWith("M")).toBe(true);
        const coords = d.slice(1).split(/ L/).map((pair) => pair.split(",").map(Number));
        // Every sampled vertex sits on channelValueAt (or its left limit, at a hold's step).
        for (const [x, y] of coords) {
            const t = scale.t(x);
            const near = [t, t - 1e-6].map((at) => Math.abs(y - scale.y(channelValueAt(points, "scale", at, 1))));
            expect(Math.min(...near)).toBeLessThan(0.05);
        }
        // The hold drops straight down at t = 4 (two vertices at that x).
        expect(coords.filter(([x]) => Math.abs(x - scale.x(4)) < 1e-6).length).toBeGreaterThanOrEqual(2);
    });

    it("hits points and segments", () => {
        const cps = channelPoints(points, "scale");
        expect(hitPoint(cps, scale, scale.x(1) + 3, scale.y(2) - 4)).toBe(1);
        expect(hitPoint(cps, scale, scale.x(2), scale.y(2))).toBeNull();
        const segments = channelSegments(points, "scale");
        const t = 2;
        expect(hitSegment(points, "scale", 1, segments, scale, scale.x(t), scale.y(channelValueAt(points, "scale", t, 1)) + 3)).toBe(1);
        expect(hitSegment(points, "scale", 1, segments, scale, scale.x(t), scale.y(2.4))).toBeNull();
        expect(hitSegment(points, "scale", 1, segments, scale, scale.x(0.5), scale.y(1.5))).toBe(0);
    });
});

describe("bezier handles", () => {
    const scale = makeGraphScale(layout, 4, [0.5, 2.5]);
    const segment = channelSegments(points, "scale")[1];

    it("places the handles in the segment's box", () => {
        const handles = bezierHandlePositions(segment, scale)!;
        expect(handles[0][0]).toBeCloseTo(scale.x(1 + 0.2 * 2), 9);
        expect(handles[0][1]).toBeCloseTo(scale.y(2), 9);
        expect(handles[1][0]).toBeCloseTo(scale.x(1 + 0.8 * 2), 9);
        expect(handles[1][1]).toBeCloseTo(scale.y(1.5), 9);
        // A flat segment has no handles (the easing has no visible effect).
        expect(bezierHandlePositions({ ...segment, v1: segment.v0 }, scale)).toBeNull();
    });

    it("maps a dragged handle back to bezier numbers, x clamped to [0, 1]", () => {
        const next = bezierFromPointer(segment, scale, 0, scale.x(1.5), scale.y(1.75), [0.2, 0, 0.8, 1]);
        expect(next[0]).toBeCloseTo(0.25, 2);
        expect(next[1]).toBeCloseTo(0.5, 2);
        expect(next.slice(2)).toEqual([0.8, 1]);
        const clamped = bezierFromPointer(segment, scale, 1, scale.x(9), scale.y(-50), [0.2, 0, 0.8, 1]);
        expect(clamped[2]).toBe(1);
        expect(clamped[3]).toBe(2);
    });
});

describe("dragTarget", () => {
    const scale = makeGraphScale(layout, 4, [0, 2]);
    const origin = { time: 1, value: 1 };
    const opts = { duration: 4, playhead: null, format: channelFormat("scale", "clip") };

    it("moves time on the 30 fps grid and value freely, clamped", () => {
        const pxPerSecond = (188 - 40) / 4;
        const pxPerUnit = (82 - 10) / 2;
        const moved = dragTarget(origin, { dx: pxPerSecond * 0.51, dy: -pxPerUnit * 0.25 }, scale, { ...opts, shift: false });
        expect(moved.time).toBeCloseTo(1.5, 3);
        expect(moved.value).toBeCloseTo(1.25, 6);
        expect(dragTarget(origin, { dx: -9999, dy: -9999 }, scale, { ...opts, shift: false })).toEqual({ time: 0, value: 4 });
    });

    it("locks the smaller axis with Shift", () => {
        expect(dragTarget(origin, { dx: 30, dy: -5 }, scale, { ...opts, shift: true }).value).toBe(1);
        expect(dragTarget(origin, { dx: 3, dy: -20 }, scale, { ...opts, shift: true }).time).toBe(1);
    });

    it("snaps to the playhead", () => {
        expect(dragTarget(origin, { dx: 37 * 1.03, dy: 0 }, scale, { ...opts, playhead: 2.04, shift: false }).time).toBe(2.04);
    });
});
