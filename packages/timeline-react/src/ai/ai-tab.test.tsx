import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { AnalysisJob, AnalysisJobContext, AnalysisJobOutcome, MediaAnalyzerHost, SceneData, TimelineClip, TimelineTrack } from "@opennan/timeline-core";
import { optimisticTimelineClipFromInput } from "@opennan/timeline-core/lib/timeline-optimistic";
import { DEFAULT_TRANSLATE } from "../i18n/format";
import { Inspector } from "../editing/inspector/inspector";
import { createTimelineTestRuntime, renderWithTimeline, seedTimeline, type TimelineTestRuntime } from "../test-utils/render-with-timeline";
import { fakeAiHost, type FakeAiHost } from "../test-utils/fake-ai-host";
import type { TimelineAiHost } from "./ai-host";
import { requestInspectorAiTab } from "./inspector-request";
import { metUpscaleTiers } from "./ai-tab";
import { fillerRows, formatClock } from "./local-panels";
import { searchLanguages } from "./languages";

const track = (type: TimelineTrack["type"], index: number): TimelineTrack => ({ type, index, label: "", muted: false, locked: false, visible: true, volume: 1 });
const scene = (id: string, patch: Partial<SceneData> = {}): SceneData => ({
    id, order: 0, caption: id, startTime: "0", endTime: "0", startImageUrl: null, endImageUrl: null, videoUrl: null, sourceVideoUrl: `/m/${id}.mp4`,
    status: "ready", transition: "cut", cardType: "source_clip", duration: 4, frameConsistencyScore: null, audioUrl: null, audioText: null, cardConfig: null,
    timelinePositionSeconds: 0.001, trackIndex: 1, ...patch,
});
const clip = (id: string, input: Record<string, unknown>): TimelineClip => optimisticTimelineClipFromInput(input, "project-1", id);
const words = JSON.stringify([{ text: "Um", start: 0.5, end: 0.8 }, { text: "so", start: 1.2, end: 1.4 }, { text: "uh", start: 2.0, end: 2.3 }, { text: "yes", start: 2.8, end: 3.1 }]);

/** An analyzer that answers silences at 1–2 s and beats every 0.5 s (source seconds); `gate` holds it. */
function fakeAnalyzer(gate?: Promise<void>): MediaAnalyzerHost & { jobs: AnalysisJob[]; contexts: AnalysisJobContext[] } {
    const jobs: AnalysisJob[] = [];
    const contexts: AnalysisJobContext[] = [];
    return {
        jobs,
        contexts,
        async analyze(job, context): Promise<AnalysisJobOutcome> {
            jobs.push(job);
            contexts.push(context);
            context.onProgress?.(0.3);
            if (gate) await gate;
            if (context.signal?.aborted) return { cancelled: true };
            if (job.kind === "silences") return { silences: [{ start: job.startSeconds + 1, end: job.startSeconds + 2 }] };
            return { beats: { bpm: 120, times: [0.5, 1, 1.5, 2].map((t) => job.startSeconds + t) } };
        },
    };
}

interface Setup {
    select?: { clip?: string; scene?: string };
    ai?: TimelineAiHost | null;
    analyzer?: MediaAnalyzerHost | null;
    before?(runtime: TimelineTestRuntime): void;
}

async function setup({ select, ai = null, analyzer = null, before }: Setup) {
    const runtime = createTimelineTestRuntime();
    await seedTimeline(runtime, {
        tracks: [track("video", 1), track("video", 2), track("audio", 1), track("text", 1), track("sticker", 1)],
        scenes: [scene("a", { sourceWidth: 1920, sourceHeight: 1080 } as Partial<SceneData>)],
        clips: [
            clip("v", { trackType: "video", trackIndex: 2, startTime: 0, endTime: 4, mediaUrl: "/m/v.mp4", mediaType: "video", label: "Interview" }),
            clip("img", { trackType: "video", trackIndex: 2, startTime: 5, endTime: 6, mediaUrl: "/m/i.png", mediaType: "image" }),
            clip("mus", { trackType: "audio", trackIndex: 1, startTime: 0, endTime: 6, mediaUrl: "/m/song.mp3", mediaType: "audio", label: "Song" }),
            clip("txt", { trackType: "text", trackIndex: 1, startTime: 0, endTime: 4, textContent: "Um so uh yes", mediaType: "text", captionWordsJson: words }),
            clip("st", { trackType: "sticker", trackIndex: 1, startTime: 0, endTime: 2, mediaType: "image", mediaUrl: "/m/s.png" }),
        ],
    });
    const state = runtime.store.getState();
    state.setAiCutPreview(null);
    before?.(runtime);
    if (select?.clip) state.setSelectedClipIds(new Set([select.clip]));
    if (select?.scene) state.selectScene(select.scene);
    renderWithTimeline(<Inspector />, { runtime, translate: DEFAULT_TRANSLATE, ai, analyzer });
    return runtime;
}

