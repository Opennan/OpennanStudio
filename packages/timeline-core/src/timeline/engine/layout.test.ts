import { describe, it, expect } from "vitest";
import { itemsOnTrack, trackEnd, contentEnd, overlaps } from "./layout";
import type { EngineItem } from "./types";

const item = (id: string, trackId: string, start: number, duration: number): EngineItem =>
    ({ id, trackId, start, duration, kind: "scene" });

describe("engine layout", () => {
    it("sorts items on a track by start then id", () => {
        const items = [item("b", "v1", 5, 2), item("a", "v1", 0, 3), item("c", "a1", 1, 1)];
        expect(itemsOnTrack(items, "v1").map((i) => i.id)).toEqual(["a", "b"]);
    });

    it("trackEnd is the max end on that track, 0 when empty", () => {
        const items = [item("a", "v1", 0, 3), item("b", "v1", 10, 4)];
        expect(trackEnd(items, "v1")).toBe(14);
        expect(trackEnd(items, "v2")).toBe(0);
    });

    it("contentEnd is the max end across all tracks", () => {
        const items = [item("a", "v1", 0, 3), item("b", "a1", 20, 5)];
        expect(contentEnd(items)).toBe(25);
        expect(contentEnd([])).toBe(0);
    });

    it("overlaps detects same-track time intersection only", () => {
        expect(overlaps(item("a", "v1", 0, 5), item("b", "v1", 4.9, 2))).toBe(true);
        expect(overlaps(item("a", "v1", 0, 5), item("b", "v1", 5, 2))).toBe(false);
        expect(overlaps(item("a", "v1", 0, 5), item("b", "v2", 0, 5))).toBe(false);
    });
});
