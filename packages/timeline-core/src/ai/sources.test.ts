import { describe, expect, it } from "vitest";
import { aiMediaSource, aiMediaSourceError, mediaFileName, sourceToTimeline, timelineToSource, type AiSnapshot } from "./sources";
import { BASE_TRACKS, clip, scene, track } from "./__fixtures__/items";

const snap = (fields: Partial<AiSnapshot>): AiSnapshot => ({ clips: [], scenes: [], tracks: BASE_TRACKS, ...fields });

describe("aiMediaSource: clips", () => {
    it("reads an audio clip's used range from trimStart and its speed", () => {
        const a = clip("a1", { trackType: "audio", startTime: 10, endTime: 14, mediaUrl: "https://x/files/Talk%20one.mp3", trimStart: 3, playbackSpeed: 1.5 });
        expect(aiMediaSource(snap({ clips: [a] }), { clipId: "a1" })).toEqual({
            target: { clipId: "a1" }, mediaUrl: "https://x/files/Talk%20one.mp3", startSeconds: 3, endSeconds: 9, timelineStart: 10, timelineEnd: 14,
            speed: 1.5, kind: "audio", hasAudio: true, trackType: "audio", trackIndex: 1, label: "Talk one.mp3",
        });
    });

    it("reads video clips from trimStart on every track", () => {
        const v2 = clip("v2", { trackType: "video", trackIndex: 2, startTime: 2, endTime: 6, mediaUrl: "blob:v", trimStart: 4, label: "Interview" });
        const v1 = clip("v1", { trackType: "video", trackIndex: 1, startTime: 0, endTime: 2, mediaUrl: "blob:w", trimStart: 4 });
        const s = snap({ clips: [v1, v2] });
        expect(aiMediaSource(s, { clipId: "v2" })).toMatchObject({ startSeconds: 4, endSeconds: 8, kind: "video", hasAudio: true, label: "Interview", trackIndex: 2 });
        expect(aiMediaSource(s, { clipId: "v1" })).toMatchObject({ startSeconds: 4, endSeconds: 6 });
    });

    it("treats image clips as images from 0", () => {
        const img = clip("i1", { trackType: "video", trackIndex: 2, startTime: 1, endTime: 4, mediaUrl: "https://x/a.png", mediaType: "image" });
        expect(aiMediaSource(snap({ clips: [img] }), { clipId: "i1" })).toMatchObject({ kind: "image", hasAudio: false, startSeconds: 0, endSeconds: 3, speed: 1 });
    });

    it("refuses curves, legacy ramps, reverse, freeze, placeholders, text, temp ids, and locked tracks with a reason", () => {
        const base = { trackType: "video", trackIndex: 2, startTime: 0, endTime: 2, mediaUrl: "blob:v" } as const;
        const cases: Array<[ReturnType<typeof clip>, RegExp, AiSnapshot["tracks"]?]> = [
            [clip("c", { ...base, speedCurveJson: JSON.stringify({ id: "custom", points: [[0, 1], [1, 2]] }) }), /speed curves/i],
            [clip("c", { ...base, speedRamp: "montage" }), /speed curves/i],
            [clip("c", { ...base, reversePlayback: true }), /reversed/i],
            [clip("c", { ...base, freezeFrame: true }), /frozen/i],
            [clip("c", { ...base, mediaUrl: null, mediaType: "ai_generate" }), /no media yet/i],
            [clip("c", { trackType: "text", startTime: 0, endTime: 1, textContent: "hi" }), /video, audio, or image/i],
            [clip("temp-1", { ...base }), /still being created/i],
            [clip("c", { ...base }), /locked/i, [track("video", 2, { locked: true })]],
            [clip("c", { ...base, locked: true }), /locked/i],
        ];
        for (const [c, reason, tracks] of cases) {
            const s = snap({ clips: [c], ...(tracks ? { tracks } : {}) });
            expect(aiMediaSource(s, { clipId: c.id })).toBeNull();
            expect(aiMediaSourceError(s, { clipId: c.id })).toMatch(reason);
        }
        expect(aiMediaSourceError(snap({}), { clipId: "nope" })).toBe("No matching clip");
        expect(aiMediaSourceError(snap({}), {})).toBe("Select a clip or a scene");
    });
});

