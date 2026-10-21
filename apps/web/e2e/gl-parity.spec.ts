// The preview's WebGL2 looks renderer against the JS reference the export parity tests prove equal to
// ffmpeg (packages/export/parity): every transition at three progress values, every filter, every
// adjustment, and every effect, in Chromium.
import { expect, test } from "@playwright/test";

const TRANSITIONS = [
    "cross_dissolve", "dip_black", "dip_white", "flash", "luma_fade", "slide_left", "slide_right", "slide_up", "slide_down", "push_left",
    "push_right", "wipe_left", "wipe_right", "wipe_up", "wipe_down", "circle_open", "clock_wipe", "zoom_in", "zoom_out", "spin",
    "blur_dissolve", "glitch", "swirl", "pixelate", "ripple",
];
const FILTERS = [
    "fresh", "warm", "cool", "soft", "bright", "cinematic", "teal_orange", "blockbuster", "moody", "bleach_bypass", "vintage", "instant",
    "faded", "seventies", "cross_process", "mono", "noir", "silver", "selenium", "blue_tone", "delicious", "crisp", "honey", "fresh_greens",
    "rich", "vivid", "golden_hour", "lush", "azure", "desert",
];
const ADJUSTMENTS: Array<[string, number]> = [
    ["brightness", 0.5], ["contrast", -0.6], ["saturation", 0.7], ["exposure", -0.4], ["temperature", 0.8], ["tint", -0.5], ["highlights", -0.7],
    ["shadows", 0.6], ["vibrance", 0.9], ["fade", 0.6], ["sharpen", 0.7], ["vignette", 0.8], ["grain", 0.6],
];
const EFFECTS = [
    "fx_blur", "fx_zoom_blur", "fx_pixelate", "fx_mirror", "fx_kaleidoscope", "fx_black_white", "fx_sepia", "fx_duotone", "fx_edge_glow",
    "fx_shake", "fx_zoom_pulse", "fx_strobe", "fx_flash", "fx_vignette_pulse", "fx_vhs", "fx_film_grain", "fx_old_film", "fx_light_leak",
    "fx_rgb_split", "fx_glitch",
];

const MASK_SHAPES = ["linear", "mirror", "circle", "rectangle", "heart", "star"];
const MASK_KEYFRAMES = JSON.stringify({ keyframes: [
    { time: 0, mask_x: 0.3, mask_y: 0.4, mask_w: 0.5, mask_h: 0.4, mask_rotation: -10, mask_feather: 0 },
    { time: 1, mask_x: 0.6, mask_y: 0.6, mask_w: 0.8, mask_h: 0.7, mask_rotation: 40, mask_feather: 0.3, easing: 3 },
] });
const mask = (shape: string, over: Record<string, unknown> = {}) => JSON.stringify({
    shape, x: 0.46, y: 0.53, width: 0.7, height: 0.55, rotation: 17, feather: 0.12, roundness: 0.45, ...over,
});

/** A text raster's layout box centred in its padded bitmap (compile/overlays.ts overlayMaskBox). */
const TEXT_BOX = { x: (96 - 75.5) / 2, y: (54 - 41) / 2, width: 75.5, height: 41 };
// Phase 10d: the legacy clip controls on the GPU path (timeline-core looks/legacy.ts references, ffmpeg parity in
// packages/export/parity/legacy.parity.test.ts). Key colours as vf_chromakey converts them (chromaKeyUv).
const GREEN = { u: 44, v: 21 };
const BLUE = { u: 208, v: 115 };
const LEGACY = [
    ...(["rgb", "yuv444", "yuv420"] as const).flatMap((mode) => [1, 4, 20].map((radius) => ({ kind: "legacy", name: `blur ${radius} ${mode}`, ops: { blur: { radius, mode }, chromaKey: null, eq: null }, alpha: true }))),
    ...[false, true].flatMap((subsampled) => [
        { kind: "legacy", name: `chroma key hard${subsampled ? " 4:2:0" : ""}`, keyed: true, ops: { blur: null, chromaKey: { key: { ...GREEN, similarity: 0.12, blend: 0 }, subsampled }, eq: null } },
        { kind: "legacy", name: `chroma key soft${subsampled ? " 4:2:0" : ""}`, keyed: true, ops: { blur: null, chromaKey: { key: { ...GREEN, similarity: 0.05, blend: 0.2 }, subsampled }, eq: null } },
        { kind: "legacy", name: `chroma key blue${subsampled ? " 4:2:0" : ""}`, keyed: true, ops: { blur: null, chromaKey: { key: { ...BLUE, similarity: 0.1, blend: 0.1 }, subsampled }, eq: null } },
    ]),
    // Blend modes: eqPlanes of the reference assembler's eq settings (filters/video.ts BLEND_MODE_ADJUSTMENTS).
    { kind: "legacy", name: "blend multiply", ops: { blur: null, chromaKey: null, eq: { luma: [4710, -40], chroma: null } } },
    { kind: "legacy", name: "blend screen", ops: { blur: null, chromaKey: null, eq: { luma: [3686, 30], chroma: null } } },
    { kind: "legacy", name: "blend overlay", ops: { blur: null, chromaKey: null, eq: { luma: [5120, -33], chroma: [4505, -13] } } },
    // Export-sized layers (odd sizes too) through both blur paths.
    ...[false, true].flatMap((singlePass) => ([[256, 144], [231, 97]] as const).map(([w, h]) => ({
        kind: "legacy", name: `blur 6 4:2:0 + overlay ${w}x${h}${singlePass ? " one pass" : ""}`, size: [w, h], singlePass,
        ops: { blur: { radius: 6, mode: "yuv420" }, chromaKey: null, eq: { luma: [5120, -33], chroma: [4505, -13] } },
    }))),
    { kind: "legacy", name: "blur + key + overlay 4:2:0", keyed: true, alpha: true, ops: {
        blur: { radius: 2, mode: "yuv420" }, chromaKey: { key: { ...GREEN, similarity: 0.1, blend: 0.15 }, subsampled: true }, eq: { luma: [5120, -33], chroma: [4505, -13] },
    } },
];

