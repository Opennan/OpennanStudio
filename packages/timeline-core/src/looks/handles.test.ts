import { describe, expect, it } from "vitest";
import type { TimelineClip } from "../model/timeline";
import type { SceneData } from "../timeline/canvas/types";
import { clipHandleMedia, handleMediaTime, sceneHandleMedia, snapHandles, transitionHandles, type HandleMedia } from "./handles";

function scene(patch: Partial<SceneData> = {}): SceneData {
    return {
        id: "s", order: 0, caption: "", startTime: "0", endTime: "0", startImageUrl: null, endImageUrl: null, videoUrl: null,
        sourceVideoUrl: "/m/s.mp4", status: "ready", transition: "cut", cardType: "source_clip", duration: 4,
        frameConsistencyScore: null, audioUrl: null, audioText: null, cardConfig: null, ...patch,
    } as SceneData;
}
const trims = (start: number, end: number, content?: number) =>
    JSON.stringify({ timelineTrimStart: start, timelineTrimEnd: end, ...(content !== undefined ? { timelineSourceDuration: content } : {}) });

function clip(patch: Partial<TimelineClip> = {}): TimelineClip {
    return {
        id: "c", trackType: "video", trackIndex: 2, startTime: 1, endTime: 3, mediaUrl: "/m/c.mp4", mediaType: "video",
        playbackSpeed: 1, speedRamp: "none", reversePlayback: false, freezeFrame: false, ...patch,
    } as TimelineClip;
}

describe("transitionHandles", () => {
    const media = (patch: Partial<HandleMedia>): HandleMedia => ({ sourceStart: 0, sourceEnd: 2, mediaLength: null, rate: 1, still: false, ...patch });

    it("gives each side the real media beyond the cut, at most half the window", () => {
        expect(transitionHandles(media({ sourceEnd: 2, mediaLength: 2.1 }), media({ sourceStart: 0.05 }), 0.25)).toEqual({ outgoingAfter: 0.1, incomingBefore: 0.05 });
        expect(transitionHandles(media({ sourceEnd: 2, mediaLength: 9 }), media({ sourceStart: 3 }), 0.25)).toEqual({ outgoingAfter: 0.25, incomingBefore: 0.25 });
    });

    it("assumes no media after the end when the media length is unknown, and none before media zero", () => {
        expect(transitionHandles(media({ mediaLength: null }), media({ sourceStart: 0 }), 0.5)).toEqual({ outgoingAfter: 0, incomingBefore: 0 });
    });

    it("keeps frozen frames for sides without handle media, and full handles for stills", () => {
        expect(transitionHandles(null, null, 0.5)).toEqual({ outgoingAfter: 0, incomingBefore: 0 });
        expect(transitionHandles(media({ still: true }), media({ still: true }), 0.4)).toEqual({ outgoingAfter: 0.4, incomingBefore: 0.4 });
    });

    it("converts media seconds to timeline seconds with the speed factor", () => {
        // 2x: one media second is half a timeline second.
        expect(transitionHandles(media({ sourceEnd: 4, mediaLength: 4.4, rate: 2 }), media({ sourceStart: 0.3, rate: 2 }), 1)).toEqual({ outgoingAfter: 0.2, incomingBefore: 0.15 });
    });

    it("snaps handles down to whole frames", () => {
        expect(snapHandles({ outgoingAfter: 0.1, incomingBefore: 0.25 }, 30)).toEqual({ outgoingAfter: 3 / 30, incomingBefore: 7 / 30 });
        expect(snapHandles({ outgoingAfter: 0.02, incomingBefore: 0 }, 30)).toEqual({ outgoingAfter: 0, incomingBefore: 0 });
    });

    it("maps timeline seconds beyond an edge to media time", () => {
        const m = media({ sourceStart: 1, sourceEnd: 3, rate: 2 });
        expect(handleMediaTime(m, "after", 0.25)).toBe(3.5);
        expect(handleMediaTime(m, "before", 0.25)).toBe(0.5);
        expect(handleMediaTime(media({ still: true }), "after", 5)).toBe(0);
    });
});

