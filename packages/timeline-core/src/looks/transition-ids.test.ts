import { describe, expect, it } from "vitest";
import { normalizeTimelineTransitionType, TIMELINE_TRANSITION_TYPES } from "../lib/timeline-editing-navigation";
import { TRANSITION_IDS } from "./transitions";

describe("transition ids", () => {
    it("are exactly none plus the library transitions", () => {
        expect([...TIMELINE_TRANSITION_TYPES].slice(1).sort()).toEqual([...TRANSITION_IDS].sort());
    });

    it("keep the pre-10a ids and aliases", () => {
        expect(normalizeTimelineTransitionType("crossfade")).toBe("cross_dissolve");
        expect(normalizeTimelineTransitionType("Dissolve")).toBe("cross_dissolve");
        expect(normalizeTimelineTransitionType("fade_black")).toBe("dip_black");
        expect(normalizeTimelineTransitionType("slideleft")).toBe("slide_left");
        expect(normalizeTimelineTransitionType("zoom_in")).toBe("zoom_in");
        expect(normalizeTimelineTransitionType("blur_dissolve")).toBe("blur_dissolve");
        expect(normalizeTimelineTransitionType("bogus")).toBe("none");
    });

    it("accept the new ids", () => {
        for (const id of ["spin", "glitch", "clock_wipe", "push_right", "ripple"]) expect(normalizeTimelineTransitionType(id)).toBe(id);
    });
});
