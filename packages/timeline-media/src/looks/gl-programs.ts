// GLSL ES 3.00 sources for the preview's look renderer. Every shader mirrors the ffmpeg code path the
// export runs (see @opennan/timeline-core/looks and @opennan/export/looks): 8-bit levels in, integer or
// float32 math as ffmpeg does it, 8-bit levels out. Rows are stored top-first in every texture and
// framebuffer: the pixel (X, Y) being written is (floor(gl_FragCoord.x), floor(gl_FragCoord.y)).
import { emitGlsl, paramsOf, type Channel, type Expr } from "@opennan/timeline-core/looks/expr";
import { maskLevelExpr, type MaskShape } from "@opennan/timeline-core/looks/masks";

export const VERTEX_SHADER = `#version 300 es
in vec2 a_position;
void main() { gl_Position = vec4(a_position, 0.0, 1.0); }
`;

const HEADER = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
uniform sampler2D u_src0;
uniform sampler2D u_src1;
uniform vec2 u_size;
out vec4 o;
// The 8-bit level of a normalized channel (texelFetch of RGBA8 is level / 255).
float lv(vec4 t, int ch) { return floor(t[ch] * 255.0 + 0.5); }
ivec2 px() { return ivec2(gl_FragCoord.xy); }
`;

/** ffmpeg nearest sampling: clip to [0, size - 1], truncate, read the level. */
const SAMPLERS = `
float S0(int ch, float x, float y) {
    ivec2 q = ivec2(int(clamp(x, 0.0, u_size.x - 1.0)), int(clamp(y, 0.0, u_size.y - 1.0)));
    return lv(texelFetch(u_src0, q, 0), ch);
}
float S1(int ch, float x, float y) {
    ivec2 q = ivec2(int(clamp(x, 0.0, u_size.x - 1.0)), int(clamp(y, 0.0, u_size.y - 1.0)));
    return lv(texelFetch(u_src1, q, 0), ch);
}
`;

/** The store ffmpeg does after an expression: trunc(clip(e, 0, 255) + 0.5). */
const STORE = "float st8(float e) { return floor(clamp(e, 0.0, 255.0) + 0.5); }";

function channelBlock(name: string, expr: Expr): string {
    const { statements, expr: body } = emitGlsl(expr);
    return `    float ${name};\n    {\n        ${statements.join("\n        ")}\n        ${name} = ${body};\n    }`;
}

export interface ExprProgram {
    source: string;
    params: string[];
}

/** An effect pass (src 0, time T) or a transition (src 0 = A, src 1 = B, progress p); `channels` RGB or RGBA. */
export function exprProgram(channel: (ch: Channel) => Expr, channels: 3 | 4): ExprProgram {
    const exprs = ([0, 1, 2, 3] as Channel[]).slice(0, channels).map((ch) => channel(ch));
    const params = [...new Set(exprs.flatMap((e) => paramsOf(e)))].sort();
    const uniforms = params.map((p) => `uniform float u_${p};`).join("\n");
    const blocks = exprs.map((e, i) => channelBlock(`c${i}`, e)).join("\n");
    const alpha = channels === 4 ? "st8(c3)" : "floor(texelFetch(u_src0, px(), 0).a * 255.0 + 0.5)";
    const source = `${HEADER}
uniform float u_T;
uniform float u_p;
${uniforms}
${SAMPLERS}
${STORE}
void main() {
    float X = floor(gl_FragCoord.x);
    float Y = floor(gl_FragCoord.y);
    float W = u_size.x;
    float H = u_size.y;
    float T = u_T;
    float p = u_p;
${blocks}
    o = vec4(st8(c0), st8(c1), st8(c2), ${alpha}) / 255.0;
}
`;
    return { source, params };
}

/**
 * The mask pass (phase 10c, timeline-core looks/masks.ts): the level L (0..255) of the shape's expression at
 * this pixel, with the mask parameters as uniforms (the caller evaluates keyframes at the item's time), and
 * alpha' = (alpha · L) / 255 in integers — the export's blend multiply. Colour is copied. `u_mbox` (phase 10d) is
 * the item's box inside the frame (x, y, width, height; the whole frame for clips and scenes): a padded text or
 * sticker bitmap is masked in its box's coordinates (looks/masks.ts MaskBox).
 */
export function maskProgram(shape: MaskShape, invert: boolean): ExprProgram {
    const level = maskLevelExpr(shape, invert);
    const params = paramsOf(level);
    const uniforms = params.map((p) => `uniform float u_${p};`).join("\n");
    const source = `${HEADER}
