// Motion parity (phase 10b). (a) Every motion channel the export writes (timeline-core motion/transform.ts
// through the scalar target) evaluates on native ffmpeg and ffmpeg.wasm to the value the preview computes
// (evaluateScalar) at every frame time. (b) A solid square clip through the REAL compiled overlay graph lands
// where the preview's placedBox puts it (centre and size ± 1 px, opacity ± 2 levels) at sampled frames, and a
// scene through the real lane graph lands where scenePlacement puts it.
import { describe, expect, it } from "vitest";
import type { SceneData, TimelineClip } from "@opennan/timeline-core";
import { evaluateScalar } from "@opennan/timeline-core/looks/expr";
import { encodePng } from "@opennan/timeline-core/looks/png";
import { animationsFor } from "@opennan/timeline-core/motion/registry";
import { itemMotion, motionAt, motionFfmpeg, type ItemMotion } from "@opennan/timeline-core/motion/transform";
import { MOTION_CHANNELS } from "@opennan/timeline-core/motion/types";
import { compileExport } from "../src/compile";
import { clip as makeClip, input, scene as makeScene } from "../src/compile/test-helpers";
import { ffmpegHosts } from "./ffmpeg";
import { splitFrames } from "./frames";
import { runPlanVideo } from "./plan-runner";
import { sceneDuration } from "../src/timeline-model";
import { asWritten, evalScalarOnFfmpeg, scalarTime } from "./scalar";
// The preview's own placement code (test-only import): the export must land where the compositor draws.
import { placedBox } from "../../timeline-react/src/preview/motion/clip-motion";
import { sceneMotionAt, scenePlacement } from "../../timeline-react/src/preview/scene-motion";

const hosts = await ffmpegHosts();
const FPS = 30;
const SECONDS = 2;
const FRAMES = SECONDS * FPS + 1;

const anim = (spec: Record<string, unknown>) => JSON.stringify(spec);
const keys = (points: Array<Record<string, number>>) => JSON.stringify(points);
const clipOf = (id: string, patch: Record<string, unknown>) =>
    makeClip(id, { trackType: "video", trackIndex: 2, startTime: 0, endTime: SECONDS, mediaUrl: "/m/v.webm", mediaType: "video", ...patch });

