// src/lib/effect-renderer.ts
// Real-time WebGL renderer for the clip effect stack (the live "CapCut" preview).
//
// Given a <canvas>, a source frame (video or image), and an ordered list of
// effects (each = the registry GLSL body + resolved param values), it renders
// the source through every effect shader in sequence using ping-pong
// framebuffers, ending on the screen. This mirrors the server's ffmpeg export
// so the preview matches the final render.

import createREGL from "regl";

export interface RenderEffect {
    id: string;
    glsl: string; // body defining: vec4 effect(sampler2D tex, vec2 uv) { ... }
    floatParams: Record<string, number>;
    keyColor?: [number, number, number]; // for chroma-key style color params
}

const VERT = `
precision mediump float;
attribute vec2 position;
varying vec2 vUv;
void main() {
    vUv = position * 0.5 + 0.5;
    gl_Position = vec4(position, 0.0, 1.0);
}
`;

// gl-transitions signature: the shader defines `vec4 transition(vec2 uv)` and
// reads getFromColor/getToColor/progress. Same contract as the export xfade.
function buildTransitionFrag(glslBody: string): string {
    return `
precision mediump float;
uniform sampler2D fromTex;
uniform sampler2D toTex;
uniform float progress;
uniform vec2 resolution;
varying vec2 vUv;
vec4 getFromColor(vec2 uv){ return texture2D(fromTex, uv); }
vec4 getToColor(vec2 uv){ return texture2D(toTex, uv); }
${glslBody}
void main(){ gl_FragColor = transition(vUv); }
`;
}

const PASSTHROUGH = `
vec4 effect(sampler2D tex, vec2 uv) { return texture2D(tex, uv); }
`;

export function canUseEffectRenderer(canvas: HTMLCanvasElement): boolean {
    if (!canvas || typeof canvas.getContext !== "function") return false;

    try {
        return Boolean(canvas.getContext("webgl") || canvas.getContext("experimental-webgl"));
    } catch {
        return false;
    }
}

function buildFrag(glslBody: string, floatKeys: string[], hasColor: boolean): string {
    const floatUniforms = floatKeys.map((k) => `uniform float ${k};`).join("\n");
    const colorUniform = hasColor ? "uniform vec3 keyColor;" : "";
    return `
precision mediump float;
uniform sampler2D tex;
uniform vec2 resolution;
uniform float time;
${floatUniforms}
${colorUniform}
varying vec2 vUv;
// Shared helpers so effects can be animated/textured.
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    float a = hash(i), b = hash(i + vec2(1.0, 0.0));
    float c = hash(i + vec2(0.0, 1.0)), d = hash(i + vec2(1.0, 1.0));
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(a, b, u.x) + (c - a) * u.y * (1.0 - u.x) + (d - b) * u.x * u.y;
}
${glslBody}
void main() {
    gl_FragColor = effect(tex, vUv);
}
`;
}

export class EffectRenderer {
    private regl: ReturnType<typeof createREGL> | null = null;
    private source: any = null; // regl texture
    private fromTex: any = null;
    private toTex: any = null;
    private fbos: any[] = [];
    private commands = new Map<string, any>();
    private transitionCommands = new Map<string, any>();
    private canvas: HTMLCanvasElement;

    constructor(canvas: HTMLCanvasElement, opts?: { preserveDrawingBuffer?: boolean }) {
        this.canvas = canvas;
        if (!canUseEffectRenderer(canvas)) {
            throw new Error("WebGL is not available"); // i18n-ignore
        }
        this.regl = createREGL({
            canvas,
            // preserveDrawingBuffer must be true to read the canvas back via
            // toDataURL (used for generating static effect thumbnails).
            attributes: { premultipliedAlpha: false, preserveDrawingBuffer: !!opts?.preserveDrawingBuffer },
        });
        this.source = this.regl.texture({
            width: 2,
            height: 2,
            min: "linear",
            mag: "linear",
        });
        this.fbos = [this.regl.framebuffer({ width: 2, height: 2 }), this.regl.framebuffer({ width: 2, height: 2 })];
    }

    private command(eff: RenderEffect) {
        const floatKeys = Object.keys(eff.floatParams);
        const cacheKey = `${eff.id}|${floatKeys.join(",")}|${eff.keyColor ? "c" : ""}`;
        let cmd = this.commands.get(cacheKey);
        if (cmd) return cmd;
        const regl = this.regl!;
        const uniforms: Record<string, any> = {
            tex: regl.prop<any, "tex">("tex"),
            resolution: regl.prop<any, "resolution">("resolution"),
            time: regl.prop<any, "time">("time"),
        };
        for (const k of floatKeys) {
            uniforms[k] = (_ctx: any, props: any) => props.floatParams[k] ?? 0;
        }
        if (eff.keyColor) {
            uniforms.keyColor = (_ctx: any, props: any) => props.keyColor ?? [0, 1, 0];
        }
        cmd = regl({
            frag: buildFrag(eff.glsl, floatKeys, !!eff.keyColor),
            vert: VERT,
            attributes: { position: [[-1, -1], [3, -1], [-1, 3]] },
            uniforms,
            framebuffer: regl.prop<any, "framebuffer">("framebuffer"),
            count: 3,
        });
        this.commands.set(cacheKey, cmd);
        return cmd;
    }

