import { describe, expect, it } from "vitest";
import type { TimelineKeyframePoint } from "@opennan/timeline-core/lib/timeline-editing-properties";
import { KEYFRAME_FRAME, adjacentKeyframeTime, groupValuesAt, keyframeState, localTime, nearKeyframe } from "./keyframe-model";

const pts = (...points: Array<Record<string, number>>) => points as unknown as TimelineKeyframePoint[];

describe("keyframe toggle state", () => {
    const points = pts({ time: 1, scale: 1.5 }, { time: 2, position_x: 0.2, position_y: 0.4 }, { time: 3, scale: 2, opacity: 0.5 });

    it("is filled on a keyframe of the channel within one frame of the playhead", () => {
        expect(keyframeState(points, ["scale"], 1).state).toBe("on");
        expect(keyframeState(points, ["scale"], 1 + KEYFRAME_FRAME * 0.9).state).toBe("on");
        expect(keyframeState(points, ["position_x", "position_y"], 2.01).point?.time).toBe(2);
    });

    it("is outlined when the channel is keyed elsewhere", () => {
        expect(keyframeState(points, ["scale"], 2).state).toBe("keyed");
        expect(keyframeState(points, ["scale"], 1 + KEYFRAME_FRAME * 1.5).state).toBe("keyed");
        // A keyframe of another channel at the playhead does not fill this one.
        expect(keyframeState(points, ["opacity"], 1).state).toBe("keyed");
    });

    it("is empty when the channel has no keyframes", () => {
        expect(keyframeState(points, ["rotation_degrees"], 1).state).toBe("off");
        expect(keyframeState([], ["scale"], 0).state).toBe("off");
    });

    it("finds the nearest point carrying any of the channels", () => {
        expect(nearKeyframe(points, 3.02)?.time).toBe(3);
        expect(nearKeyframe(points, 2.5)).toBeUndefined();
        expect(nearKeyframe(points, 1, ["opacity"])).toBeUndefined();
    });
});

describe("keyframe navigation and values", () => {
    const points = pts({ time: 0.5, scale: 1 }, { time: 2, scale: 2 }, { time: 4, opacity: 0 });

    it("finds the previous and next keyframe times, skipping the one under the playhead", () => {
        expect(adjacentKeyframeTime(points, 2, -1)).toBe(0.5);
        expect(adjacentKeyframeTime(points, 2, 1)).toBe(4);
        expect(adjacentKeyframeTime(points, 2.01, 1)).toBe(4);
        expect(adjacentKeyframeTime(points, 0.5, -1)).toBeNull();
        expect(adjacentKeyframeTime(points, 4, 1)).toBeNull();
        expect(adjacentKeyframeTime(points, 3, -1)).toBe(2);
    });

    it("interpolates keyed channels and falls back to the static value", () => {
        expect(groupValuesAt(points, [{ channel: "scale", base: 1.2 }, { channel: "rotation_degrees", base: 15 }], 1.25)).toEqual({ scale: 1.5, rotation_degrees: 15 });
    });

    it("maps the playhead into item time, null outside the item", () => {
        expect(localTime(5, 4, 2)).toBe(1);
        expect(localTime(3.99, 4, 2)).toBeNull();
        expect(localTime(6.5, 4, 2)).toBeNull();
        expect(localTime(6, 4, 2)).toBe(2);
    });
});
