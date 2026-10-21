import { collectGroupItems, groupGestureCommand } from "./group-items";
import { testClip } from "./test-fixtures";

const frame = { x: 0, y: 0, w: 1000, h: 500 };
const rect = (cx: number, cy: number, w: number, h: number) => ({ x: cx - w / 2, y: cy - h / 2, w, h, px: cx, py: cy, rot: 0, anchorW: w, anchorH: h });
const scene = { id: "s", order: 0, transformScale: 1 } as never;
const offscreenScene = { id: "s2", order: 1, transformScale: 1, cardType: "image" } as never;

function capture() {
    const clip = testClip({ id: "c", startTime: 0, endTime: 4, positionX: 0.5, positionY: 0.5 });
    const graphic = testClip({ id: "g", trackType: "remotion", startTime: 0, endTime: 4, positionX: 0.5, positionY: 0.5 });
    const box = { cx: 500, cy: 250, w: 1000, h: 500, rotation: 0 };
    return collectGroupItems({
        clips: [
            clip, graphic, testClip({ id: "later", startTime: 10, endTime: 12, scale: 0.8 }),
            testClip({ id: "music", trackType: "audio", trackIndex: 1, startTime: 10, endTime: 12 }),
        ],
        time: 1,
        frame,
        visualRects: new Map([["c", rect(500, 250, 200, 100)], ["g", rect(500, 250, 300, 100)], ["later", rect(0, 0, 10, 10)]]),
        baseRects: new Map([["c", rect(500, 250, 200, 100)]]),
        sceneBoxes: [{ sceneId: "s", geometry: { visual: box, base: box, animOffset: { x: 0, y: 0 }, baseValues: { offsetX: 0, offsetY: 0, scale: 1, rotation: 0 } } }],
        sceneRanges: [{ scene, start: 0, duration: 5 }, { scene: offscreenScene, start: 5, duration: 5 }],
        clipIds: new Set(["c", "g", "later", "music"]),
        sceneIds: new Set(["s", "s2"]),
    });
}

describe("group items", () => {
    it("captures the visible selected clips, graphics, and scenes; selected items off the playhead follow (phase 10d)", () => {
        const { items, boxes, followers } = capture();
        expect(items.map((i) => `${i.kind}:${i.id}`)).toEqual(["clip:c", "graphics:g", "scene:s"]);
        expect(boxes).toHaveLength(3);
        // The audio clip has no transform; the later clip and the off-screen scene follow the gesture's deltas.
        expect(followers?.map(({ kind, id, scale }) => ({ kind, id, scale }))).toEqual([{ kind: "clip", id: "later", scale: 0.8 }, { kind: "scene", id: "s2", scale: 1 }]);
    });

    it("a move writes every item's position in its own units; followers move by the same frame fractions (absolute values)", () => {
        const command = groupGestureCommand(capture(), { kind: "move", dx: 100, dy: 50 }, frame);
        expect(command).toEqual({
            type: "items.transform",
            clips: [
                { id: "c", patch: { positionX: (600 - 100) / 800, positionY: (300 - 50) / 400 } },
                { id: "g", patch: { positionX: 0.6, positionY: 0.6 } },
                { id: "later", patch: { positionX: 0.6, positionY: 0.6 } },
            ],
            scenes: [{ id: "s", patch: { transformOffsetX: 10, transformOffsetY: 10 } }, { id: "s2", patch: { transformOffsetX: 10, transformOffsetY: 10 } }],
        });
    });

    it("scale and rotate map followers about the group centre (frame fractions on the frame's aspect)", () => {
        // Group centre (250, 125) = (0.25, 0.25): the later clip at (0.5, 0.5) goes to 0.25 + 1.5 × 0.25 = 0.625.
        const scaled = groupGestureCommand(capture(), { kind: "scale", center: { x: 250, y: 125 }, factor: 1.5 }, frame) as unknown as { clips: Array<Record<string, unknown>>; scenes: Array<Record<string, unknown>> };
        expect(scaled.clips.find((c) => c.id === "later")).toEqual({ id: "later", patch: { positionX: 0.625, positionY: 0.625, scale: 1.2 } });
        expect(scaled.scenes.find((c) => c.id === "s2")).toEqual({ id: "s2", patch: { transformOffsetX: 12.5, transformOffsetY: 12.5, transformScale: 1.5 } });
        // Turning about the frame centre leaves the centred follower in place and adds the angle.
        const turned = groupGestureCommand(capture(), { kind: "rotate", center: { x: 500, y: 250 }, degrees: -20 }, frame) as unknown as { clips: Array<Record<string, unknown>> };
        expect(turned.clips.find((c) => c.id === "later")).toEqual({ id: "later", patch: { positionX: 0.5, positionY: 0.5, rotationDegrees: -20 } });
        // A gesture that changes nothing writes nothing for them.
        const still = groupGestureCommand(capture(), { kind: "move", dx: 0, dy: 0 }, frame) as unknown as { clips: Array<Record<string, unknown>> };
        expect(still.clips.some((c) => c.id === "later")).toBe(false);
    });

    it("live steps of one drag rewrite the follower's values from the captured base (no accumulation)", () => {
        const c = capture();
        const first = groupGestureCommand(c, { kind: "move", dx: 50, dy: 0 }, frame) as unknown as { clips: Array<Record<string, unknown>> };
        const second = groupGestureCommand(c, { kind: "move", dx: 100, dy: 0 }, frame) as unknown as { clips: Array<Record<string, unknown>> };
        expect(first.clips.find((x) => x.id === "later")).toEqual({ id: "later", patch: { positionX: 0.55, positionY: 0.5 } });
        expect(second.clips.find((x) => x.id === "later")).toEqual({ id: "later", patch: { positionX: 0.6, positionY: 0.5 } });
    });

    it("a rotation about the group centre adds the angle and keeps centred items in place", () => {
        const command = groupGestureCommand(capture(), { kind: "rotate", center: { x: 500, y: 250 }, degrees: 30 }, frame) as { clips: Array<{ patch: Record<string, number> }> };
        expect(command.clips[0].patch).toEqual({ positionX: 0.5, positionY: 0.5, rotationDegrees: 30 });
    });
});