const openAi = () => fireEvent.click(screen.getByTestId("inspector-tab-ai"));
const sections = () => screen.getAllByTestId(/^ai-section-/).map((el) => el.getAttribute("data-ai-tool"));
const clipOf = (runtime: TimelineTestRuntime, id: string) => runtime.store.getState().timelineData!.clips.find((c) => c.id === id);

describe("AI tab", () => {
    it("offers the tools that fit each item: video, audio, image, text; none for stickers", async () => {
        const runtime = await setup({ select: { clip: "v" }, ai: fakeAiHost() });
        openAi();
        expect(sections()).toEqual(["captions", "voice-isolation", "stems", "remove-background", "video-upscale", "lipsync", "stabilize", "silences", "fillers"]);
        act(() => runtime.store.getState().setSelectedClipIds(new Set(["mus"])));
        await waitFor(() => expect(screen.getByTestId("inspector-tab-ai")).toBeTruthy());
        openAi();
        expect(sections()).toEqual(["captions", "voice-isolation", "stems", "silences", "fillers", "beats"]);
        act(() => runtime.store.getState().setSelectedClipIds(new Set(["img"])));
        await waitFor(() => expect(screen.getByTestId("inspector-tab-ai")).toBeTruthy());
        openAi();
        expect(sections()).toEqual(["remove-background", "video-upscale"]);
        expect(screen.getByTestId("ai-image-hint")).toBeTruthy();
        expect(screen.getByTestId("ai-run-remove-background-reason").textContent).toBe("Works on video clips and scenes");
        act(() => runtime.store.getState().setSelectedClipIds(new Set(["txt"])));
        await waitFor(() => expect(screen.getByTestId("inspector-tab-ai")).toBeTruthy());
        openAi();
        expect(sections()).toEqual(["caption-translate"]);
        act(() => runtime.store.getState().setSelectedClipIds(new Set(["st"])));
        await waitFor(() => expect(screen.queryByTestId("inspector-tab-ai")).toBeNull());
    });

    it("runs paid tools through the host with the chosen options", async () => {
        const host = fakeAiHost({ stabilize: { state: "unavailable", reason: "Desktop app only", price: { kind: "unknown" } } });
        await setup({ select: { clip: "v" }, ai: host });
        openAi();
        expect(screen.getByTestId("ai-run-voice-isolation-run").getAttribute("aria-label")).toBe("Run, about $0.05");
        fireEvent.click(screen.getByTestId("ai-run-voice-isolation-run"));
        expect(host.run).toHaveBeenLastCalledWith("voice-isolation", { clipId: "v" });
        fireEvent.click(screen.getByTestId("ai-stems-count-all"));
        fireEvent.click(screen.getByTestId("ai-run-stems-run"));
        expect(host.run).toHaveBeenLastCalledWith("stems", { clipId: "v", stems: "all" });
        fireEvent.click(screen.getByTestId("ai-background-green"));
        fireEvent.click(screen.getByTestId("ai-run-remove-background-run"));
        expect(host.run).toHaveBeenLastCalledWith("remove-background", { clipId: "v", background: "green" });
        fireEvent.change(screen.getByTestId("ai-lipsync-audio"), { target: { value: "mus" } });
        fireEvent.click(screen.getByTestId("ai-run-lipsync-run"));
        expect(host.run).toHaveBeenLastCalledWith("lipsync", { clipId: "v", audioClipId: "mus" });
        expect(screen.getByTestId("ai-run-stabilize-reason").textContent).toBe("Desktop app only");
        expect(screen.getByTestId("ai-run-voice-isolation-billing")).toBeTruthy();
    });

    it("disables upscale tiers the scene already meets and prices the next one", async () => {
        const host = fakeAiHost();
        await setup({ select: { scene: "a" }, ai: host });
        openAi();
        const tier1080 = screen.getByTestId("ai-upscale-tier-1080p") as HTMLButtonElement;
        expect(tier1080.disabled).toBe(true);
        expect(tier1080.title).toBe("The video is already 1080p or sharper");
        expect(screen.getByTestId("ai-upscale-tier-2k").getAttribute("aria-pressed")).toBe("true");
        expect(host.tool).toHaveBeenCalledWith("video-upscale", { sceneId: "a", resolution: "2k" });
        fireEvent.click(screen.getByTestId("ai-upscale-tier-4k"));
        expect(host.tool).toHaveBeenLastCalledWith(expect.anything(), expect.anything());
        expect(host.tool).toHaveBeenCalledWith("video-upscale", { sceneId: "a", resolution: "4k" });
        expect(metUpscaleTiers({ width: 3840, height: 2160 })).toEqual(new Set(["1080p", "2k", "4k"]));
        expect(metUpscaleTiers({ width: 1080, height: 1920 })).toEqual(new Set(["1080p"]));
        expect(metUpscaleTiers(null).size).toBe(0);
    });

    it("auto captions open the host's dialog when it has one, else run", async () => {
        const openAutoCaptions = vi.fn();
        const host = fakeAiHost({}, { openAutoCaptions });
        await setup({ select: { clip: "mus" }, ai: host });
        openAi();
        fireEvent.click(screen.getByTestId("ai-run-captions-run"));
        expect(openAutoCaptions).toHaveBeenCalledWith({ clipId: "mus" });
        expect(host.run).not.toHaveBeenCalled();
    });

    it("translates a caption track: language search, keep original, the price for the track", async () => {
        const host = fakeAiHost({ "caption-translate": (params) => (params.language ? {} : { state: "unavailable", reason: "Choose the language to translate into" }) });
        await setup({ select: { clip: "txt" }, ai: host });
        openAi();
        expect(screen.getByTestId("ai-run-caption-translate-reason").textContent).toBe("Choose the language to translate into");
        fireEvent.change(screen.getByTestId("ai-translate-search"), { target: { value: "thai" } });
        const options = within(screen.getByTestId("ai-translate-language")).getAllByRole("option").map((o) => (o as HTMLOptionElement).value);
        expect(options).toEqual(["", "th"]);
        fireEvent.change(screen.getByTestId("ai-translate-language"), { target: { value: "th" } });
        fireEvent.click(screen.getByRole("switch", { name: "Keep original track" }));
        fireEvent.click(screen.getByTestId("ai-run-caption-translate-run"));
        expect(host.run).toHaveBeenLastCalledWith("caption-translate", { clipId: "txt", language: "th", keepSource: false });
        expect(searchLanguages("zh").map((l) => l.code)).toEqual(["zh-CN", "zh-TW"]);
        expect(searchLanguages("portu").map((l) => l.code)).toEqual(["pt-BR", "pt"]);
    });

    it("without a host: paid tools say they need the app, local tools still work", async () => {
        await setup({ select: { clip: "v" }, analyzer: fakeAnalyzer() });
        openAi();
        expect(screen.getByTestId("ai-no-host")).toBeTruthy();
        expect((screen.getByTestId("ai-run-voice-isolation-run") as HTMLButtonElement).disabled).toBe(true);
        expect(screen.getByTestId("ai-run-voice-isolation-reason").textContent).toBe("AI tools need the OpenNan Studio app");
        expect((screen.getByTestId("ai-silences-find") as HTMLButtonElement).disabled).toBe(false);
    });

    it("shows the jobs running on the item inline", async () => {
        const host = fakeAiHost();
        host.jobList = [
            { id: "j1", toolId: "voice-isolation", label: "Isolate voice · Interview", targetId: "v", status: "running", stage: "Isolating", progress: 0.4, cancellable: true, canRetry: false },
            { id: "j2", toolId: "stems", label: "Split vocals · Song", targetId: "mus", status: "queued", cancellable: true, canRetry: false },
        ];
        await setup({ select: { clip: "v" }, ai: host });
        openAi();
        const inline = screen.getByTestId("ai-job-tray-inline");
        expect(within(inline).getByTestId("ai-job-j1").textContent).toContain("Isolating · 40%");
        expect(within(inline).queryByTestId("ai-job-j2")).toBeNull();
    });

    it("opens on the AI tab at the tool the timeline menu asked for", async () => {
        const runtime = await setup({ ai: fakeAiHost() });
        act(() => {
            requestInspectorAiTab(runtime.store, { itemId: "a", tool: "video-upscale" });
            runtime.store.getState().selectScene("a");
        });
        await waitFor(() => expect(screen.getByTestId("inspector-panel-ai")).toBeTruthy());
        expect(screen.getByTestId("ai-section-video-upscale").getAttribute("data-focused")).toBe("true");
        // Already open on another tab: a later request switches it.
        fireEvent.click(screen.getByTestId("inspector-tab-video"));
        act(() => requestInspectorAiTab(runtime.store, { itemId: "a", tool: "silences" }));
        await waitFor(() => expect(screen.getByTestId("ai-section-silences").getAttribute("data-focused")).toBe("true"));
    });
});

