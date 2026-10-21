// Runtime coverage for ScenePreview selection fallbacks and media rendering.
import { act, cleanup, waitFor } from "@testing-library/react";
import type { ComponentProps, ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ScenePreview } from "./scene-preview";
import { getActiveEditorStore } from "../provider/registry";
import { renderWithTimeline } from "../test-utils/render-with-timeline";

vi.mock("../hooks/use-video-cache", () => ({ useVideoCache: () => ({ cachedUrl: (u: string | null | undefined) => u ?? undefined, preload: vi.fn(), abortPreloads: vi.fn(), isCached: () => false }) }));

// The old i18n mock echo: key, or key:JSON(values).
function renderPreview(ui: ReactElement) {
  return renderWithTimeline(ui, { translate: (_ns, key, values) => (values ? `${key}:${JSON.stringify(values)}` : key) });
}

type PreviewScene = NonNullable<ComponentProps<typeof ScenePreview>["scenes"]>[number];

function scene(overrides: Partial<PreviewScene> = {}): PreviewScene {
  return {
    id: "scene-1",
    order: 0,
    startTime: "00:00:00",
    endTime: "00:00:05",
    caption: "Active scene",
    startImageUrl: "/active-scene.jpg",
    endImageUrl: null,
    videoUrl: null,
    status: "completed",
    duration: 5,
    timelinePositionSeconds: 0,
    trackIndex: 1,
    ...overrides,
  };
}

function trimmedSourceScene(overrides: Partial<PreviewScene> = {}): PreviewScene {
  const trimStart = Number(overrides.timelinePositionSeconds ?? 0);
  const trimEnd = trimStart + Number(overrides.duration ?? 5);
  return scene({
    cardType: "source_clip",
    sourceVideoUrl: "/source-with-audio.mp4",
    cardConfig: JSON.stringify({ timelineTrimStart: trimStart, timelineTrimEnd: trimEnd }),
    ...overrides,
  });
}

