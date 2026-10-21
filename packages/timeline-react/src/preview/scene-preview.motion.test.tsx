// Scene motion in ScenePreview (phase 10b): animated, rotated, or translucent scenes get their media
// transform/opacity written per playhead tick from the motion at scene-local time; static scenes keep the
// React sceneFitStyle (old projects unchanged). Fake media and a fixed 640×360 preview host.
import { act, cleanup, waitFor } from "@testing-library/react";
import type { ComponentProps, ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ScenePreview } from "./scene-preview";
import { sceneMediaTransform, sceneMotionAt } from "./scene-motion";
import { getActiveEditorStore } from "../provider/registry";
import { renderWithTimeline } from "../test-utils/render-with-timeline";

vi.mock("../hooks/use-video-cache", () => ({ useVideoCache: () => ({ cachedUrl: (u: string | null | undefined) => u ?? undefined, preload: vi.fn(), abortPreloads: vi.fn(), isCached: () => false }) }));

type PreviewScene = NonNullable<ComponentProps<typeof ScenePreview>["scenes"]>[number];

const tracks = [
    { type: "video" as const, index: 1, label: "V1", locked: false, muted: false, visible: true, volume: 1 },
    { type: "video" as const, index: 2, label: "V2", locked: false, muted: false, visible: true, volume: 1 },
    { type: "audio" as const, index: 1, label: "A1", locked: false, muted: false, visible: true, volume: 1 },
];

const store = () => getActiveEditorStore().getState();

function scene(overrides: Partial<PreviewScene> = {}): PreviewScene {
    return {
        id: "scene-1", order: 0, startTime: "00:00:00", endTime: "00:00:04", caption: "", startImageUrl: null, endImageUrl: null,
        videoUrl: "/a.mp4", status: "completed", duration: 4, timelinePositionSeconds: 0, trackIndex: 1, fitMode: "contain",
        ...overrides,
    };
}

function renderPreview(ui: ReactElement) {
    return renderWithTimeline(ui, { translate: (_ns, key) => key });
}

/** The V1 pool's element for a scene (the gated under-scene layer renders an earlier copy of V1 scenes). */
function media(container: HTMLElement, src: string): HTMLElement {
    const all = container.querySelectorAll<HTMLElement>(`[src="${src}"]`);
    return all[all.length - 1];
}

/** The frame-sized media wrapper's size (the preview screen frame inside the 640×360 host). */
function frameOf(container: HTMLElement): { w: number; h: number } {
    const wrapper = container.querySelector<HTMLElement>("div.absolute.overflow-hidden")!;
    return { w: parseFloat(wrapper.style.width), h: parseFloat(wrapper.style.height) };
}

