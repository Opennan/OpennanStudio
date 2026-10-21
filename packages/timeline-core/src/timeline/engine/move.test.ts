import { describe, it, expect } from "vitest";
import { resolveMove } from "./move";
import type { EngineItem } from "./types";

const item = (id: string, trackId: string, start: number, duration: number): EngineItem =>
    ({ id, trackId, start, duration, kind: "scene" });

describe("resolveMove", () => {
    it("moves freely into empty space (gap allowed, no reflow)", () => {
        const items = [item("a", "v1", 0, 5), item("b", "v1", 10, 5)];
        const r = resolveMove(items, ["b"], 5);
        expect(r.get("b")).toEqual({ start: 15, trackId: "v1" });
        expect(r.has("a")).toBe(false);
    });

    it("clamps left drags at the previous item's end when short of its midpoint", () => {
        const items = [item("a", "v1", 0, 5), item("b", "v1", 10, 5)];
        const r = resolveMove(items, ["b"], -6); // proposed 4 — on a's far half
        expect(r.get("b")).toEqual({ start: 5, trackId: "v1" });
        expect(r.has("a")).toBe(false);
    });

    it("reorders once the drag passes the previous item's midpoint", () => {
        const items = [item("a", "v1", 0, 5), item("b", "v1", 10, 5)];
        const r = resolveMove(items, ["b"], -8); // proposed 2 < a.mid 2.5
        expect(r.get("b")).toEqual({ start: 2, trackId: "v1" });
        expect(r.get("a")).toEqual({ start: 7, trackId: "v1" });
    });

    it("dragging fully onto the previous item's start swaps the two", () => {
        const items = [item("a", "v1", 0, 5), item("b", "v1", 10, 5)];
        const r = resolveMove(items, ["b"], -10);
        expect(r.get("b")).toEqual({ start: 0, trackId: "v1" });
        expect(r.get("a")).toEqual({ start: 5, trackId: "v1" });
    });

    it("dragging right past a neighbor's midpoint swaps and closes the vacated gap", () => {
        const items = [item("a", "v1", 0, 5), item("b", "v1", 5, 5)];
        const r = resolveMove(items, ["a"], 8); // a proposed 8 > b.mid 7.5
        expect(r.get("b")).toEqual({ start: 0, trackId: "v1" });
        expect(r.get("a")).toEqual({ start: 8, trackId: "v1" });
    });

    it("dragging right onto a neighbor's near half still pushes (no reorder)", () => {
        const items = [item("a", "v1", 0, 5), item("b", "v1", 5, 5)];
        const r = resolveMove(items, ["a"], 2); // a proposed 2 < b.mid 7.5
        expect(r.get("a")).toEqual({ start: 2, trackId: "v1" });
        expect(r.get("b")).toEqual({ start: 7, trackId: "v1" });
    });

    it("inserts between two adjacent scenes by pushing the crossed one right", () => {
        // scenes 1,2 tight at 0..5..10; drag scene 3 into the middle — no gap
        // exists, so scene 2 must open a slot exactly one duration wide.
        const items = [item("s1", "v1", 0, 5), item("s2", "v1", 5, 5), item("s3", "v1", 10, 10)];
        const r = resolveMove(items, ["s3"], -7); // s3 proposed 3: between s1.start and s2.start
        expect(r.get("s3")).toEqual({ start: 5, trackId: "v1" });   // lands after s1
        expect(r.get("s2")).toEqual({ start: 15, trackId: "v1" });  // pushed right by s3's duration
        expect(r.has("s1")).toBe(false);
    });

    it("clamps at 0 when dragging past the timeline start", () => {
        const items = [item("a", "v1", 3, 5)];
        expect(resolveMove(items, ["a"], -10).get("a")).toEqual({ start: 0, trackId: "v1" });
    });

    it("pushes later items right by exactly the overlap", () => {
        const items = [item("a", "v1", 0, 5), item("b", "v1", 5, 5), item("c", "v1", 10, 5)];
        const r = resolveMove(items, ["a"], 3); // a now 3..8, overlaps b by 3
        expect(r.get("a")!.start).toBe(3);
        expect(r.get("b")!.start).toBe(8);
        expect(r.get("c")!.start).toBe(13);
    });

    it("slides into a gap without pushing (room to spare)", () => {
        const items = [item("a", "v1", 0, 5), item("b", "v1", 20, 5)];
        const r = resolveMove(items, ["a"], 10); // a → 10..15, gap before b
        expect(r.get("a")!.start).toBe(10);
        expect(r.has("b")).toBe(false);
    });

    it("moves across tracks and pushes only on the target track", () => {
        const items = [item("a", "v1", 0, 5), item("b", "v2", 2, 5)];
        const r = resolveMove(items, ["a"], 0, "v2"); // a lands v2 @0..5, overlaps b by 3
        expect(r.get("a")).toEqual({ start: 0, trackId: "v2" });
        expect(r.get("b")!.start).toBe(5);
    });

    it("multi-select keeps relative offsets", () => {
        const items = [item("a", "v1", 0, 5), item("b", "v1", 6, 4)];
        const r = resolveMove(items, ["a", "b"], 2);
        expect(r.get("a")!.start).toBe(2);
        expect(r.get("b")!.start).toBe(8);
    });

    it("multi-select cross-track drag: targetTrackId applies only to the primary item, others keep their own tracks", () => {
        const items = [
            item("a", "v1", 0, 5),
            item("b", "v2", 0, 5),
        ];
        // Drag "a" (primary) down to v2 while "b" is also selected; only "a" should move track.
        const r = resolveMove(items, ["a", "b"], 2, "v2", "a");
        expect(r.get("a")!.trackId).toBe("v2");
        expect(r.get("b")!.trackId).toBe("v2"); // unchanged (was already v2), only start shifts
        expect(r.get("a")!.start).toBe(2);
        expect(r.get("b")!.start).toBeGreaterThanOrEqual(2); // pushed/kept on v2, still same track
    });

    it("multi-select cross-track drag keeps a non-primary item on its own distinct track", () => {
        const items = [
            item("a", "v1", 0, 5),
            item("b", "v3", 10, 5),
        ];
        const r = resolveMove(items, ["a", "b"], 2, "v2", "a");
        expect(r.get("a")!.trackId).toBe("v2");
        expect(r.get("b")!.trackId).toBe("v3");
        expect(r.get("b")!.start).toBe(12);
    });
});
