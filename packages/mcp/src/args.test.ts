import { camelPatch, clipById, overlaps, presentFields, round3, sceneByOrder, sceneSpan } from "./args";
import { createFixtureStudio } from "./testing/fixture";

describe("argument helpers", () => {
    it("finds scenes by 1-based order and computes their span", async () => {
        const { controller } = await createFixtureStudio();
        const snap = controller.snapshot();
        expect(sceneByOrder(snap, 2).id).toBe("s2");
        expect(sceneSpan(snap, sceneByOrder(snap, 2))).toEqual({ start: 4, duration: 6 });
        expect(() => sceneByOrder(snap, 0)).toThrow("Scene 0 not found (the project has 3 scenes)");
        expect(clipById(snap, "title").label).toBe("Title");
        expect(() => clipById(snap, "x")).toThrow("Timeline clip not found: x");
    });

    it("renames present snake_case arguments", () => {
        expect(camelPatch({ position_x: 0.2, fade_in_duration: undefined, other: 1 }, ["position_x", "fade_in_duration"])).toEqual({ positionX: 0.2 });
    });

    it("finds top-level and array-item fields", () => {
        expect(presentFields({ a: 1, list: [{ b: 1 }, {}] }, ["a", "list[].b", "list[].c", "z"])).toEqual(["a", "list[].b"]);
    });

    it("rounds and tests overlap", () => {
        expect(round3(1.23456)).toBe(1.235);
        expect(overlaps(0, 4, 3, 10)).toBe(true);
        expect(overlaps(0, 4, 4, 10)).toBe(false);
        expect(overlaps(0, 4)).toBe(true);
    });
});
