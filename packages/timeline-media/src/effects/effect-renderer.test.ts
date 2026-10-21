// Unit and source-contract coverage for real-time WebGL effect rendering.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { canUseEffectRenderer } from "./effect-renderer";

describe("canUseEffectRenderer", () => {
    it("returns false when WebGL contexts are unavailable", () => {
        const canvas = {
            getContext: () => null,
        } as unknown as HTMLCanvasElement;

        expect(canUseEffectRenderer(canvas)).toBe(false);
    });

    it("returns false when probing the canvas context throws", () => {
        const canvas = {
            getContext: () => {
                throw new Error("blocked");
            },
        } as unknown as HTMLCanvasElement;

        expect(canUseEffectRenderer(canvas)).toBe(false);
    });

    it("returns true when a WebGL context can be created", () => {
        const context = {};
        const canvas = {
            getContext: (type: string) => type === "webgl" ? context : null,
        } as unknown as HTMLCanvasElement;

        expect(canUseEffectRenderer(canvas)).toBe(true);
    });
});

describe("EffectRenderer video texture updates", () => {
    it("reuses the texture allocation for streaming frames", () => {
        const source = readFileSync(resolve(__dirname, "effect-renderer.ts"), "utf8");

        expect(source).toContain("this.source.resize(w, h);");
        expect(source).toContain("this.source.subimage({ data: source, flipY: true }, 0, 0);");
        expect(source).not.toContain('this.source({ data: source, flipY: true, min: "linear", mag: "linear" });');
    });
});
