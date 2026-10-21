// Phase 11 placements: every AiPlacement kind lands as one undo step, undo restores the exact previous timeline, and a
// failed write rolls everything back.
import { describe, expect, it } from "vitest";
import { createRecordingBackend } from "../testing";
import { LocalBackend } from "../backend/local-backend";
import { createMemoryPersistence, type LocalProjectState } from "../backend/persistence";
import { createEditorStore } from "../store/editor-store";
import type { AiPlacement, AiRunOutcome } from "./ai-run";
import { TimelineController } from "./timeline-controller";
import { clip, scene, track } from "../ai/__fixtures__/items";
import { captionStyleJson } from "../text/captions";
import { timelineOwnsSceneAudioAtTime } from "../lib/preview-timeline-clips";
import { parseTimelineKeyframes } from "../lib/timeline-editing-properties";
import type { TimelineClip } from "../model/timeline";

const PILL = captionStyleJson("pill");

function project(): LocalProjectState {
    return {
        meta: { id: "p1", name: "AI", musicUrl: null, musicVolume: 1, aspectRatio: "16:9" },
        tracks: [track("video", 1), track("video", 2), track("video", 3), track("audio", 1), track("text", 1), track("text", 2)],
        clips: [
            clip("v2", {
                trackType: "video", trackIndex: 2, startTime: 10, endTime: 20, mediaUrl: "https://x/talk.mp4", playbackSpeed: 2, scale: 0.8, positionX: 0.3,
                rotationDegrees: 5, opacity: 0.9, visualFilter: "warm", filterIntensity: 0.5, maskJson: JSON.stringify({ shape: "circle", width: 0.5 }),
                keyframesJson: JSON.stringify({ keyframes: [{ time: 0, scale: 0.8, volume: 1 }, { time: 4, scale: 1 }] }),
            }),
            clip("v3", { trackType: "video", trackIndex: 3, startTime: 0, endTime: 5, mediaUrl: "https://x/logo.mp4" }),
            clip("a1", { trackType: "audio", trackIndex: 1, startTime: 0, endTime: 8, mediaUrl: "https://x/voice.wav", trimStart: 2 }),
            clip("c1", { trackType: "text", trackIndex: 1, startTime: 0, endTime: 2, textContent: "Hello", textStyle: PILL, positionY: 0.7 }),
            clip("c2", { trackType: "text", trackIndex: 1, startTime: 2, endTime: 4, textContent: "World", textStyle: PILL, positionY: 0.7 }),
            clip("t2", { trackType: "text", trackIndex: 2, startTime: 0, endTime: 4, textContent: "Title" }),
        ],
        scenes: [
            scene("s1", {
                cardType: "source_clip", sourceVideoUrl: "https://x/raw.mp4", videoUrl: "https://x/raw.mp4", duration: 10,
                cardConfig: JSON.stringify({ timelineTrimStart: 1, timelineTrimEnd: 11 }), transformScale: 1.5, transformOffsetX: 10, rotationDegrees: 3,
                sourceWidth: 1920, sourceHeight: 1080, visualFilter: "cool",
            }),
        ],
    };
}

async function setup(placement: () => AiPlacement) {
    const persistence = createMemoryPersistence();
    await persistence.saveProject("p1", project());
    let n = 0;
    const local = new LocalBackend({ persistence, idFactory: () => `id-${++n}` });
    const recording = createRecordingBackend(local);
    const store = createEditorStore();
    const onToast = vi.fn();
    const controller = new TimelineController({
        backend: recording.backend, store, projectId: "p1", onToast, requestTimeoutMs: 1000,
        onAiRun: async (): Promise<AiRunOutcome> => ({ jobId: "job", placement: placement() }),
    });
    await controller.load();
    recording.reset();
    const state = () => {
        const s = store.getState();
        return { tracks: s.timelineData!.tracks, clips: s.timelineData!.clips, scenes: s.serverScenes.map((sc) => ({ ...sc })) };
    };
    const byId = (id: string) => store.getState().timelineData!.clips.find((c) => c.id === id)!;
    const sceneById = (id: string) => store.getState().serverScenes.find((sc) => sc.id === id)!;
    const run = () => controller.execute({ type: "ai.run", capability: "x", input: {} });
    return { local, recording, store, onToast, controller, state, byId, sceneById, run };
}

