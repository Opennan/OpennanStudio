// WebGL2 renderer for the looks catalog (preview side of the preview/export parity contract). It runs
// the same steps the export compiles to ffmpeg filters, on RGBA8 textures with an 8-bit store after
// every step, exactly where ffmpeg stores 8-bit frames:
//   source → resize to the fit size → CLUT (or the Adjust-keyframe mix of two) → sharpen → vignette
//          → grain → effect passes → mask (alpha) → placed on the frame (axis-aligned, or affine for scene motion)
//          → transition → effect-track passes → present.
// One renderer owns one WebGL2 context on its own canvas; callers draw `canvas` where they need it.
import type { Channel, Expr } from "@opennan/timeline-core/looks/expr";
import { buildHaldClut } from "@opennan/timeline-core/looks/lut";
import type { LookPlan, LookStep } from "@opennan/timeline-core/looks/look-plan";
import { avgBlurRadii, legacyOpsEmpty, type ChromaKeyParams, type EqPlanes, type LegacyOps, type LegacyPlaneMode } from "@opennan/timeline-core/looks/legacy";
import { maskParamValues, type MaskBox } from "@opennan/timeline-core/looks/masks";
import { grainImage, grainOffset, vignetteMask } from "@opennan/timeline-core/looks/spatial";
import type { TransitionDef } from "@opennan/timeline-core/looks/transitions";
import {
    BLUR_2D_SHADER, BLUR_H_SHADER, BLUR_V_SHADER, CHROMA_KEY_SHADER, EQ_YUV_SHADER,
    COMPOSITE_SHADER, CROP_SHADER, FILL_SHADER, GRAIN_SHADER, LAYER_ADJUST_SHADER, LUT_MIX_SHADER, LUT_SHADER, MULTIPLY_SHADER, NEAREST_SHADER,
    PLACE_AFFINE_SHADER, PLACE_SHADER, PRESENT_SHADER, RESIZE_SHADER, ROTATE90_SHADER, SHARPEN_SHADER, VERTEX_SHADER, exprProgram, lutMixWeight, maskProgram,
} from "./gl-programs";

export type LookSource = TexImageSource;

/** 2×3 affine map in CSS `matrix(a, b, c, d, e, f)` order: x' = a·x + c·y + e, y' = b·x + d·y + f. */
export type AffineMatrix = readonly [number, number, number, number, number, number];

/** One CLUT: a cache key and the pointwise function it bakes (a look plan's `lut` step). */
export type LutStep = Pick<Extract<LookStep, { kind: "lut" }>, "key" | "fn">;

/** A frame in GPU memory: an RGBA8 texture with its framebuffer. Owned by the renderer's pool. */
export interface GlFrame {
    readonly width: number;
    readonly height: number;
    /** @internal */
    readonly texture: WebGLTexture;
    /** @internal */
    readonly framebuffer: WebGLFramebuffer;
}

/** Where presentRegion drew on the renderer's canvas (canvas pixels, top-left origin). */
export interface PresentedRegion {
    x: number;
    y: number;
    width: number;
    height: number;
}

interface Program {
    program: WebGLProgram;
    uniforms: Map<string, WebGLUniformLocation | null>;
}

interface PooledFrame extends GlFrame {
    inUse: boolean;
}

// Every filter thumbnail (30) plus the items the preview is drawing stay warm: a CLUT is 262,144
// evaluations to build and 1 MB of texture.
const MAX_CACHED_LUTS = 40;
const MAX_CACHED_MASKS = 8;
const MAX_POOLED_FRAMES = 24;

export function isWebGl2Available(): boolean {
    try {
        if (typeof document === "undefined") return false;
        const canvas = document.createElement("canvas");
        const gl = canvas.getContext("webgl2");
        const ok = Boolean(gl);
        (gl?.getExtension("WEBGL_lose_context") as { loseContext?: () => void } | null)?.loseContext?.();
        return ok;
    } catch {
        return false;
    }
}

export class LookRenderer {
    readonly canvas: HTMLCanvasElement | OffscreenCanvas;
    private gl: WebGL2RenderingContext;
    private lost = false;
    private readonly buffer: WebGLBuffer;
    private readonly vao: WebGLVertexArrayObject;
    private readonly programs = new Map<string, Program>();
    /** Emitted GLSL and parameter names per expression program key (building them walks the expression trees). */
    private readonly exprSources = new Map<string, { source: string; params: string[] }>();
    private readonly luts = new Map<string, WebGLTexture>();
    private readonly masks = new Map<string, { texture: WebGLTexture; width: number; height: number }>();
    private readonly pool: PooledFrame[] = [];
    /** RGBA32F frames for exact intermediate sums (the two-pass blur), when the context can render into them. */
    private readonly floatPool: PooledFrame[] = [];
    private floatTargets: boolean | null = null;
    private readonly lostListeners = new Set<() => void>();
    private readonly onLost = (event: Event) => {
        event.preventDefault();
        this.lost = true;
        for (const listener of [...this.lostListeners]) listener();
    };

