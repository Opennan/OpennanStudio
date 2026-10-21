import { describe, expect, it } from "vitest";
import { displayName, looksCatalog } from "./catalog";

describe("looksCatalog", () => {
    it("lists 25 transitions, 30 filters, 20 effects, 13 adjustments", () => {
        const c = looksCatalog();
        expect([c.transitions.length, c.filters.length, c.effects.length, c.adjustments.length]).toEqual([25, 30, 20, 13]);
        expect(c.transitions.find((t) => t.id === "cross_dissolve")!.name).toBe("Dissolve");
        expect(c.filters.find((f) => f.id === "teal_orange")!.name).toBe("Teal & orange");
        expect(c.adjustments.find((a) => a.key === "grain")).toEqual({ key: "grain", min: 0, max: 1 });
        expect(JSON.parse(JSON.stringify(c))).toEqual(c);
    });

    it("derives readable names from ids", () => {
        expect(displayName("golden_hour")).toBe("Golden hour");
        expect(displayName("fx_rgb_split")).toBe("Rgb split");
    });
});
