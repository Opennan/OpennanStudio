import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import type { SceneData, TimelineClip, TimelineTrack } from "@opennan/timeline-core";
import { optimisticTimelineClipFromInput } from "@opennan/timeline-core/lib/timeline-optimistic";
import { DEFAULT_TRANSLATE } from "../i18n/format";
import { Inspector } from "../editing/inspector/inspector";
import { createTimelineTestRuntime, renderWithTimeline, seedTimeline, type TimelineTestRuntime } from "../test-utils/render-with-timeline";
import { fakeAiHost } from "../test-utils/fake-ai-host";
import type { TimelineAiHost } from "./ai-host";
import { AiMenuRows, type AiMenuRowsProps } from "./ai-menu-rows";
import { peekInspectorAiRequest } from "./inspector-request";

const track = (type: TimelineTrack["type"], index: number): TimelineTrack => ({ type, index, label: "", muted: false, locked: false, visible: true, volume: 1 });
const clip = (id: string, input: Record<string, unknown>): TimelineClip => optimisticTimelineClipFromInput(input, "project-1", id);
const scene = (id: string, patch: Partial<SceneData> = {}): SceneData => ({
    id, order: 0, caption: id, startTime: "0", endTime: "0", startImageUrl: null, endImageUrl: null, videoUrl: null, sourceVideoUrl: `/m/${id}.mp4`,
    status: "ready", transition: "cut", cardType: "source_clip", duration: 4, frameConsistencyScore: null, audioUrl: null, audioText: null, cardConfig: null,
    timelinePositionSeconds: 0.001, trackIndex: 1, ...patch,
});

async function seeded(options: { beats?: boolean } = {}): Promise<TimelineTestRuntime> {
    const runtime = createTimelineTestRuntime();
    await seedTimeline(runtime, {
        tracks: [track("video", 1), track("video", 2), track("audio", 1), track("text", 1)],
        scenes: [scene("s1", { cardType: "ai_video", sourceVideoUrl: null, videoUrl: "/m/gen.mp4" })],
        clips: [
            clip("v1", { trackType: "video", trackIndex: 2, startTime: 0, endTime: 1.7, mediaUrl: "/m/a.mp4", mediaType: "video" }),
            clip("v2", { trackType: "video", trackIndex: 2, startTime: 1.7, endTime: 3.4, mediaUrl: "/m/b.mp4", mediaType: "video" }),
            clip("img", { trackType: "video", trackIndex: 2, startTime: 5, endTime: 6, mediaUrl: "/m/i.png", mediaType: "image" }),
            clip("mus", { trackType: "audio", trackIndex: 1, startTime: 0, endTime: 8, mediaUrl: "/m/song.mp3", mediaType: "audio", ...(options.beats ? { beatsJson: JSON.stringify([0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4]) } : {}) }),
            clip("txt", { trackType: "text", trackIndex: 1, startTime: 0, endTime: 2, textContent: "Hello", mediaType: "text" }),
        ],
    });
    runtime.store.getState().setSelection({});
    return runtime;
}

function menu(runtime: TimelineTestRuntime, props: Omit<AiMenuRowsProps, "onClose">, ai: TimelineAiHost | null = null) {
    const onClose = vi.fn();
    renderWithTimeline(<AiMenuRows {...props} onClose={onClose} />, { runtime, translate: DEFAULT_TRANSLATE, ai });
    return onClose;
}

const row = (tool: string) => screen.getByTestId(`ctx-ai-${tool}`) as HTMLButtonElement;
const labels = () => screen.getAllByTestId(/^ctx-ai-(?!group)/).map((el) => el.textContent);

