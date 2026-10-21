// e2e builds only: renders the looks catalog through the preview's WebGL2 LookRenderer and through the
// JS reference (which the export parity tests prove equal to ffmpeg), and reports the difference.
// gl-parity.spec.ts drives it; nothing in the app imports it.
import { legacyReference, type LegacyOps } from "@opennan/timeline-core/looks/legacy";
import { itemLook, type LookSource } from "@opennan/timeline-core/looks/look-plan";
import { renderLookReference, renderTransitionReference, type RawFrame } from "@opennan/timeline-core/looks/reference";
import { transitionById } from "@opennan/timeline-core/looks/transitions";
import type { MaskBox } from "@opennan/timeline-core/looks/masks";
import { LookRenderer } from "@opennan/timeline-media/looks/look-renderer";

export type HarnessCase =
    /**
     * `alpha`: the input frame carries an alpha ramp (masks multiply it). `t`: item time (a mask's keyframe time).
     * `maskBox` (phase 10d): the item's box inside the frame (a padded text or sticker bitmap).
     */
    | { kind: "look"; name: string; item: LookSource; t?: number; alpha?: boolean; maskBox?: MaskBox }
    | { kind: "transition"; name: string; id: string; p: number }
    /** Phase 10d: the legacy blur slider, chroma key, and blend modes (LookRenderer.legacy vs looks/legacy.ts). `keyed`: green and blue screens in the frame. */
    | { kind: "legacy"; name: string; ops: LegacyOps; alpha?: boolean; keyed?: boolean; size?: [number, number]; singlePass?: boolean };

export interface HarnessResult {
    name: string;
    mean: number;
    p999: number;
    max: number;
    /** The alpha channel's difference (looks with a mask step only). */
    alpha?: { mean: number; p999: number; max: number };
    error?: string;
}

function frame(width: number, height: number, seed: number, alphaRamp = false): RawFrame {
    let s = seed >>> 0 || 1;
    const rand = () => {
        s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
        return s / 4294967296;
    };
    const data = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            const o = (y * width + x) * 4;
            const noise = (rand() - 0.5) * 24;
            const edge = (x + y) % 32 < 16 ? 220 : 30;
            data[o] = Math.max(0, Math.min(255, Math.round((x / (width - 1)) * 255 + noise)));
            data[o + 1] = Math.max(0, Math.min(255, Math.round((y / (height - 1)) * 255 + noise)));
            data[o + 2] = Math.max(0, Math.min(255, Math.round(edge * (1 - x / width) + 128 * (x / width) + noise)));
            data[o + 3] = alphaRamp ? Math.round(255 - (x / width) * 140) : 255;
        }
    }
    return { width, height, channels: 4, data };
}

/** A frame with a noisy green screen on its left third and a blue one at the bottom right (chroma key cases). */
function keyedFrame(source: RawFrame): RawFrame {
    const { width, height } = source;
    const data = new Uint8Array(source.data);
    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            const n = ((x * 7 + y * 13) % 17) - 8;
            if (x < width / 3) data.set([10 + n, 230 + n, 20 + n], (y * width + x) * 4);
            else if (x > width * 0.7 && y > height * 0.6) data.set([40 + n, 60 + n, 220 + n], (y * width + x) * 4);
        }
    }
    return { ...source, data };
}

function compare(a: Uint8Array, b: Uint8Array, alpha = false): { mean: number; p999: number; max: number } {
    const histogram = new Uint32Array(256);
    let sum = 0;
    let max = 0;
    let count = 0;
    for (let i = 0; i < a.length; i += 1) {
        if ((i % 4 === 3) !== alpha) continue;
        const d = Math.abs(a[i] - b[i]);
        histogram[d] += 1;
        sum += d;
        count += 1;
        if (d > max) max = d;
    }
    let acc = 0;
    let p999 = 0;
    for (let d = 0; d < 256; d += 1) {
        acc += histogram[d];
        if (acc >= count * 0.999) {
            p999 = d;
            break;
        }
    }
    return { mean: sum / count, p999, max };
}

export function runLooksHarness(cases: HarnessCase[], width = 96, height = 54): HarnessResult[] {
    const renderer = new LookRenderer();
    const a = frame(width, height, 41);
    const b = frame(width, height, 7);
    const alphaFrame = frame(width, height, 41, true);
    try {
        return cases.map((testCase) => {
            try {
                if (testCase.kind === "look") {
                    const plan = itemLook(testCase.item);
                    const input = testCase.alpha ? alphaFrame : a;
                    const t = testCase.t ?? 0;
                    const out = renderer.readPixels(renderer.look(renderer.uploadPixels(input.data, width, height), plan, t, t, testCase.maskBox));
                    renderer.releaseAll();
                    const expected = renderLookReference(input, plan, t, testCase.maskBox).data;
                    const masked = plan?.steps.some((step) => step.kind === "mask") ?? false;
                    return { name: testCase.name, ...compare(out, expected), ...(masked ? { alpha: compare(out, expected, true) } : {}) };
                }
                if (testCase.kind === "legacy") {
                    const [w, h] = testCase.size ?? [width, height];
                    const base = testCase.size ? frame(w, h, 41, testCase.alpha) : testCase.alpha ? alphaFrame : a;
                    const input = testCase.keyed ? keyedFrame(base) : base;
                    // The blur's one-pass fallback (contexts without float render targets).
                    const internals = renderer as unknown as { floatTargets: boolean | null };
                    const floats = internals.floatTargets;
                    if (testCase.singlePass) internals.floatTargets = false;
                    const out = renderer.readPixels(renderer.legacy(renderer.uploadPixels(input.data, w, h), testCase.ops));
                    internals.floatTargets = floats;
                    renderer.releaseAll();
                    const expected = legacyReference(input.data, w, h, testCase.ops);
                    return { name: testCase.name, ...compare(out, expected), alpha: compare(out, expected, true) };
                }
                const def = transitionById(testCase.id)!;
                const out = renderer.readPixels(renderer.transition(renderer.uploadPixels(a.data, width, height), renderer.uploadPixels(b.data, width, height), def, testCase.p, 4));
                renderer.releaseAll();
                return { name: testCase.name, ...compare(out, renderTransitionReference(def, a, b, testCase.p).data) };
            } catch (error) {
                return { name: testCase.name, mean: 255, p999: 255, max: 255, error: String(error) };
            }
        });
    } finally {
        renderer.dispose();
    }
}

(window as unknown as { __looksHarness: typeof runLooksHarness }).__looksHarness = runLooksHarness;
