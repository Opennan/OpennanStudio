import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const dir = path.dirname(fileURLToPath(import.meta.url));
const css = readFileSync(path.join(dir, "keyframe-graph.css"), "utf8");

describe("keyframe-graph.css", () => {
    it("uses theme tokens only (no color literals)", () => {
        const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
        expect(withoutComments).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
        expect(withoutComments).not.toMatch(/\b(rgba?|hsla?|oklch)\(/);
        for (const [, name] of withoutComments.matchAll(/var\(\s*(--[\w-]+)/g)) expect(name.startsWith("--on-")).toBe(true);
    });

    it("keeps motion under 200 ms and turns it off for reduced motion", () => {
        for (const match of css.matchAll(/(\d+)ms/g)) expect(Number(match[1])).toBeLessThan(200);
        expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*animation: none !important;[\s\S]*transition: none !important;/);
    });

    it("is part of the package stylesheet", () => {
        expect(readFileSync(path.join(dir, "..", "styles.css"), "utf8")).toContain('@import "./editing/keyframe-graph.css";');
    });
});
