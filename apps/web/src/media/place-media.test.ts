import { optimistic, type SceneData, type TimelineTrack, type UploadedMedia } from "@opennan/timeline-core";
import { planAudioClipAtPlayhead, planVideoSceneAppend } from "./place-media";

const video: UploadedMedia = { url: "opennan-local://media/v", name: "clip.webm", size: 1, mimeType: "video/webm", durationSeconds: 6 };
const song: UploadedMedia = { url: "opennan-local://media/a", name: "song.mp3", size: 1, mimeType: "audio/mpeg", durationSeconds: 4 };

function scene(id: string, order: number, start: number, duration: number, trackIndex = 1): SceneData {
    return {
        id, order, caption: id, startTime: "00:00:00.000", endTime: "00:00:05.000", startImageUrl: null, endImageUrl: null,
        videoUrl: null, sourceVideoUrl: "x", status: "completed", transition: "cut", cardType: "source_clip", duration,
        frameConsistencyScore: null, audioUrl: null, audioText: null, cardConfig: null, shotBreakdown: "[]",
        timelinePositionSeconds: start, trackIndex,
    };
}

const audioTrack = (index: number, extra: Partial<TimelineTrack> = {}): TimelineTrack => ({
    type: "audio", index, label: `A${index}`, muted: false, locked: false, visible: true, volume: 1, ...extra,
});

describe("planVideoSceneAppend", () => {
    it("starts an empty timeline just after 0", () => {
        expect(planVideoSceneAppend([], video)).toEqual({
            afterOrder: -1, cardType: "source_clip", sourceVideoUrl: video.url, trackIndex: 1,
            timelinePositionSeconds: 0.001, duration: 6, caption: "clip.webm",
        });
    });

    it("appends after the last V1 scene and ignores overlay lanes", () => {
        const scenes = [scene("a", 0, 0.001, 5), scene("b", 1, 5.001, 3), scene("over", 2, 20, 4, 2)];
        const input = planVideoSceneAppend(scenes, { ...video, durationSeconds: undefined });
        expect(input.afterOrder).toBe(2);
        expect(input.timelinePositionSeconds).toBeCloseTo(8.001, 6);
        expect(input.duration).toBe(5);
    });
});

describe("planAudioClipAtPlayhead", () => {
    const clipOn = (index: number, start: number, end: number) => optimistic.optimisticTimelineClipFromInput(
        { trackType: "audio", trackIndex: index, startTime: start, endTime: end, mediaType: "audio" }, "p1", `c${index}-${start}`,
    );

    it("uses the first free audio lane at the playhead", () => {
        const plan = planAudioClipAtPlayhead([], [audioTrack(1)], 2, song);
        expect(plan.tracks).toBeNull();
        expect(plan.input).toEqual({ trackType: "audio", trackIndex: 1, startTime: 2, endTime: 6, mediaUrl: song.url, mediaType: "audio", label: "song.mp3" });
    });

    it("skips busy and locked lanes", () => {
        const tracks = [audioTrack(1), audioTrack(2, { locked: true }), audioTrack(3)];
        expect(planAudioClipAtPlayhead([clipOn(1, 0, 10)], tracks, 2, song).input.trackIndex).toBe(3);
    });

    it("adds an audio track when every lane is busy", () => {
        const plan = planAudioClipAtPlayhead([clipOn(1, 0, 10)], [audioTrack(1)], 2, song);
        expect(plan.tracks?.map((t) => `${t.type}${t.index}`)).toEqual(["audio1", "audio2"]);
        expect(plan.input.trackIndex).toBe(2);
    });
});
