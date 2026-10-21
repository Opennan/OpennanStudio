import { optimisticTimelineClipFromInput } from "@opennan/timeline-core/lib/timeline-optimistic";
import { textStatePlan } from "@opennan/timeline-core/text/text-states";
import { MAX_ATLAS_SIDE, atlasCropFilter, checkTextAtlas, textAtlasPlan } from "./text-atlas";

const text = (patch: Record<string, unknown>) =>
    optimisticTimelineClipFromInput({ trackType: "text", textContent: "Hello", startTime: 2, endTime: 4, ...patch }, "p", "t");

describe("textAtlasPlan", () => {
    it("is null for text without a raster animation (static or transform-only)", () => {
        expect(textAtlasPlan(text({}))).toBeNull();
        expect(textAtlasPlan(text({ animationJson: JSON.stringify({ in: { id: "fade", duration: 0.5 } }) }))).toBeNull();
    });

    it("is the clip's state plan when it has more than one raster state", () => {
        const clip = text({ animationJson: JSON.stringify({ in: { id: "typewriter", duration: 1 } }) });
        const plan = textAtlasPlan(clip)!;
        expect(plan.animated).toBe(true);
        expect(plan.states).toEqual(textStatePlan(clip).states);
        expect(plan.states).toHaveLength(6);
    });
});

describe("atlasCropFilter", () => {
    it("selects the state's cell per frame with crop on the clip-local stream time t", () => {
        const plan = textAtlasPlan(text({ animationJson: JSON.stringify({ in: { id: "typewriter", duration: 1 } }) }))!;
        const filter = atlasCropFilter(plan, { cols: 3, rows: 2, cellWidth: 40, cellHeight: 20, count: 6 });
        expect(filter).toMatch(/^crop=w=40:h=20:x='[^']+':y='[^']+':exact=1$/);
        expect(filter).toContain("t");
        expect(filter).not.toContain("T");
        expect(filter).not.toMatch(/st\(|ld\(/);
    });
});

describe("checkTextAtlas", () => {
    const good = { cols: 3, rows: 2, cellWidth: 40, cellHeight: 20, count: 6 };

    it("accepts a grid that holds every state inside the PNG", () => {
        expect(checkTextAtlas(good, 120, 40, 6)).toEqual(good);
        expect(checkTextAtlas({ ...good, count: 5 }, 120, 40, 5)).toEqual({ ...good, count: 5 });
    });

    it("refuses grids that would crop outside the PNG, miss states, or are not integers", () => {
        for (const bad of [
            null, "x", { ...good, count: 5 }, { ...good, cols: 2 }, { ...good, cellWidth: 41 }, { ...good, cellHeight: 21 },
            { ...good, cellWidth: 40.5 }, { ...good, cols: "3" }, { ...good, cellWidth: 0 }, { ...good, rows: -1 },
            { ...good, cellWidth: Number.NaN },
        ]) {
            expect(checkTextAtlas(bad, 120, 40, 6), JSON.stringify(bad)).toBeNull();
        }
    });

    it("keeps atlases within the shared side limit", () => {
        expect(MAX_ATLAS_SIDE).toBe(4096);
        expect(checkTextAtlas({ cols: 2, rows: 1, cellWidth: 4097, cellHeight: 20, count: 2 }, 8194, 20, 2)).toBeNull();
    });
});
