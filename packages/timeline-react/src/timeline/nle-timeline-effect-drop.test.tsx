// Behavior coverage for effect drop target preservation in the parent NLE timeline.
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getActiveEditorStore } from "../provider/registry";
import type { ClipEffect, TimelineTrack } from "@opennan/timeline-core/model/timeline";
import { NleTimeline } from "./nle-timeline";
import { createTimelineTestRuntime, keyEcho, renderWithTimeline, seedTimeline } from "../test-utils/render-with-timeline";

vi.mock("./canvas/canvas-timeline", () => ({
  scenesToEngineItems: () => [],
  CanvasTimeline: ({
    onTrackDrop,
    onEffectDropPreviewChange,
  }: {
    onTrackDrop?: (trackType: string, trackIndex: number, time: number, data: Record<string, unknown>) => void;
    onEffectDropPreviewChange?: (preview: { trackIndex: number; h: number; trackMissing: boolean } | null) => void;
  }) => (
    <div>
      <button
        type="button"
        onClick={() => onTrackDrop?.("effect", 1, 7.25, {
          kind: "effect",
          effectId: "shake",
          name: "Shake",
        })}
      >
        drop effect on E1
      </button>
      <button
        type="button"
        onClick={() => onTrackDrop?.("effect", 3, 7.25, {
          kind: "effect",
          effectId: "shake",
          name: "Shake",
        })}
      >
        drop effect on E3
      </button>
      <button
        type="button"
        onClick={() => onEffectDropPreviewChange?.({ trackIndex: 1, h: 40, trackMissing: true })}
      >
        show missing effect placeholder
      </button>
      <button
        type="button"
        onClick={() => onEffectDropPreviewChange?.(null)}
      >
        clear effect placeholder
      </button>
    </div>
  ),
}));

function track(type: TimelineTrack["type"], index: number): TimelineTrack {
  return {
    type,
    index,
    label: `${type[0]?.toUpperCase() || "T"}${index}`,
    muted: false,
    locked: false,
    visible: true,
    volume: 1,
  };
}

