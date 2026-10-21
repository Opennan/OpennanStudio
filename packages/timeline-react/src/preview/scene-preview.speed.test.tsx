// Speed in the preview (phase 10b): main-track scenes, under-scene clips and timeline audio clips play at
// their instantaneous rate from the exact time map. Fake media: jsdom keeps currentTime / playbackRate as
// plain values; play() and pause() are spies.
import { act, cleanup, waitFor } from "@testing-library/react";
import type { ComponentProps, ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TimelineClip } from "@opennan/timeline-core/model/timeline";
import { clipSpeedProfile, sceneSpeedProfile, sourceTimeAt, timelineDuration } from "@opennan/timeline-core/motion/speed";
import { ScenePreview } from "./scene-preview";
import { getActiveEditorStore } from "../provider/registry";
import { renderWithTimeline } from "../test-utils/render-with-timeline";

vi.mock("../hooks/use-video-cache", () => ({ useVideoCache: () => ({ cachedUrl: (u: string | null | undefined) => u ?? undefined, preload: vi.fn(), abortPreloads: vi.fn(), isCached: () => false }) }));

type PreviewScene = NonNullable<ComponentProps<typeof ScenePreview>["scenes"]>[number];
type PitchMedia = HTMLMediaElement & { preservesPitch?: boolean };

const HERO = JSON.stringify({ id: "hero", points: [[0, 1], [0.28, 1], [0.42, 0.25], [0.58, 0.25], [0.72, 1], [1, 1]] });

function renderPreview(ui: ReactElement) {
    return renderWithTimeline(ui, { translate: (_ns, key) => key });
}

/** A source clip trimmed to [trimStart, trimStart + span] source seconds. */
function sourceScene(overrides: Partial<PreviewScene> & { trimStart?: number; span?: number } = {}): PreviewScene {
    const { trimStart = 1, span = 10, ...rest } = overrides;
    return {
        id: "scene-1",
        order: 0,
        startTime: "00:00:00",
        endTime: "00:00:10",
        caption: "",
        startImageUrl: null,
        endImageUrl: null,
        videoUrl: null,
        cardType: "source_clip",
        sourceVideoUrl: "/source.mp4",
        status: "completed",
        duration: span,
        timelinePositionSeconds: 0,
        trackIndex: 1,
        cardConfig: JSON.stringify({ timelineTrimStart: trimStart, timelineTrimEnd: trimStart + span }),
        ...rest,
    };
}

function clip(overrides: Partial<TimelineClip>): TimelineClip {
    return {
        id: "clip-1", projectId: "project-1", trackType: "video", trackIndex: 2, startTime: 0, endTime: 10,
        mediaUrl: "/clip.mp4", mediaType: "video", sceneId: null, label: null, thumbnailUrl: null, locked: false,
        volume: 1, audioPan: 0, audioPitch: 0, audioEq: "none", audioDenoise: false, audioNormalize: false,
        playbackSpeed: 1, speedRamp: "none", reversePlayback: false, freezeFrame: false, fadeInDuration: 0,
        fadeOutDuration: 0, transitionType: "none", transitionDuration: 0, opacity: 1, scale: 1, positionX: 0.5,
        positionY: 0.5, horizontalFlip: false, verticalFlip: false, cropLeft: 0, cropRight: 0, cropTop: 0,
        cropBottom: 0, brightness: 0, contrast: 1, saturation: 1, visualFilter: "none", motionPreset: "none",
        blurStrength: 0, chromaKeyEnabled: false, chromaKeyColor: "0x00FF00", chromaKeySimilarity: 0.1,
        chromaKeyBlend: 0, blendMode: "normal", mosaicStrength: 0, rotationDegrees: 0, keyframesJson: null,
        textContent: null, textStyle: null, trimStart: null, trimEnd: null,
        ...overrides,
    };
}

const tracks = [
    { type: "video" as const, index: 1, label: "V1", locked: false, muted: false, visible: true, volume: 1 },
    { type: "video" as const, index: 2, label: "V2", locked: false, muted: false, visible: true, volume: 1 },
    { type: "video" as const, index: 3, label: "V3", locked: false, muted: false, visible: true, volume: 1 },
    { type: "audio" as const, index: 1, label: "A1", locked: false, muted: false, visible: true, volume: 1 },
    { type: "audio" as const, index: 2, label: "A2", locked: false, muted: false, visible: true, volume: 1 },
];

const store = () => getActiveEditorStore().getState();

/** The V1 pool's element for a scene (the gated under-scene layer renders an earlier copy of V1 scenes). */
function poolVideo(container: HTMLElement, src: string): HTMLVideoElement {
    const all = container.querySelectorAll<HTMLVideoElement>(`video[src="${src}"]`);
    return all[all.length - 1];
}