interface Diff { mean: number; p999: number; max: number }
interface Result extends Diff { name: string; alpha?: Diff; error?: string }

test("every look renders in WebGL2 as the export renders it", async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto("/#/");
    await expect.poll(() => page.evaluate(() => typeof (window as unknown as { __looksHarness?: unknown }).__looksHarness)).toBe("function");
    const cases = [
        ...TRANSITIONS.flatMap((id) => [0.2, 0.5, 0.8].map((p) => ({ kind: "transition", name: `${id}@${p}`, id, p }))),
        ...FILTERS.map((id) => ({ kind: "look", name: `filter ${id}`, item: { kind: "scene", visualFilter: id, filterIntensity: 0.85 } })),
        ...ADJUSTMENTS.map(([key, value]) => ({ kind: "look", name: `adjust ${key}`, item: { kind: "scene", adjustmentsJson: JSON.stringify({ [key]: value }) }, t: 0.3 })),
        ...EFFECTS.map((id) => ({ kind: "look", name: id, item: { kind: "scene", effects: [{ id: "row", effectId: id, order: 0, paramsJson: null, enabled: true }] }, t: 0.37 })),
        { kind: "look", name: "full look", item: {
            kind: "clip", visualFilter: "golden_hour", filterIntensity: 0.6, brightness: 0.1, contrast: 1.2, saturation: 1,
            adjustmentsJson: JSON.stringify({ sharpen: 0.5, vignette: 0.4, grain: 0.3 }),
            effects: [{ id: "1", effectId: "fx_duotone", order: 0, paramsJson: null, enabled: true }, { id: "2", effectId: "fx_vhs", order: 1, paramsJson: null, enabled: true }],
        }, t: 0.5 },
        // Masks (phase 10c): every shape static (hard and feathered, inverted), on an alpha ramp, and keyframed.
        ...MASK_SHAPES.flatMap((shape) => [
            { kind: "look", name: `mask ${shape}`, item: { kind: "scene", maskJson: mask(shape) } },
            { kind: "look", name: `mask ${shape} hard inverted`, item: { kind: "scene", maskJson: mask(shape, { feather: 0, invert: true }) } },
            { kind: "look", name: `mask ${shape} on alpha`, item: { kind: "clip", trackType: "video", maskJson: mask(shape) }, alpha: true },
            { kind: "look", name: `mask ${shape} keyframed`, item: { kind: "scene", maskJson: mask(shape), keyframesJson: MASK_KEYFRAMES }, t: 0.6 },
        ]),
        // Text and sticker masks (phase 10d): in the item box of a padded bitmap (96×54 around a 75.5×41 box), on alpha.
        ...MASK_SHAPES.flatMap((shape) => [
            { kind: "look", name: `mask ${shape} text box`, item: { kind: "clip", trackType: "text", maskJson: mask(shape) }, alpha: true, maskBox: TEXT_BOX },
            { kind: "look", name: `mask ${shape} sticker box keyframed`, item: { kind: "clip", trackType: "sticker", maskJson: mask(shape, { invert: true }), keyframesJson: MASK_KEYFRAMES }, alpha: true, maskBox: TEXT_BOX, t: 0.6 },
        ]),
        ...LEGACY,
        { kind: "look", name: "mask with a look", item: {
            kind: "scene", visualFilter: "teal_orange", filterIntensity: 0.7, maskJson: mask("heart"),
            effects: [{ id: "1", effectId: "fx_rgb_split", order: 0, paramsJson: null, enabled: true }],
        }, t: 0.4 },
    ];
    const results = await page.evaluate((c) => (window as unknown as { __looksHarness(cases: unknown[]): Result[] }).__looksHarness(c), cases);
    expect(results).toHaveLength(cases.length);
    for (const r of results) {
        expect(r.error, r.name).toBeUndefined();
        expect(r.mean, r.name).toBeLessThanOrEqual(0.1);
        // Nearest-sampling edges (kaleidoscope folds) may land one pixel over on a few samples.
        expect(r.p999, r.name).toBeLessThanOrEqual(r.name === "fx_kaleidoscope" ? 24 : 2);
        if (LEGACY.some((c) => c.name === r.name)) {
            process.stderr.write(`[gl-parity] ${r.name}: mean ${r.mean.toFixed(3)} p99.9 ${r.p999} max ${r.max}; alpha mean ${r.alpha?.mean.toFixed(3)} p99.9 ${r.alpha?.p999} max ${r.alpha?.max}\n`);
        }
        if (r.name.startsWith("mask") || LEGACY.some((c) => c.name === r.name)) {
            // float32 shader vs double reference: an edge pixel may land one level over.
            expect(r.alpha, r.name).toBeDefined();
            expect(r.alpha!.mean, `${r.name} alpha`).toBeLessThanOrEqual(0.1);
            expect(r.alpha!.p999, `${r.name} alpha`).toBeLessThanOrEqual(2);
        }
    }
});
