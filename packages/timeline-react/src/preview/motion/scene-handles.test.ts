import { sceneCanTransform, sceneHandleGeometry, sceneOffsetForCentre, sceneSourceSize } from "./scene-handles";

const frame = { x: 20, y: 10, w: 640, h: 360 };
const json = (value: unknown) => JSON.stringify(value);

describe("sceneHandleGeometry", () => {
    it("is the fitted media rect × transformScale, moved by the offsets (percent of the frame), as the export's sceneFit", () => {
        const scene = { id: "s", fitMode: "contain" as const, transformScale: 1.5, transformOffsetX: 10, transformOffsetY: -5 };
        const g = sceneHandleGeometry(scene, 5, 1, frame, { width: 1920, height: 1080 });
        expect(g.visual.w).toBeCloseTo(960, 9);
        expect(g.visual.h).toBeCloseTo(540, 9);
        expect(g.visual.cx).toBeCloseTo(20 + 320 + 64, 9);
        expect(g.visual.cy).toBeCloseTo(10 + 180 - 18, 9);
        expect(g.visual.rotation).toBe(0);
        expect(g.base).toEqual(g.visual);
        expect(g.animOffset).toEqual({ x: 0, y: 0 });
        expect(g.baseValues).toEqual({ offsetX: 10, offsetY: -5, scale: 1.5, rotation: 0 });
    });

    it("follows keyframes and rotation, and separates animation offsets from the base", () => {
        const scene = {
            id: "s", fitMode: "cover" as const, rotationDegrees: 30,
            keyframesJson: json([{ time: 0, scale: 1 }, { time: 2, scale: 2 }]),
            animationJson: json({ in: { id: "slide_left", duration: 1 } }),
        };
        const g = sceneHandleGeometry(scene, 5, 0.5, frame, { width: 1080, height: 1920 });
        // Cover of a 9:16 source in a 16:9 frame: width = frame width × scale.
        expect(g.base.w).toBeCloseTo(640 * 1.25, 6);
        expect(g.base.rotation).toBeCloseTo(Math.PI / 6, 12);
        expect(g.baseValues.scale).toBeCloseTo(1.25, 12);
        expect(g.animOffset.x).not.toBe(0);
        expect(g.visual.cx - g.base.cx).toBeCloseTo(g.animOffset.x, 9);
    });
});

describe("sceneOffsetForCentre", () => {
    it("inverts the centre placement (percent offsets, animation offset removed)", () => {
        expect(sceneOffsetForCentre(frame, { x: 20 + 320 + 64, y: 10 + 180 - 18 }, { x: 0, y: 0 })).toEqual({ offsetX: 10, offsetY: -5 });
        const out = sceneOffsetForCentre(frame, { x: 20 + 320 + 64 + 7, y: 190 }, { x: 7, y: 0 });
        expect(out.offsetX).toBeCloseTo(10, 9);
        expect(out.offsetY).toBeCloseTo(0, 9);
    });
});

describe("scene sources", () => {
    it("uses the stored source size, then the playing video, then the frame", () => {
        expect(sceneSourceSize({ sourceWidth: 1080, sourceHeight: 1920 }, null, frame)).toEqual({ width: 1080, height: 1920 });
        expect(sceneSourceSize({}, { videoWidth: 640, videoHeight: 480 }, frame)).toEqual({ width: 640, height: 480 });
        expect(sceneSourceSize({}, { videoWidth: 0, videoHeight: 0 }, frame)).toEqual({ width: 640, height: 360 });
    });

    it("transforms scenes with media (as ScenePreview's transform chrome)", () => {
        expect(sceneCanTransform({ videoUrl: "/v.mp4" })).toBe(true);
        expect(sceneCanTransform({ cardType: "image" })).toBe(true);
        expect(sceneCanTransform({ cardType: "source_clip", sourceVideoUrl: "/s.mp4" })).toBe(true);
        expect(sceneCanTransform({ shotBreakdown: json([{ video_url: "/a.mp4" }, { video_url: "/b.mp4" }]) })).toBe(true);
        expect(sceneCanTransform({ shotBreakdown: json([{ video_url: "/a.mp4" }, {}]) })).toBe(false);
        expect(sceneCanTransform({ cardType: "text" })).toBe(false);
    });
});