describe("ScenePreview scene motion", () => {
    beforeEach(() => {
        store().resetForProject();
        vi.stubGlobal("ResizeObserver", class {
            observe() {}
            disconnect() {}
        });
        // The preview host measures 640×360: a 16:9 project fills it.
        vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ x: 0, y: 0, left: 0, top: 0, right: 640, bottom: 360, width: 640, height: 360, toJSON: () => ({}) } as DOMRect);
        vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
        vi.spyOn(HTMLMediaElement.prototype, "readyState", "get").mockReturnValue(4);
        vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
        vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    });

    afterEach(() => {
        cleanup();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it("keeps a static scene on sceneFitStyle (no motion tag, no opacity write)", async () => {
        const plain = scene({ transformScale: 1.5 });
        const { container } = renderPreview(<ScenePreview scene={plain} scenes={[plain]} musicUrl={null} timelineClips={[]} timelineTracks={tracks} projectAspectRatio="16:9" />);
        await waitFor(() => expect(media(container, "/a.mp4")).toBeTruthy());
        const video = media(container, "/a.mp4");
        act(() => store().setCurrentTime(1));
        expect(video.hasAttribute("data-scene-motion")).toBe(false);
        expect(video.style.transform).toBe("translate(0px, 0px) scale(1.5)");
        expect(video.style.opacity).toBe("");
    });

    it("writes a fading, rotated scene's transform and opacity at scene-local time on every tick", async () => {
        const moving = scene({ rotationDegrees: 30, transformOffsetX: 10, animationJson: JSON.stringify({ in: { id: "fade_in", duration: 1 } }) });
        const { container } = renderPreview(<ScenePreview scene={moving} scenes={[moving]} musicUrl={null} timelineClips={[]} timelineTracks={tracks} projectAspectRatio="16:9" />);
        await waitFor(() => expect(media(container, "/a.mp4")?.getAttribute("data-scene-motion")).toBe("scene-1"));
        const video = media(container, "/a.mp4");
        const frame = frameOf(container);
        expect(frame.w).toBeGreaterThan(0);
        for (const t of [0.25, 0.5, 2]) {
            act(() => store().setCurrentTime(t));
            const expected = sceneMediaTransform(sceneMotionAt(moving, 4, t), frame);
            expect(video.style.transform).toBe(expected.transform);
            expect(video.style.opacity).toBe(expected.opacity);
        }
        expect(video.style.transform).toBe(`translate(${0.1 * frame.w}px, 0px) rotate(30deg) scale(1, 1)`);
        expect(video.style.opacity).toBe("1");
        act(() => store().setCurrentTime(0.25));
        expect(Number(video.style.opacity)).toBeGreaterThan(0);
        expect(Number(video.style.opacity)).toBeLessThan(1);
    });

    it("moves an upper-track scene by its scale keyframes", async () => {
        const base = scene({ id: "bg", videoUrl: "/bg.mp4" });
        const overlay = scene({
            id: "ov", videoUrl: "/ov.mp4", trackIndex: 2,
            keyframesJson: JSON.stringify({ keyframes: [{ time: 0, scale: 0.5 }, { time: 2, scale: 1 }] }),
        });
        const { container } = renderPreview(<ScenePreview scene={base} scenes={[base, overlay]} musicUrl={null} timelineClips={[]} timelineTracks={tracks} projectAspectRatio="16:9" />);
        act(() => store().setCurrentTime(1));
        await waitFor(() => expect(media(container, "/ov.mp4")?.getAttribute("data-scene-motion")).toBe("ov"));
        const video = media(container, "/ov.mp4");
        await waitFor(() => expect(video.style.transform).toBe("translate(0px, 0px) rotate(0deg) scale(0.75, 0.75)"));
        act(() => store().setCurrentTime(1.5));
        expect(video.style.transform).toBe("translate(0px, 0px) rotate(0deg) scale(0.875, 0.875)");
    });

    it("hands the element back to sceneFitStyle when the motion is removed", async () => {
        const moving = scene({ opacity: 0.4 });
        const props = { musicUrl: null, timelineClips: [], timelineTracks: tracks, projectAspectRatio: "16:9" };
        const view = renderPreview(<ScenePreview scene={moving} scenes={[moving]} {...props} />);
        await waitFor(() => expect(media(view.container, "/a.mp4")?.style.opacity).toBe("0.4"));
        const plain = scene({ opacity: 1 });
        await act(async () => view.rerender(<ScenePreview scene={plain} scenes={[plain]} {...props} />));
        const video = media(view.container, "/a.mp4");
        expect(video.hasAttribute("data-scene-motion")).toBe(false);
        expect(video.style.opacity).toBe("");
        expect(video.style.transform).toBe("translate(0px, 0px) scale(1)");
    });

    it("writes each tick once, without re-querying the DOM until it changes", async () => {
        const moving = scene({ rotationDegrees: 30, animationJson: JSON.stringify({ in: { id: "fade_in", duration: 1 } }) });
        const { container } = renderPreview(<ScenePreview scene={moving} scenes={[moving]} musicUrl={null} timelineClips={[]} timelineTracks={tracks} projectAspectRatio="16:9" />);
        await waitFor(() => expect(media(container, "/a.mp4")?.getAttribute("data-scene-motion")).toBe("scene-1"));
        await new Promise((resolve) => setTimeout(resolve, 50));
        const video = media(container, "/a.mp4");
        let writes = 0;
        let value = video.style.transform;
        Object.defineProperty(video.style, "transform", { configurable: true, get: () => value, set: (next: string) => { writes += 1; value = next; } });
        const query = vi.spyOn(Element.prototype, "querySelectorAll");
        const motionQueries = () => query.mock.calls.filter(([selector]) => selector === "[data-scene-motion]").length;
        for (const t of [0.2, 0.4, 0.6, 0.8]) {
            act(() => store().setCurrentTime(t));
            await new Promise((resolve) => setTimeout(resolve, 40));
        }
        expect(writes).toBe(4);
        expect(value).toBe(sceneMediaTransform(sceneMotionAt(moving, 4, 0.8), frameOf(container)).transform);
        expect(motionQueries()).toBe(0);
    });
});