describe("Remove silences", () => {
    it("finds silences on the analyzer, previews them, and removes them in one undo step", async () => {
        const analyzer = fakeAnalyzer();
        const runtime = await setup({ select: { clip: "mus" }, analyzer });
        openAi();
        fireEvent.change(within(screen.getByTestId("ai-silences-threshold")).getByRole("slider"), { target: { value: "-35" } });
        fireEvent.click(screen.getByTestId("ai-silences-find"));
        await waitFor(() => expect(screen.getByTestId("ai-silences-summary").textContent).toBe("1 silence · 1.0 s"));
        expect(analyzer.jobs[0]).toMatchObject({ kind: "silences", mediaUrl: "/m/song.mp3", options: { thresholdDb: -35, minSilence: 0.35, padding: 0.08 } });
        expect(runtime.store.getState().aiCutPreview).toEqual({ ranges: [{ start: 1, end: 2 }], kind: "silences" });
        fireEvent.click(screen.getByTestId("ai-silences-remove"));
        await waitFor(() => expect(screen.getByTestId("ai-silences-done").textContent).toBe("Removed 1.0 s. Undo brings it back."));
        // The clip is cut in two around the silence and the gap closes: 6 s of audio become 5 s.
        const audio = runtime.store.getState().timelineData!.clips.filter((c) => c.trackType === "audio");
        expect(audio.reduce((sum, c) => sum + c.endTime - c.startTime, 0)).toBeCloseTo(5);
        expect(Math.max(...audio.map((c) => c.endTime))).toBeCloseTo(5);
        expect(runtime.store.getState().aiCutPreview).toBeNull();
        expect(runtime.store.getState().canUndo).toBe(true);
    });

    it("cancels a running analysis and clears a found preview", async () => {
        let release!: () => void;
        const analyzer = fakeAnalyzer(new Promise<void>((resolve) => { release = resolve; }));
        const runtime = await setup({ select: { clip: "mus" }, analyzer });
        openAi();
        fireEvent.click(screen.getByTestId("ai-silences-find"));
        await waitFor(() => expect(screen.getByTestId("ai-silences-progress").getAttribute("aria-valuenow")).toBe("30"));
        fireEvent.click(screen.getByTestId("ai-silences-cancel"));
        expect(analyzer.contexts[0].signal?.aborted).toBe(true);
        expect(screen.getByTestId("ai-silences-find")).toBeTruthy();
        release();
        await act(async () => undefined);
        expect(screen.queryByTestId("ai-silences-summary")).toBeNull();
        fireEvent.click(screen.getByTestId("ai-silences-find"));
        await waitFor(() => expect(screen.getByTestId("ai-silences-clear")).toBeTruthy());
        fireEvent.click(screen.getByTestId("ai-silences-clear"));
        expect(runtime.store.getState().aiCutPreview).toBeNull();
    });

    it("says why when the editor has no analyzer", async () => {
        await setup({ select: { clip: "mus" }, analyzer: null });
        openAi();
        fireEvent.click(screen.getByTestId("ai-silences-find"));
        await waitFor(() => expect(screen.getByTestId("ai-silences-error").textContent).toBe("Local analysis is not available here: local analysis is turned off in this editor"));
    });
});

