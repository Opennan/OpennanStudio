// Clip, scene, and track builders for the AI planner tests.
import type { TimelineClip, TimelineTrack } from "../../model/timeline";
import type { SceneData } from "../../timeline/canvas/types";
import { optimisticTimelineClipFromInput } from "../../lib/timeline-optimistic";

export function clip(id: string, fields: Partial<TimelineClip> & Pick<TimelineClip, "trackType" | "startTime" | "endTime">): TimelineClip {
    return { ...optimisticTimelineClipFromInput({ trackIndex: 1, mediaType: fields.trackType === "audio" ? "audio" : "video", ...fields }, "p1", id), ...fields };
}

export function scene(id: string, fields: Partial<SceneData> = {}): SceneData {
    return {
        id, order: 0, caption: "", startTime: "00:00:00.000", endTime: "00:00:05.000", startImageUrl: null, endImageUrl: null,
        videoUrl: null, status: "ready", transition: "cut", frameConsistencyScore: null, audioUrl: null, audioText: null,
        cardConfig: null, shotBreakdown: "[]", trackIndex: 1, duration: 5, ...fields,
    };
}

export function track(type: TimelineTrack["type"], index: number, fields: Partial<TimelineTrack> = {}): TimelineTrack {
    return { type, index, label: `${type[0].toUpperCase()}${index}`, muted: false, locked: false, visible: true, volume: 1, ...fields };
}

export const BASE_TRACKS: TimelineTrack[] = [track("video", 1), track("video", 2), track("audio", 1), track("audio", 2), track("text", 1)];