    /** Calls `listener` when the WebGL context is lost (the renderer is unusable after that). Returns an unsubscribe. */
    onContextLost(listener: () => void): () => void {
        this.lostListeners.add(listener);
        return () => this.lostListeners.delete(listener);
    }

    constructor(canvas?: HTMLCanvasElement | OffscreenCanvas) {
        this.canvas = canvas ?? document.createElement("canvas");
        const gl = (this.canvas as HTMLCanvasElement).getContext("webgl2", {
            alpha: true, premultipliedAlpha: false, preserveDrawingBuffer: true, antialias: false, depth: false, stencil: false,
        }) as WebGL2RenderingContext | null;
        if (!gl) throw new Error("WebGL2 is not available"); // i18n-ignore
        this.gl = gl;
        (this.canvas as HTMLCanvasElement).addEventListener?.("webglcontextlost", this.onLost as EventListener);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
        gl.pixelStorei(gl.PACK_ALIGNMENT, 1);
        this.buffer = gl.createBuffer()!;
        gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
        this.vao = gl.createVertexArray()!;
        gl.bindVertexArray(this.vao);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    }

    get isLost(): boolean {
        return this.lost || this.gl.isContextLost();
    }

    // ── frames ───────────────────────────────────────────

    private createTexture(width: number, height: number, linear: boolean): WebGLTexture {
        const gl = this.gl;
        const texture = gl.createTexture()!;
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, width, height);
        const filter = linear ? gl.LINEAR : gl.NEAREST;
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        return texture;
    }

    /** A pooled frame of this size (release it with releaseAll after the draw). */
    acquire(width: number, height: number): GlFrame {
        const w = Math.max(1, Math.round(width));
        const h = Math.max(1, Math.round(height));
        const free = this.pool.find((f) => !f.inUse && f.width === w && f.height === h);
        if (free) {
            free.inUse = true;
            return free;
        }
        if (this.pool.length >= MAX_POOLED_FRAMES) this.trimPool();
        const gl = this.gl;
        const texture = this.createTexture(w, h, true);
        const framebuffer = gl.createFramebuffer()!;
        gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        const frame: PooledFrame = { width: w, height: h, texture, framebuffer, inUse: true };
        this.pool.push(frame);
        return frame;
    }

    /** Frees pooled frames nobody holds, oldest first, keeping the pool bounded. */
    private trimPool(): void {
        const gl = this.gl;
        for (let i = 0; i < this.pool.length && this.pool.length >= MAX_POOLED_FRAMES; ) {
            const frame = this.pool[i];
            if (frame.inUse) {
                i += 1;
                continue;
            }
            gl.deleteTexture(frame.texture);
            gl.deleteFramebuffer(frame.framebuffer);
            this.pool.splice(i, 1);
        }
    }

    /** Returns every pooled frame to the pool (call once per drawn frame). */
    releaseAll(): void {
        for (const frame of this.pool) frame.inUse = false;
        for (const frame of this.floatPool) frame.inUse = false;
    }

    /** A pooled RGBA32F frame, or null when the context cannot render into float textures (EXT_color_buffer_float). */
    private acquireFloat(width: number, height: number): GlFrame | null {
        const gl = this.gl;
        this.floatTargets ??= Boolean(gl.getExtension("EXT_color_buffer_float"));
        if (!this.floatTargets) return null;
        const free = this.floatPool.find((f) => !f.inUse && f.width === width && f.height === height);
        if (free) {
            free.inUse = true;
            return free;
        }
        // At most a few float frames stay around (one per layer size in a frame): drop the idle ones first.
        for (let i = this.floatPool.length - 1; i >= 0 && this.floatPool.length >= 4; i -= 1) {
            if (this.floatPool[i].inUse) continue;
            gl.deleteTexture(this.floatPool[i].texture);
            gl.deleteFramebuffer(this.floatPool[i].framebuffer);
            this.floatPool.splice(i, 1);
        }
        const texture = gl.createTexture()!;
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32F, width, height);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        const framebuffer = gl.createFramebuffer()!;
        gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        const frame: PooledFrame = { width, height, texture, framebuffer, inUse: true };
        this.floatPool.push(frame);
        return frame;
    }

    /** Uploads a video, image, canvas, bitmap, or ImageData (rows top-first, no premultiplication). */
    upload(source: LookSource, width: number, height: number): GlFrame {
        const frame = this.acquire(width, height);
        const gl = this.gl;
        gl.bindTexture(gl.TEXTURE_2D, frame.texture);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, frame.width, frame.height, gl.RGBA, gl.UNSIGNED_BYTE, source);
        return frame;
    }

    /** Uploads raw RGBA bytes (tests, parity harness). */
    uploadPixels(data: Uint8Array, width: number, height: number): GlFrame {
        const frame = this.acquire(width, height);
        const gl = this.gl;
        gl.bindTexture(gl.TEXTURE_2D, frame.texture);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, data);
        return frame;
    }

    /** RGBA bytes of a frame, rows top-first. */
    readPixels(frame: GlFrame): Uint8Array {
        const gl = this.gl;
        const out = new Uint8Array(frame.width * frame.height * 4);
        gl.bindFramebuffer(gl.FRAMEBUFFER, frame.framebuffer);
        gl.readPixels(0, 0, frame.width, frame.height, gl.RGBA, gl.UNSIGNED_BYTE, out);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        return out;
    }

    // ── programs ─────────────────────────────────────────

    private program(key: string, source: string): Program {
        const cached = this.programs.get(key);
        if (cached) return cached;
        const gl = this.gl;
        const compile = (type: number, text: string) => {
            const shader = gl.createShader(type)!;
            gl.shaderSource(shader, text);
            gl.compileShader(shader);
            if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
                const log = gl.getShaderInfoLog(shader);
                gl.deleteShader(shader);
                throw new Error(`shader ${key}: ${log}`);
            }
            return shader;
        };
        const vs = compile(gl.VERTEX_SHADER, VERTEX_SHADER);
        const fs = compile(gl.FRAGMENT_SHADER, source);
        const program = gl.createProgram()!;
        gl.attachShader(program, vs);
        gl.attachShader(program, fs);
        gl.bindAttribLocation(program, 0, "a_position");
        gl.linkProgram(program);
        gl.deleteShader(vs);
        gl.deleteShader(fs);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
            const log = gl.getProgramInfoLog(program);
            gl.deleteProgram(program);
            throw new Error(`program ${key}: ${log}`);
        }
        const entry: Program = { program, uniforms: new Map() };
        this.programs.set(key, entry);
        return entry;
    }

    private uniform(program: Program, name: string): WebGLUniformLocation | null {
        if (!program.uniforms.has(name)) program.uniforms.set(name, this.gl.getUniformLocation(program.program, name));
        return program.uniforms.get(name) ?? null;
    }

    /** Draws `program` into `target` with textures bound to units in order and the given uniforms. */
    private draw(program: Program, target: GlFrame | null, textures: Array<[string, WebGLTexture]>, set: (u: (name: string) => WebGLUniformLocation | null) => void, size?: [number, number]): void {
        const gl = this.gl;
        gl.useProgram(program.program);
        gl.bindVertexArray(this.vao);
        gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.framebuffer : null);
        const [w, h] = size ?? (target ? [target.width, target.height] : [this.canvas.width, this.canvas.height]);
        gl.viewport(0, 0, w, h);
        gl.disable(gl.BLEND);
        textures.forEach(([name, texture], unit) => {
            gl.activeTexture(gl.TEXTURE0 + unit);
            gl.bindTexture(gl.TEXTURE_2D, texture);
            gl.uniform1i(this.uniform(program, name), unit);
        });
        gl.uniform2f(this.uniform(program, "u_size"), w, h);
        set((name) => this.uniform(program, name));
        gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    // ── steps ────────────────────────────────────────────

    /** Bilinear resize (the fit scale). Returns `frame` itself when the size already matches. */
    resize(frame: GlFrame, width: number, height: number): GlFrame {
        const w = Math.max(1, Math.round(width));
        const h = Math.max(1, Math.round(height));
        if (frame.width === w && frame.height === h) return frame;
        const out = this.acquire(w, h);
        this.draw(this.program("resize", RESIZE_SHADER), out, [["u_src0", frame.texture]], () => undefined);
        return out;
    }

    private lutTexture(key: string, fn: (c: [number, number, number]) => [number, number, number]): WebGLTexture {
        const cached = this.luts.get(key);
        if (cached) {
            this.luts.delete(key);
            this.luts.set(key, cached);
            return cached;
        }
        const clut = buildHaldClut(fn);
        const rgba = new Uint8Array(clut.size * clut.size * 4);
        for (let i = 0, j = 0; i < clut.rgb.length; i += 3, j += 4) {
            rgba[j] = clut.rgb[i];
            rgba[j + 1] = clut.rgb[i + 1];
            rgba[j + 2] = clut.rgb[i + 2];
            rgba[j + 3] = 255;
        }
        const gl = this.gl;
        const texture = this.createTexture(clut.size, clut.size, false);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, clut.size, clut.size, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
        this.luts.set(key, texture);
        while (this.luts.size > MAX_CACHED_LUTS) {
            const [oldKey, old] = this.luts.entries().next().value as [string, WebGLTexture];
            gl.deleteTexture(old);
            this.luts.delete(oldKey);
        }
        return texture;
    }

    private grayTexture(key: string, make: () => { width: number; height: number; data: Uint8Array }): WebGLTexture {
        const cached = this.masks.get(key);
        if (cached) {
            this.masks.delete(key);
            this.masks.set(key, cached);
            return cached.texture;
        }
        const image = make();
        const rgba = new Uint8Array(image.width * image.height * 4);
        for (let i = 0; i < image.data.length; i += 1) rgba[i * 4] = image.data[i];
        const gl = this.gl;
        const texture = this.createTexture(image.width, image.height, false);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, image.width, image.height, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
        this.masks.set(key, { texture, width: image.width, height: image.height });
        while (this.masks.size > MAX_CACHED_MASKS) {
            const [oldKey, old] = this.masks.entries().next().value as [string, { texture: WebGLTexture }];
            gl.deleteTexture(old.texture);
            this.masks.delete(oldKey);
        }
        return texture;
    }

    private exprPass(key: string, input: GlFrame, second: GlFrame | null, channel: (ch: Channel) => Expr, channels: 3 | 4, values: { T?: number; p?: number; params?: Record<string, number> }): GlFrame {
        let built = this.exprSources.get(key);
        if (!built) {
            const emitted = exprProgram(channel, channels);
            built = { source: emitted.source, params: [...emitted.params] };
            this.exprSources.set(key, built);
        }
        const program = this.program(key, built.source);
        const out = this.acquire(input.width, input.height);
        const textures: Array<[string, WebGLTexture]> = [["u_src0", input.texture], ["u_src1", (second ?? input).texture]];
        this.draw(program, out, textures, (u) => {
            const gl = this.gl;
            gl.uniform1f(u("u_T"), values.T ?? 0);
            gl.uniform1f(u("u_p"), values.p ?? 0);
            for (const name of built.params) gl.uniform1f(u(`u_${name}`), values.params?.[name] ?? 0);
        });
        return out;
    }

    /** One look step on a frame at item-local time t. */
    step(frame: GlFrame, step: LookStep, t: number): GlFrame {
        const gl = this.gl;
        switch (step.kind) {
            case "lut": {
                const lut = this.lutTexture(step.key, step.fn);
                const out = this.acquire(frame.width, frame.height);
                this.draw(this.program("lut", LUT_SHADER), out, [["u_src0", frame.texture], ["u_lut", lut]], () => undefined);
                return out;
            }
            case "sharpen": {
                const k = -step.kernel.matrix[1];
                const out = this.acquire(frame.width, frame.height);
                this.draw(this.program("sharpen", SHARPEN_SHADER), out, [["u_src0", frame.texture]], (u) => gl.uniform1i(u("u_k"), k));
                return out;
            }
            case "vignette": {
                const { width, height } = frame;
                const mask = this.grayTexture(`v|${width}x${height}|${step.amount}`, () => ({ width, height, data: vignetteMask(width, height, step.amount) }));
                const out = this.acquire(width, height);
                this.draw(this.program("multiply", MULTIPLY_SHADER), out, [["u_src0", frame.texture], ["u_mask", mask]], () => undefined);
                return out;
            }
            case "grain": {
                const { width, height } = frame;
                const grain = this.grayTexture(`g|${width}x${height}|${step.amount}`, () => grainImage(width, height, step.amount));
                const offset = grainOffset(t);
                const out = this.acquire(width, height);
                this.draw(this.program("grain", GRAIN_SHADER), out, [["u_src0", frame.texture], ["u_grain", grain]], (u) => gl.uniform2i(u("u_offset"), offset.x, offset.y));
                return out;
            }
            case "pass":
                return this.exprPass(`fx|${step.key.replace(/:\{.*$/, "")}`, frame, null, (ch) => step.pass.channel(ch), 3, { T: t, params: step.params });
            case "mask":
                return this.mask(frame, step, t);
        }
    }

    /**
     * The mask step (phase 10c): alpha × level / 255, the level from the shape's expression with the mask's
     * parameters at keyframe time `t` (item-local for clips, scene-local for scenes — what callers pass to look()).
     * One program per shape and invert; the values are uniforms, so dragging a handle compiles nothing.
     */
    mask(frame: GlFrame, step: Extract<LookStep, { kind: "mask" }>, t: number, box?: MaskBox | null): GlFrame {
        const key = `mask|${step.mask.shape}|${step.mask.invert ? 1 : 0}`;
        let built = this.exprSources.get(key);
        if (!built) {
            const emitted = maskProgram(step.mask.shape, step.mask.invert);
            built = { source: emitted.source, params: [...emitted.params] };
            this.exprSources.set(key, built);
        }
        const program = this.program(key, built.source);
        const values = maskParamValues(step.mask, step.points, Number.isFinite(t) ? t : 0);
        const out = this.acquire(frame.width, frame.height);
        const b = box ?? { x: 0, y: 0, width: frame.width, height: frame.height };
        this.draw(program, out, [["u_src0", frame.texture]], (u) => {
            for (const name of built.params) this.gl.uniform1f(u(`u_${name}`), values[name] ?? 0);
            this.gl.uniform4f(u("u_mbox"), b.x, b.y, b.width, b.height);
        });
        return out;
    }

    /**
     * Adjust keyframes: the frame through CLUTs `a` and `b`, mixed with the eased weight `w` (quantized to
     * k / 1024, truncating store as ffmpeg blend). A weight that rounds to 0 or 1, or one CLUT on both
     * sides, is one plain CLUT pass.
     */
    lutMix(frame: GlFrame, a: LutStep, b: LutStep, w: number): GlFrame {
        const weight = lutMixWeight(w);
        // trunc(A + 0·w) = A: the same CLUT on both sides is one pass, exactly.
        if (weight === 0 || weight === 1 || a.key === b.key) return this.step(frame, { kind: "lut", ...(weight === 1 ? b : a) }, 0);
        const lut0 = this.lutTexture(a.key, a.fn);
        const lut1 = this.lutTexture(b.key, b.fn);
        const out = this.acquire(frame.width, frame.height);
        this.draw(this.program("lutmix", LUT_MIX_SHADER), out, [["u_src0", frame.texture], ["u_lut0", lut0], ["u_lut1", lut1]], (u) => this.gl.uniform1f(u("u_w"), weight));
        return out;
    }

    /** Every step of a plan. */
    /**
     * Every step of a plan at item-local time `t`. `keyframeTime` is the clock mask keyframes read (scene-local for a
     * scene whose head is covered by an earlier one; the export's keyframeOffset); default `t`. `maskBox` (phase 10d):
     * the item's box inside the frame for the mask (a padded text or sticker bitmap); default the whole frame.
     */
    look(frame: GlFrame, plan: LookPlan | null, t: number, keyframeTime = t, maskBox?: MaskBox | null): GlFrame {
        let current = frame;
        for (const step of plan?.steps ?? []) current = step.kind === "mask" ? this.mask(current, step, keyframeTime, maskBox) : this.step(current, step, t);
        return current;
    }

    /** A transition frame at CapCut progress p (a and b the same size). */
    transition(a: GlFrame, b: GlFrame, def: TransitionDef, p: number, channels: 3 | 4 = 3): GlFrame {
        return this.exprPass(`tr|${def.id}|${channels}`, a, b, (ch) => def.channel(ch), channels, { p });
    }

    /** `frame` placed at (x, y) on a width×height target; uncovered pixels get `background` (RGBA 0..1). */
    place(frame: GlFrame, width: number, height: number, x: number, y: number, background: [number, number, number, number] = [0, 0, 0, 1]): GlFrame {
        const out = this.acquire(width, height);
        this.draw(this.program("place", PLACE_SHADER), out, [["u_src0", frame.texture]], (u) => {
            this.gl.uniform4f(u("u_rect"), Math.round(x), Math.round(y), frame.width, frame.height);
            this.gl.uniform4f(u("u_background"), background[0], background[1], background[2], background[3]);
        });
        return out;
    }

    /**
     * `frame` placed on a width×height target through `inverse` (target pixel center → frame pixel), sampled
     * bilinearly, with alpha × `opacity` over `background` (RGBA 0..1; opaque black on V1, clear on V2+).
     * Scene motion (rotation, flips, animated scale and position, opacity). A non-finite or collapsed map
     * draws the background only.
     */
    placeAffine(frame: GlFrame, width: number, height: number, inverse: AffineMatrix, opacity: number, background: [number, number, number, number] = [0, 0, 0, 1]): GlFrame {
        const out = this.acquire(width, height);
        const valid = inverse.every((x) => Number.isFinite(x));
        const [a, b, c, d, e, f] = valid ? inverse : [1, 0, 0, 1, 0, 0];
        const alpha = valid && Number.isFinite(opacity) ? Math.min(1, Math.max(0, opacity)) : 0;
        this.draw(this.program("place-affine", PLACE_AFFINE_SHADER), out, [["u_src0", frame.texture]], (u) => {
            const gl = this.gl;
            gl.uniform3f(u("u_inv0"), a, c, e);
            gl.uniform3f(u("u_inv1"), b, d, f);
            gl.uniform1f(u("u_opacity"), alpha);
            gl.uniform4f(u("u_background"), background[0], background[1], background[2], background[3]);
        });
        return out;
    }

    // ── legacy clip filters (phase 10d: blur slider, chroma key, blend modes; timeline-core looks/legacy.ts) ──

    /**
     * The legacy blur slider: vf_avgblur with sizeX = sizeY = `radius` (truncated) on every plane of `mode` — a clamped
     * box, floor(Σ / area), the radius limited by the smallest plane. Two exact passes through a float frame, or one
     * 2D pass when the context cannot render into float textures. Radius below 1: the frame itself.
     */
    boxBlur(frame: GlFrame, radius: number, mode: LegacyPlaneMode): GlFrame {
        const { x: rx, y: ry } = avgBlurRadii(radius, frame.width, frame.height, mode);
        if (rx === 0 && ry === 0) return frame;
        const gl = this.gl;
        const modeIndex = mode === "rgb" ? 0 : mode === "yuv444" ? 1 : 2;
        const area = (2 * rx + 1) * (2 * ry + 1);
        const out = this.acquire(frame.width, frame.height);
        const sums = this.acquireFloat(frame.width, frame.height);
        if (!sums) {
            this.draw(this.program("blur-2d", BLUR_2D_SHADER), out, [["u_src0", frame.texture]], (u) => {
                gl.uniform1i(u("u_rx"), rx);
                gl.uniform1i(u("u_ry"), ry);
                gl.uniform1i(u("u_mode"), modeIndex);
                gl.uniform1f(u("u_area"), area);
            });
            return out;
        }
        this.draw(this.program("blur-h", BLUR_H_SHADER), sums, [["u_src0", frame.texture]], (u) => {
            gl.uniform1i(u("u_rx"), rx);
            gl.uniform1i(u("u_mode"), modeIndex);
        });
        this.draw(this.program("blur-v", BLUR_V_SHADER), out, [["u_src0", sums.texture]], (u) => {
            gl.uniform1i(u("u_ry"), ry);
            gl.uniform1i(u("u_mode"), modeIndex);
            gl.uniform1f(u("u_area"), area);
        });
        return out;
    }

    /** vf_chromakey: the alpha from the 3×3 mean chroma distance to the key (per 2×2 block when `subsampled`); colour kept. */
    chromaKey(frame: GlFrame, key: ChromaKeyParams, subsampled: boolean): GlFrame {
        const gl = this.gl;
        const out = this.acquire(frame.width, frame.height);
        this.draw(this.program("chroma-key", CHROMA_KEY_SHADER), out, [["u_src0", frame.texture]], (u) => {
            gl.uniform2f(u("u_key"), key.u, key.v);
            gl.uniform1f(u("u_similarity"), key.similarity);
            gl.uniform1f(u("u_blend"), key.blend);
            gl.uniform1i(u("u_sub"), subsampled ? 1 : 0);
        });
        return out;
    }

    /** eq's 8-bit lookup on BT.601 YUV (legacy blend modes); the frame itself when both planes are identity. */
    eqYuv(frame: GlFrame, planes: EqPlanes): GlFrame {
        if (!planes.luma && !planes.chroma) return frame;
        const gl = this.gl;
        const out = this.acquire(frame.width, frame.height);
        this.draw(this.program("eq-yuv", EQ_YUV_SHADER), out, [["u_src0", frame.texture]], (u) => {
            gl.uniform4f(u("u_eq"), planes.luma?.[0] ?? 4096, planes.luma?.[1] ?? 0, planes.chroma?.[0] ?? 4096, planes.chroma?.[1] ?? 0);
            gl.uniform2i(u("u_on"), planes.luma ? 1 : 0, planes.chroma ? 1 : 0);
        });
        return out;
    }

    /** Every legacy op in ffmpeg's order (blur, chroma key, eq). */
    legacy(frame: GlFrame, ops: LegacyOps | null | undefined): GlFrame {
        if (!ops || legacyOpsEmpty(ops)) return frame;
        let current = frame;
        if (ops.blur) current = this.boxBlur(current, ops.blur.radius, ops.blur.mode);
        if (ops.chromaKey) current = this.chromaKey(current, ops.chromaKey.key, ops.chromaKey.subsampled);
        if (ops.eq) current = this.eqYuv(current, ops.eq);
        return current;
    }

    // ── GPU export compositing (phase 10c) ──────────────────

    /** A solid width×height frame (RGBA 0..1). */
    fill(width: number, height: number, rgba: readonly [number, number, number, number]): GlFrame {
        const out = this.acquire(width, height);
        this.draw(this.program("fill", FILL_SHADER), out, [], (u) => this.gl.uniform4f(u("u_color"), rgba[0], rgba[1], rgba[2], rgba[3]));
        return out;
    }

    /** The sub-rectangle `rect` of a frame (whole pixels, clamped to the frame). */
    crop(frame: GlFrame, rect: { x: number; y: number; width: number; height: number }): GlFrame {
        const x = Math.max(0, Math.min(frame.width - 1, Math.round(rect.x)));
        const y = Math.max(0, Math.min(frame.height - 1, Math.round(rect.y)));
        const w = Math.max(1, Math.min(frame.width - x, Math.round(rect.width)));
        const h = Math.max(1, Math.min(frame.height - y, Math.round(rect.height)));
        if (x === 0 && y === 0 && w === frame.width && h === frame.height) return frame;
        const out = this.acquire(w, h);
        this.draw(this.program("crop", CROP_SHADER), out, [["u_src0", frame.texture]], (u) => this.gl.uniform2i(u("u_offset"), x, y));
        return out;
    }

    /** Nearest-neighbour resize (mosaic blocks). */
    nearest(frame: GlFrame, width: number, height: number): GlFrame {
        const w = Math.max(1, Math.round(width));
        const h = Math.max(1, Math.round(height));
        if (frame.width === w && frame.height === h) return frame;
        const out = this.acquire(w, h);
        this.draw(this.program("nearest", NEAREST_SHADER), out, [["u_src0", frame.texture]], () => undefined);
        return out;
    }

    /**
     * Downscale with a box filter: halves (each halving at exactly 2× averages 2×2 texels bilinearly) while the
     * frame is more than twice the target, then one bilinear resize. Avoids the aliasing a single bilinear tap
     * gives at large reductions (ffmpeg's swscale filters with its full kernel there).
     */
    downscale(frame: GlFrame, width: number, height: number): GlFrame {
        const w = Math.max(1, Math.round(width));
        const h = Math.max(1, Math.round(height));
        let current = frame;
        while (current.width >= w * 2 && current.height >= h * 2) current = this.resize(current, Math.ceil(current.width / 2), Math.ceil(current.height / 2));
        return this.resize(current, w, h);
    }

    /** Flips, a colour dip (rgb → colour by `dip.amount`), and an alpha factor, as the export's overlay chain applies them. */
    adjustLayer(frame: GlFrame, options: { flipX?: boolean; flipY?: boolean; alpha?: number; dip?: { color: readonly [number, number, number]; amount: number } | null }): GlFrame {
        const alpha = Number.isFinite(options.alpha) ? Math.min(1, Math.max(0, options.alpha!)) : 1;
        const dip = options.dip && options.dip.amount > 0 ? options.dip : null;
        if (!options.flipX && !options.flipY && alpha >= 1 && !dip) return frame;
        const out = this.acquire(frame.width, frame.height);
        this.draw(this.program("layer-adjust", LAYER_ADJUST_SHADER), out, [["u_src0", frame.texture]], (u) => {
            const gl = this.gl;
            gl.uniform2f(u("u_flip"), options.flipX ? 1 : 0, options.flipY ? 1 : 0);
            gl.uniform1f(u("u_alpha"), alpha);
            gl.uniform4f(u("u_dip"), dip?.color[0] ?? 0, dip?.color[1] ?? 0, dip?.color[2] ?? 0, dip ? Math.min(1, dip.amount) : 0);
        });
        return out;
    }

    /** Rotates by `degrees` (a multiple of 90, clockwise): video display rotation. */
    rotate90(frame: GlFrame, degrees: number): GlFrame {
        const turns = ((Math.round(degrees / 90) % 4) + 4) % 4;
        if (turns === 0) return frame;
        const out = turns % 2 === 1 ? this.acquire(frame.height, frame.width) : this.acquire(frame.width, frame.height);
        this.draw(this.program("rotate90", ROTATE90_SHADER), out, [["u_src0", frame.texture]], (u) => this.gl.uniform1i(u("u_turns"), turns));
        return out;
    }

    /**
     * `layer` composited over `base` (Porter-Duff over, straight alpha × opacity) through `inverse` (target pixel
     * centre → layer pixel), sampled bilinearly with a transparent border. Returns a new frame of base's size.
     */
    composite(base: GlFrame, layer: GlFrame, inverse: AffineMatrix, opacity: number): GlFrame {
        const valid = inverse.every((x) => Number.isFinite(x));
        const alpha = valid && Number.isFinite(opacity) ? Math.min(1, Math.max(0, opacity)) : 0;
        if (alpha <= 0) return base;
        const [a, b, c, d, e, f] = inverse;
        const out = this.acquire(base.width, base.height);
        this.draw(this.program("composite", COMPOSITE_SHADER), out, [["u_src0", layer.texture], ["u_base", base.texture]], (u) => {
            const gl = this.gl;
            gl.uniform3f(u("u_inv0"), a, c, e);
            gl.uniform3f(u("u_inv1"), b, d, f);
            gl.uniform1f(u("u_opacity"), alpha);
        });
        return out;
    }

    /**
     * Draws a frame at width×height onto the renderer's canvas WITHOUT shrinking it: the canvas only grows (a
     * resize reallocates its framebuffer, and the shared renderer draws several sizes per frame), and the frame
     * goes into a width×height viewport at its bottom-left (GL rows run bottom-up). The present pass sees
     * exactly what present() would show on a canvas of that size. Returns the drawn region in canvas pixels,
     * top-left origin: callers draw that source rect of `canvas`.
     */
    presentRegion(frame: GlFrame, width = frame.width, height = frame.height): PresentedRegion {
        const w = Math.max(1, Math.round(width));
        const h = Math.max(1, Math.round(height));
        if (this.canvas.width < w) this.canvas.width = w;
        if (this.canvas.height < h) this.canvas.height = h;
        this.draw(this.program("present", PRESENT_SHADER), null, [["u_src0", frame.texture]], (u) => this.gl.uniform2f(u("u_canvas"), w, h), [w, h]);
        return { x: 0, y: this.canvas.height - h, width: w, height: h };
    }

    /** Draws a frame onto the renderer's canvas at the canvas size (resizing the canvas when asked). */
    present(frame: GlFrame, width = frame.width, height = frame.height): void {
        const w = Math.max(1, Math.round(width));
        const h = Math.max(1, Math.round(height));
        if (this.canvas.width !== w) this.canvas.width = w;
        if (this.canvas.height !== h) this.canvas.height = h;
        this.draw(this.program("present", PRESENT_SHADER), null, [["u_src0", frame.texture]], (u) => this.gl.uniform2f(u("u_canvas"), w, h), [w, h]);
    }

    dispose(): void {
        const gl = this.gl;
        for (const frame of this.pool) {
            gl.deleteTexture(frame.texture);
            gl.deleteFramebuffer(frame.framebuffer);
        }
        this.pool.length = 0;
        for (const frame of this.floatPool) {
            gl.deleteTexture(frame.texture);
            gl.deleteFramebuffer(frame.framebuffer);
        }
        this.floatPool.length = 0;
        for (const texture of this.luts.values()) gl.deleteTexture(texture);
        this.luts.clear();
        for (const { texture } of this.masks.values()) gl.deleteTexture(texture);
        this.masks.clear();
        for (const { program } of this.programs.values()) gl.deleteProgram(program);
        this.programs.clear();
        gl.deleteBuffer(this.buffer);
        gl.deleteVertexArray(this.vao);
        (this.canvas as HTMLCanvasElement).removeEventListener?.("webglcontextlost", this.onLost as EventListener);
        (gl.getExtension("WEBGL_lose_context") as { loseContext?: () => void } | null)?.loseContext?.();
    }
}