${uniforms}
uniform vec4 u_mbox;
void main() {
    float X = floor(gl_FragCoord.x) - u_mbox.x;
    float Y = floor(gl_FragCoord.y) - u_mbox.y;
    float W = u_mbox.z;
    float H = u_mbox.w;
${channelBlock("level", level)}
    vec4 c = texelFetch(u_src0, px(), 0);
    int a = int(floor(c.a * 255.0 + 0.5));
    int l = int(clamp(level, 0.0, 255.0));
    o = vec4(c.rgb, float((a * l) / 255) / 255.0);
}
`;
    return { source, params };
}

/** vf_lut3d.c interp_8_trilinear on a Hald CLUT (level 8: 64 entries per axis in a 512×512 image). */
export const LUT_SHADER = `${HEADER}
uniform sampler2D u_lut;
vec3 node(int r, int g, int b) {
    int i = b * 4096 + g * 64 + r;
    return floor(texelFetch(u_lut, ivec2(i % 512, i / 512), 0).rgb * 255.0 + 0.5) / 255.0;
}
void main() {
    vec4 c = texelFetch(u_src0, px(), 0);
    vec3 level = floor(c.rgb * 255.0 + 0.5);
    vec3 s = clamp(level * (1.0 / 255.0) * 63.0, 0.0, 63.0);
    ivec3 pv = ivec3(s);
    ivec3 nx = min(pv + 1, ivec3(63));
    vec3 d = s - vec3(pv);
    vec3 c000 = node(pv.r, pv.g, pv.b);
    vec3 c001 = node(pv.r, pv.g, nx.b);
    vec3 c010 = node(pv.r, nx.g, pv.b);
    vec3 c011 = node(pv.r, nx.g, nx.b);
    vec3 c100 = node(nx.r, pv.g, pv.b);
    vec3 c101 = node(nx.r, pv.g, nx.b);
    vec3 c110 = node(nx.r, nx.g, pv.b);
    vec3 c111 = node(nx.r, nx.g, nx.b);
    vec3 c00 = c000 + (c100 - c000) * d.r;
    vec3 c10 = c010 + (c110 - c010) * d.r;
    vec3 c01 = c001 + (c101 - c001) * d.r;
    vec3 c11 = c011 + (c111 - c011) * d.r;
    vec3 c0 = c00 + (c10 - c00) * d.g;
    vec3 c1 = c01 + (c11 - c01) * d.g;
    vec3 v = c0 + (c1 - c0) * d.b;
    o = vec4(clamp(floor(v * 255.0), 0.0, 255.0) / 255.0, c.a);
}
`;

/** convolution 3x3 [0,-k,0,-k,16+4k,-k,0,-k,0] / 16 with clamped edges (the export pads a replicated border). */
export const SHARPEN_SHADER = `${HEADER}
uniform int u_k;
ivec3 at(ivec2 q) {
    ivec2 m = ivec2(u_size) - 1;
    return ivec3(floor(texelFetch(u_src0, clamp(q, ivec2(0), m), 0).rgb * 255.0 + 0.5));
}
void main() {
    ivec2 q = px();
    vec4 c = texelFetch(u_src0, q, 0);
    ivec3 sum = at(q) * (16 + 4 * u_k) - u_k * (at(q + ivec2(-1, 0)) + at(q + ivec2(1, 0)) + at(q + ivec2(0, -1)) + at(q + ivec2(0, 1)));
    vec3 v = trunc(vec3(sum) * 0.0625 + 0.5);
    o = vec4(clamp(v, 0.0, 255.0) / 255.0, c.a);
}
`;

/** blend all_mode=multiply: (A * B) / 255 in integers, B from an 8-bit mask the same size as the frame. */
export const MULTIPLY_SHADER = `${HEADER}
uniform sampler2D u_mask;
void main() {
    ivec2 q = px();
    vec4 c = texelFetch(u_src0, q, 0);
    ivec3 a = ivec3(floor(c.rgb * 255.0 + 0.5));
    int m = int(floor(texelFetch(u_mask, q, 0).r * 255.0 + 0.5));
    o = vec4(vec3((a * m) / 255) / 255.0, c.a);
}
`;

/** blend all_mode=grainmerge: clip(A + B - 128), B from the grain image at the window offset. */
export const GRAIN_SHADER = `${HEADER}
uniform sampler2D u_grain;
uniform ivec2 u_offset;
void main() {
    ivec2 q = px();
    vec4 c = texelFetch(u_src0, q, 0);
    ivec3 a = ivec3(floor(c.rgb * 255.0 + 0.5));
    int g = int(floor(texelFetch(u_grain, q + u_offset, 0).r * 255.0 + 0.5));
    o = vec4(vec3(clamp(a + g - 128, 0, 255)) / 255.0, c.a);
}
`;

/** Bilinear resize of a whole texture into the target (preview only: the export scales with swscale). */
export const RESIZE_SHADER = `${HEADER}
void main() {
    vec2 uv = gl_FragCoord.xy / u_size;
    o = texture(u_src0, uv);
}
`;

/**
 * A texture placed at a pixel rect on a frame-size target; elsewhere the background color. Inside, the layer's
 * alpha composites over the background (straight alpha, Porter-Duff over, as PLACE_AFFINE_SHADER): an opaque
 * layer is copied exactly, a masked one shows the background (black on V1, as the export's overlay onto black).
 */
export const PLACE_SHADER = `${HEADER}
uniform vec4 u_rect;
uniform vec4 u_background;
void main() {
    vec2 q = floor(gl_FragCoord.xy);
    vec2 local = q - u_rect.xy;
    if (local.x < 0.0 || local.y < 0.0 || local.x >= u_rect.z || local.y >= u_rect.w) {
        o = u_background;
        return;
    }
    vec4 c = texelFetch(u_src0, ivec2(local), 0);
    float a = c.a;
    float outA = a + u_background.a * (1.0 - a);
    vec3 rgb = outA > 0.0 ? (c.rgb * a + u_background.rgb * u_background.a * (1.0 - a)) / outA : vec3(0.0);
    o = vec4(floor(rgb * 255.0 + 0.5), floor(outA * 255.0 + 0.5)) / 255.0;
}
`;

/**
 * A texture placed through an affine map (scene motion, phase 10b): each frame pixel center goes through
 * the inverse map (u_inv0 · (x, y, 1), u_inv1 · (x, y, 1)) into texture pixels; inside the texture it is
 * sampled bilinearly (pooled frames are LINEAR), outside it is the background. The layer's alpha × opacity
 * composites over the background (straight alpha, Porter-Duff over): over opaque black on V1 that is the
 * export's overlay onto black, over clear on V2+ it keeps the layer's own alpha.
 */
export const PLACE_AFFINE_SHADER = `${HEADER}
uniform vec3 u_inv0;
uniform vec3 u_inv1;
uniform float u_opacity;
uniform vec4 u_background;
void main() {
    vec3 q = vec3(floor(gl_FragCoord.xy) + 0.5, 1.0);
    vec2 s = vec2(dot(u_inv0, q), dot(u_inv1, q));
    vec2 ts = vec2(textureSize(u_src0, 0));
    if (s.x < 0.0 || s.y < 0.0 || s.x >= ts.x || s.y >= ts.y) {
        o = u_background;
        return;
    }
    vec4 c = texture(u_src0, s / ts);
    float a = c.a * u_opacity;
    float outA = a + u_background.a * (1.0 - a);
    vec3 rgb = outA > 0.0 ? (c.rgb * a + u_background.rgb * u_background.a * (1.0 - a)) / outA : vec3(0.0);
    o = vec4(floor(rgb * 255.0 + 0.5), floor(outA * 255.0 + 0.5)) / 255.0;
}
`;

/** Weight steps of the Adjust-keyframe CLUT cross-fade (both sides quantize the eased weight to k / 1024). */
export const LUT_MIX_WEIGHT_STEPS = 1024;

/**
 * The cross-fade weight as both backends use it: clamp to [0, 1], round to k / 1024. With k / 1024 every
 * A + (B − A)·w on 8-bit levels is exact in float32 and in double, so the truncating store agrees bit for bit.
 */
export function lutMixWeight(weight: number): number {
    const w = Number.isFinite(weight) ? Math.min(1, Math.max(0, weight)) : 0;
    return Math.round(w * LUT_MIX_WEIGHT_STEPS) / LUT_MIX_WEIGHT_STEPS;
}

/**
 * The mixed 8-bit level (JS reference): trunc(A + (B − A)·w). ffmpeg's blend all_expr assigns the double
 * result to the uint8 plane (C conversion: truncation toward zero, checked on 7.1.5: A−0.5 on 10 stores 9).
 */
export function lutMixLevel(a: number, b: number, weight: number): number {
    return Math.floor(a + (b - a) * lutMixWeight(weight));
}

/**
 * Adjust keyframes (phase 10b): the pixel through two Hald CLUTs (the surrounding keyframes' looks), each
 * stored as lut3d stores it (LUT_SHADER, unchanged), then mixed with the quantized eased weight u_w and
 * truncated as blend all_expr stores: out = trunc(LUT_k(x) + (LUT_k+1(x) − LUT_k(x))·w). Alpha passes.
 */
export const LUT_MIX_SHADER = `${HEADER}
uniform sampler2D u_lut0;
uniform sampler2D u_lut1;
uniform float u_w;
vec3 node(sampler2D lut, int r, int g, int b) {
    int i = b * 4096 + g * 64 + r;
    return floor(texelFetch(lut, ivec2(i % 512, i / 512), 0).rgb * 255.0 + 0.5) / 255.0;
}
vec3 lut3d(sampler2D lut, vec3 level) {
    vec3 s = clamp(level * (1.0 / 255.0) * 63.0, 0.0, 63.0);
    ivec3 pv = ivec3(s);
    ivec3 nx = min(pv + 1, ivec3(63));
    vec3 d = s - vec3(pv);
    vec3 c000 = node(lut, pv.r, pv.g, pv.b);
    vec3 c001 = node(lut, pv.r, pv.g, nx.b);
    vec3 c010 = node(lut, pv.r, nx.g, pv.b);
    vec3 c011 = node(lut, pv.r, nx.g, nx.b);
    vec3 c100 = node(lut, nx.r, pv.g, pv.b);
    vec3 c101 = node(lut, nx.r, pv.g, nx.b);
    vec3 c110 = node(lut, nx.r, nx.g, pv.b);
    vec3 c111 = node(lut, nx.r, nx.g, nx.b);
    vec3 c00 = c000 + (c100 - c000) * d.r;
    vec3 c10 = c010 + (c110 - c010) * d.r;
    vec3 c01 = c001 + (c101 - c001) * d.r;
    vec3 c11 = c011 + (c111 - c011) * d.r;
    vec3 c0 = c00 + (c10 - c00) * d.g;
    vec3 c1 = c01 + (c11 - c01) * d.g;
    vec3 v = c0 + (c1 - c0) * d.b;
    return clamp(floor(v * 255.0), 0.0, 255.0);
}
void main() {
    vec4 c = texelFetch(u_src0, px(), 0);
    vec3 level = floor(c.rgb * 255.0 + 0.5);
    vec3 la = lut3d(u_lut0, level);
    vec3 lb = lut3d(u_lut1, level);
    o = vec4(floor(la + (lb - la) * u_w) / 255.0, c.a);
}
`;

/** Draws a texture onto the canvas: canvas rows are bottom-first, so flip. */
export const PRESENT_SHADER = `${HEADER}
uniform vec2 u_canvas;
void main() {
    vec2 uv = vec2(gl_FragCoord.x / u_canvas.x, 1.0 - gl_FragCoord.y / u_canvas.y);
    o = texture(u_src0, uv);
}
`;

// ── GPU export compositing (phase 10c) ────────────────────

/**
 * A layer composited over a base frame of the target size: each target pixel centre goes through the inverse
 * map into layer pixels and is sampled bilinearly with a transparent border (the layer's edge is anti-aliased like
 * ffmpeg's rotate/scale with a clear fill), straight alpha × opacity, Porter-Duff over the base, 8-bit store.
 */
export const COMPOSITE_SHADER = `${HEADER}
uniform sampler2D u_base;
uniform vec3 u_inv0;
uniform vec3 u_inv1;
uniform float u_opacity;
vec4 texel(ivec2 q, ivec2 ts) {
    if (q.x < 0 || q.y < 0 || q.x >= ts.x || q.y >= ts.y) return vec4(0.0);
    return texelFetch(u_src0, q, 0);
}
void main() {
    vec4 base = texelFetch(u_base, px(), 0);
    vec3 q = vec3(floor(gl_FragCoord.xy) + 0.5, 1.0);
    vec2 s = vec2(dot(u_inv0, q), dot(u_inv1, q)) - 0.5;
    ivec2 ts = textureSize(u_src0, 0);
    vec2 f0 = floor(s);
    vec2 f = s - f0;
    ivec2 i0 = ivec2(f0);
    vec4 c = mix(mix(texel(i0, ts), texel(i0 + ivec2(1, 0), ts), f.x), mix(texel(i0 + ivec2(0, 1), ts), texel(i0 + ivec2(1, 1), ts), f.x), f.y);
    float a = c.a * u_opacity;
    float outA = a + base.a * (1.0 - a);
    vec3 rgb = outA > 0.0 ? (c.rgb * a + base.rgb * base.a * (1.0 - a)) / outA : vec3(0.0);
    o = vec4(floor(rgb * 255.0 + 0.5), floor(outA * 255.0 + 0.5)) / 255.0;
}
`;

/** A solid frame. */
export const FILL_SHADER = `${HEADER}
uniform vec4 u_color;
void main() { o = u_color; }
`;

/** A sub-rectangle (u_offset = its top-left in the source). */
export const CROP_SHADER = `${HEADER}
uniform ivec2 u_offset;
void main() { o = texelFetch(u_src0, px() + u_offset, 0); }
`;

/** Nearest-neighbour resize (mosaic: ffmpeg scale flags=neighbor down, then up). */
export const NEAREST_SHADER = `${HEADER}
void main() {
    vec2 ts = vec2(textureSize(u_src0, 0));
    ivec2 q = ivec2(min(floor(floor(gl_FragCoord.xy) * ts / u_size), ts - 1.0));
    o = texelFetch(u_src0, q, 0);
}
`;

/**
 * Per-layer adjustments the ffmpeg overlay chain applies after the look: flips (hflip/vflip), a colour dip
 * (fade to black/white: rgb → colour by u_dip.a), and an alpha factor (alpha fades), with an 8-bit store.
 */
export const LAYER_ADJUST_SHADER = `${HEADER}
uniform vec2 u_flip;
uniform float u_alpha;
uniform vec4 u_dip;
void main() {
    ivec2 q = px();
    ivec2 size = ivec2(u_size);
    if (u_flip.x > 0.5) q.x = size.x - 1 - q.x;
    if (u_flip.y > 0.5) q.y = size.y - 1 - q.y;
    vec4 c = texelFetch(u_src0, q, 0);
    vec3 rgb = mix(c.rgb, u_dip.rgb, u_dip.a);
    o = vec4(floor(rgb * 255.0 + 0.5), floor(c.a * u_alpha * 255.0 + 0.5)) / 255.0;
}
`;

/** Rotates a frame by a multiple of 90° clockwise (video display rotation); the target has the rotated size. */
export const ROTATE90_SHADER = `${HEADER}
uniform int u_turns;
void main() {
    ivec2 q = px();
    ivec2 ts = textureSize(u_src0, 0);
    ivec2 s;
    if (u_turns == 1) s = ivec2(q.y, ts.y - 1 - q.x);
    else if (u_turns == 2) s = ivec2(ts.x - 1 - q.x, ts.y - 1 - q.y);
    else if (u_turns == 3) s = ivec2(ts.x - 1 - q.y, q.x);
    else s = q;
    o = texelFetch(u_src0, s, 0);
}
`;

// ── legacy clip filters (blur slider, chroma key, blend modes; timeline-core looks/legacy.ts) ──

/**
 * 8-bit RGB ↔ BT.601 limited-range YUV, rounded (legacy.ts rgbToYuv601 / yuvToRgb601), clamped pixel reads, and
 * the 4:2:0 chroma sample of a 2×2 block (the rounded mean of its pixels, edge pixels repeated).
 */
const LEGACY_YUV = `
float rnd8(float v) { return clamp(floor(v + 0.5), 0.0, 255.0); }
vec3 toYuv(vec3 c) {
    return vec3(
        rnd8(16.0 + (65.481 * c.r + 128.553 * c.g + 24.966 * c.b) / 255.0),
        rnd8(128.0 + (-37.797 * c.r - 74.203 * c.g + 112.0 * c.b) / 255.0),
        rnd8(128.0 + (112.0 * c.r - 93.786 * c.g - 18.214 * c.b) / 255.0));
}
vec3 toRgb(vec3 yuv) {
    float l = 1.164383 * (yuv.x - 16.0);
    return vec3(
        rnd8(l + 1.596027 * (yuv.z - 128.0)),
        rnd8(l - 0.391762 * (yuv.y - 128.0) - 0.812968 * (yuv.z - 128.0)),
        rnd8(l + 2.017232 * (yuv.y - 128.0)));
}
ivec2 clampPx(ivec2 q) { return clamp(q, ivec2(0), ivec2(u_size) - 1); }
vec4 lv4(ivec2 q) { return floor(texelFetch(u_src0, clampPx(q), 0) * 255.0 + 0.5); }
vec2 pixelUv(ivec2 q) { return toYuv(lv4(q).rgb).yz; }
vec2 blockUv(ivec2 b) {
    vec2 s = pixelUv(b * 2) + pixelUv(b * 2 + ivec2(1, 0)) + pixelUv(b * 2 + ivec2(0, 1)) + pixelUv(b * 2 + ivec2(1, 1));
    return floor((s + 2.0) / 4.0);
}
`;

/** One avgblur tap in the plane mode's levels: planar RGB(A) (0) or YUV(A) (1: 4:4:4, 2: 4:2:0 — chroma replaced by block sums). */
const BLUR_TAP = `
uniform int u_mode;
vec4 tapValue(ivec2 q) {
    vec4 c = lv4(q);
    return u_mode == 0 ? c : vec4(toYuv(c.rgb), c.a);
}
`;

/** Back to RGBA8 from the planes' truncated means. */
const BLUR_STORE = `
vec4 blurStore(vec4 sum, float area) {
    vec4 m = floor(sum / area);
    return vec4(u_mode == 0 ? m.rgb : toRgb(m.xyz), m.w) / 255.0;
}
`;

/**
 * vf_avgblur, horizontal half: per pixel the integer sum of the (2rx + 1) clamped taps of each plane into a float
 * frame (exact up to radius 20: 41 × 255). 4:2:0 chroma sums whole chroma blocks along the pixel's block row.
 */
export const BLUR_H_SHADER = `${HEADER}
uniform int u_rx;
${LEGACY_YUV}
${BLUR_TAP}
void main() {
    ivec2 p = px();
    vec4 sum = vec4(0.0);
    for (int i = -u_rx; i <= u_rx; i += 1) sum += tapValue(p + ivec2(i, 0));
    if (u_mode == 2) {
        int cw = (int(u_size.x) + 1) / 2;
        ivec2 b = p / 2;
        vec2 cs = vec2(0.0);
        for (int i = -u_rx; i <= u_rx; i += 1) cs += blockUv(ivec2(clamp(b.x + i, 0, cw - 1), b.y));
        sum.yz = cs;
    }
    o = sum;
}
`;

/** vf_avgblur, vertical half: sums the horizontal sums over (2ry + 1) clamped rows (block rows for 4:2:0 chroma), floor(Σ / area). */
export const BLUR_V_SHADER = `${HEADER}
uniform int u_ry;
uniform float u_area;
${LEGACY_YUV.replace(/vec4 lv4[\s\S]*$/, "")}
uniform int u_mode;
${BLUR_STORE}
void main() {
    ivec2 p = px();
    int h = int(u_size.y);
    vec4 sum = vec4(0.0);
    for (int j = -u_ry; j <= u_ry; j += 1) sum += texelFetch(u_src0, ivec2(p.x, clamp(p.y + j, 0, h - 1)), 0);
    if (u_mode == 2) {
        int ch = (h + 1) / 2;
        int by = p.y / 2;
        vec2 cs = vec2(0.0);
        for (int j = -u_ry; j <= u_ry; j += 1) cs += texelFetch(u_src0, ivec2(p.x, clamp(by + j, 0, ch - 1) * 2), 0).yz;
        sum.yz = cs;
    }
    o = blurStore(sum, u_area);
}
`;

/** vf_avgblur in one pass (no float render targets): the full (2rx + 1) × (2ry + 1) window per pixel. */
export const BLUR_2D_SHADER = `${HEADER}
uniform int u_rx;
uniform int u_ry;
uniform float u_area;
${LEGACY_YUV}
${BLUR_TAP}
${BLUR_STORE}
void main() {
    ivec2 p = px();
    vec4 sum = vec4(0.0);
    for (int j = -u_ry; j <= u_ry; j += 1) {
        for (int i = -u_rx; i <= u_rx; i += 1) sum += tapValue(p + ivec2(i, j));
    }
    if (u_mode == 2) {
        int cw = (int(u_size.x) + 1) / 2;
        int ch = (int(u_size.y) + 1) / 2;
        ivec2 b = p / 2;
        vec2 cs = vec2(0.0);
        for (int j = -u_ry; j <= u_ry; j += 1) {
            for (int i = -u_rx; i <= u_rx; i += 1) cs += blockUv(ivec2(clamp(b.x + i, 0, cw - 1), clamp(b.y + j, 0, ch - 1)));
        }
        sum.yz = cs;
    }
    o = blurStore(sum, u_area);
}
`;

/**
 * vf_chromakey: alpha = the level of the mean chroma distance sqrt((du² + dv²) / (2 · 255²)) to the key over the
 * 3×3 neighbourhood (clamped; per 2×2 block for 4:2:0), hard (diff > similarity) or ramped over `blend`, stored by
 * truncation. The colour is kept and the alpha replaced, as ffmpeg writes the alpha plane.
 */
export const CHROMA_KEY_SHADER = `${HEADER}
uniform vec2 u_key;
uniform float u_similarity;
uniform float u_blend;
uniform int u_sub;
${LEGACY_YUV}
void main() {
    ivec2 p = px();
    float diff = 0.0;
    for (int yo = -1; yo <= 1; yo += 1) {
        for (int xo = -1; xo <= 1; xo += 1) {
            ivec2 q = clampPx(p + ivec2(xo, yo));
            vec2 d = (u_sub == 1 ? blockUv(q / 2) : pixelUv(q)) - u_key;
            diff += sqrt((d.x * d.x + d.y * d.y) / (255.0 * 255.0 * 2.0));
        }
    }
    diff /= 9.0;
    float a = u_blend > 0.0001 ? floor(clamp((diff - u_similarity) / u_blend, 0.0, 1.0) * 255.0) : (diff > u_similarity ? 255.0 : 0.0);
    o = vec4(texelFetch(u_src0, p, 0).rgb, a / 255.0);
}
`;

/** eq's 8-bit lookup (legacy blend modes) on BT.601 YUV: pel = clip(floor(val · c / 4096) + b, 0, 255) per plane. */
export const EQ_YUV_SHADER = `${HEADER}
uniform vec4 u_eq;
uniform ivec2 u_on;
${LEGACY_YUV}
float eqv(float v, float c, float b) { return clamp(floor(v * c / 4096.0) + b, 0.0, 255.0); }
void main() {
    vec4 t = texelFetch(u_src0, px(), 0);
    vec3 yuv = toYuv(floor(t.rgb * 255.0 + 0.5));
    if (u_on.x == 1) yuv.x = eqv(yuv.x, u_eq.x, u_eq.y);
    if (u_on.y == 1) yuv.yz = vec2(eqv(yuv.y, u_eq.z, u_eq.w), eqv(yuv.z, u_eq.z, u_eq.w));
    o = vec4(toRgb(yuv) / 255.0, t.a);
}
`;