describe("NleTimeline effect drop behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getActiveEditorStore().getState().resetForProject();
  });

  it("creates a dropped effect layer on the canvas-reported effect track", async () => {
    const runtime = createTimelineTestRuntime();
    await seedTimeline(runtime, { tracks: [
      track("effect", 2),
      track("effect", 1),
      track("video", 1),
      track("audio", 1),
    ] });
    const release = runtime.recording.hold("createClips");
    renderWithTimeline(
      <NleTimeline />,
      { runtime, translate: keyEcho },
    );

    fireEvent.click(screen.getByRole("button", { name: "drop effect on E1" }));

    // The temp clip is in the store before the backend resolves (onStartCreateClip adapter).
    const tempClip = runtime.store.getState().timelineData?.clips.find((c) => c.trackType === "effect");
    expect(tempClip).toMatchObject({
      trackType: "effect",
      trackIndex: 1,
      startTime: 7.25,
      endTime: 10.25,
      label: "Shake",
    });
    const tempId = tempClip!.id;
    expect(tempId).toMatch(/^temp-/);
    expect(runtime.store.getState().timelineData?.clips.find((c) => c.id === tempId)?.effects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ clipId: tempId, effectId: "shake" }),
      ]) as ClipEffect[],
    );
    await waitFor(() => {
      expect(runtime.recording.callsTo("createClips")[0].args[1][0]).toMatchObject({
        trackType: "effect",
        trackIndex: 1,
        startTime: 7.25,
        endTime: 10.25,
        label: "Shake",
      });
    });

    release();
    await waitFor(() => {
      expect(runtime.recording.callsTo("addClipEffect")[0].args.slice(1, 3)).toEqual([{ clipId: "srv-1" }, "shake"]);
      expect(runtime.store.getState().timelineData?.clips.find((c) => c.id === "srv-1")?.effects).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ effectId: "shake" }),
        ]) as ClipEffect[],
      );
    });
  });

  it("mirrors a missing effect-track drop preview in the sticky track label rail", async () => {
    const runtime = createTimelineTestRuntime();
    await seedTimeline(runtime, { tracks: [
      track("video", 1),
      track("audio", 1),
    ] });
    renderWithTimeline(
      <NleTimeline />,
      { runtime, translate: keyEcho },
    );

    expect(screen.queryByText("E1")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "show missing effect placeholder" }));

    const effectLabel = await screen.findByText("E1");
    const videoLabel = screen.getByText("V1");
    expect(effectLabel).toBeInTheDocument();
    expect(effectLabel.compareDocumentPosition(videoLabel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "clear effect placeholder" }));

    await waitFor(() => {
      expect(screen.queryByText("E1")).toBeNull();
    });
  });

  it("leaves nothing behind when the new effect track cannot be saved (one atomic command)", async () => {
    const runtime = createTimelineTestRuntime();
    await seedTimeline(runtime, { tracks: [
      track("video", 1),
      track("audio", 1),
    ] });
    runtime.recording.failNext("updateTracks");
    renderWithTimeline(
      <NleTimeline />,
      { runtime, translate: keyEcho },
    );

    fireEvent.click(screen.getByRole("button", { name: "drop effect on E1" }));

    await waitFor(() => {
      expect(runtime.recording.callsTo("updateTracks")[0].args[1]).toEqual([
        expect.objectContaining({ type: "video", index: 1, label: "V1" }),
        expect.objectContaining({ type: "audio", index: 1, label: "A1" }),
        expect.objectContaining({ type: "effect", index: 1, label: "E1" }),
      ]);
    });
    // effect.layer.add is one command: the failed track write rolls back the optimistic layer and no clip is created.
    await waitFor(() => {
      expect(runtime.store.getState().timelineData?.clips ?? []).toEqual([]);
    });
    expect(runtime.recording.callsTo("createClips")).toHaveLength(0);
  });

  it("creates a dropped effect on a newly resolved row when persisted tracks miss the requested row", async () => {
    const hiddenE1 = { ...track("effect", 1), visible: false };
    const lockedE2 = { ...track("effect", 2), locked: true };
    const stalePersistedTracks = [
      hiddenE1,
      lockedE2,
      track("video", 1),
      track("audio", 1),
    ];

    const runtime = createTimelineTestRuntime();
    await seedTimeline(runtime, { tracks: stalePersistedTracks });
    renderWithTimeline(
      <NleTimeline />,
      { runtime, translate: keyEcho },
    );

    fireEvent.click(screen.getByRole("button", { name: "drop effect on E3" }));

    await waitFor(() => {
      expect(runtime.recording.callsTo("updateTracks")[0].args[1]).toEqual([
        expect.objectContaining({ type: "effect", index: 1, visible: false }),
        expect.objectContaining({ type: "effect", index: 2, locked: true }),
        expect.objectContaining({ type: "video", index: 1, label: "V1" }),
        expect.objectContaining({ type: "audio", index: 1, label: "A1" }),
        expect.objectContaining({ type: "effect", index: 3, label: "E3" }),
      ]);
    });
    await waitFor(() => {
      expect(runtime.recording.callsTo("createClips")[0].args[1][0]).toMatchObject({
        trackType: "effect",
        trackIndex: 3,
      });
    });
  });

  it("lets users add an effect track from the fallback no-track-data state", async () => {
    const runtime = createTimelineTestRuntime();
    // "No track data" = a loaded timeline with no persisted tracks (the controller
    // needs a loaded timeline to apply track.update).
    await seedTimeline(runtime, { tracks: [] });
    renderWithTimeline(
      <NleTimeline />,
      { runtime, translate: keyEcho },
    );

    fireEvent.click(screen.getByRole("button", { name: "title" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "effectTrack" }));

    await waitFor(() => {
      expect(runtime.recording.callsTo("updateTracks")[0].args[1]).toEqual([
        expect.objectContaining({ type: "video", index: 1, label: "V1" }),
        expect.objectContaining({ type: "audio", index: 1, label: "A1" }),
        expect.objectContaining({ type: "effect", index: 1, label: "E1" }),
      ]);
    });
  });
});
