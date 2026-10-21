import { describe, expect, it } from "vitest";
import { AI_TOOL_IDS, planAiTool, type AiToolPlan, type AiToolPlanResult } from "./tools";
import type { AiSnapshot } from "./sources";
import { BASE_TRACKS, clip, scene, track } from "./__fixtures__/items";
import { captionStyleJson } from "../text/captions";

const VIDEO = clip("v", { trackType: "video", trackIndex: 2, startTime: 10, endTime: 20, mediaUrl: "https://x/Interview.mp4", playbackSpeed: 2 });
const LONG_VIDEO = clip("lv", { trackType: "video", trackIndex: 2, startTime: 0, endTime: 200, mediaUrl: "https://x/long.mp4" });
const AUDIO = clip("a", { trackType: "audio", startTime: 0, endTime: 30, mediaUrl: "https://x/voice.wav", trimStart: 5, label: "Voice" });
const IMAGE = clip("img", { trackType: "video", trackIndex: 3, startTime: 0, endTime: 5, mediaUrl: "https://x/p.png", mediaType: "image" });
const SCENE = scene("s1", { cardType: "source_clip", sourceVideoUrl: "https://x/raw.mp4", cardConfig: JSON.stringify({ timelineTrimStart: 1, timelineTrimEnd: 9 }), caption: "Intro" });
const SILENT_SCENE = scene("s2", { videoUrl: "https://x/gen.mp4", trackIndex: 4 });
const captionStyle = captionStyleJson("pill");
const CAPTIONS = [
    clip("t2", { trackType: "text", trackIndex: 1, startTime: 2, endTime: 3, textContent: "Second line", textStyle: captionStyle }),
    clip("t1", { trackType: "text", trackIndex: 1, startTime: 0, endTime: 2, textContent: "สวัสดี 👋", textStyle: captionStyle }),
    clip("t0", { trackType: "text", trackIndex: 1, startTime: 4, endTime: 5, textContent: "   ", textStyle: captionStyle }),
];

const SNAP: AiSnapshot = { clips: [VIDEO, LONG_VIDEO, AUDIO, IMAGE, ...CAPTIONS], scenes: [SCENE, SILENT_SCENE], tracks: [...BASE_TRACKS, track("video", 3), track("video", 4)] };

function plan(result: AiToolPlanResult): AiToolPlan {
    if (!result.ok) throw new Error(result.error);
    return result.plan;
}