describe("AI menu rows", () => {
    it("lists the tools of a video clip with their prices on the right", async () => {
        const runtime = await seeded();
        const host = fakeAiHost({ stabilize: { state: "unavailable", reason: "Desktop app only", price: { kind: "unknown" } }, stems: { price: { kind: "billed-elsewhere", by: "fal.ai" } } });
        menu(runtime, { target: { clipId: "v1" }, kind: "video" }, host);
        expect(screen.getByRole("group", { name: "AI" })).toBeTruthy();
        expect(labels()).toEqual([
            "Auto captions≈ $0.05", "Isolate voice≈ $0.05", "Split vocalsfal.ai", "Remove background≈ $0.05", "Upscale…≈ $0.05", "Stabilize",
            "Remove silences…Free", "Remove filler words…Free",
        ]);
        expect(row("stabilize").disabled).toBe(true);
        expect(row("stabilize").title).toBe("Desktop app only");
        expect(row("stabilize").getAttribute("aria-description")).toBe("Desktop app only");
    });

    it("runs direct rows through the host and closes the menu", async () => {
        const runtime = await seeded();
        const host = fakeAiHost();
        const onClose = menu(runtime, { target: { clipId: "v1" }, kind: "video" }, host);
        fireEvent.click(row("remove-background"));
        expect(host.run).toHaveBeenLastCalledWith("remove-background", { clipId: "v1", background: "transparent" });
        fireEvent.click(row("stems"));
        expect(host.run).toHaveBeenLastCalledWith("stems", { clipId: "v1", stems: "vocals" });
        fireEvent.click(row("captions"));
        expect(host.run).toHaveBeenLastCalledWith("captions", { clipId: "v1" });
        expect(onClose).toHaveBeenCalledTimes(3);
    });

    it("rows that need a choice select the item and ask the inspector for the AI tab", async () => {
        const runtime = await seeded();
        const host = fakeAiHost({ "video-upscale": { state: "over-limit", limit: { maxSeconds: 60 } } });
        menu(runtime, { target: { sceneId: "s1" }, kind: "scene" }, host);
        fireEvent.click(row("video-upscale"));
        expect(runtime.store.getState().selectedSceneId).toBe("s1");
        expect(peekInspectorAiRequest(runtime.store, "s1")).toMatchObject({ itemId: "s1", tool: "video-upscale" });
        expect(host.run).not.toHaveBeenCalled();
        // A scene made without sound has nothing for the local audio tools.
        expect(row("silences").disabled).toBe(true);
        expect(row("silences").title).toBe("This scene has no audio");
    });

    it("audio clips: Detect beats opens the tab and starts; image clips explain the video tools", async () => {
        const runtime = await seeded();
        menu(runtime, { target: { clipId: "mus" }, kind: "audio" }, fakeAiHost());
        expect(labels()).toEqual(["Auto captions≈ $0.05", "Isolate voice≈ $0.05", "Split vocals≈ $0.05", "Remove silences…Free", "Remove filler words…Free", "Detect beatsFree"]);
        fireEvent.click(row("beats"));
        expect(peekInspectorAiRequest(runtime.store, "mus")).toMatchObject({ tool: "beats", autoStart: true });
        expect([...runtime.store.getState().selectedClipIds]).toEqual(["mus"]);
    });

    it("image clips and caption clips get their own rows", async () => {
        const runtime = await seeded();
        menu(runtime, { target: { clipId: "img" }, kind: "image" }, fakeAiHost());
        expect(row("remove-background").disabled).toBe(true);
        expect(row("remove-background").title).toBe("Works on video clips and scenes");
    });

    it("caption clips offer Translate captions…, which opens the tab", async () => {
        const runtime = await seeded();
        menu(runtime, { target: { clipId: "txt" }, kind: "text" }, fakeAiHost({ "caption-translate": { state: "unavailable", reason: "Choose the language to translate into" } }));
        expect(labels()).toEqual(["Translate captions…"]);
        expect(row("caption-translate").disabled).toBe(false);
        fireEvent.click(row("caption-translate"));
        expect(peekInspectorAiRequest(runtime.store, "txt")).toMatchObject({ tool: "caption-translate" });
    });

    it("without a host, paid rows need the app and local rows still work", async () => {
        const runtime = await seeded();
        menu(runtime, { target: { clipId: "v1" }, kind: "video" });
        expect(row("voice-isolation").disabled).toBe(true);
        expect(row("voice-isolation").title).toBe("AI tools need the OpenNan Studio app");
        expect(row("silences").disabled).toBe(false);
    });

    it("Auto cut to beat for a multi-selection: disabled until an audio clip has beats, then one beats.autoCut", async () => {
        const runtime = await seeded();
        act(() => runtime.store.getState().setSelectedClipIds(new Set(["v1", "v2"])));
        const view = renderWithTimeline(<AiMenuRows target={{ clipId: "v1" }} kind="video" onClose={vi.fn()} />, { runtime, translate: DEFAULT_TRANSLATE });
        expect(row("auto-cut").disabled).toBe(true);
        expect(row("auto-cut").title).toBe("Detect beats on an audio clip first");
        view.unmount();
        const withBeats = await seeded({ beats: true });
        act(() => withBeats.store.getState().setSelectedClipIds(new Set(["v1", "v2"])));
        menu(withBeats, { target: { clipId: "v1" }, kind: "video" });
        expect(row("auto-cut").disabled).toBe(false);
        fireEvent.click(row("auto-cut"));
        await waitFor(() => expect(withBeats.store.getState().timelineData!.clips.find((c) => c.id === "v1")!.endTime).toBe(1.5));
    });
});

describe("Group inspector: Auto cut to beat", () => {
    it("cuts the selected clips to the beat in one step, or says to detect beats first", async () => {
        const runtime = await seeded();
        act(() => runtime.store.getState().setSelectedClipIds(new Set(["v1", "v2"])));
        const view = renderWithTimeline(<Inspector />, { runtime, translate: DEFAULT_TRANSLATE });
        expect((screen.getByTestId("ai-auto-cut-run") as HTMLButtonElement).disabled).toBe(true);
        expect(screen.getByTestId("ai-auto-cut-reason").textContent).toBe("Detect beats on an audio clip first");
        view.unmount();
        const withBeats = await seeded({ beats: true });
        act(() => withBeats.store.getState().setSelectedClipIds(new Set(["v1", "v2"])));
        renderWithTimeline(<Inspector />, { runtime: withBeats, translate: DEFAULT_TRANSLATE });
        fireEvent.click(screen.getByTestId("ai-auto-cut-run"));
        await waitFor(() => expect(screen.getByTestId("ai-auto-cut-status").textContent).toMatch(/on the beat\.$/));
        expect(withBeats.store.getState().canUndo).toBe(true);
    });
});
