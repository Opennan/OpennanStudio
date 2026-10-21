import { describe, expect, it } from "vitest";
import { chainClipFades, clipJunction, clipLibraryTransition, clipTransitionChains, isLegacyPresetFade, planTransitionWindows, windowProgress } from "./windows";

describe("transition windows", () => {
    it("centers on the cut and never takes more than half of a neighbour", () => {
        const w = planTransitionWindows([4, 1, 3], new Map([[0, { type: "cross_dissolve", duration: 3 }], [1, { type: "spin", duration: 0.5 }]]));
        expect(w.get(0)).toEqual({ type: "cross_dissolve", half: 0.5 });
        expect(w.get(1)).toEqual({ type: "spin", half: 0.25 });
    });

    it("snaps to frames and drops unknown or too-short joins", () => {
        const w = planTransitionWindows([2, 2, 0.02], new Map([[0, { type: "wipe_left", duration: 0.55 }], [1, { type: "wipe_left", duration: 1 }]]), 30);
        expect(w.get(0)!.half).toBeCloseTo(8 / 30, 9);
        expect(w.has(1)).toBe(false);
        expect(planTransitionWindows([2, 2], new Map([[0, { type: "warp", duration: 1 }]])).size).toBe(0);
    });

    it("maps time to progress inside the window", () => {
        expect(windowProgress(4.75, 5, 0.5)).toBe(0.25);
        expect(windowProgress(5.5, 5, 0.5)).toBeNull();
        expect(windowProgress(4.4, 5, 0.5)).toBeNull();
    });
});

