// packages/timeline-core/src/design/validate.test.ts
import { parseLayerDesign } from "./validate";
import { testDesign } from "./test-design";

describe("parseLayerDesign", () => {
    it("accepts a valid design and fills defaults", () => {
        const raw = JSON.parse(JSON.stringify(testDesign()));
        delete raw.layers[1].transform;
        delete raw.layers[1].opacity;
        const d = parseLayerDesign(raw);
        expect(d.layers[1].transform).toEqual({ dx: 0, dy: 0, scale: 1, rotation: 0 });
        expect(d.layers[1].opacity).toBe(1);
    });

    it("names the bad field", () => {
        const raw = JSON.parse(JSON.stringify(testDesign()));
        raw.layers[2].box.w = -1;
        expect(() => parseLayerDesign(raw)).toThrow("layers[2].box.w must be a positive number");
    });

    it("rejects duplicate ids and unknown kinds", () => {
        const dup = JSON.parse(JSON.stringify(testDesign()));
        dup.layers[1].id = "bg";
        expect(() => parseLayerDesign(dup)).toThrow('duplicate layer id "bg"');
        const kind = JSON.parse(JSON.stringify(testDesign()));
        kind.layers[1].kind = "video";
        expect(() => parseLayerDesign(kind)).toThrow('layers[1].kind must be "image" or "text"');
    });
});
