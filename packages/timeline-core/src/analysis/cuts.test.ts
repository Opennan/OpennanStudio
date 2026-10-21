import { describe, expect, it } from "vitest";
import { keptRanges, mergeTimeRanges, planCuts, removedBefore, rippleTime, sourceRangesToTimeline, timelineRangesToSource, type CutsPlan } from "./cuts";
import { BASE_TRACKS, clip, scene, track } from "../ai/__fixtures__/items";

function plan(result: ReturnType<typeof planCuts>): CutsPlan {
    if (!result.ok) throw new Error(result.error);
    return result.value;
}

describe("range helpers", () => {
    it("merges, subtracts, and ripples", () => {
        expect(mergeTimeRanges([{ start: 5, end: 6 }, { start: 1, end: 2 }, { start: 1.5, end: 3 }, { start: 3.0005, end: 4 }, { start: 7, end: 7.0005 }])).toEqual([{ start: 1, end: 4 }, { start: 5, end: 6 }]);
        const removed = [{ start: 2, end: 3 }, { start: 5, end: 7 }];
        expect(keptRanges(0, 10, removed)).toEqual([{ start: 0, end: 2 }, { start: 3, end: 5 }, { start: 7, end: 10 }]);
        expect(removedBefore(6, removed)).toBe(2);
        expect(rippleTime(8, removed)).toBe(5);
        expect(rippleTime(2.5, removed)).toBe(2);
    });

    it("maps source ranges of an item to the timeline through its speed and back", () => {
        const source = { startSeconds: 4, endSeconds: 24, timelineStart: 10, timelineEnd: 20, speed: 2 };
        expect(sourceRangesToTimeline(source, [{ start: 6, end: 8 }, { start: 22, end: 30 }])).toEqual([{ start: 11, end: 12 }, { start: 19, end: 20 }]);
        expect(timelineRangesToSource(source, [{ start: 11, end: 12 }])).toEqual([{ start: 6, end: 8 }]);
    });
});

