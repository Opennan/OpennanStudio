// Sample project for the playground: three 5 s source-clip scenes at 0/5/10 s on V1
// (same layout as the source smoke fixture) and one 6 s title on T1.
import { optimistic, type LocalBackend, type SceneData, type TimelineTrack } from "@opennan/timeline-core";

export const SAMPLE_PROJECT_ID = "sample";
const SAMPLE_VIDEO = "/sample/testsrc-6s.webm";

function track(type: TimelineTrack["type"], index: number, label: string): TimelineTrack {
    return { type, index, label, muted: false, locked: false, visible: true, volume: 1 };
}

function scene(id: string, order: number, start: number): SceneData {
    return {
        id, order, caption: `Shot ${order + 1}`, startTime: "00:00:00.000", endTime: "00:00:05.000",
        startImageUrl: null, endImageUrl: null, videoUrl: SAMPLE_VIDEO, sourceVideoUrl: SAMPLE_VIDEO,
        status: "completed", transition: "cut", cardType: "source_clip", duration: 5,
        frameConsistencyScore: null, audioUrl: null, audioText: null, cardConfig: null, shotBreakdown: "[]",
        timelinePositionSeconds: start, trackIndex: 1,
    };
}

export async function seedSampleProject(backend: LocalBackend, options: { force?: boolean } = {}): Promise<void> {
    if (!options.force && (await backend.loadScenes(SAMPLE_PROJECT_ID)).length > 0) return;
    const title = optimistic.optimisticTimelineClipFromInput(
        { trackType: "text", trackIndex: 1, startTime: 0, endTime: 6, mediaType: "text", textContent: "OpenNan Studio", label: "Title" },
        SAMPLE_PROJECT_ID,
        "title-clip",
    );
    await backend.seedProject(SAMPLE_PROJECT_ID, {
        meta: { name: "Sample", aspectRatio: "16:9" },
        tracks: [track("video", 1, "V1"), track("audio", 1, "A1"), track("text", 1, "T1")],
        // 0.001, not 0: an exact 0 means "unpositioned" (engine/persist.ts comment).
        scenes: [scene("scene-a", 0, 0.001), scene("scene-b", 1, 5), scene("scene-c", 2, 10)],
        clips: [title],
    });
}
