import { describe, it, expect } from "vitest";
import { resolveRippleDelete } from "./ripple";
import type { EngineItem } from "./types";

const item = (id: string, trackId: string, start: number, duration: number): EngineItem =>
    ({ id, trackId, start, duration, kind: "scene" });

describe("resolveRippleDelete", () => {
    it("shifts later same-track items left by the deleted duration", () => {
        const items = [item("a", "v1", 0, 5), item("b", "v1", 5, 5), item("c", "v1", 12, 3)];
        const r = resolveRippleDelete(items, "b");
        expect(r.get("c")).toEqual({ start: 7, trackId: "v1" });
        expect(r.has("a")).toBe(false);
    });

    it("does not touch other tracks", () => {
        const items = [item("a", "v1", 0, 5), item("b", "a1", 10, 5)];
        expect(resolveRippleDelete(items, "a").size).toBe(0);
    });
});