describe("sceneHandleMedia", () => {
    it("reads the scene trim and its stored content length", () => {
        expect(sceneHandleMedia(scene({ cardConfig: trims(1, 3, 10) }))).toEqual({ sourceStart: 1, sourceEnd: 3, mediaLength: 10, rate: 1, still: false });
    });

    it("leaves the content length unknown without timelineSourceDuration (no media after the trim end)", () => {
        const m = sceneHandleMedia(scene({ cardConfig: trims(1, 3) }))!;
        expect(m.mediaLength).toBeNull();
        expect(transitionHandles(m, m, 0.5)).toEqual({ outgoingAfter: 0, incomingBefore: 0.5 });
    });

    it("untrimmed scenes have no handles", () => {
        const m = sceneHandleMedia(scene())!;
        expect(m).toEqual({ sourceStart: 0, sourceEnd: 4, mediaLength: null, rate: 1, still: false });
        expect(transitionHandles(m, m, 0.5)).toEqual({ outgoingAfter: 0, incomingBefore: 0 });
    });

    it("converts with the scene speed factor", () => {
        const m = sceneHandleMedia(scene({ cardConfig: trims(1, 3, 10), playbackSpeed: 2 }))!;
        expect(m.rate).toBe(2);
        expect(transitionHandles(m, m, 0.4)).toEqual({ outgoingAfter: 0.4, incomingBefore: 0.4 });
        expect(transitionHandles(m, m, 2)).toEqual({ outgoingAfter: 2, incomingBefore: 0.5 });
    });

    it("stills have infinite media; shot sequences and empty scenes stay frozen", () => {
        expect(sceneHandleMedia(scene({ cardType: "image", sourceVideoUrl: null, startImageUrl: "/m/a.png" }))!.still).toBe(true);
        const shots = JSON.stringify([{ video_url: "/m/1.mp4", duration: 2 }, { video_url: "/m/2.mp4", duration: 2 }]);
        expect(sceneHandleMedia(scene({ cardType: "image", sourceVideoUrl: null, shotBreakdown: shots }))).toBeNull();
        expect(sceneHandleMedia(scene({ cardType: "image", sourceVideoUrl: null }))).toBeNull();
    });
});

describe("clipHandleMedia", () => {
    it("plain video clips play from media zero: handles after their span only, by the probed length", () => {
        expect(clipHandleMedia(clip(), 2.5)).toEqual({ sourceStart: 0, sourceEnd: 2, mediaLength: 2.5, rate: 1, still: false });
        expect(clipHandleMedia(clip(), null)!.mediaLength).toBeNull();
    });

    it("a trimmed clip plays from its trimStart: real media before it (incoming) and after its span (outgoing)", () => {
        const right = clipHandleMedia(clip({ trimStart: 2, trimEnd: 4 }), 10)!;
        expect(right).toEqual({ sourceStart: 2, sourceEnd: 4, mediaLength: 10, rate: 1, still: false });
        expect(transitionHandles(clipHandleMedia(clip({ trimStart: 0, trimEnd: 2 }), 10), right, 0.5)).toEqual({ outgoingAfter: 0.5, incomingBefore: 0.5 });
        // A null or negative trim is media zero.
        expect(clipHandleMedia(clip({ trimStart: null }), 10)!.sourceStart).toBe(0);
        expect(clipHandleMedia(clip({ trimStart: -1 }), 10)!.sourceStart).toBe(0);
    });

    it("images are stills; sped-up, reversed, frozen, and GIF clips keep frozen frames", () => {
        expect(clipHandleMedia(clip({ mediaType: "image", mediaUrl: "/m/a.png" }), null)!.still).toBe(true);
        expect(clipHandleMedia(clip({ playbackSpeed: 2 }), 10)).toBeNull();
        expect(clipHandleMedia(clip({ speedRamp: "hero" }), 10)).toBeNull();
        expect(clipHandleMedia(clip({ reversePlayback: true }), 10)).toBeNull();
        expect(clipHandleMedia(clip({ freezeFrame: true }), 10)).toBeNull();
        expect(clipHandleMedia(clip({ mediaUrl: "/m/a.gif", mediaType: "image" }), 10)).toBeNull();
    });
});