const sorted = (clips: TimelineClip[]) => [...clips].sort((a, b) => a.id.localeCompare(b.id));
const tracksOf = (tracks: Array<{ type: string; index: number; label: string }>) => tracks.map((t) => `${t.type}${t.index}:${t.label}`);

async function expectOneStepAndExactUndo(h: Awaited<ReturnType<typeof setup>>, check: () => void) {
    const before = h.state();
    const recorded = h.controller.historyDepth().recorded;
    const result = await h.run();
    expect(result.ok, result.error).toBe(true);
    expect(h.controller.historyDepth().recorded).toBe(recorded + 1);
    check();
    const after = h.state();
    await h.controller.execute({ type: "history.undo" });
    expect(h.state().tracks).toEqual(before.tracks);
    expect(sorted(h.state().clips)).toEqual(sorted(before.clips));
    expect(h.state().scenes).toEqual(before.scenes);
    await h.controller.execute({ type: "history.redo" });
    expect(tracksOf(h.state().tracks)).toEqual(tracksOf(after.tracks));
    expect(h.state().clips.length).toBe(after.clips.length);
    return result;
}

describe("replace-audio", () => {
    it("puts the isolated voice on a new track over the clip's window at its speed and mutes the clip", async () => {
        const h = await setup(() => ({ kind: "replace-audio", source: { clipId: "v2" }, media: [{ url: "https://x/voice-only.wav", durationSeconds: 20 }], range: { startSeconds: 0, endSeconds: 20 } }));
        const result = await expectOneStepAndExactUndo(h, () => {
            const created = h.state().clips.filter((c) => c.mediaUrl === "https://x/voice-only.wav");
            expect(created).toHaveLength(1);
            expect(created[0]).toMatchObject({ trackType: "audio", trackIndex: 2, startTime: 10, endTime: 20, playbackSpeed: 2, trimStart: 0, volume: 1, sceneId: null });
            expect(h.state().tracks.find((t) => t.type === "audio" && t.index === 2)?.label).toBe("Voice");
            expect(h.byId("v2").volume).toBe(0);
        });
        expect(result.createdClipIds).toHaveLength(1);
    });

    it("clamps the clip to a shorter result and follows a partial range", async () => {
        const h = await setup(() => ({ kind: "replace-audio", source: { clipId: "v2" }, media: [{ url: "https://x/v.wav", durationSeconds: 7.9 }], range: { startSeconds: 2, endSeconds: 12 } }));
        await h.run();
        const created = h.state().clips.find((c) => c.mediaUrl === "https://x/v.wav")!;
        expect(created.startTime).toBe(11);
        expect(created.endTime).toBeCloseTo(14.95, 6);
    });

    it("stems on a scene: one track per stem, labelled by role, owning the scene's sound only while they play", async () => {
        const h = await setup(() => ({
            kind: "replace-audio", source: { sceneId: "s1" }, range: { startSeconds: 1, endSeconds: 11 },
            media: [{ url: "https://x/vocals.wav", role: "vocals" }, { url: "https://x/inst.wav", role: "instrumental" }],
        }));
        await expectOneStepAndExactUndo(h, () => {
            const created = h.state().clips.filter((c) => c.trackType === "audio" && c.id !== "a1");
            expect(created.map((c) => [c.trackIndex, c.startTime, c.endTime, c.sceneId])).toEqual([[2, 0, 10, "s1"], [3, 0, 10, "s1"]]);
            expect(tracksOf(h.state().tracks).filter((t) => t.startsWith("audio"))).toEqual(["audio1:A1", "audio2:Vocals", "audio3:Instrumental"]);
            expect(timelineOwnsSceneAudioAtTime("s1", h.state().clips, 5)).toBe(true);
            expect(timelineOwnsSceneAudioAtTime("s1", h.state().clips, 10.5)).toBe(false);
            expect(h.sceneById("s1").opacity ?? 1).toBe(1);
        });
        expect(timelineOwnsSceneAudioAtTime("s1", h.state().clips, 5)).toBe(true);
    });
});

