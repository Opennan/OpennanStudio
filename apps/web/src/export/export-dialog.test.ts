// The export dialog's cancel and error states, with the export session replaced: a running export stops
// only through Cancel (Escape and the backdrop would throw away minutes of work), and a failed
// export shows the session's message and the last ffmpeg log lines.
import { act, createElement, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ExportSessionState } from "@opennan/export";
import { ExportDialog } from "./export-dialog";
import type { ExportPlatform, PlatformExporter } from "../platform/export-platform";
import { StudioRuntimeProvider } from "../platform/runtime-context";
import type { StudioRuntime } from "../platform/runtime-types";
import type { LocalExport } from "./use-local-export";

const timeline = vi.hoisted(() => ({ scenes: [] as unknown[], tracks: [] as unknown[] }));

vi.mock("@opennan/timeline-react", () => {
    const state = { projectMeta: { name: "Trip", aspectRatio: "16:9" }, timelineData: { clips: [], tracks: [] } };
    const snapshot = { projectId: "p", project: { id: "p", name: "Trip", aspectRatio: "16:9" }, tracks: timeline.tracks, clips: [], scenes: timeline.scenes };
    // Stable instances, as the real hooks return.
    const runtime = { backend: {}, projectId: "p" };
    const controller = { snapshot: () => snapshot };
    return {
        useEditorStore: (select: (s: typeof state) => unknown) => select(state),
        useTimelineBackend: () => runtime,
        useTimelineController: () => controller,
    };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
let host: HTMLElement | null = null;

type FakeExporter = PlatformExporter & { session: PlatformExporter["session"] & { start: ReturnType<typeof vi.fn> } };

let platform: ExportPlatform = {
    resolutions: ["720p", "1080p"], formatLabel: "MP4 (test)", resolutionNote: "4K needs the desktop app", gl: false,
    createExporter: () => { throw new Error("not used"); },
};

function fakeExporter(onStart: (set: (next: ExportSessionState) => void) => void): FakeExporter {
    let state: ExportSessionState = { status: "idle" };
    const listeners = new Set<() => void>();
    const set = (next: ExportSessionState) => {
        state = next;
        listeners.forEach((listener) => listener());
    };
    const session = {
        getState: () => state,
        subscribe: (listener: () => void) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        start: vi.fn(async () => {
            onStart(set);
            return state;
        }),
        cancel: vi.fn(() => set({ status: "cancelled" })),
        reset: vi.fn(() => set({ status: "idle" })),
    };
    return {
        session,
        start: vi.fn(async () => {
            await session.start();
        }),
        commandHandler: vi.fn(),
        deliver: vi.fn(async () => ({ fileName: "trip.mp4", size: 1 })),
        dispose: vi.fn(),
    } as unknown as FakeExporter;
}

function Harness({ exporter, onClose }: { exporter: FakeExporter; onClose(): void }) {
    const state = useSyncExternalStore(exporter.session.subscribe, exporter.session.getState);
    const local: LocalExport = { exporter, state };
    return createElement(StudioRuntimeProvider, { runtime: { exportPlatform: platform } as StudioRuntime, children: createElement(ExportDialog, { onClose, local }) });
}

function renderDialog(exporter: FakeExporter, onClose: () => void) {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    act(() => root!.render(createElement(Harness, { exporter, onClose })));
}

function button(name: string): HTMLButtonElement {
    const found = [...document.querySelectorAll("button")].find((b) => b.textContent === name);
    if (!found) throw new Error(`no button ${name}`);
    return found;
}

const pressEscape = () => act(() => void window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
const backdropMouseDown = () =>
    act(() => void document.querySelector(".dialog-backdrop")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));

afterEach(() => {
    timeline.scenes.length = 0;
    timeline.tracks.length = 0;
    act(() => root?.unmount());
    host?.remove();
    root = null;
    host = null;
});

test("while an export runs, Escape and the backdrop leave it running; Cancel cancels it and closes", async () => {
    const exporter = fakeExporter((set) => set({ status: "running", progress: { phase: "encode", ratio: 0.25 } }));
    const onClose = vi.fn();
    renderDialog(exporter, onClose);
    await act(async () => button("Export MP4").click());
    expect(exporter.session.start).toHaveBeenCalledTimes(1);
    expect(document.querySelector('progress[aria-label="Export progress"]')).not.toBeNull();

    pressEscape();
    backdropMouseDown();
    expect(onClose).not.toHaveBeenCalled();
    expect(exporter.session.cancel).not.toHaveBeenCalled();

    await act(async () => button("Cancel").click());
    expect(exporter.session.cancel).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
});

test("the size line shows the platform's resolutions, format, and note", () => {
    renderDialog(fakeExporter(() => undefined), vi.fn());
    expect(document.body.textContent).toContain("1280 × 720 · MP4 (test) · 30 fps · 4K needs the desktop app");
    expect([...document.querySelectorAll('input[name="export-quality"]')]).toHaveLength(2);
});

test("when no export runs, Escape and the backdrop close the dialog", () => {
    const onClose = vi.fn();
    renderDialog(fakeExporter(() => undefined), onClose);
    pressEscape();
    backdropMouseDown();
    expect(onClose).toHaveBeenCalledTimes(2);
});

test("a failed export shows the message and the last six ffmpeg log lines, and can be retried", async () => {
    const log = Array.from({ length: 9 }, (_, i) => `line ${i + 1}`);
    const exporter = fakeExporter((set) => set({ status: "error", code: "ffmpeg-failed", message: "ffmpeg.wasm could not render the export.", detail: log.join("\n") }));
    renderDialog(exporter, vi.fn());
    await act(async () => button("Export MP4").click());

    const alert = document.querySelector('[role="alert"]');
    expect(alert?.querySelector(".error-text")?.textContent).toBe("ffmpeg.wasm could not render the export.");
    expect(alert?.querySelector(".export-log")?.textContent).toBe(log.slice(-6).join("\n"));
    expect(button("Export MP4").disabled).toBe(false);
    expect(button("Close")).toBeTruthy();
});

test("long animated effects show the slow-export warning on a platform without native speed", async () => {
    const glitch = (i: number) => ({ id: `e${i}`, clipId: null, sceneId: `s${i}`, effectId: "fx_glitch", order: 0, paramsJson: null, enabled: true, ownerScope: "project" });
    timeline.tracks.push({ type: "video", index: 1, label: "", muted: false, locked: false, visible: true, volume: 1 });
    for (let i = 0; i < 6; i += 1) {
        timeline.scenes.push({
            id: `s${i}`, order: i, caption: "", startTime: "0", endTime: "0", startImageUrl: null, endImageUrl: null, videoUrl: null, sourceVideoUrl: `/m/s${i}.webm`,
            status: "ready", transition: "cut", cardType: "source_clip", duration: 4, frameConsistencyScore: null, audioUrl: null, audioText: null, cardConfig: null,
            timelinePositionSeconds: i * 4 || 0.001, effects: [glitch(i)],
        });
    }
    const saved = platform;
    try {
        platform = { ...saved, nativeSpeed: false };
        renderDialog(fakeExporter(() => undefined), vi.fn());
        await act(async () => undefined);
        expect(document.body.textContent).toContain("Animated effects cover about 24 s");
        expect(document.body.textContent).toContain("desktop app exports them much faster");
        act(() => root?.unmount());
        host?.remove();

        platform = { ...saved, gl: true };
        renderDialog(fakeExporter(() => undefined), vi.fn());
        await act(async () => undefined);
        expect(document.body.textContent).not.toContain("Animated effects cover");
    } finally {
        platform = saved;
    }
});

test("the engine line names the fast GPU export, and the slow-export warning only shows for the compatible one (phase 10c)", async () => {
    const glitch = { id: "e0", clipId: null, sceneId: "s0", effectId: "fx_glitch", order: 0, paramsJson: null, enabled: true, ownerScope: "project" };
    timeline.tracks.push({ type: "video", index: 1, label: "", muted: false, locked: false, visible: true, volume: 1 });
    timeline.scenes.push({
        id: "s0", order: 0, caption: "", startTime: "0", endTime: "0", startImageUrl: null, endImageUrl: null, videoUrl: null, sourceVideoUrl: "/m/s0.webm",
        status: "ready", transition: "cut", cardType: "source_clip", duration: 30, frameConsistencyScore: null, audioUrl: null, audioText: null, cardConfig: null,
        timelinePositionSeconds: 0.001, effects: [glitch],
    });
    const saved = platform;
    try {
        platform = { ...saved, nativeSpeed: false };
        const fast = fakeExporter(() => undefined);
        (fast as { engine?: unknown }).engine = vi.fn(async () => ({ engine: "gpu", formatLabel: "MP4 (H.264, AAC)", nativeSpeed: true, gl: false }));
        renderDialog(fast, vi.fn());
        await act(async () => undefined);
        expect(document.querySelector(".export-engine")?.textContent).toBe("Fast export (GPU)");
        expect(document.body.textContent).toContain("1280 × 720 · MP4 (H.264, AAC) · 30 fps");
        expect(document.body.textContent).not.toContain("Animated effects cover");
        act(() => root?.unmount());
        host?.remove();

        const slow = fakeExporter(() => undefined);
        (slow as { engine?: unknown }).engine = vi.fn(async () => ({ engine: "ffmpeg", formatLabel: "MP4 (test)", reason: "a clip uses chroma key", nativeSpeed: false, gl: false }));
        renderDialog(slow, vi.fn());
        await act(async () => undefined);
        expect(document.querySelector(".export-engine")?.textContent).toBe("Compatible export · a clip uses chroma key");
        expect(document.body.textContent).toContain("Animated effects cover about 30 s");
    } finally {
        platform = saved;
    }
});

test("progress shows the phase, percent, and time left", async () => {
    const exporter = fakeExporter((set) => set({ status: "running", progress: { phase: "render", ratio: 0.5, etaSeconds: 95, engine: "gpu" } }));
    renderDialog(exporter, vi.fn());
    await act(async () => button("Export MP4").click());
    expect(document.querySelector(".export-progress")?.textContent).toContain("Rendering 50% · about 2 min left");
});

test("formatTimeLeft", async () => {
    const { formatTimeLeft } = await import("./export-dialog");
    expect(formatTimeLeft(undefined)).toBeNull();
    expect(formatTimeLeft(0.2)).toBe("1 s left");
    expect(formatTimeLeft(42)).toBe("42 s left");
    expect(formatTimeLeft(150)).toBe("about 3 min left");
    expect(formatTimeLeft(3900)).toBe("about 1 h 5 min left");
});

test("the GIF format (phase 10d): its size line, its button, and the format passed to the exporter", async () => {
    const exporter = fakeExporter(() => undefined);
    const previous = platform;
    platform = { ...platform, formats: ["video", "gif"] };
    try {
        renderDialog(exporter, vi.fn());
        const gif = [...document.querySelectorAll<HTMLInputElement>('input[name="export-format"]')];
        expect(gif.map((input) => input.parentElement?.textContent)).toEqual(["MP4", "GIF"]);
        await act(async () => gif[1].click());
        expect(document.body.textContent).toContain("640 × 360 · GIF (no audio, loops) · 15 fps");
        await act(async () => button("Export GIF").click());
        expect(exporter.start).toHaveBeenCalledWith(expect.objectContaining({ resolution: "720p", format: "gif" }));
    } finally {
        platform = previous;
    }
});

test("a platform without GIF shows no format picker", () => {
    renderDialog(fakeExporter(() => undefined), vi.fn());
    expect(document.querySelectorAll('input[name="export-format"]')).toHaveLength(0);
});
