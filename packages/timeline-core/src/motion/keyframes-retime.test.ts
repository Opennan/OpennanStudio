import { describe, expect, it } from "vitest";
import type { TimelineKeyframePoint } from "../lib/timeline-editing-properties";
import { easingCode } from "./easing";
import { channelValueAt, retimeKeyframe } from "./keyframes";

const P = (point: Record<string, number>) => point as TimelineKeyframePoint;

describe("retimeKeyframe", () => {
    const start = [
        P({ time: 0, scale: 1, opacity: 1 }),
        P({ time: 1, scale: 2, opacity: 0.5, easing: easingCode("bezier"), bx1: 0.1, by1: 0.2, bx2: 0.3, by2: 0.9 }),
        P({ time: 3, scale: 3 }),
    ];

    it("moves the whole point with its easing and keeps the points sorted, without mutating", () => {
        const moved = retimeKeyframe(start, 1, 3.5);
        expect(moved.map((p) => p.time)).toEqual([0, 3, 3.5]);
        expect(moved[2]).toEqual({ time: 3.5, scale: 2, opacity: 0.5, easing: easingCode("bezier"), bx1: 0.1, by1: 0.2, bx2: 0.3, by2: 0.9 });
        expect(start[1].time).toBe(1);
        const earlier = retimeKeyframe(start, 3, 0.5);
        expect(earlier.map((p) => p.time)).toEqual([0, 0.5, 1]);
    });

    it("finds the source point within 1 ms and rounds the new time to the millisecond", () => {
        const moved = retimeKeyframe(start, 1.0004, 2.00049);
        expect(moved.map((p) => p.time)).toEqual([0, 2, 3]);
        expect(retimeKeyframe(start, 1.2, 2)).toEqual(start);
    });

    it("merges into a point already at the target, the moved values and easing winning", () => {
        const merged = retimeKeyframe(start, 1, 3.0004);
        expect(merged).toHaveLength(2);
        expect(merged[1]).toEqual({ time: 3, scale: 2, opacity: 0.5, easing: easingCode("bezier"), bx1: 0.1, by1: 0.2, bx2: 0.3, by2: 0.9 });
        // A linear point landing on an eased one makes it linear: the moved point wins.
        const eased = [P({ time: 0, scale: 1 }), P({ time: 2, opacity: 1, easing: easingCode("hold") })];
        expect(retimeKeyframe(eased, 0, 2)).toEqual([{ time: 2, scale: 1, opacity: 1 }]);
    });

    it("moves only the given channels, splitting the point and copying its easing", () => {
        const split = retimeKeyframe(start, 1, 2, ["opacity"]);
        expect(split.map((p) => p.time)).toEqual([0, 1, 2, 3]);
        expect(split[1]).toEqual({ time: 1, scale: 2, easing: easingCode("bezier"), bx1: 0.1, by1: 0.2, bx2: 0.3, by2: 0.9 });
        expect(split[2]).toEqual({ time: 2, opacity: 0.5, easing: easingCode("bezier"), bx1: 0.1, by1: 0.2, bx2: 0.3, by2: 0.9 });
        // Scale is untouched, opacity now peaks later.
        expect(channelValueAt(split, "scale", 1, 0)).toBe(2);
        expect(channelValueAt(split, "opacity", 2, 0)).toBe(0.5);
        // Every channel of the point named: the point moves whole.
        expect(retimeKeyframe(start, 1, 2, ["scale", "opacity"]).map((p) => p.time)).toEqual([0, 2, 3]);
        // Channels the point does not define: unchanged.
        expect(retimeKeyframe(start, 1, 2, ["volume"])).toEqual(start);
    });

    it("merges a partial move into an existing point", () => {
        const merged = retimeKeyframe(start, 1, 3, ["opacity"]);
        expect(merged.map((p) => p.time)).toEqual([0, 1, 3]);
        expect(merged[2]).toEqual({ time: 3, scale: 3, opacity: 0.5, easing: easingCode("bezier"), bx1: 0.1, by1: 0.2, bx2: 0.3, by2: 0.9 });
    });

    it("never moves before zero and is a no-op onto itself", () => {
        expect(retimeKeyframe(start, 1, -2).map((p) => p.time)).toEqual([0, 3]);
        expect(retimeKeyframe(start, 1, 1)).toEqual(start);
    });
});
