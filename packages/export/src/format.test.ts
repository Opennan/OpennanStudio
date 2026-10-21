import { clamp, fmt, num, quantize, round3, sec, truthy } from "./format";

describe("fmt", () => {
    it("prints like Python %g without exponents", () => {
        expect(fmt(0.5)).toBe("0.5");
        expect(fmt(1)).toBe("1");
        expect(fmt(1 / 3)).toBe("0.333333");
        expect(fmt(2.0000001)).toBe("2");
        expect(fmt(-0.08)).toBe("-0.08");
        expect(fmt(1e-12)).toBe("0");
        expect(fmt(Number.NaN)).toBe("0");
        expect(fmt(0.0000123)).toBe("0.0000123");
        expect(fmt(1.23e-7)).toBe("0");
        expect(fmt(125.5)).toBe("125.5");
    });
});

describe("coercion helpers", () => {
    it("sec keeps milliseconds and never goes negative", () => {
        expect(sec(1.23456)).toBe("1.235");
        expect(sec(-1)).toBe("0.000");
    });
    it("num falls back on null, empty and non-finite", () => {
        expect(num(null, 1)).toBe(1);
        expect(num("", 2)).toBe(2);
        expect(num("0.5", 1)).toBe(0.5);
        expect(num(Number.POSITIVE_INFINITY, 3)).toBe(3);
        expect(num(0, 1)).toBe(0);
    });
    it("truthy matches the assembler's string booleans", () => {
        expect(truthy("Yes")).toBe(true);
        expect(truthy("off")).toBe(false);
        expect(truthy(1)).toBe(true);
        expect(truthy(null)).toBe(false);
    });
    it("clamp, round3, quantize", () => {
        expect(clamp(5, 0, 1)).toBe(1);
        expect(round3(0.12345)).toBe(0.123);
        expect(quantize(1.01, 30)).toBeCloseTo(1);
        expect(quantize(1.02, 30)).toBeCloseTo(31 / 30);
    });
});