describe("planCuts", () => {
    it("cuts a clip into parts laid end to end, ripples its track and later items elsewhere, leaves spanning and locked items", () => {
        const state = {
            clips: [
                clip("a", { trackType: "audio", trackIndex: 1, startTime: 0, endTime: 10, mediaUrl: "https://x/talk.wav", trimStart: 2, fadeInDuration: 0.5, fadeOutDuration: 1 }),
                clip("next", { trackType: "audio", trackIndex: 1, startTime: 12, endTime: 14, mediaUrl: "https://x/other.wav" }),
                clip("bed", { trackType: "audio", trackIndex: 2, startTime: 0, endTime: 30, mediaUrl: "https://x/music.mp3" }),
                clip("title", { trackType: "text", trackIndex: 1, startTime: 20, endTime: 22, textContent: "End" }),
                clip("locked", { trackType: "video", trackIndex: 3, startTime: 20, endTime: 22, mediaUrl: "https://x/v.mp4" }),
            ],
            scenes: [],
            tracks: [...BASE_TRACKS, track("video", 3, { locked: true })],
        };
        const p = plan(planCuts(state, { clipId: "a" }, [{ start: 3, end: 5 }]));
        expect(p.removed).toEqual([{ start: 3, end: 5 }]);
        expect(p.removedSeconds).toBe(2);
        const byId = new Map(p.clipUpdates.map((u) => [u.clipId, u]));
        expect(byId.get("a")).toMatchObject({ startTime: 0, endTime: 3, trimStart: 2, trimEnd: 5, fadeOutDuration: 0, transitionType: "none" });
        expect(p.clipCreates).toHaveLength(1);
        expect(p.clipCreates[0]).toMatchObject({ trackType: "audio", trackIndex: 1, startTime: 3, endTime: 8, trimStart: 7, trimEnd: 12, fadeInDuration: 0, fadeOutDuration: 1, mediaUrl: "https://x/talk.wav" });
        expect(byId.get("next")).toEqual({ clipId: "next", startTime: 10, endTime: 12 });
        expect(byId.get("title")).toEqual({ clipId: "title", startTime: 18, endTime: 20 });
        expect(byId.has("bed")).toBe(false);
        expect(byId.has("locked")).toBe(false);
        expect(p.clipDeletes).toEqual([]);
    });

    it("cuts linked captions by their words and audio playing the same media", () => {
        const words = JSON.stringify([{ start: 0, end: 1, text: "one" }, { start: 1, end: 2, text: "two" }, { start: 2, end: 3, text: "three" }, { start: 3, end: 4, text: "four" }]);
        const state = {
            clips: [
                clip("v", { trackType: "video", trackIndex: 2, startTime: 0, endTime: 10, mediaUrl: "https://x/talk.mp4" }),
                clip("cap", { trackType: "text", trackIndex: 1, startTime: 2, endTime: 6, textContent: "one two three four", captionWordsJson: words }),
                clip("cap2", { trackType: "text", trackIndex: 1, startTime: 3.2, endTime: 4.8, textContent: "gone" , captionWordsJson: JSON.stringify([{ start: 0, end: 1.6, text: "gone" }]) }),
                clip("det", { trackType: "audio", trackIndex: 1, startTime: 0, endTime: 10, mediaUrl: "https://x/talk.mp4" }),
            ],
            scenes: [],
            tracks: BASE_TRACKS,
        };
        const p = plan(planCuts(state, { clipId: "v" }, [{ start: 3, end: 5 }]));
        expect(p.linked.clipIds.sort()).toEqual(["cap", "cap2", "det"]);
        const cap = p.clipUpdates.find((u) => u.clipId === "cap")!;
        expect(cap).toMatchObject({ startTime: 2, endTime: 3, textContent: "one" });
        expect(JSON.parse(cap.captionWordsJson!)).toEqual([{ start: 0, end: 1, text: "one" }]);
        const right = p.clipCreates.find((c) => c.textContent === "four")!;
        expect(right).toMatchObject({ trackType: "text", startTime: 3, endTime: 4 });
        expect(JSON.parse(right.captionWordsJson as string)).toEqual([{ start: 0, end: 1, text: "four" }]);
        expect(p.clipDeletes).toEqual(["cap2"]);
        expect(p.clipUpdates.find((u) => u.clipId === "det")).toMatchObject({ startTime: 0, endTime: 3, trimEnd: 3 });
        expect(p.clipCreates.find((c) => c.trackType === "audio")).toMatchObject({ startTime: 3, endTime: 8, trimStart: 5, trimEnd: 10 });
    });

    it("cuts a scene by its trims: the first part is the scene, later parts are copies; owned audio and later scenes follow", () => {
        const s1 = scene("s1", { cardType: "source_clip", sourceVideoUrl: "https://x/raw.mp4", videoUrl: "https://x/raw.mp4", cardConfig: JSON.stringify({ timelineTrimStart: 1, timelineTrimEnd: 11, timelineSourceDuration: 30 }), duration: 10, visualTransition: "fade", visualTransitionDuration: 0.5 });
        const s2 = scene("s2", { videoUrl: "https://x/b.mp4", duration: 4, timelinePositionSeconds: 12 });
        const owned = clip("vo", { trackType: "audio", trackIndex: 2, startTime: 0, endTime: 10, mediaUrl: "https://x/voice.wav", sceneId: "s1" });
        const p = plan(planCuts({ clips: [owned], scenes: [s1, s2], tracks: BASE_TRACKS }, { sceneId: "s1" }, [{ start: 4, end: 6 }, { start: 9.5, end: 20 }]));
        expect(p.removed).toEqual([{ start: 4, end: 6 }, { start: 9.5, end: 10 }]);
        const patch = p.scenePatches.find((x) => x.sceneId === "s1")!.patch;
        expect(JSON.parse(patch.cardConfig!)).toMatchObject({ timelineTrimStart: 1, timelineTrimEnd: 5, timelineSourceDuration: 30 });
        expect(patch).toMatchObject({ duration: 4, visualTransition: "none" });
        expect(p.sceneCopies).toHaveLength(1);
        expect(p.sceneCopies[0]).toMatchObject({ sourceSceneId: "s1", timelinePositionSeconds: 4, trackIndex: 1, patch: { duration: 3.5 } });
        expect(JSON.parse(p.sceneCopies[0].patch.cardConfig!)).toMatchObject({ timelineTrimStart: 7, timelineTrimEnd: 10.5 });
        expect(p.sceneCopies[0].patch).toMatchObject({ visualTransition: "fade", visualTransitionDuration: 0.5 });
        expect(p.sceneMoves).toEqual([{ sceneId: "s2", timelinePositionSeconds: 9.5 }]);
        expect(p.clipUpdates.find((u) => u.clipId === "vo")).toMatchObject({ startTime: 0, endTime: 4 });
        expect(p.clipCreates.find((c) => c.sceneId === "s1")).toMatchObject({ startTime: 4, endTime: 7.5, trimStart: 6, trimEnd: 9.5 });
    });

    it("refuses empty, whole-item, and malformed cuts", () => {
        const state = { clips: [clip("a", { trackType: "audio", startTime: 0, endTime: 5, mediaUrl: "u" })], scenes: [], tracks: BASE_TRACKS };
        expect(planCuts(state, { clipId: "a" }, [])).toEqual({ ok: false, error: "cuts.apply needs at least one range" });
        expect(planCuts(state, { clipId: "a" }, [{ start: 6, end: 8 }])).toEqual({ ok: false, error: "the ranges do not cover any part of the item" });
        expect(planCuts(state, { clipId: "a" }, [{ start: -1, end: 9 }])).toEqual({ ok: false, error: "the ranges cover the whole item: delete it instead" });
        expect(planCuts(state, { clipId: "a" }, [{ start: 3, end: 2 }]).ok).toBe(false);
        expect(planCuts(state, { clipId: "zz" }, [{ start: 1, end: 2 }])).toEqual({ ok: false, error: "No matching clip" });
    });
});
