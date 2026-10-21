// Phase 11 commands: analysis.run (host analyzer, changes nothing), analysis.fillers (pure), cuts.apply, beats.set,
// beats.autoCut (one undo step each), view.update { snapToBeats }.
import { describe, expect, it } from "vitest";
import { createRecordingBackend } from "../testing";
import { LocalBackend } from "../backend/local-backend";
import { createMemoryPersistence, type LocalProjectState } from "../backend/persistence";
import { createEditorStore } from "../store/editor-store";
import type { AnalysisJob, AnalysisJobContext, AnalysisJobOutcome, MediaAnalyzerHost } from "../analysis/host";
import { TimelineController } from "./timeline-controller";
import { clip, scene, track } from "../ai/__fixtures__/items";
import type { TimelineClip } from "../model/timeline";

const WORDS = JSON.stringify([{ start: 0, end: 0.4, text: "So" }, { start: 0.5, end: 0.8, text: "um," }, { start: 0.9, end: 1.4, text: "hello" }]);

function project(): LocalProjectState {
    return {
        meta: { id: "p1", name: "Cuts", musicUrl: null, musicVolume: 1, aspectRatio: "16:9" },
        tracks: [track("video", 1), track("video", 2), track("audio", 1), track("audio", 2), track("text", 1)],
        clips: [
            clip("talk", { trackType: "audio", trackIndex: 1, startTime: 10, endTime: 20, mediaUrl: "https://x/talk.wav", trimStart: 2, playbackSpeed: 2 }),
            clip("after", { trackType: "audio", trackIndex: 1, startTime: 22, endTime: 24, mediaUrl: "https://x/b.wav" }),
            clip("bed", { trackType: "audio", trackIndex: 2, startTime: 0, endTime: 40, mediaUrl: "https://x/bed.mp3", beatsJson: JSON.stringify(Array.from({ length: 80 }, (_, i) => i * 0.5)) }),
            clip("cap", { trackType: "text", trackIndex: 1, startTime: 30, endTime: 31.5, textContent: "So um, hello", captionWordsJson: WORDS }),
            clip("img1", { trackType: "video", trackIndex: 2, startTime: 0, endTime: 1.7, mediaUrl: "https://x/1.png", mediaType: "image" }),
            clip("img2", { trackType: "video", trackIndex: 2, startTime: 1.7, endTime: 2.9, mediaUrl: "https://x/2.png", mediaType: "image" }),
        ],
        scenes: [
            scene("s1", { cardType: "source_clip", sourceVideoUrl: "https://x/raw.mp4", videoUrl: "https://x/raw.mp4", duration: 10, timelinePositionSeconds: 30, cardConfig: JSON.stringify({ timelineTrimStart: 0, timelineTrimEnd: 10 }) }),
        ],
    };
}

async function setup(analyzer?: MediaAnalyzerHost) {
    const persistence = createMemoryPersistence();
    await persistence.saveProject("p1", project());
    let n = 0;
    const local = new LocalBackend({ persistence, idFactory: () => `id-${++n}` });
    const recording = createRecordingBackend(local);
    const store = createEditorStore();
    const onToast = vi.fn();
    const controller = new TimelineController({ backend: recording.backend, store, projectId: "p1", onToast, requestTimeoutMs: 1000, analyzer });
    await controller.load();
    recording.reset();
    const clips = () => store.getState().timelineData!.clips;
    const byId = (id: string) => clips().find((c) => c.id === id)!;
    const scenes = () => store.getState().serverScenes;
    return { local, recording, store, onToast, controller, clips, byId, scenes };
}

function analyzerReturning(outcome: AnalysisJobOutcome | ((job: AnalysisJob, context: AnalysisJobContext) => Promise<AnalysisJobOutcome>)) {
    const analyze = vi.fn(typeof outcome === "function" ? outcome : async () => outcome);
    return { analyze } satisfies MediaAnalyzerHost;
}

const sorted = (list: TimelineClip[]) => [...list].sort((a, b) => a.id.localeCompare(b.id));

