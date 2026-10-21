import { createRecordingBackend } from "../testing";
import { LocalBackend } from "../backend/local-backend";
import { createMemoryPersistence } from "../backend/persistence";
import { createEditorStore } from "../store/editor-store";
import type { AiRunContext, AiRunOutcome, AiRunRequest } from "./ai-run";
import { TimelineController } from "./timeline-controller";

const CUES = [
    { startTime: 0, endTime: 5.41, text: "And so, my fellow Americans, ask not what" },
    { startTime: 5.41, endTime: 9.04, text: "your country can do for you, ask what you" },
    { startTime: 9.04, endTime: 10.5, text: "can do for your country." },
];
const TRANSCRIPT = { language: "en", segments: CUES.map((c) => ({ start: c.startTime, end: c.endTime, text: c.text })) };

async function setup(onAiRun?: (request: AiRunRequest, context: AiRunContext) => Promise<AiRunOutcome>) {
    let n = 0;
    const local = new LocalBackend({ persistence: createMemoryPersistence(), idFactory: () => `id-${++n}` });
    const recording = createRecordingBackend(local);
    const store = createEditorStore();
    const onToast = vi.fn();
    const controller = new TimelineController({ backend: recording.backend, store, projectId: "p1", onToast, requestTimeoutMs: 1000, onAiRun });
    await controller.load();
    recording.reset();
    return { local, recording, store, onToast, controller };
}

const captions = (cues = CUES): AiRunOutcome => ({ jobId: "job-1", output: TRANSCRIPT, placement: { kind: "captions-track", style: "caption", cues } });
const RUN = { type: "ai.run", capability: "audio.transcribe", input: { language: "en" }, placeAt: { kind: "captions-track" } } as const;
const textClips = (store: ReturnType<typeof createEditorStore>) => (store.getState().timelineData?.clips ?? []).filter((c) => c.trackType === "text");
const tracks = (store: ReturnType<typeof createEditorStore>) => (store.getState().timelineData?.tracks ?? []).map((t) => `${t.type}${t.index}:${t.label}`);