/** Every clip and text animation, eased keyframes (all six easings), legacy fades and motion presets, and scenes. */
function motionCases(): Array<[string, ItemMotion]> {
    const cases: Array<[string, ItemMotion]> = [];
    const clip = (name: string, patch: Record<string, unknown>) => cases.push([name, itemMotion({ kind: "clip", clip: clipOf(name, patch) })]);
    for (const slot of ["in", "out"] as const) {
        for (const def of animationsFor("clip", slot)) clip(`clip ${slot} ${def.id}`, { animationJson: anim({ [slot]: { id: def.id, duration: 0.7 } }) });
        for (const def of animationsFor("text", slot)) clip(`text ${slot} ${def.id}`, { trackType: "text", trackIndex: 1, textContent: "Hi", animationJson: anim({ [slot]: { id: def.id, duration: 0.6 } }) });
    }
    for (const def of animationsFor("clip", "combo")) clip(`clip combo ${def.id}`, { animationJson: anim({ combo: { id: def.id } }) });
    for (const def of animationsFor("text", "loop")) {
        clip(`text loop ${def.id}`, { trackType: "text", trackIndex: 1, textContent: "Hi", animationJson: anim({ in: { id: "fade", duration: 0.3 }, loop: { id: def.id, period: 0.7 } }) });
    }
    for (const def of animationsFor("sticker", "loop")) clip(`sticker loop ${def.id}`, { trackType: "sticker", trackIndex: 1, textContent: "★", animationJson: anim({ loop: { id: def.id, period: 0.45 } }) });
    clip("in + out + keyframes", {
        animationJson: anim({ in: { id: "spin_in", duration: 0.5 }, out: { id: "slide_up_out", duration: 0.8 } }),
        keyframesJson: keys([{ time: 0.2, scale: 0.5, position_x: 0.1, rotation_degrees: 10 }, { time: 1.4, scale: 1.3, position_x: 0.9, rotation_degrees: -40, easing: 3 }]),
    });
    // Keyframes: every easing on every transform channel, the bezier with overshooting handles.
    clip("eased keyframes", {
        keyframesJson: keys([
            { time: 0.1, scale: 0.6, opacity: 0.2, position_x: 0, position_y: 1, rotation_degrees: 0, easing: 1 },
            { time: 0.5, scale: 1.4, opacity: 1, position_x: 0.4, position_y: 0.2, rotation_degrees: 45, easing: 2 },
            { time: 0.83, scale: 0.9, opacity: 0.5, position_x: 0.6, position_y: 0.7, rotation_degrees: -30, easing: 5, bx1: 0.3, by1: -0.6, bx2: 0.7, by2: 1.8 },
            { time: 1.2, scale: 1.1, opacity: 0.9, position_x: 1, position_y: 0, rotation_degrees: 90, easing: 4 },
            { time: 1.5, scale: 0.7, opacity: 0.1, position_x: 0.2, position_y: 0.5, rotation_degrees: 180, easing: 3 },
            { time: 1.9, scale: 1, opacity: 1, position_x: 0.5, position_y: 0.5, rotation_degrees: 0 },
        ]),
    });
    clip("bezier default handles", { keyframesJson: keys([{ time: 0, scale: 0.5, easing: 5 }, { time: 1.7, scale: 1.5 }]) });
    // Legacy motion the 10a export applied: fades (and the text transition-duration fallback) and motion presets.
    clip("legacy fades", { fadeInDuration: 0.4, fadeOutDuration: 0.7, opacity: 0.8 });
    clip("legacy fade transition", { transitionType: "cross_dissolve", fadeInDuration: 0.3 });
    clip("legacy text transition fades", { trackType: "text", trackIndex: 1, textContent: "Hi", transitionType: "cross_dissolve", transitionDuration: 0.45 });
    for (const preset of ["zoom_in", "zoom_out", "pulse"]) clip(`motion preset ${preset}`, { motionPreset: preset, scale: 1.2 });
    clip("motion preset under scale keyframes", { motionPreset: "pulse", keyframesJson: keys([{ time: 0, scale: 0.5 }, { time: 2, scale: 1 }]) });
    clip("preset + fades + animation", { motionPreset: "zoom_out", fadeOutDuration: 0.5, animationJson: anim({ in: { id: "bounce_in", duration: 0.6 } }) });
    // Scenes: scene units (offsets in %, transformScale).
    const scene = (name: string, patch: Partial<SceneData>) => cases.push([name, itemMotion({ kind: "scene", scene: makeScene(name, 0, SECONDS, patch), duration: SECONDS })]);
    scene("scene fade + zoom in", { animationJson: anim({ in: { id: "fade_in", duration: 0.5 } }), transformScale: 1.2 });
    scene("scene keyframes + combo", {
        animationJson: anim({ combo: { id: "combo_swing" } }),
        keyframesJson: keys([{ time: 0, position_x: -20, scale: 0.8, rotation_degrees: 0, opacity: 0.5 }, { time: 1.5, position_x: 15, scale: 1.3, rotation_degrees: 30, opacity: 1, easing: 3 }]),
    });
    return cases;
}

const relative = (a: number, b: number) => Math.abs(a - b) / Math.max(1, Math.abs(b));

describe.each(hosts.map((h) => [h.name, h] as const))("motion channels on %s", (_name, host) => {
    const cases = motionCases();

    it("covers every animation and moves at least one channel per case", () => {
        expect(cases.length).toBeGreaterThanOrEqual(80);
        for (const [name, motion] of cases) {
            // Raster-only text animations (typewriter, wipe, blur, letters) and the glow loop move no transform channel.
            if (/typewriter|wipe|blur|letter|glow/.test(name)) continue;
            expect(motion.animated, name).toBe(true);
        }
    });

    // ffmpeg evaluates the written expression to 1e-9 of evaluateScalar on the same tree (constants as written:
    // ffNumber keeps nine decimals); those constants move the value by at most 1e-7 relative.
    it("every channel expression equals evaluateScalar at every frame time (1e-9; written constants within 1e-7)", async () => {
        const exprs: string[] = [];
        const refs: Array<{ name: string; written: number[]; exact: number[] }> = [];
        for (const [name, motion] of cases) {
            for (const channel of MOTION_CHANNELS) {
                const e = motion.channels[channel];
                if (e.k === "num") continue;
                exprs.push(motionFfmpeg(motion, channel, scalarTime(FPS)));
                const written = asWritten(e);
                refs.push({
                    name: `${name} ${channel}`,
                    written: Array.from({ length: FRAMES }, (_, n) => evaluateScalar(written, n / FPS)),
                    exact: Array.from({ length: FRAMES }, (_, n) => evaluateScalar(e, n / FPS)),
                });
            }
        }
        const values = await evalScalarOnFfmpeg(host, exprs, FPS, FRAMES);
        let worstEval = 0;
        let worstConstants = 0;
        const failures: string[] = [];
        refs.forEach((ref, i) => {
            ref.written.forEach((js, n) => {
                const ff = values[i][n];
                const evalError = relative(ff, js);
                const constantError = relative(js, ref.exact[n]);
                worstEval = Math.max(worstEval, evalError);
                worstConstants = Math.max(worstConstants, constantError);
                if ((evalError > 1e-9 || constantError > 1e-7) && failures.length < 10) failures.push(`${ref.name} @${n}: ffmpeg ${ff}, written ${js}, exact ${ref.exact[n]}`);
            });
        });
        if (process.env.PARITY_DEBUG) console.log(`${host.name}: ${refs.length} channels × ${FRAMES} frames; worst ffmpeg error ${worstEval}, worst constant rounding ${worstConstants}`);
        expect(failures).toEqual([]);
        expect(refs.length).toBeGreaterThan(120);
    }, 600_000);
});