describe("ScenePreview speed", () => {
    let play: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        store().resetForProject();
        vi.stubGlobal("ResizeObserver", class {
            observe() {}
            disconnect() {}
        });
        vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
        vi.spyOn(HTMLMediaElement.prototype, "readyState", "get").mockReturnValue(4);
        play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
        vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    });

    afterEach(() => {
        act(() => store().setIsPlaying(false));
        cleanup();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it("seeks a 2× scene to trimStart + 2·t and plays it at rate 2 with its pitch setting", async () => {
        const fast = sourceScene({ playbackSpeed: 2, preservePitch: false });
        const { container } = renderPreview(<ScenePreview scene={fast} scenes={[fast]} musicUrl={null} timelineClips={[]} timelineTracks={tracks} />);
        await waitFor(() => expect(container.querySelector('video[src="/source.mp4"]')).not.toBeNull());
        const video = poolVideo(container, "/source.mp4") as PitchMedia;

        // Paused scrub to 2 s of a 5 s (10 source seconds at 2×) scene: source 1 + 4.
        act(() => store().setSeekRequest(2));
        await waitFor(() => expect(video.currentTime).toBeCloseTo(5, 6));

        act(() => store().setPlayRequest("play"));
        await waitFor(() => {
            expect(video.playbackRate).toBe(2);
            expect(video.preservesPitch).toBe(false);
            expect(play.mock.contexts).toContain(video);
        });
        // The element keeps following 1 + 2·t while the clock runs.
        const t = store().currentTime;
        expect(video.currentTime).toBeGreaterThanOrEqual(5 - 1e-6);
        expect(Math.abs(video.currentTime - (1 + 2 * t))).toBeLessThan(2 * 0.5);
    });

    it("scrubs a hero-curve scene to the curve's source time and plays it at the curve's rate", async () => {
        const curved = sourceScene({ speedCurveJson: HERO, trimStart: 1, span: 10 });
        const profile = sceneSpeedProfile(curved);
        const length = timelineDuration(profile, 10);
        const { container } = renderPreview(<ScenePreview scene={curved} scenes={[curved]} musicUrl={null} timelineClips={[]} timelineTracks={tracks} />);
        await waitFor(() => expect(container.querySelector('video[src="/source.mp4"]')).not.toBeNull());
        const video = poolVideo(container, "/source.mp4");

        const middle = length / 2;
        act(() => store().setSeekRequest(middle));
        await waitFor(() => expect(video.currentTime).toBeCloseTo(1 + sourceTimeAt(profile, middle, length), 6));
        act(() => store().setPlayRequest("play"));
        // Mid-curve the hero preset plays at a quarter speed.
        await waitFor(() => expect(video.playbackRate).toBeCloseTo(0.25, 1));
    });

    it("steps a 50× scene by seeking each frame instead of playing it", async () => {
        // 100 source seconds at 50× last 2 s on the timeline.
        const extreme = sourceScene({ playbackSpeed: 50, span: 100, trimStart: 0 });
        act(() => store().setCurrentTime(0.1));
        const { container } = renderPreview(<ScenePreview scene={extreme} scenes={[extreme]} musicUrl={null} timelineClips={[]} timelineTracks={tracks} />);
        await waitFor(() => expect(container.querySelector('video[src="/source.mp4"]')).not.toBeNull());
        const video = poolVideo(container, "/source.mp4");

        act(() => store().setPlayRequest("play"));
        // Starts at 50 × 0.1 and advances ~50 source seconds per second by seeks alone.
        await waitFor(() => expect(video.currentTime).toBeGreaterThan(6), { timeout: 2000 });
        expect(video.playbackRate).toBe(16);
        expect(play.mock.contexts).not.toContain(video);
        expect(Math.abs(video.currentTime - 50 * store().currentTime)).toBeLessThan(50 * 0.2);
    });

    it("runs shot-sequenced scene videos at the scene's time scale instead of 1×", async () => {
        // Two 2 s shots at 2×: 4 source seconds over a 2 s scene, so the time scale (and rate) is 2.
        const shots = sourceScene({
            id: "shots", cardType: "copy_video", sourceVideoUrl: null, cardConfig: null, playbackSpeed: 2,
            shotBreakdown: JSON.stringify([{ video_url: "/shot-1.mp4", duration: 2 }, { video_url: "/shot-2.mp4", duration: 2 }]),
        });
        act(() => store().setCurrentTime(1.5));
        const { container } = renderPreview(<ScenePreview scene={shots} scenes={[shots]} musicUrl={null} timelineClips={[]} timelineTracks={tracks} />);
        await waitFor(() => expect(container.querySelector('video[src="/shot-2.mp4"]')).not.toBeNull());
        const video = container.querySelector('video[src="/shot-2.mp4"]') as HTMLVideoElement;
        // The sequencer re-syncs on the next playhead move (shot two mounts after the index flips).
        act(() => store().setCurrentTime(1.6));
        // Timeline 1.6 s → 3.2 source seconds → 1.2 s into shot two.
        await waitFor(() => expect(video.playbackRate).toBe(2));
        expect(video.currentTime).toBeCloseTo(1.2, 6);
    });

    it("plays a hero-curve clip under a scene at the curve's rate across the clip", async () => {
        // Scene on V3 so the V2 clip renders in the under-scene layer.
        const top = sourceScene({ id: "top", trackIndex: 3, sourceVideoUrl: "/top.mp4" });
        const hero = clip({ id: "hero", speedCurveJson: HERO });
        const { container } = renderPreview(<ScenePreview scene={top} scenes={[top]} musicUrl={null} timelineClips={[hero]} timelineTracks={tracks} />);
        await waitFor(() => expect(container.querySelector('video[src="/clip.mp4"]')).not.toBeNull());
        const video = container.querySelector('video[src="/clip.mp4"]') as HTMLVideoElement;
        const profile = clipSpeedProfile(hero);

        act(() => store().setCurrentTime(1));
        await waitFor(() => expect(video.playbackRate).toBeCloseTo(1, 9));
        expect(video.currentTime).toBeCloseTo(1, 9);

        // Deep in the slow middle: quarter speed, source time from the exact map (< t).
        act(() => store().setCurrentTime(5));
        await waitFor(() => expect(video.playbackRate).toBeCloseTo(0.25, 9));
        expect(video.currentTime).toBeCloseTo(sourceTimeAt(profile, 5, 10), 9);
        expect(video.currentTime).toBeLessThan(5);

        act(() => store().setCurrentTime(9));
        await waitFor(() => expect(video.playbackRate).toBeCloseTo(1, 9));
    });

    it("plays a trimmed clip under a scene from its trimStart (2×: trimStart + 2·t)", async () => {
        const top = sourceScene({ id: "top", trackIndex: 3, sourceVideoUrl: "/top.mp4" });
        const trimmed = clip({ id: "trimmed", trimStart: 3, trimEnd: 23, playbackSpeed: 2 });
        const { container } = renderPreview(<ScenePreview scene={top} scenes={[top]} musicUrl={null} timelineClips={[trimmed]} timelineTracks={tracks} />);
        await waitFor(() => expect(container.querySelector('video[src="/clip.mp4"]')).not.toBeNull());
        const video = container.querySelector('video[src="/clip.mp4"]') as HTMLVideoElement;
        act(() => store().setCurrentTime(1.5));
        await waitFor(() => expect(video.currentTime).toBeCloseTo(6, 6));
    });

    it("plays a legacy speedRamp clip through its step curve", async () => {
        const top = sourceScene({ id: "top", trackIndex: 3, sourceVideoUrl: "/top.mp4" });
        const ramp = clip({ id: "ramp", speedRamp: "hero" });
        const { container } = renderPreview(<ScenePreview scene={top} scenes={[top]} musicUrl={null} timelineClips={[ramp]} timelineTracks={tracks} />);
        await waitFor(() => expect(container.querySelector('video[src="/clip.mp4"]')).not.toBeNull());
        const video = container.querySelector('video[src="/clip.mp4"]') as HTMLVideoElement;
        act(() => store().setCurrentTime(5));
        // legacy_hero: 1.35× between 35% and 65%.
        await waitFor(() => expect(video.playbackRate).toBeCloseTo(1.35, 9));
        expect(video.currentTime).toBeCloseTo(sourceTimeAt(clipSpeedProfile(ramp), 5, 10), 9);
    });

    it("plays a 0.5× audio clip at half rate from trimStart + t/2 with its pitch kept", async () => {
        const base = sourceScene();
        const slow = clip({ id: "slow-audio", trackType: "audio", trackIndex: 2, mediaUrl: "/voice.mp3", mediaType: "audio", playbackSpeed: 0.5, trimStart: 2 });
        act(() => store().setCurrentTime(4));
        renderPreview(<ScenePreview scene={base} scenes={[base]} musicUrl={null} timelineClips={[slow]} timelineTracks={tracks} />);

        act(() => store().setPlayRequest("play"));
        let audio: PitchMedia | undefined;
        await waitFor(() => {
            audio = play.mock.contexts.find((el: unknown) => el instanceof HTMLAudioElement && el.getAttribute("data-opennan-audio-url") === "/voice.mp3") as PitchMedia | undefined;
            expect(audio).toBeDefined();
            expect(audio!.playbackRate).toBe(0.5);
        });
        expect(audio!.preservesPitch).toBe(true);
        expect(Math.abs(audio!.currentTime - (2 + 0.5 * store().currentTime))).toBeLessThan(0.5 * 0.5);
    });
});
