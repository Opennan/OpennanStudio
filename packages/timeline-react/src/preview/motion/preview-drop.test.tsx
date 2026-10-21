import { act, createEvent, fireEvent, screen, waitFor } from "@testing-library/react";
import type { TimelineTrack } from "@opennan/timeline-core";
import { stickerBox } from "@opennan/timeline-core/stickers/catalog";
import { createTimelineTestRuntime, renderWithTimeline, seedTimeline } from "../../test-utils/render-with-timeline";
import { STICKER_DRAG_MIME } from "../../editing/library/stickers-tab";
import { PreviewPanel } from "../preview-panel";
import { getPreviewScreenFrame } from "../preview-screen-frame";
import { placedBox } from "./clip-motion";
import { parsePreviewDrop, previewDropAccepts, previewDropBox, previewDropPosition } from "./preview-drop";
import { RecordingContext } from "./test-fixtures";

const STICKER = "twemoji:1f60d";
const frame = { x: 40, y: 20, w: 800, h: 450 };

describe("preview drop math", () => {
    it("centres the item's box on the drop point (the inverse of placedBox)", () => {
        const box = { w: 120, h: 80 };
        const point = { x: 300, y: 150 };
        const pos = previewDropPosition(frame, box, point);
        const placed = placedBox(frame, box, { posX: pos.x, posY: pos.y, scale: 1, scaleX: 1, dx: 0, dy: 0, rotation: 0 });
        expect(placed.cx).toBeCloseTo(point.x, 1);
        expect(placed.cy).toBeCloseTo(point.y, 1);
    });

    it("clamps to the frame and keeps a frame-sized box centred", () => {
        expect(previewDropPosition(frame, { w: 100, h: 100 }, { x: -500, y: 9999 })).toEqual({ x: 0, y: 1 });
        expect(previewDropPosition(frame, { w: 800, h: 450 }, { x: 100, y: 100 })).toEqual({ x: 0.5, y: 0.5 });
    });

    it("sizes a sticker by its catalog box and text by its laid-out default text", () => {
        const sticker = previewDropBox({ kind: "sticker", stickerId: STICKER }, frame, 1, null);
        const expected = stickerBox(STICKER, frame.h)!;
        expect(sticker).toEqual({ w: expected.width, h: expected.height });
        expect(previewDropBox({ kind: "text-template", templateId: "plain" }, frame, 0.5, null)).toEqual({ w: 0, h: 0 });
        const text = previewDropBox({ kind: "text-template", templateId: "plain" }, frame, 0.5, new RecordingContext() as never);
        expect(text.w).toBeGreaterThan(0);
        expect(text.h).toBeGreaterThan(0);
    });

    it("takes stickers and text templates (by their markers), not media, effects, bare JSON, or files", () => {
        expect(previewDropAccepts([STICKER_DRAG_MIME, "application/json"])).toBe(true);
        expect(previewDropAccepts(["application/x-text-template", "application/json"])).toBe(true);
        expect(previewDropAccepts(["application/json"])).toBe(false);
        expect(previewDropAccepts(["application/x-effect-layer", "application/json"])).toBe(false);
        expect(previewDropAccepts(["application/x-timeline-media-video;d=3.0", "application/json"])).toBe(false);
        expect(previewDropAccepts(["Files"])).toBe(false);
        expect(parsePreviewDrop(JSON.stringify({ kind: "sticker", stickerId: STICKER, name: "Heart eyes" }))).toEqual({ kind: "sticker", stickerId: STICKER, name: "Heart eyes" });
        expect(parsePreviewDrop(JSON.stringify({ kind: "text-template", templateId: "plain" }))).toEqual({ kind: "text-template", templateId: "plain" });
        expect(parsePreviewDrop(JSON.stringify({ kind: "text-template", templateId: "nope" }))).toBeNull();
        expect(parsePreviewDrop(JSON.stringify({ kind: "effect", effectId: "fx_blur" }))).toBeNull();
        expect(parsePreviewDrop("{")).toBeNull();
    });
});