describe("analysis.run", () => {
    it("is unavailable without an analyzer", async () => {
        const { controller } = await setup();
        expect(await controller.execute({ type: "analysis.run", kind: "silences", clipId: "talk" })).toMatchObject({ ok: false, unavailable: true });
    });

    it("sends the used source range and maps silences to the timeline; nothing changes", async () => {
        const analyzer = analyzerReturning(async (_job, context) => {
            context.onProgress?.(0.5);
            return { silences: [{ start: 4, end: 6 }, { start: 21, end: 30 }] };
        });
        const { controller, recording } = await setup(analyzer);
        const progress = vi.fn();
        const before = controller.historyDepth().recorded;
        const result = await controller.execute({ type: "analysis.run", kind: "silences", clipId: "talk", options: { thresholdDb: -35 } }, { onProgress: progress });
        expect(analyzer.analyze.mock.calls[0][0]).toEqual({ kind: "silences", mediaUrl: "https://x/talk.wav", startSeconds: 2, endSeconds: 22, options: { thresholdDb: -35 } });
        expect(result).toEqual({ ok: true, changed: {}, output: { kind: "silences", ranges: [{ start: 11, end: 12 }, { start: 19.5, end: 20 }], sourceRanges: [{ start: 4, end: 6 }, { start: 21, end: 22 }] } });
        expect(progress).toHaveBeenCalledWith({ jobId: "analysis", status: "running", progress: 0.5 });
        expect(recording.calls).toEqual([]);
        expect(controller.historyDepth().recorded).toBe(before);
    });

    it("maps beats to the timeline", async () => {
        const { controller } = await setup(analyzerReturning({ beats: { bpm: 120, times: [1, 2, 4, 22, 23] } }));
        expect((await controller.execute({ type: "analysis.run", kind: "beats", clipId: "talk" })).output).toEqual({ kind: "beats", bpm: 120, times: [10, 11, 20], sourceTimes: [2, 4, 22] });
    });

    it("maps cancel, unavailable, errors, and throws like tracking", async () => {
        const outcomes: Array<AnalysisJobOutcome | Error> = [{ cancelled: true }, { unavailable: true, error: "no WebCodecs" }, { error: "decode failed" }, new Error("worker crashed")];
        const { controller, onToast } = await setup(analyzerReturning(async () => {
            const next = outcomes.shift()!;
            if (next instanceof Error) throw next;
            return next;
        }));
        const run = () => controller.execute({ type: "analysis.run", kind: "beats", clipId: "talk" });
        expect(await run()).toEqual({ ok: false, changed: {}, cancelled: true });
        expect(await run()).toEqual({ ok: false, changed: {}, unavailable: true, error: "no WebCodecs" });
        expect(onToast).not.toHaveBeenCalled();
        expect(await run()).toEqual({ ok: false, changed: {}, error: "decode failed" });
        expect(onToast).toHaveBeenLastCalledWith({ kind: "error", message: "Could not analyse the audio" });
        expect(await run()).toEqual({ ok: false, changed: {}, error: "worker crashed" });
    });

    it("refuses items without sound", async () => {
        const { controller } = await setup(analyzerReturning({ silences: [] }));
        expect(await controller.execute({ type: "analysis.run", kind: "silences", clipId: "img1" })).toMatchObject({ ok: false, error: "This clip has no audio" });
    });
});

describe("analysis.fillers", () => {
    it("reads the caption words over a scene's window (clip-local → timeline)", async () => {
        const { controller } = await setup();
        const result = await controller.execute({ type: "analysis.fillers", sceneId: "s1" });
        expect(result).toEqual({ ok: true, changed: {}, output: { ranges: [{ start: 30.45, end: 30.85 }], words: [{ text: "um,", start: 30.5, end: 30.8 }], language: "en" } });
    });

    it("takes words from the command and explains when there are none", async () => {
        const { controller } = await setup();
        const result = await controller.execute({ type: "analysis.fillers", clipId: "talk", words: [{ text: "เอ่อ", start: 12, end: 12.4 }, { text: "ครับ", start: 12.5, end: 13 }], padding: 0 });
        expect(result.output).toEqual({ ranges: [{ start: 12, end: 12.4 }], words: [{ text: "เอ่อ", start: 12, end: 12.4 }], language: "th" });
        expect(await controller.execute({ type: "analysis.fillers", clipId: "talk" })).toMatchObject({ ok: false, error: "No word timings over this item: add captions with Auto captions first" });
    });
});

