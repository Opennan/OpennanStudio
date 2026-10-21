import { act, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWithTimeline } from "../test-utils/render-with-timeline";
import { getActiveEditorStore } from "../provider/registry";
import type { LaneRange, LaneScene } from "./lane-look-plan";
import { applyAffine } from "./scene-motion";

// A stand-in renderer: every stage returns a token, presentRegion() draws nothing.
const fake = {
    isLost: false,
    canvas: null as unknown,
    upload: vi.fn((_source: unknown, width: number, height: number) => ({ id: "f", width, height })),
    resize: vi.fn((_frame: unknown, width: number, height: number) => ({ id: "r", width: Math.round(width), height: Math.round(height) })),
    look: vi.fn((frame: unknown, ..._rest: unknown[]) => frame),
    lutMix: vi.fn((frame: unknown, ..._rest: unknown[]) => frame),
    place: vi.fn((frame: unknown) => frame),
    placeAffine: vi.fn((frame: unknown, ..._rest: unknown[]) => frame),
    transition: vi.fn((a: unknown) => a),
    presentRegion: vi.fn((_frame: unknown, width: number, height: number) => ({ x: 0, y: 0, width, height })),
    releaseAll: vi.fn(),
};
vi.mock("./use-look-renderer", () => ({ useLookRenderer: () => fake }));
// Held frames come from hidden snapshots; jsdom cannot decode, so they are ready at once here. Live handle frames
// come from the hidden decoder: `decoder.frame` is what live() returns, `decoder.ready()` fires its onReady.
const decoder = {
    frame: null as null | { exact: boolean; time: number },
    requests: [] as Array<[string, number]>,
    held: [] as Array<[string, number]>,
    source: null as unknown as HTMLCanvasElement,
    ready: () => {},
    failed: new Set<string>(),
    draws: 0,
};
vi.mock("@opennan/timeline-media/looks/frame-snapshots", () => ({
    FrameSnapshots: class {
        constructor(options: { onReady(): void }) { decoder.ready = () => options.onReady(); }
        video(url: string, time: number) { decoder.held.push([url, time]); return { source: document.createElement("canvas"), width: 64, height: 36 }; }
        image() { return { source: document.createElement("canvas"), width: 64, height: 36 }; }
        live(url: string, time: number) {
            decoder.requests.push([url, time]);
            return decoder.frame ? { ...decoder.frame, source: decoder.source, width: 64, height: 36 } : null;
        }
        failed(url: string) { return decoder.failed.has(url); }
        beginDraw() { decoder.draws += 1; }
        dispose() {}
    },
}));

const { LaneLookOverlay } = await import("./lane-look-overlay");

function video(seeking = false, currentTime = 0): HTMLVideoElement {
    const element = document.createElement("video");
    Object.defineProperties(element, {
        currentTime: { value: currentTime, writable: true },
        readyState: { value: 4 },
        videoWidth: { value: 64 },
        videoHeight: { value: 36 },
        duration: { value: 10 },
        seeking: { value: seeking },
    });
    return element;
}

const ranges = (visualFilter: string): LaneRange[] => [{
    scene: { id: "a", videoUrl: "a.mp4", visualFilter },
    start: 0, end: 4, trackIndex: 1, transitionType: "none", transitionDuration: 0,
}];

afterEach(() => vi.clearAllMocks());