describe("stack-video", () => {
    it("stacks the result directly above a V2 clip (V3 moves up), copies its look, hides it, and mutes the result", async () => {
        const h = await setup(() => ({ kind: "stack-video", source: { clipId: "v2" }, media: { url: "https://x/up.mp4", durationSeconds: 20 }, range: { startSeconds: 0, endSeconds: 20 } }));
        await expectOneStepAndExactUndo(h, () => {
            expect(tracksOf(h.state().tracks).filter((t) => t.startsWith("video"))).toEqual(["video1:V1", "video2:V2", "video3:V3", "video4:V4"]);
            expect(h.byId("v3").trackIndex).toBe(4);
            const created = h.state().clips.find((c) => c.mediaUrl === "https://x/up.mp4")!;
            expect(created).toMatchObject({
                trackType: "video", trackIndex: 3, startTime: 10, endTime: 20, playbackSpeed: 2, volume: 0, scale: 0.8, positionX: 0.3,
                rotationDegrees: 5, opacity: 0.9, visualFilter: "warm", filterIntensity: 0.5, maskJson: h.byId("v2").maskJson,
            });
            expect(parseTimelineKeyframes(created.keyframesJson)).toEqual([{ time: 0, scale: 0.8 }, { time: 4, scale: 1 }]);
            expect(h.byId("v2").opacity).toBe(0);
            expect(h.byId("v2").volume).toBe(1);
        });
    });

    it("keeps an upscaled result at the source's size when both sizes are known", async () => {
        const h = await setup(() => ({ kind: "stack-video", source: { clipId: "v2" }, media: { url: "https://x/4k.mp4", width: 3840, height: 2160 }, sourceSize: { width: 1920, height: 1080 } }));
        await h.run();
        expect(h.state().clips.find((c) => c.mediaUrl === "https://x/4k.mp4")!.scale).toBeCloseTo(0.4, 6);
    });

    it("stacks over a V1 scene in clip units, hides the scene, and lets lip sync's audio own the scene's sound", async () => {
        const h = await setup(() => ({ kind: "stack-video", source: { sceneId: "s1" }, media: { url: "https://x/lips.mp4" }, muteSource: true, audioClipId: "a1" }));
        await expectOneStepAndExactUndo(h, () => {
            expect(h.byId("v2").trackIndex).toBe(3);
            expect(h.byId("v3").trackIndex).toBe(4);
            const created = h.state().clips.find((c) => c.mediaUrl === "https://x/lips.mp4")!;
            expect(created).toMatchObject({ trackIndex: 2, startTime: 0, endTime: 10, volume: 0, rotationDegrees: 3, visualFilter: "cool" });
            // A 1920×1080 scene contained in a 16:9 frame at 1.5× is a 1.5× box; wider than the frame, it stays centred.
            expect(created.scale).toBeCloseTo(1.5, 6);
            expect(created.positionX).toBe(0.5);
            expect(h.sceneById("s1").opacity).toBe(0);
            expect(h.byId("a1").sceneId).toBe("s1");
            expect(timelineOwnsSceneAudioAtTime("s1", h.state().clips, 4)).toBe(true);
        });
    });

    it("leaves the source visible with hideSource false", async () => {
        const h = await setup(() => ({ kind: "stack-video", source: { clipId: "v2" }, media: { url: "https://x/r.mp4" }, hideSource: false }));
        await h.run();
        expect(h.byId("v2").opacity).toBe(0.9);
    });

    it("rolls every write back when creating the clip fails", async () => {
        const h = await setup(() => ({ kind: "stack-video", source: { sceneId: "s1" }, media: { url: "https://x/r.mp4" } }));
        const before = h.state();
        const backendBefore = await h.local.loadTimeline("p1");
        const scenesBefore = await h.local.loadScenes("p1");
        h.recording.failNext("createClips");
        const result = await h.run();
        expect(result.ok).toBe(false);
        expect(h.state().tracks).toEqual(before.tracks);
        expect(sorted(h.state().clips)).toEqual(sorted(before.clips));
        expect(h.sceneById("s1").opacity ?? null).toBe(before.scenes[0].opacity ?? null);
        expect((await h.local.loadTimeline("p1")).tracks).toEqual(backendBefore.tracks);
        expect(sorted((await h.local.loadTimeline("p1")).clips)).toEqual(sorted(backendBefore.clips));
        expect(await h.local.loadScenes("p1")).toEqual(scenesBefore);
        expect(h.store.getState().canUndo).toBe(false);
        expect(h.onToast).toHaveBeenCalledWith({ kind: "error", message: "Could not run the AI tool" });
    });

    it("answers an error when the source is gone", async () => {
        const h = await setup(() => ({ kind: "stack-video", source: { clipId: "missing" }, media: { url: "https://x/r.mp4" } }));
        const result = await h.run();
        expect(result).toMatchObject({ ok: false, error: "No matching clip" });
        expect(h.recording.calls).toEqual([]);
    });
});