describe("ScenePreview behavior", () => {
  beforeEach(() => {
    getActiveEditorStore().getState().resetForProject();
    vi.stubGlobal("ResizeObserver", class {
      observe() {}
      disconnect() {}
    });
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("renders the playhead scene when parent selection is owned by another timeline item", async () => {
    const scenes = [
      scene({
        id: "scene-before",
        startImageUrl: "/before.jpg",
        duration: 5,
        timelinePositionSeconds: 0,
      }),
      scene({
        id: "scene-active",
        order: 1,
        startImageUrl: "/active-scene.jpg",
        duration: 5,
        timelinePositionSeconds: 5,
      }),
    ];

    act(() => {
      getActiveEditorStore().getState().setCurrentTime(6);
      getActiveEditorStore().getState().selectClip("effect-or-transition-selection");
    });

    const { container } = renderPreview(
      <ScenePreview
        scene={null}
        scenes={scenes}
        musicUrl={null}
        timelineClips={[]}
        timelineTracks={[{ type: "video", index: 1, label: "V1", locked: false, muted: false, visible: true, volume: 1 }]}
        projectAspectRatio="16:9"
      />,
    );

    await waitFor(() => {
      expect(container.querySelector('img[src="/active-scene.jpg"]')).not.toBeNull();
    });
    expect(container.textContent).not.toContain("selectScene");
  });

  it("keeps saved zero music volume when the soundtrack loads after mount", async () => {
    act(() => {
      getActiveEditorStore().getState().setMusicVolume(0);
    });

    const previewScene = scene();
    const props = {
      scene: previewScene,
      scenes: [previewScene],
      timelineClips: [],
      timelineTracks: [
        { type: "video" as const, index: 1, label: "V1", locked: false, muted: false, visible: true, volume: 1 },
        { type: "audio" as const, index: 1, label: "A1", locked: false, muted: false, visible: true, volume: 1 },
      ],
      projectAspectRatio: "16:9",
    };

    const { container, rerender } = renderPreview(<ScenePreview {...props} musicUrl={null} />);
    rerender(<ScenePreview {...props} musicUrl="/background-music.mp3" />);

    await waitFor(() => {
      const music = container.querySelector('audio[src="/background-music.mp3"]') as HTMLAudioElement | null;
      expect(music).not.toBeNull();
      expect(music?.volume).toBe(0);
    });
  });

  it("reapplies zero music volume when the soundtrack element remounts", async () => {
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    act(() => {
      getActiveEditorStore().getState().setMusicVolume(0);
    });
    const previewScene = scene();
    const { container } = renderPreview(
      <ScenePreview scene={previewScene} scenes={[previewScene]} musicUrl="/background-music.mp3" />,
    );

    await waitFor(() => {
      expect((container.querySelector('audio[src="/background-music.mp3"]') as HTMLAudioElement | null)?.volume).toBe(0);
    });
    act(() => {
      visibility.mockReturnValue("hidden");
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await waitFor(() => {
      expect(container.querySelector('audio[src="/background-music.mp3"]')).toBeNull();
    });
    act(() => {
      visibility.mockReturnValue("visible");
      document.dispatchEvent(new Event("visibilitychange"));
    });

    await waitFor(() => {
      const music = container.querySelector('audio[src="/background-music.mp3"]') as HTMLAudioElement | null;
      expect(music?.volume).toBe(0);
    });
  });

  it.each([
    ["muted", { muted: true, visible: true, volume: 1 }],
    ["hidden", { muted: false, visible: false, volume: 1 }],
    ["zero volume", { muted: false, visible: true, volume: 0 }],
  ])("silences project music when A1 is %s", async (_state, audioTrackState) => {
    const previewScene = scene();
    const { container } = renderPreview(
      <ScenePreview
        scene={previewScene}
        scenes={[previewScene]}
        musicUrl="/background-music.mp3"
        timelineTracks={[
          { type: "video", index: 1, label: "V1", locked: false, muted: false, visible: true, volume: 1 },
          { type: "audio", index: 1, label: "A1", locked: false, ...audioTrackState },
        ]}
      />,
    );

    await waitFor(() => {
      const music = container.querySelector('audio[src="/background-music.mp3"]') as HTMLAudioElement | null;
      expect(music?.volume).toBe(0);
    });
  });

  it.each([
    ["muted", { muted: true, visible: true }],
    ["hidden", { muted: false, visible: false }],
  ])("keeps source-clip video audio muted when the base audio track is %s", async (_state, audioTrackState) => {
    const sourceClip = scene({
      cardType: "source_clip",
      sourceVideoUrl: "/source-with-audio.mp4",
      videoUrl: null,
      startImageUrl: "/source-poster.jpg",
    });

    const { container } = renderPreview(
      <ScenePreview
        scene={sourceClip}
        scenes={[sourceClip]}
        musicUrl={null}
        timelineClips={[]}
        timelineTracks={[
          { type: "video", index: 1, label: "V1", locked: false, muted: false, visible: true, volume: 1 },
          { type: "audio", index: 1, label: "A1", locked: false, volume: 1, ...audioTrackState },
        ]}
        projectAspectRatio="16:9"
      />,
    );

    await waitFor(() => {
      const video = container.querySelector('video[src="/source-with-audio.mp4"]') as HTMLVideoElement | null;
      expect(video).not.toBeNull();
      expect(video?.muted).toBe(true);
    });
  });

  it("keeps embedded source audio muted when detached audio plays on the timeline", async () => {
    const sourceClip = scene({
      cardType: "source_clip",
      sourceVideoUrl: "/source-with-audio.mp4",
      videoUrl: null,
      startImageUrl: "/source-poster.jpg",
    });

    const { container } = renderPreview(
      <ScenePreview
        scene={sourceClip}
        scenes={[sourceClip]}
        musicUrl={null}
        timelineClips={[
          {
            id: "detached-audio",
            projectId: "project-1",
            trackType: "audio",
            trackIndex: 1,
            startTime: 0,
            endTime: 10,
            mediaUrl: "/source-with-audio.mp4",
            mediaType: "audio",
            sceneId: null,
            label: "Detached audio",
            thumbnailUrl: null,
            locked: false,
            volume: 1,
            audioPan: 0,
            audioPitch: 0,
            audioEq: "none",
            audioDenoise: false,
            audioNormalize: false,
            playbackSpeed: 1,
            speedRamp: "none",
            reversePlayback: false,
            freezeFrame: false,
            fadeInDuration: 0,
            fadeOutDuration: 0,
            transitionType: "none",
            transitionDuration: 0,
            opacity: 1,
            scale: 1,
            positionX: 0.5,
            positionY: 0.5,
            horizontalFlip: false,
            verticalFlip: false,
            cropLeft: 0,
            cropRight: 0,
            cropTop: 0,
            cropBottom: 0,
            brightness: 0,
            contrast: 1,
            saturation: 1,
            visualFilter: "none",
            motionPreset: "none",
            blurStrength: 0,
            chromaKeyEnabled: false,
            chromaKeyColor: "0x00FF00",
            chromaKeySimilarity: 0.1,
            chromaKeyBlend: 0,
            blendMode: "normal",
            mosaicStrength: 0,
            rotationDegrees: 0,
            keyframesJson: null,
            textContent: null,
            textStyle: null,
            trimStart: null,
            trimEnd: null,
          },
          {
            id: "silent-video",
            projectId: "project-1",
            trackType: "video",
            trackIndex: 1,
            startTime: 0,
            endTime: 10,
            mediaUrl: "/source-with-audio.mp4",
            mediaType: "video",
            sceneId: null,
            label: null,
            thumbnailUrl: null,
            locked: false,
            volume: 0,
            audioPan: 0,
            audioPitch: 0,
            audioEq: "none",
            audioDenoise: false,
            audioNormalize: false,
            playbackSpeed: 1,
            speedRamp: "none",
            reversePlayback: false,
            freezeFrame: false,
            fadeInDuration: 0,
            fadeOutDuration: 0,
            transitionType: "none",
            transitionDuration: 0,
            opacity: 1,
            scale: 1,
            positionX: 0.5,
            positionY: 0.5,
            horizontalFlip: false,
            verticalFlip: false,
            cropLeft: 0,
            cropRight: 0,
            cropTop: 0,
            cropBottom: 0,
            brightness: 0,
            contrast: 1,
            saturation: 1,
            visualFilter: "none",
            motionPreset: "none",
            blurStrength: 0,
            chromaKeyEnabled: false,
            chromaKeyColor: "0x00FF00",
            chromaKeySimilarity: 0.1,
            chromaKeyBlend: 0,
            blendMode: "normal",
            mosaicStrength: 0,
            rotationDegrees: 0,
            keyframesJson: null,
            textContent: null,
            textStyle: null,
            trimStart: null,
            trimEnd: null,
          },
        ]}
        timelineTracks={[
          { type: "video", index: 1, label: "V1", locked: false, muted: false, visible: true, volume: 1 },
          { type: "audio", index: 1, label: "A1", locked: false, muted: false, visible: true, volume: 1 },
        ]}
        projectAspectRatio="16:9"
      />,
    );

    await waitFor(() => {
      const video = container.querySelector('video[src="/source-with-audio.mp4"]') as HTMLVideoElement | null;
      expect(video).not.toBeNull();
      expect(video?.muted).toBe(true);
    });
  });

  it("keeps embedded source audio muted when extracted audio is the A1 source", async () => {
    const sourceClip = scene({
      cardType: "source_clip",
      sourceVideoUrl: "/source-with-audio.mp4",
      videoUrl: null,
      audioUrl: "/extracted-source-audio.mp3",
      startImageUrl: "/source-poster.jpg",
    });

    const { container } = renderPreview(
      <ScenePreview
        scene={sourceClip}
        scenes={[sourceClip]}
        musicUrl={null}
        timelineClips={[]}
        timelineTracks={[
          { type: "video", index: 1, label: "V1", locked: false, muted: false, visible: true, volume: 1 },
          { type: "audio", index: 1, label: "A1", locked: false, muted: false, visible: true, volume: 1 },
        ]}
        projectAspectRatio="16:9"
      />,
    );

    await waitFor(() => {
      const video = container.querySelector('video[src="/source-with-audio.mp4"]') as HTMLVideoElement | null;
      expect(video).not.toBeNull();
      expect(video?.muted).toBe(true);
    });
  });

  it("does not replay a zero-volume extracted source layer under replacement voice clips", async () => {
    const sourceClip = scene({
      cardType: "copy_video",
      sourceVideoUrl: "/source-with-music.mp4",
      videoUrl: "/rendered-video.mp4",
      audioUrl: null,
      autoGenerateAudio: true,
      cardConfig: JSON.stringify({
        audio_layers: [
          { type: "extracted", url: "/extracted-source-audio.mp3", volume: 0, offset: 0 },
        ],
      }),
    } as Partial<PreviewScene>);

    const { container } = renderPreview(
      <ScenePreview
        scene={sourceClip}
        scenes={[sourceClip]}
        musicUrl={null}
        timelineClips={[]}
        timelineTracks={[
          { type: "video", index: 1, label: "V1", locked: false, muted: true, visible: true, volume: 1 },
          { type: "audio", index: 1, label: "A1", locked: false, muted: false, visible: true, volume: 1 },
          { type: "audio", index: 2, label: "A2", locked: false, muted: false, visible: true, volume: 1 },
        ]}
      />,
    );

    await waitFor(() => {
      expect(container.querySelector('video[src="/rendered-video.mp4"]')).not.toBeNull();
    });
    expect(
      Array.from(container.querySelectorAll("audio")).some(
        (audio) => audio.getAttribute("src") === "/extracted-source-audio.mp3",
      ),
    ).toBe(false);
  });

  it("shows a dip transition overlay at a trimmed source cut", async () => {
    const scenes = [
      trimmedSourceScene({
        id: "scene-1",
        duration: 12.9,
        timelinePositionSeconds: 0,
        visualTransition: "dip_black",
        visualTransitionDuration: 0.5,
      } as Partial<PreviewScene>),
      trimmedSourceScene({ id: "scene-2", duration: 13.1, timelinePositionSeconds: 12.9 }),
    ];

    act(() => {
      getActiveEditorStore().getState().setCurrentTime(12.9);
    });

    const { container } = renderPreview(
      <ScenePreview
        scene={scenes[1]}
        scenes={scenes}
        musicUrl={null}
        timelineClips={[]}
        timelineTracks={[{ type: "video", index: 1, label: "V1", locked: false, muted: false, visible: true, volume: 1 }]}
        projectAspectRatio="16:9"
      />,
    );

    await waitFor(() => {
      const overlay = container.querySelector('[data-testid="scene-transition-overlay"]') as HTMLElement | null;
      expect(overlay).not.toBeNull();
      expect(overlay?.style.backgroundColor).toBe("rgb(0, 0, 0)");
      expect(Number(overlay?.style.opacity)).toBeGreaterThan(0.9);
    });
  });

  it("clamps stale current time when source-trim duration shrinks", async () => {
    const scenes = [
      trimmedSourceScene({ id: "scene-1", duration: 12.9, timelinePositionSeconds: 0 }),
      trimmedSourceScene({ id: "scene-2", duration: 13.1, timelinePositionSeconds: 12.9 }),
    ];

    act(() => {
      getActiveEditorStore().getState().setCurrentTime(38);
    });

    renderPreview(
      <ScenePreview
        scene={scenes[0]}
        scenes={scenes}
        musicUrl={null}
        timelineClips={[]}
        timelineTracks={[{ type: "video", index: 1, label: "V1", locked: false, muted: false, visible: true, volume: 1 }]}
        projectAspectRatio="16:9"
      />,
    );

    await waitFor(() => {
      expect(getActiveEditorStore().getState().currentTime).toBe(26);
    });
  });

  it("clamps timeline seek requests to the trimmed preview duration", async () => {
    const scenes = [
      trimmedSourceScene({ id: "scene-1", duration: 12.9, timelinePositionSeconds: 0 }),
      trimmedSourceScene({ id: "scene-2", duration: 13.1, timelinePositionSeconds: 12.9 }),
    ];

    act(() => {
      getActiveEditorStore().getState().setSeekRequest(38);
    });

    renderPreview(
      <ScenePreview
        scene={scenes[0]}
        scenes={scenes}
        musicUrl={null}
        timelineClips={[]}
        timelineTracks={[{ type: "video", index: 1, label: "V1", locked: false, muted: false, visible: true, volume: 1 }]}
        projectAspectRatio="16:9"
      />,
    );

    await waitFor(() => {
      expect(getActiveEditorStore().getState().currentTime).toBe(26);
    });
  });
});
