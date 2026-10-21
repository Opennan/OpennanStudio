import { isCapabilityOutput } from "./capability-output";

describe("CapabilityOutput", () => {
    it("recognizes outputs with a media list", () => {
        expect(isCapabilityOutput({ media: [] })).toBe(true);
        expect(isCapabilityOutput({ media: [{ kind: "image", url: "https://x/y.png" }], costUsd: 0.1 })).toBe(true);
        expect(isCapabilityOutput({ media: [{ kind: "text" }] })).toBe(false);
        expect(isCapabilityOutput({ media: "x" })).toBe(false);
        expect(isCapabilityOutput(null)).toBe(false);
    });
});
