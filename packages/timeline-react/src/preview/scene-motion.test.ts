import { describe, expect, it } from "vitest";
import { sceneFitRect } from "@opennan/timeline-core/looks/fit";
import {
    IDENTITY_SCENE_MOTION, applyAffine, invertAffine, isIdentitySceneMotion, sceneHasMotion, sceneMediaMatrix, sceneMediaTransform,
    sceneMotionAt, scenePlacement, type Affine, type SceneMotionValues,
} from "./scene-motion";

const motion = (patch: Partial<SceneMotionValues>): SceneMotionValues => ({ ...IDENTITY_SCENE_MOTION, ...patch });

/** CSS `translate(tx, ty) rotate(θ) scale(sx, sy)` about the element center (cx, cy), as a 2×3 matrix. */
function cssMatrix(transform: string, cx: number, cy: number): Affine {
    const m = /^translate\(([-\d.e]+)px, ([-\d.e]+)px\) rotate\(([-\d.e]+)deg\) scale\(([-\d.e]+), ([-\d.e]+)\)$/.exec(transform);
    if (!m) throw new Error(`unexpected transform ${transform}`);
    const [tx, ty, deg, sx, sy] = m.slice(1).map(Number);
    const r = (deg * Math.PI) / 180;
    const cos = Math.cos(r);
    const sin = Math.sin(r);
    // T(c) · translate · rotate · scale · T(−c)
    const a = cos * sx;
    const b = sin * sx;
    const c = -sin * sy;
    const d = cos * sy;
    return [a, b, c, d, cx + tx - (a * cx + c * cy), cy + ty - (b * cx + d * cy)];
}

/** The export's placement (phase 10b contract): fit at transformScale = scale, centered + (posX% + dx·100%) of the frame,
 *  |scaleX| horizontally about its center, rotated clockwise about its center. Corner (u, v) in 0..1 of the media. */
function exportCorner(fitMode: string, source: { width: number; height: number }, frame: { width: number; height: number }, v: SceneMotionValues, u: number, w: number) {
    const fit = sceneFitRect(fitMode, source, frame, v.scale, v.posX + v.dx * 100, v.posY + v.dy * 100);
    const cx = fit.x + fit.width / 2;
    const cy = fit.y + fit.height / 2;
    const lx = (u - 0.5) * fit.width * Math.abs(v.scaleX);
    const ly = (w - 0.5) * fit.height;
    const r = (v.rotation * Math.PI) / 180;
    return [cx + lx * Math.cos(r) - ly * Math.sin(r), cy + lx * Math.sin(r) + ly * Math.cos(r)];
}

const CASES: Array<{ name: string; fitMode: string; v: SceneMotionValues }> = [
    { name: "identity", fitMode: "contain", v: IDENTITY_SCENE_MOTION },
    { name: "zoom + offset", fitMode: "contain", v: motion({ scale: 1.6, posX: 12, posY: -8 }) },
    { name: "rotated slide", fitMode: "cover", v: motion({ rotation: 33, dx: 0.25, dy: -0.1 }) },
    { name: "flip edge-on", fitMode: "fill", v: motion({ scaleX: -0.4, scale: 0.7, rotation: -90 }) },
];

describe("scenePlacement / sceneMediaMatrix", () => {
    const frame = { width: 1280, height: 720 };
    const source = { width: 1080, height: 1920 };

    for (const { name, fitMode, v } of CASES) {
        it(`maps the fitted texture's corners where the export places them (${name})`, () => {
            const base = sceneFitRect(fitMode, source, frame); // the texture the overlay fitted (scale 1)
            const texture = { width: Math.round(base.width), height: Math.round(base.height) };
            const m = sceneMediaMatrix(fitMode, source, frame, v, texture);
            for (const [u, w] of [[0, 0], [1, 0], [0, 1], [1, 1], [0.5, 0.5]]) {
                const [x, y] = applyAffine(m, u * texture.width, w * texture.height);
                const [ex, ey] = exportCorner(fitMode, source, frame, v, u, w);
                expect(x).toBeCloseTo(ex, 6);
                expect(y).toBeCloseTo(ey, 6);
            }
            const inverse = invertAffine(m)!;
            const [u, w] = applyAffine(inverse, ...(applyAffine(m, 17, 23) as [number, number]));
            expect(u).toBeCloseTo(17, 6);
            expect(w).toBeCloseTo(23, 6);
        });
    }

    it("shrinks to nothing at scale 0 (no fallback to full size)", () => {
        const placed = scenePlacement("contain", source, frame, motion({ scale: 0 }));
        expect(placed.width).toBe(0);
        expect(invertAffine(sceneMediaMatrix("contain", source, frame, motion({ scale: 0 }), { width: 10, height: 10 }))).toBeNull();
    });

    it("clamps opacity and takes |scaleX|", () => {
        const placed = scenePlacement("contain", source, frame, motion({ opacity: 1.4, scaleX: -0.5 }));
        expect(placed.opacity).toBe(1);
        expect(placed.scaleX).toBe(0.5);
    });
});

