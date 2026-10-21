// Unit tests for coercing arbitrary color strings into a value that
// <input type="color"> accepts (it only accepts 7-char lowercase #rrggbb).
import { describe, expect, it } from "vitest";
import { toColorInputValue } from "./color-input";

describe("toColorInputValue", () => {
  it("passes through a valid 6-digit hex", () => {
    expect(toColorInputValue("#1a2b3c")).toBe("#1a2b3c");
  });

  it("normalizes uppercase hex to lowercase", () => {
    expect(toColorInputValue("#ABCDEF")).toBe("#abcdef");
  });

  it("expands 3-digit shorthand hex to 6 digits", () => {
    expect(toColorInputValue("#f80")).toBe("#ff8800");
  });

  it("converts rgb() to hex", () => {
    expect(toColorInputValue("rgb(255, 136, 0)")).toBe("#ff8800");
  });

  it("converts rgba() to hex, dropping the alpha channel", () => {
    expect(toColorInputValue("rgba(0, 0, 0, 0.6)")).toBe("#000000");
  });

  it("returns the fallback for 'transparent' (a color input cannot show transparency)", () => {
    expect(toColorInputValue("transparent", "#222222")).toBe("#222222");
  });

  it("returns the fallback for empty / null / unparseable values", () => {
    expect(toColorInputValue("", "#333333")).toBe("#333333");
    expect(toColorInputValue(null, "#333333")).toBe("#333333");
    expect(toColorInputValue("not-a-color", "#333333")).toBe("#333333");
  });

  it("defaults the fallback to #000000 when none is given", () => {
    expect(toColorInputValue("transparent")).toBe("#000000");
  });
});
