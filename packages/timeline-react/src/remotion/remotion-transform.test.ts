// Graphics clips (phase 10c): the DOM layer follows the shared motion model like every other visual clip.
import { testClip } from "../preview/motion/test-fixtures";
import { getRemotionLayerStyle, getRemotionLayerTransform, remotionLayerPlacement } from "./remotion-transform";

const graphic = (overrides = {}) => testClip({ id: "g1", trackType: "remotion", trackIndex: 1, mediaUrl: null, mediaType: "remotion", startTime: 0, endTime: 4, ...overrides });

describe("graphics layer placement", () => {
    it("is the identity for a centred, unscaled graphic", () => {
        expect(remotionLayerPlacement(graphic(), 0)).toEqual({ x: 0, y: 0, scale: 1, scaleX: 1, rotation: 0, opacity: 1 });
        expect(getRemotionLayerTransform(graphic())).toBe("translate(0.0000%, 0.0000%) rotate(0.0000deg) scale(1, 1)");
    });

    it("translates by the position across the whole frame, rotates, and scales about the centre", () => {
        const clip = graphic({ positionX: 0.75, positionY: 0.4, scale: 1.5, rotationDegrees: 30, opacity: 0.5 });
        expect(remotionLayerPlacement(clip, 1)).toMatchObject({ x: 0.25, rotation: 30, scale: 1.5, opacity: 0.5 });
        expect(remotionLayerPlacement(clip, 1).y).toBeCloseTo(-0.1, 9);
        expect(getRemotionLayerStyle(clip, 1)).toEqual({
            transform: "translate(25.0000%, -10.0000%) rotate(30.0000deg) scale(1.5, 1.5)", opacity: 0.5, transformOrigin: "50% 50%",
        });
    });

    it("follows keyframes at the clip-local time", () => {
        const keyframesJson = JSON.stringify({ keyframes: [
            { time: 0, rotation_degrees: 0, scale: 1 },
            { time: 2, rotation_degrees: 90, scale: 2 },
        ] });
        const at1 = remotionLayerPlacement(graphic({ keyframesJson }), 1);
        expect(at1.rotation).toBeCloseTo(45, 6);
        expect(at1.scale).toBeCloseTo(1.5, 6);
    });

    it("plays in animations (a fade in starts transparent)", () => {
        const animationJson = JSON.stringify({ in: { id: "fade_in", duration: 1 } });
        expect(remotionLayerPlacement(graphic({ animationJson }), 0).opacity).toBeCloseTo(0, 6);
        expect(remotionLayerPlacement(graphic({ animationJson }), 2).opacity).toBeCloseTo(1, 6);
    });

    it("applies a live drag override per channel, rotation included", () => {
        const clip = graphic({ positionX: 0.5, rotationDegrees: 10 });
        const placed = remotionLayerPlacement(clip, 0, { clipId: "g1", positionX: 0.6, rotation: 40, scale: 2 });
        expect(placed).toMatchObject({ rotation: 40, scale: 2 });
        expect(placed.x).toBeCloseTo(0.1, 9);
        expect(remotionLayerPlacement(clip, 0, { clipId: "other", rotation: 40 }).rotation).toBe(10);
    });
});