describe("LaneLookOverlay", () => {
    it("hides its last frame when the scene's look is removed (the effect re-runs on the edit)", async () => {
        fake.canvas = document.createElement("canvas");
        const element = video();
        const props = { getSceneVideo: () => element, screenFrame: { w: 320, h: 180 }, effectSpans: [] };
        const view = renderWithTimeline(<LaneLookOverlay ranges={ranges("noir")} {...props} />);
        const canvas = screen.getByTestId("lane-look-overlay");
        await waitFor(() => expect(canvas.style.opacity).toBe("1"));
        await act(async () => view.rerender(<LaneLookOverlay ranges={ranges("none")} {...props} />));
        await waitFor(() => expect(canvas.style.opacity).toBe("0"));
    });

    it("adds one set of landing listeners per element while it seeks", async () => {
        fake.canvas = document.createElement("canvas");
        const element = video(true);
        const add = vi.spyOn(element, "addEventListener");
        const props = { getSceneVideo: () => element, screenFrame: { w: 320, h: 180 }, effectSpans: [] };
        const view = renderWithTimeline(<LaneLookOverlay ranges={ranges("noir")} {...props} />);
        for (let i = 0; i < 3; i += 1) {
            await act(async () => {
                view.store.getState().setCurrentTime(0.1 * (i + 1));
                await new Promise((resolve) => setTimeout(resolve, 40));
            });
        }
        expect(add.mock.calls.length).toBe(4);
    });

    it("presents the plain lane frame (no look applied) while a compositor-run effect is at the playhead (phase 11)", async () => {
        fake.canvas = document.createElement("canvas");
        // The editor's element already shows scene-local 2 s (where the playhead goes).
        const element = video(false, 2);
        const span = { id: "fx", trackType: "effect", trackIndex: 1, startTime: 1, endTime: 3, effects: [] } as unknown as import("@opennan/timeline-core").TimelineClip;
        const view = renderWithTimeline(<LaneLookOverlay ranges={ranges("none")} getSceneVideo={() => element} screenFrame={{ w: 320, h: 180 }} effectSpans={[]} footageSpans={[span]} />);
        const canvas = screen.getByTestId("lane-look-overlay");
        // Before the span: no look, no effect — nothing to present.
        await new Promise((resolve) => setTimeout(resolve, 40));
        expect(canvas.style.opacity).toBe("0");
        await act(async () => view.store.getState().setCurrentTime(2));
        await waitFor(() => expect(canvas.style.opacity).toBe("1"));
        // The frame is the footage only: the compositor runs the effect.
        expect(fake.look.mock.calls.every(([, plan]) => plan === null)).toBe(true);
        await act(async () => view.store.getState().setCurrentTime(3.5));
        await waitFor(() => expect(canvas.style.opacity).toBe("0"));
    });

    const one = (scene: Partial<LaneScene>, extra: Partial<LaneRange> = {}): LaneRange => ({
        scene: { id: "a", videoUrl: "a.mp4", ...scene }, start: 0, end: 4, trackIndex: 1, transitionType: "none", transitionDuration: 0, ...extra,
    });

    /** Paused at `t` with the editor's element already showing scene-local `mediaTime`. */
    async function draw(ranges: LaneRange[], t = 0, mediaTime = t) {
        fake.canvas = document.createElement("canvas");
        getActiveEditorStore().getState().setCurrentTime(t);
        const element = video(false, mediaTime);
        const view = renderWithTimeline(<LaneLookOverlay ranges={ranges} getSceneVideo={() => element} screenFrame={{ w: 320, h: 180 }} effectSpans={[]} />);
        await waitFor(() => expect(screen.getByTestId("lane-look-overlay").style.opacity).toBe("1"));
        return view;
    }

    it("places a static scene axis-aligned, exactly as before", async () => {
        await draw([one({ visualFilter: "noir", transformScale: 1.5, transformOffsetX: 10 })]);
        expect(fake.place).toHaveBeenCalled();
        expect(fake.placeAffine).not.toHaveBeenCalled();
        expect(fake.lutMix).not.toHaveBeenCalled();
    });

    it("places a rotated, translucent scene through the inverse affine map over black", async () => {
        await draw([one({ visualFilter: "noir", rotationDegrees: 90, opacity: 0.5 })]);
        expect(fake.place).not.toHaveBeenCalled();
        const [frame, width, height, inverse, opacity, background] = fake.placeAffine.mock.calls.at(-1) as unknown as [{ width: number; height: number }, number, number, [number, number, number, number, number, number], number, number[]];
        expect(opacity).toBe(0.5);
        expect(background).toEqual([0, 0, 0, 1]);
        // The frame center maps to the texture center; a quarter turn clockwise maps the frame's +x to the texture's −y.
        const [u, v] = applyAffine(inverse, width / 2, height / 2);
        expect(u).toBeCloseTo(frame.width / 2, 6);
        expect(v).toBeCloseTo(frame.height / 2, 6);
        const [u2, v2] = applyAffine(inverse, width / 2 + 10, height / 2);
        expect(u2).toBeCloseTo(frame.width / 2, 6);
        expect(v2).toBeLessThan(frame.height / 2);
    });

    it("moves each side of a transition window with its own motion at its own local time", async () => {
        const fadeIn = JSON.stringify({ in: { id: "fade_in", duration: 1 } });
        const ranges = [one({ visualFilter: "noir" }, { transitionType: "wipe_left", transitionDuration: 1 }), one({ id: "b", videoUrl: "b.mp4", animationJson: fadeIn }, { start: 4, end: 8 })];
        await draw(ranges, 4.25, 0.25);
        // a (held, static) is placed axis-aligned; b at local 0.25 s of its fade-in through the affine pass.
        expect(fake.place).toHaveBeenCalled();
        const opacity = fake.placeAffine.mock.calls.at(-1)?.[4] as unknown as number;
        expect(opacity).toBeGreaterThan(0);
        expect(opacity).toBeLessThan(1);
        expect(fake.transition).toHaveBeenCalled();
    });

    it("cross-fades the keyframes' CLUTs before the rest of the look", async () => {
        const keyframesJson = JSON.stringify({ keyframes: [{ time: 0, adj_exposure: -0.4 }, { time: 2, adj_exposure: 0.4 }] });
        await draw([one({ keyframesJson, adjustmentsJson: '{"vignette":0.3}' })], 1);
        const [, a, b, w] = fake.lutMix.mock.calls.at(-1) as unknown as [unknown, { key: string }, { key: string }, number];
        expect(w).toBe(0.5);
        expect(a.key).not.toBe(b.key);
        const plan = fake.look.mock.calls.at(-1)?.[1] as unknown as { steps: Array<{ kind: string }> };
        expect(plan.steps.map((step) => step.kind)).toEqual(["vignette"]);
    });

    describe("live transition handles", () => {
        const trims = (start: number, end: number, content: number) => JSON.stringify({ timelineTrimStart: start, timelineTrimEnd: end, timelineSourceDuration: content });
        // a has 0.4 s of media after its end; the window's half is 0.5 s.
        const handleRanges = (): LaneRange[] => [
            one({ cardConfig: trims(0, 4, 4.4) }, { transitionType: "wipe_left", transitionDuration: 1 }),
            one({ id: "b", videoUrl: "b.mp4" }, { start: 4, end: 8 }),
        ];

        afterEach(() => {
            decoder.frame = null;
            decoder.requests = [];
            decoder.held = [];
            decoder.failed.clear();
        });

        it("paused, a decoder whose media failed is not waited for: the held frame is drawn", async () => {
            fake.canvas = document.createElement("canvas");
            decoder.source = document.createElement("canvas");
            decoder.frame = null;
            decoder.failed.add("a.mp4");
            getActiveEditorStore().getState().setCurrentTime(4.2);
            const element = video(false, 0.2);
            const drawsBefore = decoder.draws;
            renderWithTimeline(<LaneLookOverlay ranges={handleRanges()} getSceneVideo={() => element} screenFrame={{ w: 320, h: 180 }} effectSpans={[]} />);
            await waitFor(() => expect(fake.transition).toHaveBeenCalled());
            expect(decoder.held.some(([url, time]) => url === "a.mp4" && Math.abs(time - (4.4 - 1 / 30)) < 1e-9)).toBe(true);
            // Each draw starts a decoder draw (eviction protects what it requests).
            expect(decoder.draws).toBeGreaterThan(drawsBefore);
        });

        it("paused inside the handle, it waits for the decoder's exact frame and draws it once it lands", async () => {
            fake.canvas = document.createElement("canvas");
            decoder.source = document.createElement("canvas");
            decoder.frame = { exact: false, time: 4.1 };
            getActiveEditorStore().getState().setCurrentTime(4.2);
            const element = video(false, 0.2);
            renderWithTimeline(<LaneLookOverlay ranges={handleRanges()} getSceneVideo={() => element} screenFrame={{ w: 320, h: 180 }} effectSpans={[]} />);
            await waitFor(() => expect(decoder.requests.length).toBeGreaterThan(0));
            // a's media at 4.2 s: 0.2 s past its trim end.
            expect(decoder.requests.at(-1)?.[0]).toBe("a.mp4");
            expect(decoder.requests.at(-1)?.[1]).toBeCloseTo(4.2, 9);
            await new Promise((resolve) => setTimeout(resolve, 40));
            expect(fake.transition).not.toHaveBeenCalled();
            expect(screen.getByTestId("lane-look-overlay").style.opacity).toBe("0");
            decoder.frame = { exact: true, time: 4.2 };
            await act(async () => decoder.ready());
            await waitFor(() => expect(fake.transition).toHaveBeenCalled());
            expect(fake.upload.mock.calls.some((call) => call[0] === decoder.source)).toBe(true);
        });

        it("playing, it never waits: the decoder's last frame, else the held frame", async () => {
            fake.canvas = document.createElement("canvas");
            decoder.source = document.createElement("canvas");
            decoder.frame = null;
            const store = getActiveEditorStore();
            store.getState().setCurrentTime(4.2);
            store.getState().setIsPlaying(true);
            const element = video(false, 0.2);
            renderWithTimeline(<LaneLookOverlay ranges={handleRanges()} getSceneVideo={() => element} screenFrame={{ w: 320, h: 180 }} effectSpans={[]} />);
            // Nothing decoded yet: the held frame (a's last real frame, 4.4 s − one frame).
            await waitFor(() => expect(fake.transition).toHaveBeenCalled());
            expect(decoder.held.some(([url, time]) => url === "a.mp4" && Math.abs(time - (4.4 - 1 / 30)) < 1e-9)).toBe(true);
            decoder.frame = { exact: false, time: 4.1 };
            fake.transition.mockClear();
            await act(async () => store.getState().setCurrentTime(4.25));
            await waitFor(() => expect(fake.transition).toHaveBeenCalled());
            expect(fake.upload.mock.calls.some((call) => call[0] === decoder.source)).toBe(true);
            store.getState().setIsPlaying(false);
        });
    });
});