// ── (b) rendered placement ───────────────────────────────

const SIDE = 720; // "1:1" at 720p
const SQUARE_PX = 60; // a 60 px PNG at frameScale 2/3 is a 40 px box at clip scale 1
const BOX = 40;
const URL_SQUARE = "/m/square.png";
const squarePng = encodePng({ width: SQUARE_PX, height: SQUARE_PX, channels: 3, data: new Uint8Array(SQUARE_PX * SQUARE_PX * 3).fill(255) });
const SQUARE_INFO = { durationSeconds: 0, hasVideo: true, hasAudio: false, width: SQUARE_PX, height: SQUARE_PX };

interface Measured {
    cx: number;
    cy: number;
    /** Columns and rows at least half as bright as the peak. */
    width: number;
    height: number;
    /** Brightest level (the layer's opacity × 255 over black). */
    peak: number;
    /** Total brightness / 255: area × opacity. */
    mass: number;
}

function measure(frame: Uint8Array, size: number): Measured | null {
    let sum = 0;
    let sx = 0;
    let sy = 0;
    let peak = 0;
    for (let y = 0; y < size; y += 1) {
        for (let x = 0; x < size; x += 1) {
            const g = frame[(y * size + x) * 3 + 1];
            if (g <= 2) continue;
            sum += g;
            sx += g * (x + 0.5);
            sy += g * (y + 0.5);
            if (g > peak) peak = g;
        }
    }
    if (sum === 0) return null;
    const cols = new Set<number>();
    const rows = new Set<number>();
    for (let y = 0; y < size; y += 1) {
        for (let x = 0; x < size; x += 1) {
            if (frame[(y * size + x) * 3 + 1] * 2 >= peak) {
                cols.add(x);
                rows.add(y);
            }
        }
    }
    return { cx: sx / sum, cy: sy / sum, width: cols.size, height: rows.size, peak, mass: sum / 255 };
}

const SAMPLES = [0, 2, 5, 8, 11, 15, 22, 30, 38, 45, 50, 54, 57, 59];

interface RenderCase {
    name: string;
    patch: Record<string, unknown>;
    /** Rotated cases compare the centre and the mass; the bright box is not axis-aligned. */
    rotates?: boolean;
}

const RENDER_CASES: RenderCase[] = [
    { name: "zoom in + slide left out", patch: { scale: 2, positionX: 0.3, positionY: 0.6, animationJson: anim({ in: { id: "zoom_in", duration: 0.6 }, out: { id: "slide_left_out", duration: 0.6 } }) } },
    { name: "flip in (|scaleX|) + bounce out", patch: { scale: 3, animationJson: anim({ in: { id: "flip_in", duration: 0.8 }, out: { id: "bounce_out", duration: 0.5 } }) } },
    { name: "eased keyframes (position, scale, opacity) + fades", patch: {
        fadeOutDuration: 0.4,
        keyframesJson: keys([
            { time: 0, position_x: 0.1, position_y: 0.9, scale: 1, opacity: 0.3, easing: 5, bx1: 0.2, by1: -0.4, bx2: 0.8, by2: 1.4 },
            { time: 1, position_x: 0.8, position_y: 0.2, scale: 2.5, opacity: 1, easing: 3 },
            { time: 1.8, position_x: 0.5, position_y: 0.5, scale: 1.5, opacity: 0.7 },
        ]),
    } },
    // Legacy motion through the 10a filters (alpha fade, colorchannelmixer) and the preset's scale channel.
    { name: "legacy fades + zoom_in preset + opacity", patch: { scale: 2, positionX: 0.2, fadeInDuration: 0.5, fadeOutDuration: 0.6, opacity: 0.9, motionPreset: "zoom_in" } },
    { name: "combo rotate zoom", rotates: true, patch: { scale: 2.5, animationJson: anim({ combo: { id: "combo_rotate_zoom" } }) } },
    { name: "spin in + keyframed rotation", rotates: true, patch: { scale: 2, positionX: 0.7, animationJson: anim({ in: { id: "spin_in", duration: 0.7 } }), keyframesJson: keys([{ time: 0, rotation_degrees: 0 }, { time: 2, rotation_degrees: 60 }]) } },
];