describe("sceneMediaTransform (CSS on an object-fit element the size of the frame)", () => {
    const frame = { w: 640, h: 360 };
    const source = { width: 1920, height: 1080 };

    for (const { name, fitMode, v } of CASES) {
        it(`lands the media where the export does (${name})`, () => {
            const css = sceneMediaTransform(v, frame);
            const m = cssMatrix(css.transform, frame.w / 2, frame.h / 2);
            // object-fit places the media at the scale-1 fit rect inside the element box.
            const base = sceneFitRect(fitMode, source, { width: frame.w, height: frame.h });
            for (const [u, w] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
                const [x, y] = applyAffine(m, base.x + u * base.width, base.y + w * base.height);
                const [ex, ey] = exportCorner(fitMode, source, { width: frame.w, height: frame.h }, v, u, w);
                expect(x).toBeCloseTo(ex, 6);
                expect(y).toBeCloseTo(ey, 6);
            }
            expect(css.opacity).toBe(String(Math.min(1, Math.max(0, v.opacity))));
        });
    }
});

describe("sceneMotionAt / sceneHasMotion", () => {
    const base = { id: "s", transformScale: 1.2, transformOffsetX: 5, transformOffsetY: -3 };

    it("leaves old scenes on the static path (fields only)", () => {
        expect(sceneHasMotion(base, 4)).toBe(false);
        expect(sceneHasMotion({ ...base, rotationDegrees: 0, opacity: 1, keyframesJson: null, animationJson: null }, 4)).toBe(false);
        expect(sceneMotionAt(base, 4, 1)).toEqual(motion({ scale: 1.2, posX: 5, posY: -3 }));
    });

    it("needs per-frame placement for rotation, opacity, animations, and keyframes", () => {
        expect(sceneHasMotion({ ...base, rotationDegrees: 15 }, 4)).toBe(true);
        expect(sceneHasMotion({ ...base, opacity: 0.5 }, 4)).toBe(true);
        expect(sceneHasMotion({ ...base, animationJson: JSON.stringify({ in: { id: "fade_in", duration: 1 } }) }, 4)).toBe(true);
        const keyed = { ...base, keyframesJson: JSON.stringify({ keyframes: [{ time: 0, scale: 1 }, { time: 2, scale: 2 }] }) };
        expect(sceneHasMotion(keyed, 4)).toBe(true);
        expect(sceneMotionAt(keyed, 4, 1).scale).toBeCloseTo(1.5, 9);
        // A single keyframe that disagrees with the field is static but not what sceneFitStyle draws.
        expect(sceneHasMotion({ ...base, keyframesJson: JSON.stringify({ keyframes: [{ time: 1, scale: 2 }] }) }, 4)).toBe(true);
        expect(sceneHasMotion({ ...base, keyframesJson: JSON.stringify({ keyframes: [{ time: 1, scale: 1.2 }] }) }, 4)).toBe(false);
    });

    it("evaluates the fade-in at scene-local time and clamps outside the scene", () => {
        const fading = { ...base, animationJson: JSON.stringify({ in: { id: "fade_in", duration: 1 } }) };
        expect(sceneMotionAt(fading, 4, 0).opacity).toBe(0);
        expect(sceneMotionAt(fading, 4, -1).opacity).toBe(0);
        expect(sceneMotionAt(fading, 4, 0.5).opacity).toBeGreaterThan(0);
        expect(sceneMotionAt(fading, 4, 2).opacity).toBe(1);
        expect(isIdentitySceneMotion(sceneMotionAt(fading, 4, 2), fading)).toBe(true);
        expect(isIdentitySceneMotion(sceneMotionAt(fading, 4, 0.5), fading)).toBe(false);
    });
});
