import css from "./cloud.css?raw";

describe("cloud.css", () => {
    it("uses theme tokens only (no colour literals)", () => {
        expect(css.length).toBeGreaterThan(100);
        expect(css).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);
    });
});