const renderClip = (patch: Record<string, unknown>): TimelineClip =>
    makeClip("sq", { trackType: "video", trackIndex: 2, startTime: 0, endTime: SECONDS, mediaUrl: URL_SQUARE, mediaType: "image", ...patch });

describe.each(hosts.map((h) => [h.name, h] as const))("rendered overlay placement on %s", (_name, host) => {
    it.each(RENDER_CASES.map((c) => [c.name, c] as const))("%s lands on placedBox at sampled frames", async (_label, test) => {
        const clip = renderClip(test.patch);
        const plan = compileExport(input({ project: { aspectRatio: "1:1", musicUrl: null, musicVolume: 1 }, clips: [clip] }), { resolution: "720p" }, {
            media: new Map([[URL_SQUARE, SQUARE_INFO]]), rasters: new Map(), gl: false,
        });
        // Luma as full-range gray: swscale's fast yuv → rgb24 path reads mid levels up to 2 low (Y 168 → 175, not 177).
        const select = `select='${SAMPLES.map((n) => `eq(n,${n})`).join("+")}',format=gray`;
        const frames = splitFrames(await runPlanVideo(host, plan, { [URL_SQUARE]: squarePng }, select), SIDE * SIDE * 3);
        expect(frames).toHaveLength(SAMPLES.length);
        const motion = itemMotion({ kind: "clip", clip });
        const failures: string[] = [];
        SAMPLES.forEach((n, i) => {
            const values = motionAt(motion, n / FPS);
            const box = placedBox({ x: 0, y: 0, w: SIDE, h: SIDE }, { w: BOX, h: BOX }, values);
            const m = measure(frames[i], SIDE);
            const level = 255 * values.opacity;
            const visible = box.w >= 6 && box.h >= 6 && level >= 4 && box.cx > box.w && box.cx < SIDE - box.w && box.cy > box.h && box.cy < SIDE - box.h;
            if (!visible) return;
            if (!m) {
                failures.push(`frame ${n}: nothing drawn, expected ${JSON.stringify(box)}`);
                return;
            }
            const report = (what: string, got: number, want: number, tolerance: number) => {
                if (Math.abs(got - want) > tolerance) failures.push(`frame ${n} ${what}: export ${got.toFixed(2)} vs preview ${want.toFixed(2)}`);
            };
            report("cx", m.cx, box.cx, 1);
            report("cy", m.cy, box.cy, 1);
            report("opacity level", m.peak, level, 2);
            if (test.rotates) {
                report("area", m.mass / values.opacity, box.w * box.h, (box.w + box.h) * 2);
            } else {
                report("width", m.width, box.w, 1);
                report("height", m.height, box.h, 1);
            }
        });
        expect(failures).toEqual([]);
    }, 600_000);
});

// ── (b) rendered scene placement (Task 16) ───────────────

const SCENE_PX = 100; // a 100 px white still: contain-fitted to 720 px at scale 1
const URL_SCENE = "/m/scene.png";
const URL_BLACK = "/m/black.png";
const scenePng = encodePng({ width: SCENE_PX, height: SCENE_PX, channels: 3, data: new Uint8Array(SCENE_PX * SCENE_PX * 3).fill(255) });
const blackPng = encodePng({ width: SCENE_PX, height: SCENE_PX, channels: 3, data: new Uint8Array(SCENE_PX * SCENE_PX * 3) });
const STILL = { durationSeconds: 0, hasVideo: true, hasAudio: false, width: SCENE_PX, height: SCENE_PX };
const stillScene = (id: string, start: number, duration: number, url: string, patch: Partial<SceneData>) =>
    makeScene(id, start, duration, { cardType: "image", sourceVideoUrl: null, startImageUrl: url, ...patch });

