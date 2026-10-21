import { describe, expect, it } from "vitest";
import { planAiPlacement, type AiPlacementPlan, type AiPlacementState } from "./ai-placement";
import { BASE_TRACKS, clip, scene, track } from "../ai/__fixtures__/items";

function plan(state: AiPlacementState, placement: Parameters<typeof planAiPlacement>[1]): AiPlacementPlan {
    const result = planAiPlacement(state, placement);
    if (!result.ok) throw new Error(result.error);
    return result.value;
}

describe("planAiPlacement", () => {
    it("places a scaled-down scene's offset as the clip position (centre of the fit rect over the free space)", () => {
        const s = scene("s", { videoUrl: "https://x/v.mp4", transformScale: 0.5, transformOffsetX: 10, transformOffsetY: -10, sourceWidth: 1920, sourceHeight: 1080 });
        const p = plan({ clips: [], scenes: [s], tracks: [track("video", 1)], aspectRatio: "16:9" }, { kind: "stack-video", source: { sceneId: "s" }, media: { url: "https://x/r.mp4" } });
        expect(p.creates[0]).toMatchObject({ scale: 0.5, positionX: 0.7, positionY: 0.3, trackIndex: 2 });
        // The slot above was free: nothing is renumbered.
        expect(p.clipUpdates).toEqual([]);
        expect(p.scenePatches).toEqual([{ sceneId: "s", patch: { opacity: 0 } }]);
    });

    it("fits a landscape scene in a portrait project by height and uses the result's pixel size", () => {
        const s = scene("s", { videoUrl: "https://x/v.mp4", sourceWidth: 1920, sourceHeight: 1080 });
        const p = plan({ clips: [], scenes: [s], tracks: [track("video", 1)], aspectRatio: "9:16" }, { kind: "stack-video", source: { sceneId: "s" }, media: { url: "https://x/r.mp4", width: 3840, height: 2160 } });
        // Contain: the 16:9 picture is as wide as the 1080-wide reference frame, so 607.5 px tall; the 2160 px result → 0.28125.
        expect(p.creates[0].scale).toBeCloseTo(0.28125, 4);
        expect(p.creates[0]).toMatchObject({ positionX: 0.5, positionY: 0.5 });
    });

    it("renumbers scenes on upper video tracks when the slot is taken", () => {
        const a = scene("a", { videoUrl: "https://x/a.mp4" });
        const b = scene("b", { videoUrl: "https://x/b.mp4", trackIndex: 2 });
        const p = plan({ clips: [], scenes: [a, b], tracks: [track("video", 1), track("video", 2)] }, { kind: "stack-video", source: { sceneId: "a" }, media: { url: "https://x/r.mp4" } });
        expect(p.scenePatches).toEqual([{ sceneId: "b", patch: { trackIndex: 3 } }, { sceneId: "a", patch: { opacity: 0 } }]);
        expect(p.tracks!.filter((t) => t.type === "video").map((t) => `${t.index}:${t.label}`)).toEqual(["1:V1", "2:V2", "3:V3"]);
    });

    it("refuses audio sources for video results, empty results, and locked tracks", () => {
        const a = clip("a", { trackType: "audio", startTime: 0, endTime: 4, mediaUrl: "https://x/a.wav" });
        const state = { clips: [a], scenes: [], tracks: BASE_TRACKS };
        expect(planAiPlacement(state, { kind: "stack-video", source: { clipId: "a" }, media: { url: "https://x/r.mp4" } })).toEqual({ ok: false, error: "a video result needs a video clip or scene" });
        expect(planAiPlacement(state, { kind: "replace-audio", source: { clipId: "a" }, media: [] })).toEqual({ ok: false, error: "the tool returned no audio" });
        expect(planAiPlacement(state, { kind: "replace-audio", source: { clipId: "a" }, media: [{ url: "u", durationSeconds: 0.01 }] })).toEqual({ ok: false, error: "the result is too short to place" });
        const locked = { ...state, tracks: [track("audio", 1, { locked: true })] };
        expect(planAiPlacement(locked, { kind: "replace-audio", source: { clipId: "a" }, media: [{ url: "u" }] })).toEqual({ ok: false, error: "The track is locked" });
        expect(planAiPlacement(state, { kind: "insert-media", at: 0, media: [] })).toEqual({ ok: false, error: "the tool returned no media" });
    });

    it("keeps a muted scene's sound owned by a new clip of the result when lip sync's audio clip is taken", () => {
        const s = scene("s", { cardType: "source_clip", sourceVideoUrl: "https://x/v.mp4", duration: 4 });
        const a = clip("a", { trackType: "audio", startTime: 0, endTime: 4, mediaUrl: "https://x/a.wav", sceneId: "other" });
        const p = plan({ clips: [a], scenes: [s], tracks: BASE_TRACKS }, { kind: "stack-video", source: { sceneId: "s" }, media: { url: "https://x/lips.mp4" }, muteSource: true, audioClipId: "a" });
        expect(p.creates.find((c) => c.trackType === "audio")).toMatchObject({ mediaUrl: "https://x/lips.mp4", sceneId: "s", volume: 1, startTime: 0, endTime: 4 });
    });
});