describe("planAiTool", () => {
    it("plans every tool id", () => {
        for (const id of AI_TOOL_IDS) {
            const params = id === "caption-translate" ? { clipId: "t1", language: "en" } : id === "lipsync" ? { clipId: "v", audioClipId: "a" } : { clipId: id === "voice-isolation" || id === "stems" || id === "silences" || id === "beats" || id === "fillers" || id === "captions" ? "a" : "v" };
            expect(planAiTool(SNAP, id, params).ok, id).toBe(true);
        }
        expect(planAiTool(SNAP, "nope" as never, {})).toEqual({ ok: false, error: 'Unknown AI tool "nope"' });
    });

    it("captions on a clip: the used range, the timeline offset and speed for placement, the source seconds as units", () => {
        const p = plan(planAiTool(SNAP, "captions", { clipId: "v", language: "th", engine: "cloud", style: "pill" }));
        expect(p).toEqual({
            toolId: "captions", capability: "audio.transcribe",
            input: { source: { mediaUrl: "https://x/Interview.mp4", startSeconds: 0, endSeconds: 20 }, language: "th", engine: "cloud" },
            placeAt: { kind: "captions-track", style: "pill", timeOffset: 10, timeScale: 2 },
            units: { seconds: 20 }, limit: { maxSeconds: 1800 }, target: { clipId: "v" }, label: "Auto captions · Interview.mp4",
        });
    });

    it("captions on the whole timeline", () => {
        const p = plan(planAiTool(SNAP, "captions", {}));
        expect(p.input).toEqual({ source: "timeline" });
        expect(p.placeAt).toEqual({ kind: "captions-track", style: "caption" });
        expect(p.units.seconds).toBe(200);
        expect(p.target).toEqual({});
        expect(planAiTool({ clips: [], scenes: [], tracks: [] }, "captions", {})).toEqual({ ok: false, error: "The timeline is empty" });
    });

    it("caption-translate: segments by start, characters with the 10-character overhead per line, style kept", () => {
        const p = plan(planAiTool(SNAP, "caption-translate", { clipId: "t2", language: "ja" }));
        expect(p.capability).toBe("captions.translate");
        expect(p.input).toEqual({ segments: [{ start: 0, end: 2, text: "สวัสดี 👋" }, { start: 2, end: 3, text: "Second line" }], targetLanguage: "ja" });
        // "สวัสดี 👋" is 8 code points (the emoji counts once), "Second line" 11.
        expect(p.units).toEqual({ characters: 8 + 10 + 11 + 10, segments: 2 });
        expect(p.placeAt).toEqual({ kind: "captions-track-translated", sourceTrackIndex: 1, language: "ja", keepSource: true, style: "pill" });
        expect(p.target).toEqual({ trackIndex: 1, clipId: "t2" });
        expect(p.label).toBe("Translate captions · T1 → ja");
        expect(plan(planAiTool(SNAP, "caption-translate", { trackIndex: 1, language: "pt-BR", keepSource: false })).placeAt).toMatchObject({ keepSource: false, language: "pt-BR" });
    });

    it("caption-translate: needs a valid language and a captions track; flags the server limits", () => {
        expect(planAiTool(SNAP, "caption-translate", { clipId: "t1" })).toEqual({ ok: false, error: "Choose the language to translate into" });
        expect(planAiTool(SNAP, "caption-translate", { clipId: "t1", language: "thai language" }).ok).toBe(false);
        expect(planAiTool(SNAP, "caption-translate", { clipId: "v", language: "th" })).toEqual({ ok: false, error: "Select a caption clip or a captions track" });
        expect(planAiTool(SNAP, "caption-translate", { trackIndex: 9, language: "th" })).toEqual({ ok: false, error: "No matching text track" });
        const longLine = clip("tl", { trackType: "text", trackIndex: 1, startTime: 0, endTime: 1, textContent: "x".repeat(501) });
        expect(plan(planAiTool({ ...SNAP, clips: [longLine] }, "caption-translate", { trackIndex: 1, language: "th" })).overLimit).toEqual({ kind: "characters", max: 500, actual: 501 });
        const many = Array.from({ length: 2001 }, (_, i) => clip(`m${i}`, { trackType: "text", trackIndex: 1, startTime: i, endTime: i + 1, textContent: "a" }));
        expect(plan(planAiTool({ ...SNAP, clips: many }, "caption-translate", { trackIndex: 1, language: "th" })).overLimit).toEqual({ kind: "segments", max: 2000, actual: 2001 });
        const big = Array.from({ length: 61 }, (_, i) => clip(`b${i}`, { trackType: "text", trackIndex: 1, startTime: i, endTime: i + 1, textContent: "y".repeat(500) }));
        expect(plan(planAiTool({ ...SNAP, clips: big }, "caption-translate", { trackIndex: 1, language: "th" })).overLimit).toEqual({ kind: "characters", max: 30_000, actual: 30_500 });
    });

    it("voice-isolation on a scene replaces its audio over the used range", () => {
        const p = plan(planAiTool(SNAP, "voice-isolation", { sceneId: "s1" }));
        expect(p).toEqual({
            toolId: "voice-isolation", capability: "audio.isolate-voice", input: { source: { mediaUrl: "https://x/raw.mp4", startSeconds: 1, endSeconds: 9 } },
            placeAt: { kind: "replace-audio", source: { sceneId: "s1" }, range: { startSeconds: 1, endSeconds: 9 } },
            units: { seconds: 8 }, limit: { maxSeconds: 600 }, target: { sceneId: "s1" }, label: "Isolate voice · Intro",
        });
        expect(planAiTool(SNAP, "voice-isolation", { sceneId: "s2" })).toEqual({ ok: false, error: "This scene has no audio" });
        expect(planAiTool(SNAP, "voice-isolation", { clipId: "img" }).ok).toBe(false);
        expect(planAiTool(SNAP, "voice-isolation", {})).toEqual({ ok: false, error: "Select a clip or a scene" });
    });

    it("video tools stack the result over the used range; past a limit the plan says so, maxSeconds cuts the range", () => {
        const up = plan(planAiTool(SNAP, "video-upscale", { clipId: "lv", resolution: "4k" }));
        expect(up.capability).toBe("video.upscale");
        expect(up.input).toEqual({ source: { mediaUrl: "https://x/long.mp4", startSeconds: 0, endSeconds: 200 }, resolution: "4k" });
        expect(up.units).toEqual({ seconds: 200, resolution: "4k" });
        expect(up.overLimit).toEqual({ kind: "seconds", max: 60, actual: 200 });
        const cut = plan(planAiTool(SNAP, "video-upscale", { clipId: "lv", maxSeconds: 60 }));
        expect(cut.overLimit).toBeUndefined();
        expect(cut.input).toEqual({ source: { mediaUrl: "https://x/long.mp4", startSeconds: 0, endSeconds: 60 }, resolution: "1080p" });
        expect(cut.placeAt).toEqual({ kind: "stack-video", source: { clipId: "lv" }, range: { startSeconds: 0, endSeconds: 60 } });
        expect(plan(planAiTool(SNAP, "remove-background", { clipId: "v" }))).toMatchObject({
            capability: "video.remove-background", input: { background: "transparent" }, limit: { maxSeconds: 120 }, placeAt: { kind: "stack-video" },
        });
        const stab = plan(planAiTool(SNAP, "stabilize", { clipId: "lv" }));
        expect(stab).toMatchObject({ capability: "media.stabilize", placeAt: { kind: "stack-video" } });
        expect(stab.limit).toBeUndefined();
        expect(stab.overLimit).toBeUndefined();
        expect(planAiTool(SNAP, "video-upscale", { clipId: "a" })).toEqual({ ok: false, error: "Select a video clip or scene" });
        expect(planAiTool(SNAP, "video-upscale", { clipId: "v", resolution: "8k" as never }).ok).toBe(false);
    });

    it("lipsync: units are the audio clip's used seconds; the source is muted under the result", () => {
        const p = plan(planAiTool(SNAP, "lipsync", { clipId: "v", audioClipId: "a" }));
        expect(p.input).toEqual({
            videoSource: { mediaUrl: "https://x/Interview.mp4", startSeconds: 0, endSeconds: 20 },
            audioSource: { mediaUrl: "https://x/voice.wav", startSeconds: 5, endSeconds: 35 },
        });
        expect(p.units).toEqual({ seconds: 30 });
        expect(p.placeAt).toEqual({ kind: "stack-video", source: { clipId: "v" }, range: { startSeconds: 0, endSeconds: 20 }, muteSource: true, audioClipId: "a" });
        const longAudio = clip("la", { trackType: "audio", startTime: 0, endTime: 90, mediaUrl: "https://x/l.wav" });
        expect(plan(planAiTool({ ...SNAP, clips: [...SNAP.clips, longAudio] }, "lipsync", { clipId: "v", audioClipId: "la" })).overLimit).toEqual({ kind: "seconds", max: 60, actual: 90 });
        expect(plan(planAiTool(SNAP, "lipsync", { clipId: "lv", audioClipId: "a" })).overLimit).toEqual({ kind: "seconds", max: 120, actual: 200 });
        expect(planAiTool(SNAP, "lipsync", { clipId: "v" })).toEqual({ ok: false, error: "Choose the audio clip the lips follow" });
        expect(planAiTool(SNAP, "lipsync", { clipId: "v", audioClipId: "v" })).toEqual({ ok: false, error: "Choose the audio clip the lips follow" });
    });

    it("stems split into replace-audio tracks", () => {
        const p = plan(planAiTool(SNAP, "stems", { clipId: "a", stems: "all" }));
        expect(p).toMatchObject({ capability: "audio.separate", input: { stems: "all" }, placeAt: { kind: "replace-audio", source: { clipId: "a" }, range: { startSeconds: 5, endSeconds: 35 } }, limit: { maxSeconds: 900 } });
        expect(plan(planAiTool(SNAP, "stems", { clipId: "a" })).input).toMatchObject({ stems: "vocals" });
    });

    it("local tools build the analysis command fields", () => {
        expect(plan(planAiTool(SNAP, "silences", { clipId: "a", analysisOptions: { thresholdDb: -35 } }))).toMatchObject({
            capability: "local", input: { kind: "silences", clipId: "a", options: { thresholdDb: -35 } }, units: { seconds: 30 }, label: "Remove silences · Voice",
        });
        expect(plan(planAiTool(SNAP, "beats", { sceneId: "s1" })).input).toEqual({ kind: "beats", sceneId: "s1", options: {} });
        expect(plan(planAiTool(SNAP, "fillers", { clipId: "a", language: "th" })).input).toEqual({ kind: "fillers", clipId: "a", language: "th" });
        expect(planAiTool(SNAP, "silences", { sceneId: "s2" })).toEqual({ ok: false, error: "This scene has no audio" });
    });
});
