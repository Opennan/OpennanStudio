import { describe, expect, it } from "vitest";
import { beatTimesOnTimeline, clipBeatTimes, parseBeatsJson, planAutoCut, planBeatsJson, type AutoCutPlan } from "./beat-plan";
import { BASE_TRACKS, clip, scene } from "../ai/__fixtures__/items";

function plan(result: ReturnType<typeof planAutoCut>): AutoCutPlan {
    if (!result.ok) throw new Error(result.error);
    return result.value;
}

const beatsEvery = (step: number, count: number, from = 0) => JSON.stringify(Array.from({ length: count }, (_, i) => Math.round((from + i * step) * 1000) / 1000));

describe("beats on clips", () => {
    it("validates, sorts, and de-duplicates beats; null clears", () => {
        expect(planBeatsJson([2, 1, 1.0001, 0])).toEqual({ ok: true, value: "[0,1,2]" });
        expect(planBeatsJson(null)).toEqual({ ok: true, value: null });
        expect(planBeatsJson([]).ok && planBeatsJson([])).toEqual({ ok: true, value: null });
        expect(planBeatsJson([-1]).ok).toBe(false);
        expect(planBeatsJson([Number.NaN]).ok).toBe(false);
        expect(planBeatsJson("1,2").ok).toBe(false);
        expect(planBeatsJson(Array.from({ length: 4001 }, (_, i) => i)).ok).toBe(false);
        expect(parseBeatsJson("nope")).toEqual([]);
    });

    it("maps source beats through trim and speed into the clip's window", () => {
        const c = clip("m", { trackType: "audio", startTime: 10, endTime: 14, trimStart: 2, playbackSpeed: 2, beatsJson: "[1,2,4,6,10,11]" });
        expect(clipBeatTimes(c)).toEqual([10, 11, 12, 14]);
        expect(clipBeatTimes({ ...c, reversePlayback: true })).toEqual([]);
        const other = clip("n", { trackType: "audio", startTime: 0, endTime: 3, beatsJson: "[0.5,1.5]" });
        const notAudio = clip("v", { trackType: "video", startTime: 0, endTime: 3, beatsJson: "[1]" });
        expect(beatTimesOnTimeline([c, other, notAudio])).toEqual([0.5, 1.5, 10, 11, 12, 14]);
    });
});

describe("planAutoCut", () => {
    const music = clip("music", { trackType: "audio", trackIndex: 2, startTime: 0, endTime: 30, mediaUrl: "https://x/m.mp3", beatsJson: beatsEvery(0.5, 60) });

    it("lays the items end to end, each end on the beat nearest its natural end, and ripples later items on their track", () => {
        const a = clip("a", { trackType: "video", trackIndex: 2, startTime: 1, endTime: 2.7, mediaUrl: "https://x/a.png", mediaType: "image" });
        const b = clip("b", { trackType: "video", trackIndex: 2, startTime: 3, endTime: 4.1, mediaUrl: "https://x/b.png", mediaType: "image" });
        const later = clip("later", { trackType: "video", trackIndex: 2, startTime: 6, endTime: 7, mediaUrl: "https://x/c.png", mediaType: "image" });
        const p = plan(planAutoCut({ clips: [music, a, b, later], scenes: [], tracks: BASE_TRACKS }, { clipIds: ["b", "a"] }));
        expect(p.beatClipId).toBe("music");
        // a: 1 → natural end 2.7 → beat 2.5; b starts 2.5, natural end 3.6 → beat 3.5; the group ended at 4.1, now 3.5.
        expect(p.clipUpdates).toEqual([
            { clipId: "a", startTime: 1, endTime: 2.5 },
            { clipId: "b", startTime: 2.5, endTime: 3.5 },
            { clipId: "later", startTime: 5.4, endTime: 6.4 },
        ]);
        expect(p.snapped).toBe(2);
    });

    it("keeps media clips within their media (shorter only) and at least 0.2 s, every N beats", () => {
        const v = clip("v", { trackType: "video", trackIndex: 2, startTime: 0, endTime: 1.9, mediaUrl: "https://x/v.mp4", trimStart: 1 });
        const p = plan(planAutoCut({ clips: [music, v], scenes: [], tracks: BASE_TRACKS }, { clipIds: ["v"], every: 2 }));
        // Beats every 1 s (0, 1, 2, ...): 2 is past the media, so 1.
        expect(p.clipUpdates).toEqual([{ clipId: "v", startTime: 0, endTime: 1, trimStart: 1, trimEnd: 2 }]);
        const tiny = clip("t", { trackType: "video", trackIndex: 2, startTime: 0, endTime: 0.15, mediaUrl: "https://x/v.mp4" });
        const kept = plan(planAutoCut({ clips: [music, tiny], scenes: [], tracks: BASE_TRACKS }, { clipIds: ["t"] }));
        expect(kept.clipUpdates).toEqual([]);
        expect(kept.unchanged).toBe(1);
    });

    it("re-times scenes by their trims and may lengthen them inside their content", () => {
        const s = scene("s", { cardType: "source_clip", sourceVideoUrl: "https://x/s.mp4", cardConfig: JSON.stringify({ timelineTrimStart: 0, timelineTrimEnd: 2.8, timelineSourceDuration: 10 }) });
        const p = plan(planAutoCut({ clips: [music], scenes: [s], tracks: BASE_TRACKS }, { sceneIds: ["s"] }));
        expect(p.scenePatches).toHaveLength(1);
        expect(JSON.parse(p.scenePatches[0].patch.cardConfig!)).toMatchObject({ timelineTrimStart: 0, timelineTrimEnd: 3 });
        expect(p.sceneMoves).toEqual([{ sceneId: "s", timelinePositionSeconds: 0.001 }]);
    });

    it("explains what is missing", () => {
        const a = clip("a", { trackType: "video", trackIndex: 2, startTime: 0, endTime: 1, mediaUrl: "https://x/a.png", mediaType: "image" });
        expect(planAutoCut({ clips: [a], scenes: [], tracks: BASE_TRACKS }, { clipIds: ["a"] })).toEqual({ ok: false, error: "No audio clip with beats under these items: detect beats first" });
        expect(planAutoCut({ clips: [a, music], scenes: [], tracks: BASE_TRACKS }, {})).toEqual({ ok: false, error: "Select the clips or scenes to cut to the beat" });
        expect(planAutoCut({ clips: [a, music], scenes: [], tracks: BASE_TRACKS }, { clipIds: ["a"], every: 0 }).ok).toBe(false);
    });
});
