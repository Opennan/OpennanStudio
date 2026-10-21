// Tests preview text wrapping so canvas overlays match inspector text behavior.
import { describe, expect, it } from "vitest";
import { layoutPreviewText, splitGraphemes } from "./preview-text-layout";

const measureText = (text: string) => text.length * 10;

describe("layoutPreviewText", () => {
  it("preserves manual newlines as separate preview rows", () => {
    const layout = layoutPreviewText({
      text: "first line\nsecond line\nthird",
      maxWidth: 200,
      fontSize: 20,
      letterSpacing: 0,
      measureText,
    });

    expect(layout.lines.map((line) => line.text)).toEqual(["first line", "second line", "third"]);
    expect(layout.boxHeight).toBeCloseTo(20 * 1.3 * 3);
  });

  it("wraps long unbroken text to the locked preview width", () => {
    const layout = layoutPreviewText({
      text: "superlongwordwithoutspaces",
      maxWidth: 64,
      fontSize: 16,
      letterSpacing: 0,
      measureText,
    });

    expect(layout.lines.length).toBeGreaterThan(1);
    expect(layout.lines.every((line) => line.width <= 64)).toBe(true);
    expect(layout.boxWidth).toBeLessThanOrEqual(80);
  });

  it("includes letter spacing in wrap measurements", () => {
    const layout = layoutPreviewText({
      text: "abcd efgh",
      maxWidth: 45,
      fontSize: 16,
      letterSpacing: 5,
      measureText,
    });

    expect(layout.lines.length).toBeGreaterThan(1);
    expect(layout.lines.every((line) => line.width <= 45)).toBe(true);
  });
});

describe("line height and graphemes", () => {
  it("uses 1.3 x font size by default and the given multiplier otherwise", () => {
    const base = { text: "a\nb", maxWidth: 200, fontSize: 20, letterSpacing: 0, measureText };
    expect(layoutPreviewText(base).lineHeight).toBe(20 * 1.3);
    const tall = layoutPreviewText({ ...base, lineHeight: 1.8 });
    expect(tall.lineHeight).toBeCloseTo(36);
    expect(tall.boxHeight).toBeCloseTo(72);
  });

  it("splits text into grapheme clusters", () => {
    expect(splitGraphemes("ab")).toEqual(["a", "b"]);
    expect(splitGraphemes("e\u0301x")).toEqual(["e\u0301", "x"]);
    expect(splitGraphemes("\u{1F44D}\u{1F3FD}!")).toEqual(["\u{1F44D}\u{1F3FD}", "!"]);
    expect(splitGraphemes("")).toEqual([]);
  });
});