describe("clip transition chains (upper-track clip cuts)", () => {
    const clip = (id: string, start: number, end: number, patch: Record<string, unknown> = {}) => ({
        id, trackType: "video", trackIndex: 2, startTime: start, endTime: end, mediaUrl: `/m/${id}.mp4`, mediaType: "video",
        transitionType: "none", transitionDuration: 0, fadeInDuration: 0, fadeOutDuration: 0, ...patch,
    });

    it("joins touching V2+ video/image clips whose outgoing clip has a library transition", () => {
        const chains = clipTransitionChains([
            clip("b", 2, 4.04, { transitionType: "cross_dissolve", transitionDuration: 1 }),
            clip("a", 0, 2, { transitionType: "wipe_left", transitionDuration: 0.5 }),
            clip("c", 4.08, 6, { mediaType: "image", mediaUrl: "/m/c.png" }),
        ]);
        expect(chains).toHaveLength(1);
        expect(chains[0].trackIndex).toBe(2);
        expect(chains[0].clips.map((c) => c.id)).toEqual(["a", "b", "c"]);
        expect([...chains[0].joins]).toEqual([[0, { type: "wipe_left", duration: 0.5 }], [1, { type: "cross_dissolve", duration: 1 }]]);
    });

    it("leaves clips out that are not touching, have no transition, or are not upper-track media clips", () => {
        const chains = clipTransitionChains([
            clip("a", 0, 2, { transitionType: "wipe_left", transitionDuration: 0.5 }),
            clip("gap", 2.1, 4),
            clip("d", 4, 6),
            clip("e", 6, 8),
            clip("v1", 0, 2, { trackIndex: 1, transitionType: "wipe_left", transitionDuration: 0.5 }),
            clip("v1b", 2, 4, { trackIndex: 1 }),
            clip("t", 0, 2, { trackType: "text", trackIndex: 1, transitionType: "wipe_left", transitionDuration: 0.5 }),
            clip("t2", 2, 4, { trackType: "text", trackIndex: 1 }),
            clip("legacy", 10, 12, { transitionType: "zoom_blur_legacy", transitionDuration: 0.5 }),
            clip("legacy2", 12, 14),
            clip("zero", 20, 22, { transitionType: "wipe_left", transitionDuration: 0 }),
            clip("zero2", 22, 24),
            clip("empty", 30, 32, { transitionType: "wipe_left", transitionDuration: 0.5 }),
            clip("empty2", 32, 34, { mediaUrl: null }),
        ]);
        expect(chains).toEqual([]);
    });

    it("splits a track into separate chains around cuts without a transition", () => {
        const chains = clipTransitionChains([
            clip("a", 0, 2, { transitionType: "spin", transitionDuration: 0.5 }),
            clip("b", 2, 4),
            clip("c", 4, 6, { transitionType: "push_left", transitionDuration: 0.5 }),
            clip("d", 6, 8),
            clip("x", 0, 2, { trackIndex: 3, transitionType: "flash", transitionDuration: 0.5 }),
            clip("y", 2, 4, { trackIndex: 3 }),
        ]);
        expect(chains.map((c) => [c.trackIndex, c.clips.map((x) => x.id)])).toEqual([[2, ["a", "b"]], [2, ["c", "d"]], [3, ["x", "y"]]]);
    });

    it("skips legacy-preset joins (fade-out equal to the transition duration within 1 ms): they keep the per-clip fades", () => {
        // Phase 10a's preset path wrote transitionType with fadeIn = fadeOut = transitionDuration; 10a exported
        // those as alpha fades, so they must not become a window (an old fade to V1 would turn into a dissolve).
        const chains = clipTransitionChains([
            clip("a", 0, 2, { transitionType: "cross_dissolve", transitionDuration: 0.5, fadeInDuration: 0.5, fadeOutDuration: 0.5 }),
            clip("b", 2, 4),
            clip("c", 10, 12, { transitionType: "dip_black", transitionDuration: 0.75, fadeInDuration: 0.75, fadeOutDuration: 0.7505 }),
            clip("d", 12, 14),
            // Only the outgoing fade-out decides: a preset fade-in alone does not make it legacy.
            clip("e", 20, 22, { transitionType: "wipe_left", transitionDuration: 0.5, fadeInDuration: 0.5, fadeOutDuration: 0 }),
            clip("f", 22, 24),
            // A fade-out that differs from the duration is the user's own fade: the window replaces it.
            clip("g", 30, 32, { transitionType: "spin", transitionDuration: 0.5, fadeOutDuration: 0.3 }),
            clip("h", 32, 34),
        ]);
        expect(chains.map((c) => c.clips.map((x) => x.id))).toEqual([["e", "f"], ["g", "h"]]);
        expect(clipLibraryTransition(clip("x", 0, 2, { transitionType: "cross_dissolve", transitionDuration: 0.5, fadeOutDuration: 0.5 }))).toBeNull();
        expect(isLegacyPresetFade({ transitionType: "cross_dissolve", transitionDuration: 0.5, fadeOutDuration: 0.501 })).toBe(true);
        expect(isLegacyPresetFade({ transitionType: "cross_dissolve", transitionDuration: 0.5, fadeOutDuration: 0.502 })).toBe(false);
        expect(isLegacyPresetFade({ transitionType: "none", transitionDuration: 0.5, fadeOutDuration: 0.5 })).toBe(false);
    });

    it("drops the junction fades a window replaces (outgoing fade-out, incoming fade-in)", () => {
        const a = clip("a", 0, 2, { transitionType: "wipe_left", transitionDuration: 0.5, fadeInDuration: 0.3, fadeOutDuration: 0.5 });
        const b = clip("b", 2, 4, { fadeInDuration: 0.2, fadeOutDuration: 0.4 });
        expect(chainClipFades(a, { incoming: false, outgoing: true })).toMatchObject({ fadeInDuration: 0.3, fadeOutDuration: 0 });
        expect(chainClipFades(b, { incoming: true, outgoing: false })).toMatchObject({ fadeInDuration: 0, fadeOutDuration: 0.4 });
        expect(chainClipFades(b, { incoming: false, outgoing: false })).toBe(b);
    });

    it("finds the junction of a clip as the outgoing or incoming side", () => {
        const clips = [clip("a", 0, 2), clip("b", 2.03, 4), clip("c", 5, 6)];
        expect(clipJunction(clips, "a")).toEqual({ outgoingId: "a", incomingId: "b", cut: 2, maxDuration: 1.97 });
        expect(clipJunction(clips, "b")).toEqual({ outgoingId: "a", incomingId: "b", cut: 2, maxDuration: 1.97 });
        expect(clipJunction(clips, "c")).toBeNull();
    });
});
