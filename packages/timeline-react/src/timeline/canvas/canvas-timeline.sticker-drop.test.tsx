// Sticker cards from the Stickers library drop anywhere on the canvas timeline.
import { cleanup, createEvent, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TimelineTrack } from "@opennan/timeline-core/model/timeline";
import { renderWithTimeline, keyOnly } from "../../test-utils/render-with-timeline";
import { getActiveEditorStore } from "../../provider/registry";
import { CanvasTimeline } from "./canvas-timeline";

vi.mock("../../hooks/use-timeline-upload", () => ({
  useTimelineUpload: () => ({ upload: vi.fn(), reset: vi.fn() }),
}));

const track = (type: TimelineTrack["type"], index: number): TimelineTrack => ({
  type, index, label: `${type[0].toUpperCase()}${index}`, muted: false, locked: false, visible: true, volume: 1,
});

function renderCanvas(tracks: TimelineTrack[]) {
  const onTrackDrop = vi.fn();
  const result = renderWithTimeline(
    <CanvasTimeline
      scenes={[]} tracks={tracks} clips={[]} selectedSceneId={null} zoom={10} totalDuration={30} musicUrl={null} musicVolume={1}
      selectedAudioTarget={null} onSelectClip={vi.fn()} onSelectScene={vi.fn()} onUpdateClips={vi.fn()} onSeek={vi.fn()}
      onSelectMusic={vi.fn()} onSelectVoiceover={vi.fn()} onReorderScenes={vi.fn()} onDeleteClips={vi.fn()} onTrackDrop={onTrackDrop}
    />,
    { translate: keyOnly },
  );
  const canvas = result.container.querySelector("canvas")!;
  vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({
    x: 100, y: 200, left: 100, top: 200, width: 900, height: 180, right: 1000, bottom: 380, toJSON: () => ({}),
  } as DOMRect);
  return { canvas, onTrackDrop };
}

function drop(canvas: HTMLCanvasElement, clientX: number, clientY: number, payload: unknown) {
  const values: Record<string, string> = { "application/x-sticker-id": "opennan:arrow-right", "application/json": JSON.stringify(payload) };
  const event = createEvent.drop(canvas, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clientX", { value: clientX });
  Object.defineProperty(event, "clientY", { value: clientY });
  Object.defineProperty(event, "dataTransfer", {
    value: { types: Object.keys(values), getData: (type: string) => values[type] ?? "", dropEffect: "", effectAllowed: "" },
  });
  fireEvent(canvas, event);
}

beforeEach(() => {
  getActiveEditorStore().getState().resetForProject();
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => { callback(0); return 1; }));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("CanvasTimeline sticker drop", () => {
  const payload = { kind: "sticker", stickerId: "opennan:arrow-right", name: "Arrow" };

  it("passes the sticker track under the cursor and the drop time", async () => {
    const { canvas, onTrackDrop } = renderCanvas([track("sticker", 1), track("video", 1), track("audio", 1)]);
    drop(canvas, 220, 240, payload);
    await waitFor(() => expect(onTrackDrop).toHaveBeenCalledWith("sticker", 1, 12, payload));
  });

  it("accepts a drop outside any sticker track (index 0: the handler finds or adds one)", async () => {
    const { canvas, onTrackDrop } = renderCanvas([track("video", 1), track("audio", 1)]);
    drop(canvas, 220, 375, payload);
    await waitFor(() => expect(onTrackDrop).toHaveBeenCalledWith("sticker", 0, 12, payload));
  });
});