    /** Resize the canvas drawing buffer + framebuffers to match the source. */
    private resize(w: number, h: number) {
        if (this.canvas.width !== w || this.canvas.height !== h) {
            this.canvas.width = w;
            this.canvas.height = h;
        }
        for (const fbo of this.fbos) fbo.resize(w, h);
    }

    /** Render `source` through the ordered effect stack onto the canvas. */
    render(source: HTMLVideoElement | HTMLImageElement | HTMLCanvasElement, effects: RenderEffect[], timeSec: number) {
        const regl = this.regl;
        if (!regl) return;
        const w =
            (source as HTMLVideoElement).videoWidth ||
            (source as HTMLImageElement).naturalWidth ||
            source.width ||
            0;
        const h =
            (source as HTMLVideoElement).videoHeight ||
            (source as HTMLImageElement).naturalHeight ||
            source.height ||
            0;
        if (!w || !h) return;
        this.resize(w, h);
        // We drive draws manually (not via regl.frame), so regl never refreshes
        // its cached drawingBuffer size after a canvas resize — poll() makes it
        // pick up the new size so the default-framebuffer viewport is correct.
        regl.poll();
        // Video frames are a streaming texture. Reinitializing the texture with
        // texImage2D on every draw can stall Chromium's media decoder long
        // enough that the opaque effect canvas keeps showing one old frame.
        // Resize only when dimensions change, then update the existing GPU
        // allocation with texSubImage2D for every presented video frame.
        if (this.source.width !== w || this.source.height !== h) {
            this.source.resize(w, h);
        }
        this.source.subimage({ data: source, flipY: true }, 0, 0);

        const resolution: [number, number] = [w, h];
        const enabled = effects;

        if (enabled.length === 0) {
            // Passthrough — show the raw frame.
            this.passthrough(resolution);
            return;
        }

        let inputTex = this.source;
        for (let i = 0; i < enabled.length; i++) {
            const eff = enabled[i];
            const isLast = i === enabled.length - 1;
            const target = isLast ? null : this.fbos[i % 2];
            this.command(eff)({
                tex: inputTex,
                resolution,
                time: timeSec,
                floatParams: eff.floatParams,
                keyColor: eff.keyColor,
                framebuffer: target,
            });
            inputTex = isLast ? inputTex : this.fbos[i % 2].color[0];
        }
    }

    private passthrough(resolution: [number, number]) {
        const eff: RenderEffect = { id: "__passthrough", glsl: PASSTHROUGH, floatParams: {} };
        this.command(eff)({
            tex: this.source,
            resolution,
            time: 0,
            floatParams: {},
            framebuffer: null,
        });
    }

    private transitionCommand(id: string, glsl: string) {
        let cmd = this.transitionCommands.get(id);
        if (cmd) return cmd;
        const regl = this.regl!;
        cmd = regl({
            frag: buildTransitionFrag(glsl),
            vert: VERT,
            attributes: { position: [[-1, -1], [3, -1], [-1, 3]] },
            uniforms: {
                fromTex: regl.prop<any, "fromTex">("fromTex"),
                toTex: regl.prop<any, "toTex">("toTex"),
                progress: regl.prop<any, "progress">("progress"),
                resolution: regl.prop<any, "resolution">("resolution"),
            },
            count: 3,
        });
        this.transitionCommands.set(id, cmd);
        return cmd;
    }

    /** Render a gl-transition between two frames at `progress` (0→1) onto canvas. */
    renderTransition(
        from: HTMLVideoElement | HTMLImageElement | HTMLCanvasElement,
        to: HTMLVideoElement | HTMLImageElement | HTMLCanvasElement,
        id: string,
        glsl: string,
        progress: number,
    ) {
        const regl = this.regl;
        if (!regl) return;
        const sz = (s: any) => [s.videoWidth || s.naturalWidth || s.width || 0, s.videoHeight || s.naturalHeight || s.height || 0];
        const [w, h] = sz(from).every(Boolean) ? sz(from) : sz(to);
        if (!w || !h) return;
        this.resize(w, h);
        regl.poll();
        if (!this.fromTex) this.fromTex = regl.texture({ width: 2, height: 2 });
        if (!this.toTex) this.toTex = regl.texture({ width: 2, height: 2 });
        this.fromTex({ data: from, flipY: true, min: "linear", mag: "linear" });
        this.toTex({ data: to, flipY: true, min: "linear", mag: "linear" });
        this.transitionCommand(id, glsl)({
            fromTex: this.fromTex,
            toTex: this.toTex,
            progress: Math.max(0, Math.min(1, progress)),
            resolution: [w, h] as [number, number],
            framebuffer: null,
        });
    }

    destroy() {
        try {
            this.regl?.destroy();
        } catch {
            /* noop */
        }
        this.regl = null;
        this.commands.clear();
        this.transitionCommands.clear();
    }
}

/** Convert a #rrggbb / 0xRRGGBB hex string to a normalized [r,g,b] triple. */
export function hexToRgb(hex: string | number | undefined): [number, number, number] {
    if (typeof hex !== "string") return [0, 1, 0];
    const m = hex.replace(/^#/, "").replace(/^0x/i, "");
    const n = parseInt(m.length === 3 ? m.split("").map((c) => c + c).join("") : m, 16);
    if (Number.isNaN(n)) return [0, 1, 0];
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
