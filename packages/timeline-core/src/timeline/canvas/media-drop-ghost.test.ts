// Unit coverage for media library drag detection + drop-ghost placement.
import { describe, expect, it } from "vitest";
import { getTimelineLibraryDragKind, getTimelineMediaDragDuration } from "./canvas-timeline-utils";
import { getMediaLayerDropPreview } from "./hit-detector";

function fakeDataTransfer(types: string[]): DataTransfer {
    return {
        types,
        getData: () => "",
    } as unknown as DataTransfer;
}

describe("getTimelineLibraryDragKind — media markers", () => {
    it("detects video/audio/image media drags from bare MIME markers", () => {
        expect(getTimelineLibraryDragKind(fakeDataTransfer(["application/x-timeline-media-video", "application/json"]))).toBe("media-video");
        expect(getTimelineLibraryDragKind(fakeDataTransfer(["application/x-timeline-media-audio"]))).toBe("media-audio");
        expect(getTimelineLibraryDragKind(fakeDataTransfer(["application/x-timeline-media-image"]))).toBe("media-image");
    });

    it("still prefers effect/remotion/transition markers", () => {
        expect(getTimelineLibraryDragKind(fakeDataTransfer(["application/x-effect-layer", "application/x-timeline-media-video"]))).toBe("effect");
    });

    it("reads kind and duration from a marker with a ;d= suffix", () => {
        const dt = fakeDataTransfer(["application/x-timeline-media-video;d=21.4"]);
        expect(getTimelineLibraryDragKind(dt)).toBe("media-video");
        expect(getTimelineMediaDragDuration(dt)).toBeCloseTo(21.4);
        expect(getTimelineMediaDragDuration(fakeDataTransfer(["application/x-timeline-media-audio"]))).toBeNull();
    });
});

const RULER_HEIGHT = 20;

function makeState(tracks: Array<{ type: string; index: number; y: number; height: number; locked?: boolean; visible?: boolean; virtual?: boolean }>) {
    return {
        tracks,
        zoom: 25,
        scrollLeft: 0,
        totalDuration: 60,
    } as never;
}

describe("getMediaLayerDropPreview", () => {
    const tracks = [
        { type: "video", index: 2, y: 40, height: 40 },
        { type: "video", index: 1, y: 80, height: 40 },
        { type: "audio", index: 1, y: 120, height: 32 },
        { type: "sticker", index: 1, y: 0, height: 40 },
    ];

    it("routes video media to overlay lanes (V2+), never V1", () => {
        const preview = getMediaLayerDropPreview("video", 250, makeState(tracks));
        expect(preview.trackIndex).toBe(2);
        expect(preview.trackMissing).toBe(false);
        expect(preview.time).toBeCloseTo(10);
        expect(preview.y).toBe(RULER_HEIGHT + 40);
    });

    it("marks the video row missing when only V1 exists", () => {
        const preview = getMediaLayerDropPreview("video", 0, makeState([{ type: "video", index: 1, y: 0, height: 40 }]));
        expect(preview.trackMissing).toBe(true);
        expect(preview.trackIndex).toBe(2);
    });

    it("routes image media to overlay video lanes (shared family) and audio to audio tracks", () => {
        expect(getMediaLayerDropPreview("image", 0, makeState(tracks)).y).toBe(RULER_HEIGHT + 40);
        expect(getMediaLayerDropPreview("image", 0, makeState(tracks)).trackIndex).toBe(2);
        expect(getMediaLayerDropPreview("audio", 0, makeState(tracks)).y).toBe(RULER_HEIGHT + 120);
    });

    it("sizes the ghost from the real media duration when known", () => {
        const known = getMediaLayerDropPreview("video", 0, makeState(tracks), undefined, 21.4);
        expect(known.w).toBeCloseTo(21.4 * 25);
        const unknown = getMediaLayerDropPreview("video", 0, makeState(tracks));
        expect(unknown.w).toBeCloseTo(5 * 25);
    });

    it("prefers the editable track under the cursor", () => {
        const two = [
            { type: "audio", index: 1, y: 100, height: 32 },
            { type: "audio", index: 2, y: 132, height: 32 },
        ];
        const preview = getMediaLayerDropPreview("audio", 0, makeState(two), RULER_HEIGHT + 140);
        // cursor at local y=140 → second audio row (y 132..164)
        expect(preview.trackIndex).toBe(2);
    });
});
