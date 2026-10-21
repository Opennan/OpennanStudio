import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const css = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "editing.css"), "utf8");

describe("editing.css", () => {
    it("uses theme tokens only (no color literals)", () => {
        const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
        expect(withoutComments).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
        expect(withoutComments).not.toMatch(/\b(rgba?|hsla?|oklch)\(/);
    });

    it("keeps motion under 200 ms and turns it off for reduced motion", () => {
        for (const match of css.matchAll(/(\d+)ms/g)) expect(Number(match[1])).toBeLessThan(200);
        expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*animation: none !important;[\s\S]*transition: none !important;/);
    });
});