describe("ai.run through onAiRun (spec §5.1.1)", () => {
    it("is unavailable without onAiRun", async () => {
        const { controller } = await setup();
        expect(await controller.execute(RUN)).toMatchObject({ ok: false, unavailable: true });
    });

    it("passes the request, the current snapshot, the caller's signal, and progress", async () => {
        const onAiRun = vi.fn(async (_request: AiRunRequest, context: AiRunContext) => {
            context.onProgress?.({ jobId: "job-1", status: "running", progress: 0.5, message: "Transcribing" });
            return { jobId: "job-1", output: TRANSCRIPT };
        });
        const { controller } = await setup(onAiRun);
        const abort = new AbortController();
        const progress = vi.fn();
        const result = await controller.execute({ type: "ai.run", capability: "audio.transcribe", input: { language: "en" } }, { signal: abort.signal, onProgress: progress });
        expect(onAiRun).toHaveBeenCalledTimes(1);
        const [request, context] = onAiRun.mock.calls[0];
        expect(request).toEqual({ capability: "audio.transcribe", input: { language: "en" }, placeAt: undefined });
        expect(context.snapshot).toEqual(controller.snapshot());
        expect(context.signal).toBe(abort.signal);
        expect(progress).toHaveBeenCalledWith({ jobId: "job-1", status: "running", progress: 0.5, message: "Transcribing" });
        expect(result).toEqual({ ok: true, changed: {}, jobId: "job-1", output: TRANSCRIPT });
    });

    it("places captions on a new Captions track as one undo step", async () => {
        const { controller, store, recording } = await setup(async () => captions());
        const before = controller.historyDepth().recorded;
        const result = await controller.execute(RUN);
        expect(result).toMatchObject({ ok: true, jobId: "job-1", output: TRANSCRIPT, changed: { tracks: true } });
        expect(result.createdClipIds).toHaveLength(3);
        expect(tracks(store)).toEqual(["video1:V1", "audio1:A1", "text1:Captions"]);
        expect(textClips(store).map((c) => [c.trackIndex, c.startTime, c.endTime, c.textContent, c.positionY])).toEqual([
            [1, 0, 5.41, CUES[0].text, 0.82], [1, 5.41, 9.04, CUES[1].text, 0.82], [1, 9.04, 10.5, CUES[2].text, 0.82],
        ]);
        expect(recording.calls.map((c) => c.method)).toEqual(["updateTracks", "createClips"]);
        expect(controller.historyDepth().recorded).toBe(before + 1);

        await controller.execute({ type: "history.undo" });
        expect(recording.callsTo("undo")[0].args).toEqual(["p1", 2]);
        expect(textClips(store)).toEqual([]);
        expect(tracks(store)).toEqual(["video1:V1", "audio1:A1"]);
        await controller.execute({ type: "history.redo" });
        expect(textClips(store)).toHaveLength(3);
        expect(tracks(store)).toContain("text1:Captions");
    });

    it("leaves existing text tracks and clips alone", async () => {
        const { controller, store } = await setup(async () => captions());
        await controller.execute({ type: "track.update", tracks: [...store.getState().timelineData!.tracks, { type: "text", index: 1, label: "Titles", muted: false, locked: false, visible: true, volume: 1 }] });
        await controller.execute({ type: "clip.create", input: { trackType: "text", trackIndex: 1, startTime: 0, endTime: 3, textContent: "Title" } });
        await controller.execute(RUN);
        expect(tracks(store)).toEqual(["video1:V1", "audio1:A1", "text1:Titles", "text2:Captions"]);
        expect(textClips(store).filter((c) => c.trackIndex === 1).map((c) => c.textContent)).toEqual(["Title"]);
        expect(textClips(store).filter((c) => c.trackIndex === 2)).toHaveLength(3);
    });

    it("plans against the timeline as it is when the job finishes", async () => {
        let finish!: (outcome: AiRunOutcome) => void;
        const { controller, store } = await setup(() => new Promise((resolve) => { finish = resolve; }));
        const pending = controller.execute(RUN);
        await controller.execute({ type: "track.update", tracks: [...store.getState().timelineData!.tracks, { type: "text", index: 1, label: "Late", muted: false, locked: false, visible: true, volume: 1 }] });
        finish(captions());
        await pending;
        expect(tracks(store)).toEqual(["video1:V1", "audio1:A1", "text1:Late", "text2:Captions"]);
    });

    it("passes cancellable through and still places a result when a refused cancel let the job finish", async () => {
        const abort = new AbortController();
        const { controller, store } = await setup(async (_request, context) => {
            abort.abort();
            context.onProgress?.({ jobId: "job-1", status: "running", progress: 0.6, cancellable: false, message: "Already running: it will finish and be charged." });
            return captions();
        });
        const progress = vi.fn();
        const result = await controller.execute(RUN, { signal: abort.signal, onProgress: progress });
        expect(progress).toHaveBeenCalledWith(expect.objectContaining({ cancellable: false }));
        expect(result).toMatchObject({ ok: true, jobId: "job-1" });
        expect(result.createdClipIds).toHaveLength(3);
        expect(textClips(store)).toHaveLength(3);
    });

    it("answers ok with no edits when the transcript has no speech", async () => {
        const { controller, recording } = await setup(async () => captions([]));
        expect(await controller.execute(RUN)).toEqual({ ok: true, changed: {}, jobId: "job-1", output: TRANSCRIPT, createdClipIds: [] });
        expect(recording.calls).toEqual([]);
    });

    it("maps cancelled, unavailable, errors, and throws without toasting guidance", async () => {
        const outcomes: Array<AiRunOutcome | Error> = [
            { jobId: "job-1", cancelled: true },
            { unavailable: true, error: "needs a provider" },
            { jobId: "job-1", error: "whisper.cpp failed" },
            new Error("handler crashed"),
        ];
        const { controller, onToast } = await setup(async () => {
            const next = outcomes.shift()!;
            if (next instanceof Error) throw next;
            return next;
        });
        expect(await controller.execute(RUN)).toEqual({ ok: false, changed: {}, jobId: "job-1", cancelled: true });
        expect(await controller.execute(RUN)).toEqual({ ok: false, changed: {}, unavailable: true, error: "needs a provider" });
        expect(onToast).not.toHaveBeenCalled();
        expect(await controller.execute(RUN)).toEqual({ ok: false, changed: {}, jobId: "job-1", error: "whisper.cpp failed" });
        expect(onToast).toHaveBeenLastCalledWith({ kind: "error", message: "Could not run the AI tool" });
        expect(await controller.execute(RUN, { toastOnError: false })).toEqual({ ok: false, changed: {}, error: "handler crashed" });
        expect(onToast).toHaveBeenCalledTimes(1);
    });

    it("rolls back the track and its backend write when creating the clips fails", async () => {
        const { controller, store, recording, local } = await setup(async () => captions());
        recording.failNext("createClips");
        const result = await controller.execute(RUN);
        expect(result.ok).toBe(false);
        expect(tracks(store)).toEqual(["video1:V1", "audio1:A1"]);
        expect(textClips(store)).toEqual([]);
        expect(recording.calls.map((c) => c.method)).toEqual(["updateTracks", "createClips", "undo"]);
        expect((await local.loadTimeline("p1")).tracks.map((t) => `${t.type}${t.index}`)).toEqual(["video1", "audio1"]);
        expect(store.getState().canUndo).toBe(false);
    });

    it("keeps the track instead of undoing another edit that wrote between the two calls", async () => {
        const { controller, store, recording, local } = await setup(async () => captions());
        await controller.execute({ type: "clip.create", input: { trackType: "audio", trackIndex: 1, startTime: 0, endTime: 1, mediaType: "audio" } });
        recording.reset();
        const release = recording.hold("createClips");
        recording.failNext("createClips");
        const run = controller.execute(RUN);
        await vi.waitFor(() => expect(recording.callsTo("createClips")).toHaveLength(1));
        const [clip] = store.getState().timelineData!.clips.filter((c) => c.trackType === "audio");
        await controller.execute({ type: "clip.update", clipIds: [clip.id], patch: { volume: 0.5 } });
        release();
        expect((await run).ok).toBe(false);
        expect(recording.callsTo("undo")).toEqual([]);
        // The audio edit stays; the empty Captions track stays in the store and the backend alike.
        expect(store.getState().timelineData!.clips.find((c) => c.id === clip.id)?.volume).toBe(0.5);
        expect(tracks(store)).toContain("text1:Captions");
        expect((await local.loadTimeline("p1")).tracks.map((t) => `${t.type}${t.index}`)).toContain("text1");
        // One undo takes back the volume edit together with the folded track write.
        await controller.execute({ type: "history.undo" });
        expect(recording.callsTo("undo").at(-1)!.args).toEqual(["p1", 2]);
    });
});