describe("Remove filler words", () => {
    it("lists the fillers in the caption words, previews the checked ones, and removes them", async () => {
        const runtime = await setup({ select: { clip: "v" } });
        openAi();
        fireEvent.click(screen.getByTestId("ai-fillers-find"));
        await waitFor(() => expect(screen.getByTestId("ai-fillers-summary").textContent).toBe("2 filler words found"));
        const list = screen.getByTestId("ai-fillers-list");
        expect(within(list).getAllByRole("checkbox").map((c) => (c as HTMLInputElement).checked)).toEqual([true, true]);
        expect(list.textContent).toContain("Um");
        expect(runtime.store.getState().aiCutPreview?.kind).toBe("fillers");
        expect(runtime.store.getState().aiCutPreview?.ranges).toHaveLength(2);
        fireEvent.click(screen.getByTestId("ai-fillers-row-0"));
        expect(runtime.store.getState().aiCutPreview?.ranges).toHaveLength(1);
        expect(screen.getByTestId("ai-fillers-remove").textContent).toBe("Remove 1");
        const before = clipOf(runtime, "v")!.endTime;
        fireEvent.click(screen.getByTestId("ai-fillers-remove"));
        await waitFor(() => expect(screen.getByTestId("ai-fillers-done")).toBeTruthy());
        expect(clipOf(runtime, "v")!.endTime).toBeLessThan(before);
        expect(runtime.store.getState().aiCutPreview).toBeNull();
    });

    it("explains that captions come first and offers to make them", async () => {
        const openAutoCaptions = vi.fn();
        const host: FakeAiHost = fakeAiHost({}, { openAutoCaptions });
        await setup({ select: { clip: "mus" }, ai: host, before: (runtime) => runtime.store.getState().setTimelineData({ ...runtime.store.getState().timelineData!, clips: runtime.store.getState().timelineData!.clips.filter((c) => c.id !== "txt") }) });
        openAi();
        fireEvent.click(screen.getByTestId("ai-fillers-find"));
        await waitFor(() => expect(screen.getByTestId("ai-fillers-needs-captions")).toBeTruthy());
        fireEvent.click(screen.getByTestId("ai-fillers-make-captions"));
        expect(openAutoCaptions).toHaveBeenCalledWith({ clipId: "mus" });
    });

    it("groups words into the cut ranges and formats times", () => {
        expect(fillerRows([{ start: 0.4, end: 0.9 }, { start: 1.9, end: 2.6 }], [{ text: "um", start: 0.5, end: 0.8 }, { text: "uh", start: 2, end: 2.2 }, { text: "er", start: 2.3, end: 2.5 }])).toEqual([
            { range: { start: 0.4, end: 0.9 }, words: ["um"] },
            { range: { start: 1.9, end: 2.6 }, words: ["uh", "er"] },
        ]);
        expect(formatClock(3.24)).toBe("0:03.2");
        expect(formatClock(75.06)).toBe("1:15.1");
    });
});