describe("captions-track-translated", () => {
    it("adds the translation directly above the source track with the same timings and style; untranslated cues keep their text", async () => {
        const h = await setup(() => ({
            kind: "captions-track-translated", sourceTrackIndex: 1, language: "th", keepSource: true, untranslated: [1],
            cues: [{ startTime: 0, endTime: 2, text: "สวัสดี" }, { startTime: 2, endTime: 4, text: "โลก (unchanged)" }],
        }));
        await expectOneStepAndExactUndo(h, () => {
            expect(tracksOf(h.state().tracks).filter((t) => t.startsWith("text"))).toEqual(["text1:T1", "text2:Captions (th)", "text3:T3"]);
            expect(h.byId("t2").trackIndex).toBe(3);
            const created = h.state().clips.filter((c) => c.trackType === "text" && c.trackIndex === 2).sort((a, b) => a.startTime - b.startTime);
            expect(created.map((c) => [c.startTime, c.endTime, c.textContent, c.textStyle, c.positionY, c.label])).toEqual([
                [0, 2, "สวัสดี", PILL, 0.7, null], [2, 4, "World", PILL, 0.7, "Untranslated (th)"],
            ]);
            expect(h.byId("c1")).toBeDefined();
        });
    });

    it("deletes the source cues in the same step with keepSource false", async () => {
        const h = await setup(() => ({ kind: "captions-track-translated", sourceTrackIndex: 1, language: "ja", keepSource: false, cues: [{ startTime: 0, endTime: 2, text: "こんにちは" }, { startTime: 2, endTime: 4, text: "世界" }] }));
        await expectOneStepAndExactUndo(h, () => {
            expect(h.state().clips.some((c) => c.id === "c1" || c.id === "c2")).toBe(false);
            expect(h.state().clips.filter((c) => c.trackType === "text" && c.trackIndex === 2)).toHaveLength(2);
        });
    });
});

describe("insert-media", () => {
    it("puts each file on a free track of its kind at the time", async () => {
        const h = await setup(() => ({
            kind: "insert-media", at: 2,
            media: [{ url: "https://x/pic.png", mimeType: "image/png" }, { url: "https://x/clip.mp4", durationSeconds: 3 }, { url: "https://x/music.mp3", mimeType: "audio/mpeg", durationSeconds: 30 }],
        }));
        const result = await expectOneStepAndExactUndo(h, () => {
            const img = h.state().clips.find((c) => c.mediaUrl === "https://x/pic.png")!;
            const vid = h.state().clips.find((c) => c.mediaUrl === "https://x/clip.mp4")!;
            const mus = h.state().clips.find((c) => c.mediaUrl === "https://x/music.mp3")!;
            // V2 is busy at 2 s (v2 starts at 10, so V2 is free), V3 holds the logo until 5 s.
            expect([img.trackType, img.trackIndex, img.startTime, img.endTime, img.mediaType]).toEqual(["video", 2, 2, 7, "image"]);
            expect([vid.trackIndex, vid.startTime, vid.endTime, vid.mediaType]).toEqual([4, 2, 5, "video"]);
            expect([mus.trackType, mus.trackIndex, mus.startTime, mus.endTime]).toEqual(["audio", 2, 2, 32]);
        });
        expect(result.createdClipIds).toHaveLength(3);
    });
});

describe("captions-track label", () => {
    it("names the new captions track from the placement", async () => {
        const h = await setup(() => ({ kind: "captions-track", style: "caption", label: "Captions · Interview", cues: [{ startTime: 0, endTime: 1, text: "Hi" }] }));
        await h.run();
        expect(h.state().tracks.some((t) => t.label === "Captions · Interview")).toBe(true);
    });
});