interface SceneCase {
    name: string;
    scenes: SceneData[];
    /** The measured scene and the frames to sample (timeline frames). */
    target: SceneData;
    samples: number[];
    rotates?: boolean;
}

const SCENE_CASES: SceneCase[] = (() => {
    const fadeZoom = stillScene("fz", 0, SECONDS, URL_SCENE, { transformScale: 0.15, transformOffsetX: -10, transformOffsetY: 12, animationJson: anim({ in: { id: "zoom_in", duration: 0.8 }, out: { id: "fade_out", duration: 0.5 } }) });
    const rotated = stillScene("rk", 0, SECONDS, URL_SCENE, {
        rotationDegrees: 15,
        keyframesJson: keys([
            { time: 0, rotation_degrees: 0, position_x: -20, position_y: 10, scale: 0.1, opacity: 0.4, easing: 3 },
            { time: 1.2, rotation_degrees: 120, position_x: 25, position_y: -15, scale: 0.2, opacity: 1, easing: 5, bx1: 0.3, by1: -0.5, bx2: 0.6, by2: 1.5 },
            { time: 2, rotation_degrees: 200, position_x: 0, position_y: 0, scale: 0.15, opacity: 0.8 },
        ]),
    });
    // A moving scene after a transition: its head and body are separate pieces that must keep scene-local time.
    const before = stillScene("bk", 0, 1, URL_BLACK, { visualTransition: "cross_dissolve", visualTransitionDuration: 0.4 });
    const after = stillScene("mv", 1, SECONDS, URL_SCENE, { transformScale: 0.12, animationJson: anim({ combo: { id: "combo_zoom_pulse" } }), keyframesJson: keys([{ time: 0, position_x: -30 }, { time: 2, position_x: 30, easing: 2 }]) });
    return [
        { name: "fade-in + zoom-in scene (zoom_in, fade_out, offsets)", scenes: [fadeZoom], target: fadeZoom, samples: SAMPLES },
        { name: "rotated keyframed scene (eased rotation, position, scale, opacity)", scenes: [rotated], target: rotated, samples: SAMPLES, rotates: true },
        { name: "moving scene after a transition window (body piece at scene-local time)", scenes: [before, after], target: after, samples: [37, 40, 45, 52, 60, 70, 80, 89] },
    ];
})();

describe.each(hosts.map((h) => [h.name, h] as const))("rendered scene placement on %s", (_name, host) => {
    it.each(SCENE_CASES.map((c) => [c.name, c] as const))("%s lands on scenePlacement at sampled frames", async (_label, test) => {
        const plan = compileExport(input({ project: { aspectRatio: "1:1", musicUrl: null, musicVolume: 1 }, scenes: test.scenes }), { resolution: "720p" }, {
            media: new Map([[URL_SCENE, STILL], [URL_BLACK, STILL]]), rasters: new Map(), gl: false,
        });
        const select = `select='${test.samples.map((n) => `eq(n,${n})`).join("+")}',format=gray`;
        const frames = splitFrames(await runPlanVideo(host, plan, { [URL_SCENE]: scenePng, [URL_BLACK]: blackPng }, select), SIDE * SIDE * 3);
        expect(frames).toHaveLength(test.samples.length);
        const start = Number(test.target.timelinePositionSeconds ?? 0) > 0.01 ? Number(test.target.timelinePositionSeconds) : 0;
        const length = sceneDuration(test.target);
        const failures: string[] = [];
        test.samples.forEach((n, i) => {
            const values = sceneMotionAt(test.target, length, n / FPS - start);
            const placed = scenePlacement(test.target.fitMode, { width: SCENE_PX, height: SCENE_PX }, { width: SIDE, height: SIDE }, values);
            const w = placed.width * placed.scaleX;
            const h = placed.height;
            const level = 255 * placed.opacity;
            if (w < 6 || h < 6 || level < 4) return;
            const m = measure(frames[i], SIDE);
            if (!m) {
                failures.push(`frame ${n}: nothing drawn, expected ${JSON.stringify(placed)}`);
                return;
            }
            const report = (what: string, got: number, want: number, tolerance: number) => {
                if (Math.abs(got - want) > tolerance) failures.push(`frame ${n} ${what}: export ${got.toFixed(2)} vs preview ${want.toFixed(2)}`);
            };
            report("cx", m.cx, placed.cx, 1);
            report("cy", m.cy, placed.cy, 1);
            report("opacity level", m.peak, level, 2);
            if (test.rotates) {
                report("area", m.mass / placed.opacity, w * h, (w + h) * 2);
            } else {
                report("width", m.width, w, 1);
                report("height", m.height, h, 1);
            }
        });
        expect(failures).toEqual([]);
    }, 600_000);
});