describe("Detect beats", () => {
    it("detects the beats of an audio clip and stores them in one step; Clear removes them", async () => {
        const runtime = await setup({ select: { clip: "mus" }, analyzer: fakeAnalyzer() });
        openAi();
        fireEvent.click(screen.getByTestId("ai-beats-detect"));
        await waitFor(() => expect(screen.getByTestId("ai-beats-summary").textContent).toBe("120 BPM · 4 beats"));
        expect(JSON.parse(clipOf(runtime, "mus")!.beatsJson!)).toEqual([0.5, 1, 1.5, 2]);
        await waitFor(() => expect(screen.getByTestId("ai-beats-clear")).toBeTruthy());
        fireEvent.click(screen.getByTestId("ai-beats-clear"));
        await waitFor(() => expect(clipOf(runtime, "mus")!.beatsJson ?? null).toBeNull());
        expect(screen.getByTestId("ai-beats-detect").textContent).toBe("Detect beats");
    });

    it("starts at once when the timeline menu asked for it", async () => {
        const analyzer = fakeAnalyzer();
        const runtime = await setup({ analyzer });
        act(() => {
            requestInspectorAiTab(runtime.store, { itemId: "mus", tool: "beats", autoStart: true });
            runtime.store.getState().setSelectedClipIds(new Set(["mus"]));
        });
        await waitFor(() => expect(screen.getByTestId("ai-beats-summary")).toBeTruthy());
        expect(analyzer.jobs).toHaveLength(1);
    });
});