describe("cuts.apply", () => {
    it("ripple-deletes from a clip as one undo step; undo and redo restore exactly", async () => {
        const h = await setup();
        const before = sorted(h.clips());
        const recorded = h.controller.historyDepth().recorded;
        const result = await h.controller.execute({ type: "cuts.apply", clipId: "talk", ranges: [{ start: 12, end: 13 }, { start: 15, end: 16 }] });
        expect(result.ok, result.error).toBe(true);
        expect(result.output).toMatchObject({ removed: [{ start: 12, end: 13 }, { start: 15, end: 16 }], removedSeconds: 2 });
        expect(h.controller.historyDepth().recorded).toBe(recorded + 1);
        const parts = h.clips().filter((c) => c.mediaUrl === "https://x/talk.wav").sort((a, b) => a.startTime - b.startTime);
        expect(parts.map((c) => [c.startTime, c.endTime, c.trimStart, c.trimEnd])).toEqual([[10, 12, 2, 6], [12, 14, 8, 12], [14, 18, 14, 22]]);
        expect(h.byId("after")).toMatchObject({ startTime: 20, endTime: 22 });
        expect(h.byId("bed")).toMatchObject({ startTime: 0, endTime: 40 });
        expect(h.byId("cap")).toMatchObject({ startTime: 28, endTime: 29.5 });
        expect(h.scenes().find((s) => s.id === "s1")!.timelinePositionSeconds).toBe(28);
        await h.controller.execute({ type: "history.undo" });
        expect(sorted(h.clips())).toEqual(before);
        expect(h.scenes().find((s) => s.id === "s1")!.timelinePositionSeconds).toBe(30);
        await h.controller.execute({ type: "history.redo" });
        expect(h.clips().filter((c) => c.mediaUrl === "https://x/talk.wav")).toHaveLength(3);
    });

    it("cuts a scene into copies with its linked captions, one undo step", async () => {
        const h = await setup();
        const result = await h.controller.execute({ type: "cuts.apply", sceneId: "s1", ranges: [{ start: 30.45, end: 30.85 }] });
        expect(result.ok, result.error).toBe(true);
        const scenes = [...h.scenes()].sort((a, b) => Number(a.timelinePositionSeconds) - Number(b.timelinePositionSeconds));
        expect(scenes).toHaveLength(2);
        expect(scenes.map((s) => [s.timelinePositionSeconds, JSON.parse(s.cardConfig!).timelineTrimStart, JSON.parse(s.cardConfig!).timelineTrimEnd])).toEqual([[30, 0, 0.45], [30.45, 0.85, 10]]);
        const caps = h.clips().filter((c) => c.trackType === "text").sort((a, b) => a.startTime - b.startTime);
        expect(caps.map((c) => [c.startTime, c.endTime, c.textContent])).toEqual([[30, 30.45, "So"], [30.45, 31.1, "hello"]]);
        expect(JSON.parse(caps[1].captionWordsJson!)).toEqual([{ start: 0.05, end: 0.55, text: "hello" }]);
        await h.controller.execute({ type: "history.undo" });
        expect(h.scenes()).toHaveLength(1);
        expect(JSON.parse(h.scenes()[0].cardConfig!)).toMatchObject({ timelineTrimStart: 0, timelineTrimEnd: 10 });
        expect(h.byId("cap")).toMatchObject({ startTime: 30, endTime: 31.5, textContent: "So um, hello" });
    });

    it("rolls back every write when a later write fails", async () => {
        const h = await setup();
        const before = sorted(h.clips());
        const backendBefore = sorted((await h.local.loadTimeline("p1")).clips);
        h.recording.failNext("createClips");
        const result = await h.controller.execute({ type: "cuts.apply", clipId: "talk", ranges: [{ start: 12, end: 13 }] });
        expect(result.ok).toBe(false);
        expect(sorted(h.clips())).toEqual(before);
        expect(sorted((await h.local.loadTimeline("p1")).clips)).toEqual(backendBefore);
        expect((await h.local.loadScenes("p1"))[0].timelinePositionSeconds).toBe(30);
        expect(h.store.getState().canUndo).toBe(false);
        expect(h.onToast).toHaveBeenLastCalledWith({ kind: "error", message: "Could not cut the clip" });
    });
});

describe("beats", () => {
    it("beats.set writes beatsJson as one undo step; null clears; bad input and non-audio clips are refused", async () => {
        const h = await setup();
        expect((await h.controller.execute({ type: "beats.set", clipId: "talk", beats: [3, 1, 2] })).ok).toBe(true);
        expect(h.byId("talk").beatsJson).toBe("[1,2,3]");
        expect((await h.local.loadTimeline("p1")).clips.find((c) => c.id === "talk")!.beatsJson).toBe("[1,2,3]");
        await h.controller.execute({ type: "history.undo" });
        expect(h.byId("talk").beatsJson ?? null).toBeNull();
        await h.controller.execute({ type: "history.redo" });
        expect((await h.controller.execute({ type: "beats.set", clipId: "talk", beats: null })).ok).toBe(true);
        expect(h.byId("talk").beatsJson).toBeNull();
        expect(await h.controller.execute({ type: "beats.set", clipId: "talk", beats: [-1] })).toMatchObject({ ok: false });
        expect(await h.controller.execute({ type: "beats.set", clipId: "img1", beats: [1] })).toMatchObject({ ok: false, error: "beats belong to audio clips" });
    });

    it("beats.autoCut re-times the selection onto the beats as one undo step", async () => {
        const h = await setup();
        await h.controller.execute({ type: "selection.set", clipIds: ["img2", "img1"] });
        const recorded = h.controller.historyDepth().recorded;
        const result = await h.controller.execute({ type: "beats.autoCut" });
        expect(result.ok, result.error).toBe(true);
        expect(result.output).toMatchObject({ beatClipId: "bed", snapped: 2 });
        expect(h.controller.historyDepth().recorded).toBe(recorded + 1);
        expect([h.byId("img1").startTime, h.byId("img1").endTime, h.byId("img2").startTime, h.byId("img2").endTime]).toEqual([0, 1.5, 1.5, 2.5]);
        await h.controller.execute({ type: "history.undo" });
        expect([h.byId("img1").endTime, h.byId("img2").startTime, h.byId("img2").endTime]).toEqual([1.7, 1.7, 2.9]);
    });

    it("view.update toggles snap to beats", async () => {
        const h = await setup();
        expect(h.store.getState().snapToBeats).toBe(false);
        await h.controller.execute({ type: "view.update", snapToBeats: true });
        expect(h.store.getState().snapToBeats).toBe(true);
    });
});