describe("aiMediaSource: scenes", () => {
    it("reads a trimmed source-clip scene: footage URL, trims, speed, window, size", () => {
        const first = scene("s0", { duration: 4, videoUrl: "https://x/gen.mp4" });
        const s1 = scene("s1", {
            cardType: "source_clip", sourceVideoUrl: "https://x/raw.mov", videoUrl: "https://x/raw.mov", caption: "Opening",
            cardConfig: JSON.stringify({ timelineTrimStart: 2, timelineTrimEnd: 8 }), playbackSpeed: 2, sourceWidth: 1920, sourceHeight: 1080,
        });
        expect(aiMediaSource(snap({ scenes: [first, s1] }), { sceneId: "s1" })).toEqual({
            target: { sceneId: "s1" }, mediaUrl: "https://x/raw.mov", startSeconds: 2, endSeconds: 8, timelineStart: 4, timelineEnd: 7,
            speed: 2, kind: "video", hasAudio: true, width: 1920, height: 1080, trackType: "video", trackIndex: 1, label: "Opening",
        });
    });

    it("prefers the source footage of a source clip, the generated video otherwise; generated video has no audio unless made with it", () => {
        const a = scene("a", { cardType: "source_clip", sourceVideoUrl: "https://x/raw.mp4", videoUrl: null });
        const b = scene("b", { videoUrl: "https://x/gen.mp4", trackIndex: 2 });
        const c = scene("c", { videoUrl: "https://x/gen2.mp4", trackIndex: 3, autoGenerateAudio: true } as never);
        const s = snap({ scenes: [a, b, c] });
        expect(aiMediaSource(s, { sceneId: "a" })).toMatchObject({ mediaUrl: "https://x/raw.mp4", hasAudio: true });
        expect(aiMediaSource(s, { sceneId: "b" })).toMatchObject({ mediaUrl: "https://x/gen.mp4", hasAudio: false, trackIndex: 2, label: "gen.mp4" });
        expect(aiMediaSource(s, { sceneId: "c" })).toMatchObject({ hasAudio: true });
    });

    it("treats image-only scenes as images", () => {
        const s = scene("s", { startImageUrl: "https://x/still.png", duration: 3 });
        expect(aiMediaSource(snap({ scenes: [s] }), { sceneId: "s" })).toMatchObject({ kind: "image", mediaUrl: "https://x/still.png", startSeconds: 0, endSeconds: 3, hasAudio: false });
    });

    it("refuses shot-sequenced scenes, copy-video storyboards, curves, placeholders, and locked tracks", () => {
        const shots = JSON.stringify([{ duration: 2, video_url: "https://x/1.mp4" }, { duration: 2, video_url: "https://x/2.mp4" }]);
        const cases: Array<[ReturnType<typeof scene>, RegExp, AiSnapshot["tracks"]?]> = [
            [scene("s", { shotBreakdown: shots }), /storyboard/i],
            [scene("s", { cardType: "copy_video", startImageUrl: "https://x/p.png" }), /storyboard/i],
            [scene("s", { videoUrl: "https://x/v.mp4", speedCurveJson: JSON.stringify({ id: "custom", points: [[0, 1], [1, 3]] }) }), /speed curves/i],
            [scene("s", {}), /no media yet/i],
            [scene("s", { videoUrl: "https://x/v.mp4" }), /locked/i, [track("video", 1, { locked: true })]],
        ];
        for (const [sc, reason, tracks] of cases) {
            expect(aiMediaSourceError(snap({ scenes: [sc], ...(tracks ? { tracks } : {}) }), { sceneId: "s" })).toMatch(reason);
        }
        expect(aiMediaSourceError(snap({}), { sceneId: "x" })).toBe("No matching scene");
    });
});

describe("time mapping helpers", () => {
    it("maps source seconds to the timeline through the speed and back", () => {
        const source = { startSeconds: 3, timelineStart: 10, speed: 2 };
        expect(sourceToTimeline(source, 7)).toBe(12);
        expect(timelineToSource(source, 12)).toBe(7);
    });

    it("names media files from URLs", () => {
        expect(mediaFileName("https://x/a/My%20Clip.mp4?sig=1")).toBe("My Clip.mp4");
        expect(mediaFileName(null)).toBe("");
    });
});
