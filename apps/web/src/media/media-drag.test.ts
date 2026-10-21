import type { UploadedMedia } from "@opennan/timeline-core";
import { getTimelineLibraryDragKind, getTimelineMediaDragDuration } from "@opennan/timeline-core/timeline/canvas/canvas-timeline-utils";
import { buildMediaDragPayload, hasDraggedFiles, writeMediaDrag } from "./media-drag";

const video: UploadedMedia = { url: "opennan-local://media/v1", name: "clip.webm", size: 10, mimeType: "video/webm", durationSeconds: 6.008 };
const audio: UploadedMedia = { url: "opennan-local://media/a1", name: "song.mp3", size: 10, mimeType: "audio/mpeg", durationSeconds: 30 };

function fakeDataTransfer() {
    const data = new Map<string, string>();
    return {
        effectAllowed: "none",
        get types() { return [...data.keys()]; },
        setData: (type: string, value: string) => { data.set(type, value); },
        getData: (type: string) => data.get(type) ?? "",
    };
}

describe("media drag payload", () => {
    it("matches the sources panel payload the timeline drop handler reads", () => {
        expect(JSON.parse(buildMediaDragPayload(video).json)).toEqual({ url: video.url, name: "clip.webm", mediaType: "video", duration: 6.008 });
        expect(JSON.parse(buildMediaDragPayload(audio).json)).toEqual({ url: audio.url, name: "song.mp3", mediaType: "audio", sourceType: "music" });
        expect(buildMediaDragPayload(video).marker).toBe("application/x-timeline-media-video;d=6.0");
        expect(buildMediaDragPayload({ ...audio, durationSeconds: undefined }).marker).toBe("application/x-timeline-media-audio");
    });

    it("is recognized by the timeline's drag helpers", () => {
        const transfer = fakeDataTransfer();
        writeMediaDrag(transfer as unknown as DataTransfer, video);
        expect(transfer.effectAllowed).toBe("copy");
        expect(getTimelineLibraryDragKind(transfer as unknown as DataTransfer)).toBe("media-video");
        expect(getTimelineMediaDragDuration(transfer as unknown as DataTransfer)).toBe(6);
    });

    it("tells file drags apart from tile drags", () => {
        expect(hasDraggedFiles({ types: ["Files"] } as unknown as DataTransfer)).toBe(true);
        expect(hasDraggedFiles({ types: ["application/json"] } as unknown as DataTransfer)).toBe(false);
        expect(hasDraggedFiles(null)).toBe(false);
    });
});