describe("PreviewPanel drops", () => {
    const HOST = { left: 100, top: 50, width: 1000, height: 600 };

    beforeEach(() => {
        vi.stubGlobal("ResizeObserver", class {
            observe() {}
            unobserve() {}
            disconnect() {}
        });
        vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
        vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    const track = (type: TimelineTrack["type"], index: number): TimelineTrack => ({ type, index, label: "", muted: false, locked: false, visible: true, volume: 1 });

    async function mount() {
        const runtime = createTimelineTestRuntime();
        await seedTimeline(runtime, { tracks: [track("video", 1), track("audio", 1), track("sticker", 1), track("text", 1)] });
        runtime.store.getState().setCurrentTime(3);
        renderWithTimeline(<PreviewPanel />, { runtime });
        const area = screen.getByTestId("preview-drop-area");
        vi.spyOn(area, "getBoundingClientRect").mockReturnValue({ ...HOST, x: HOST.left, y: HOST.top, right: HOST.left + HOST.width, bottom: HOST.top + HOST.height, toJSON() {} } as DOMRect);
        return { runtime, area };
    }

    /** The 16:9 project frame inside the host, in host px (preview-panel projectFrameRect). */
    function hostFrame() {
        const { w, h } = getPreviewScreenFrame({ w: HOST.width, h: HOST.height }, 16 / 9);
        return { x: (HOST.width - w) / 2, y: (HOST.height - h) / 2, w, h };
    }

    /** jsdom has no DragEvent: the pointer position is set on the generic event. */
    function drag(kind: "dragOver" | "drop", el: Element, dataTransfer: unknown, clientX: number, clientY: number) {
        const event = createEvent[kind](el, { dataTransfer });
        Object.defineProperties(event, { clientX: { value: clientX }, clientY: { value: clientY } });
        fireEvent(el, event);
    }

    const transfer = (types: string[], json: string) => ({ types, getData: (type: string) => (type === "application/json" ? json : ""), dropEffect: "none" });

    it("a sticker dropped on the frame becomes one clip.create at the playhead, centred on the drop point", async () => {
        const { runtime, area } = await mount();
        const json = JSON.stringify({ kind: "sticker", stickerId: STICKER, name: "Heart eyes" });
        drag("dragOver", area, transfer([STICKER_DRAG_MIME, "application/json"], json), 400, 250);
        expect(screen.getByTestId("preview-drop-highlight")).toBeTruthy();
        await act(async () => {
            drag("drop", area, transfer([STICKER_DRAG_MIME, "application/json"], json), 400, 250);
        });
        expect(screen.queryByTestId("preview-drop-highlight")).toBeNull();
        await waitFor(() => expect(runtime.recording.callsTo("createClips")).toHaveLength(1));
        const f = hostFrame();
        const box = stickerBox(STICKER, f.h)!;
        const expected = previewDropPosition(f, { w: box.width, h: box.height }, { x: 400 - HOST.left, y: 250 - HOST.top });
        expect(expected.x).not.toBe(0.5);
        expect(runtime.recording.callsTo("createClips")[0].args[1][0]).toMatchObject({
            trackType: "sticker", trackIndex: 1, startTime: 3, stickerId: STICKER, label: "Heart eyes",
            positionX: expected.x, positionY: expected.y,
        });
    });

    it("a text template dropped on the frame becomes one text clip.create with the drop position", async () => {
        const { runtime, area } = await mount();
        const json = JSON.stringify({ kind: "text-template", templateId: "plain", name: "Plain" });
        await act(async () => {
            drag("drop", area, transfer(["application/json"], json), 900, 500);
        });
        await waitFor(() => expect(runtime.recording.callsTo("createClips")).toHaveLength(1));
        const input = runtime.recording.callsTo("createClips")[0].args[1][0] as Record<string, unknown>;
        expect(input).toMatchObject({ trackType: "text", trackIndex: 1, startTime: 3 });
        // jsdom has no canvas 2D: the text box is unknown, so the position is the drop's plain fraction of the frame.
        const f = hostFrame();
        expect(input.positionX).toBeCloseTo((900 - HOST.left - f.x) / f.w, 3);
        expect(input.positionY).toBeCloseTo((500 - HOST.top - f.y) / f.h, 3);
    });

    it("ignores other cards: no highlight, no create", async () => {
        const { runtime, area } = await mount();
        const json = JSON.stringify({ kind: "effect", effectId: "fx_blur" });
        drag("dragOver", area, transfer(["application/x-effect-layer", "application/json"], json), 400, 250);
        expect(screen.queryByTestId("preview-drop-highlight")).toBeNull();
        await act(async () => {
            drag("drop", area, transfer(["application/x-effect-layer", "application/json"], json), 400, 250);
        });
        expect(runtime.recording.callsTo("createClips")).toHaveLength(0);
    });

    it("drops the highlight when the drag leaves the preview", async () => {
        const { area } = await mount();
        drag("dragOver", area, transfer(["application/x-text-template", "application/json"], "{}"), 400, 250);
        expect(screen.getByTestId("preview-drop-highlight")).toBeTruthy();
        fireEvent.dragLeave(area, { relatedTarget: null });
        expect(screen.queryByTestId("preview-drop-highlight")).toBeNull();
    });
});
