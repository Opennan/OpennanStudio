// Deterministic RGBA blur for text blur states (phase 10b). Canvas `filter: blur()` differs between
// hosts (and is missing in some), so blur states blur the drawn bitmap with this function instead:
// three separable box passes (≈ gaussian) in premultiplied alpha, integer math only, edges clamped.
// Every host that runs it on the same pixels gets the same bytes.

const PASSES = 3;

/** One horizontal or vertical box pass of radius r over a planar Int32 buffer (clamp-to-edge). */
function boxPass(src: Int32Array, dst: Int32Array, w: number, h: number, r: number, horizontal: boolean): void {
    const size = 2 * r + 1;
    const half = r; // (sum + r) / size, floored: round half down, symmetric for mirrored inputs
    const lines = horizontal ? h : w;
    const length = horizontal ? w : h;
    const stride = horizontal ? 1 : w;
    const last = length - 1;
    for (let line = 0; line < lines; line += 1) {
        const base = horizontal ? line * w : line;
        const first = src[base];
        const end = src[base + last * stride];
        let sum = 0;
        for (let i = -r; i <= r; i += 1) sum += src[base + (i < 0 ? 0 : i > last ? last : i) * stride];
        for (let i = 0; i < length; i += 1) {
            dst[base + i * stride] = Math.floor((sum + half) / size);
            const enter = i + r + 1;
            const leave = i - r;
            sum += (enter > last ? end : src[base + enter * stride]) - (leave < 0 ? first : src[base + leave * stride]);
        }
    }
}

/**
 * Blurs RGBA pixels (w × h, row-major) with radius `radius` px and returns a new array; radius ≤ 0
 * returns an unchanged copy. Colours are weighted by alpha (premultiplied as c·a and a·255, both on
 * a 0..65025 scale) so transparent pixels never tint their neighbours.
 */
export function boxBlurRgba(data: Uint8ClampedArray, w: number, h: number, radius: number): Uint8ClampedArray {
    const r = Math.max(0, Math.floor(radius));
    const out = new Uint8ClampedArray(data);
    if (r === 0 || w <= 0 || h <= 0) return out;
    const count = w * h;
    const planes = [0, 1, 2, 3].map(() => new Int32Array(count));
    for (let i = 0; i < count; i += 1) {
        const a = data[i * 4 + 3];
        planes[0][i] = data[i * 4] * a;
        planes[1][i] = data[i * 4 + 1] * a;
        planes[2][i] = data[i * 4 + 2] * a;
        planes[3][i] = a * 255;
    }
    const scratch = new Int32Array(count);
    for (const plane of planes) {
        for (let pass = 0; pass < PASSES; pass += 1) {
            boxPass(plane, scratch, w, h, r, true);
            boxPass(scratch, plane, w, h, r, false);
        }
    }
    for (let i = 0; i < count; i += 1) {
        const a = planes[3][i];
        const o = i * 4;
        out[o + 3] = Math.floor((a + 127) / 255);
        if (a <= 0 || out[o + 3] === 0) {
            out[o] = 0;
            out[o + 1] = 0;
            out[o + 2] = 0;
            continue;
        }
        for (let c = 0; c < 3; c += 1) out[o + c] = Math.min(255, Math.floor((planes[c][i] * 510 + a) / (2 * a)));
    }
    return out;
}