// ── non-positive scale hides the layer (the preview draws nothing there) ──

describe.each(hosts.map((h) => [h.name, h] as const))("non-positive scale on %s", (_name, host) => {
    it("an overlay and a scene draw nothing while their scale is 0 or less, and land on the preview box after", async () => {
        // Scale crosses 0 at t = 2/3 s (frame 20): samples 0-15 draw nothing, 22 on are measured.
        const clip = renderClip({ positionX: 0.3, positionY: 0.3, keyframesJson: keys([{ time: 0, scale: -1 }, { time: 2, scale: 2 }]) });
        const scene = stillScene("ns", 0, SECONDS, URL_SCENE, { transformOffsetX: 20, transformOffsetY: 20, keyframesJson: keys([{ time: 0, scale: -0.1 }, { time: 2, scale: 0.2 }]) });
        const select = `select='${SAMPLES.map((n) => `eq(n,${n})`).join("+")}',format=gray`;
        const failures: string[] = [];
        const clipPlan = compileExport(input({ project: { aspectRatio: "1:1", musicUrl: null, musicVolume: 1 }, clips: [clip] }), { resolution: "720p" }, {
            media: new Map([[URL_SQUARE, SQUARE_INFO]]), rasters: new Map(), gl: false,
        });
        const clipFrames = splitFrames(await runPlanVideo(host, clipPlan, { [URL_SQUARE]: squarePng }, select), SIDE * SIDE * 3);
        const motion = itemMotion({ kind: "clip", clip });
        SAMPLES.forEach((n, i) => {
            const values = motionAt(motion, n / FPS);
            const m = measure(clipFrames[i], SIDE);
            if (values.scale <= 0) {
                if (m) failures.push(`overlay frame ${n}: drawn at scale ${values.scale.toFixed(3)}`);
                return;
            }
            const box = placedBox({ x: 0, y: 0, w: SIDE, h: SIDE }, { w: BOX, h: BOX }, values);
            if (box.w < 6) return;
            if (!m) failures.push(`overlay frame ${n}: nothing drawn at scale ${values.scale.toFixed(3)}`);
            else if (Math.abs(m.cx - box.cx) > 1 || Math.abs(m.width - box.w) > 1) failures.push(`overlay frame ${n}: ${m.cx.toFixed(2)}/${m.width} vs ${box.cx.toFixed(2)}/${box.w.toFixed(2)}`);
        });
        const scenePlan = compileExport(input({ project: { aspectRatio: "1:1", musicUrl: null, musicVolume: 1 }, scenes: [scene] }), { resolution: "720p" }, {
            media: new Map([[URL_SCENE, STILL]]), rasters: new Map(), gl: false,
        });
        const sceneFrames = splitFrames(await runPlanVideo(host, scenePlan, { [URL_SCENE]: scenePng }, select), SIDE * SIDE * 3);
        SAMPLES.forEach((n, i) => {
            const values = sceneMotionAt(scene, sceneDuration(scene), n / FPS);
            const m = measure(sceneFrames[i], SIDE);
            if (values.scale <= 0) {
                if (m) failures.push(`scene frame ${n}: drawn at scale ${values.scale.toFixed(3)}`);
                return;
            }
            const placed = scenePlacement(scene.fitMode, { width: SCENE_PX, height: SCENE_PX }, { width: SIDE, height: SIDE }, values);
            if (placed.width < 6) return;
            if (!m) failures.push(`scene frame ${n}: nothing drawn at scale ${values.scale.toFixed(3)}`);
            else if (Math.abs(m.cx - placed.cx) > 1 || Math.abs(m.width - placed.width) > 1) failures.push(`scene frame ${n}: ${m.cx.toFixed(2)}/${m.width} vs ${placed.cx.toFixed(2)}/${placed.width.toFixed(2)}`);
        });
        expect(failures).toEqual([]);
    }, 600_000);
});
