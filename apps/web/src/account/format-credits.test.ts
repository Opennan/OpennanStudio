import { chipCreditsLabel, creditsTone, formatCredits } from "./format-credits";

describe("credits", () => {
    it("formats dollars with cents", () => {
        expect(formatCredits(12.4)).toBe("$12.40");
        // A balance is never shown above what is there (phase 9c): rounded down.
        expect(formatCredits(12.459)).toBe("$12.45");
        expect(formatCredits(0.009)).toBe("$0.00");
        expect(formatCredits(1.1)).toBe("$1.10");
        expect(formatCredits(0)).toBe("$0.00");
        expect(formatCredits(-3)).toBe("$0.00");
        expect(formatCredits(null)).toBe("—");
    });
    it("warns below $1 and asks for credits at $0", () => {
        expect(creditsTone(12.4)).toBe("normal");
        expect(creditsTone(0.99)).toBe("low");
        expect(creditsTone(0)).toBe("zero");
        expect(creditsTone(null)).toBe("unknown");
        expect(chipCreditsLabel(0)).toBe("Add credits");
        expect(chipCreditsLabel(0.5)).toBe("$0.50");
    });
});
