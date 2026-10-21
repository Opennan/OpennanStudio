import { clipTransformTarget, groupTransformCommand, sceneTransformTarget } from "./drag-commit";
import { testClip } from "./test-fixtures";

describe("groupTransformCommand", () => {
    it("writes one items.transform: static fields, or keyframes where a channel is keyed", () => {
        const plain = testClip({ id: "a" });
        const keyed = testClip({ id: "b", keyframesJson: JSON.stringify({ keyframes: [{ time: 0, position_x: 0.2, position_y: 0.3 }] }) });
        const scene = { id: "s", transformScale: 1, keyframesJson: JSON.stringify({ keyframes: [{ time: 0, rotation_degrees: 5 }] }) };
        const command = groupTransformCommand([
            { target: clipTransformTarget(plain), values: { position_x: 0.4, position_y: 0.6, scale: 2 }, localTime: 1 },
            { target: clipTransformTarget(keyed), values: { position_x: 0.7, scale: 1.5 }, localTime: 1.23456 },
            { target: sceneTransformTarget(scene, 5), values: { rotation_degrees: 30, position_x: 10 }, localTime: 2 },
        ]);
        expect(command).toEqual({
            type: "items.transform",
            clips: [
                { id: "a", patch: { positionX: 0.4, positionY: 0.6, scale: 2 } },
                { id: "b", patch: { scale: 1.5 }, keyframe: { time: 1.235, values: { position_x: 0.7, position_y: 0.3 } } },
            ],
            scenes: [{ id: "s", patch: { transformOffsetX: 10 }, keyframe: { time: 2, values: { rotation_degrees: 30 } } }],
        });
    });

    it("is null when nothing is written", () => {
        expect(groupTransformCommand([{ target: clipTransformTarget(testClip()), values: {}, localTime: 0 }])).toBeNull();
    });
});
