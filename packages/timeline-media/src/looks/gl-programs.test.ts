import { describe, expect, it } from "vitest";
import { EFFECTS } from "@opennan/timeline-core/looks/effects";
import { TRANSITIONS } from "@opennan/timeline-core/looks/transitions";
import { LUT_MIX_SHADER, LUT_MIX_WEIGHT_STEPS, LUT_SHADER, PLACE_AFFINE_SHADER, SHARPEN_SHADER, exprProgram, lutMixLevel, lutMixWeight } from "./gl-programs";

describe("look shaders", () => {
    it("builds a program for every transition (RGB and RGBA) and every effect pass", () => {
        for (const def of TRANSITIONS) {
            for (const channels of [3, 4] as const) {
                const { source, params } = exprProgram((ch) => def.channel(ch), channels);
                expect(source.startsWith("#version 300 es")).toBe(true);
                expect(source).toContain("float c2;");
                expect(source.includes("float c3;")).toBe(channels === 4);
                expect(params).toEqual([]);
            }
        }
        for (const effect of EFFECTS) {
            for (const pass of effect.passes ?? []) {
                const { source, params } = exprProgram((ch) => pass.channel(ch), 3);
                for (const name of params) expect(source).toContain(`uniform float u_${name};`);
                expect(source).toContain("o = vec4(st8(c0), st8(c1), st8(c2)");
            }
        }
    });

    it("ports lut3d's truncating store and the sharpen kernel's rounding", () => {
        expect(LUT_SHADER).toContain("floor(v * 255.0)");
        expect(LUT_SHADER).toContain("int i = b * 4096 + g * 64 + r;");
        expect(SHARPEN_SHADER).toContain("trunc(vec3(sum) * 0.0625 + 0.5)");
    });

    it("places through an inverse affine map with bilinear sampling, opacity, and alpha over the background", () => {
        expect(PLACE_AFFINE_SHADER).toContain("uniform vec3 u_inv0;");
        expect(PLACE_AFFINE_SHADER).toContain("uniform vec3 u_inv1;");
        expect(PLACE_AFFINE_SHADER).toContain("uniform float u_opacity;");
        expect(PLACE_AFFINE_SHADER).toContain("uniform vec4 u_background;");
        // Pixel centers map into the texture; outside it is the background; texture() samples bilinearly.
        expect(PLACE_AFFINE_SHADER).toContain("floor(gl_FragCoord.xy) + 0.5");
        expect(PLACE_AFFINE_SHADER).toContain("textureSize(u_src0, 0)");
        expect(PLACE_AFFINE_SHADER).toContain("texture(u_src0, s / ts)");
        expect(PLACE_AFFINE_SHADER).toContain("float a = c.a * u_opacity;");
        expect(PLACE_AFFINE_SHADER).toContain("float outA = a + u_background.a * (1.0 - a);");
    });

    it("mixes two CLUT lookups with the quantized weight and blend's truncating store", () => {
        expect(LUT_MIX_SHADER).toContain("uniform sampler2D u_lut0;");
        expect(LUT_MIX_SHADER).toContain("uniform sampler2D u_lut1;");
        // Each CLUT result is stored as lut3d stores it, then mixed and truncated.
        expect(LUT_MIX_SHADER).toContain("clamp(floor(v * 255.0), 0.0, 255.0)");
        expect(LUT_MIX_SHADER).toContain("int i = b * 4096 + g * 64 + r;");
        expect(LUT_MIX_SHADER).toContain("floor(la + (lb - la) * u_w)");
    });

    it("quantizes the weight to 1/1024 so float32 (GL) and double (ffmpeg) agree exactly", () => {
        expect(LUT_MIX_WEIGHT_STEPS).toBe(1024);
        expect(lutMixWeight(0.5)).toBe(0.5);
        expect(lutMixWeight(1 / 3)).toBe(341 / 1024);
        expect(lutMixWeight(-0.2)).toBe(0);
        expect(lutMixWeight(1.7)).toBe(1);
        expect(lutMixWeight(Number.NaN)).toBe(0);
        // ffmpeg blend all_expr assigns the double to uint8: truncation (A−0.5 on level 10 stores 9).
        expect(lutMixLevel(10, 11, 0.5)).toBe(10);
        expect(lutMixLevel(11, 10, 0.5)).toBe(10);
        expect(lutMixLevel(10, 20, 0.75)).toBe(17);
        expect(lutMixLevel(0, 255, 1)).toBe(255);
        // Exact in float32: every |B − A|·k/1024 + A is a multiple of 1/1024 below 2^8.
        for (let k = 0; k <= 1024; k += 37) {
            const w = k / 1024;
            expect(Math.fround(Math.fround(255 * w) + 3)).toBe(255 * w + 3);
        }
    });
});

describe("mask program (phase 10c)", () => {
    it("builds one program per shape and invert from the shared IR, with the seven mask uniforms and the integer alpha multiply", async () => {
        const { MASK_SHAPES } = await import("@opennan/timeline-core/looks/masks");
        const { maskProgram } = await import("./gl-programs");
        for (const shape of MASK_SHAPES) {
            for (const invert of [false, true]) {
                const { source, params } = maskProgram(shape, invert);
                expect(source.startsWith("#version 300 es")).toBe(true);
                expect(params).toEqual(["mf", "mh", "mo", "mr", "mw", "mx", "my"].filter((name) => source.includes(`u_${name}`)));
                for (const name of params) expect(source).toContain(`uniform float u_${name};`);
                expect(source).toContain("(a * l) / 255");
                // Phase 10d: X, Y, W, H are the item box's (u_mbox: x, y, width, height inside the bitmap).
                expect(source).toContain("uniform vec4 u_mbox;");
                expect(source).toContain("float X = floor(gl_FragCoord.x) - u_mbox.x;");
                expect(source).toContain("float W = u_mbox.z;");
                expect(source).toContain("o = vec4(c.rgb,");
            }
        }
    });
});

describe("axis-aligned placement over the background (phase 10c)", () => {
    it("composites the layer's alpha over the background (a masked V1 scene shows black, as the export's overlay onto black)", async () => {
        const { PLACE_SHADER } = await import("./gl-programs");
        expect(PLACE_SHADER).toContain("float outA = a + u_background.a * (1.0 - a);");
        expect(PLACE_SHADER).toContain("o = u_background;");
    });
});
