// Where "Add to timeline" puts imported media.
// - video: a source_clip scene appended to V1, as the canvas "add scene from file"
//   path does (packages/timeline-react/src/timeline/canvas/canvas-timeline.tsx:3778-3793);
// - audio: a clip at the playhead on the first free editable audio lane, the drop
//   handler's lane rule (packages/timeline-react/src/timeline/nle-timeline.tsx:2506-2601);
// - images go through the store's addImageRequest, which NleTimeline turns into a sticker
//   at the playhead (nle-timeline.tsx:2395-2401; source sources-panel.tsx:398-402).
import {
    getSceneDuration, getSceneStart, tracks as trackOps,
    type AddSceneInput, type CreateClipInput, type SceneData, type TimelineClip, type TimelineTrack, type UploadedMedia,
} from "@opennan/timeline-core";

export const DEFAULT_MEDIA_SECONDS = 5;

function mediaSeconds(media: UploadedMedia): number {
    return media.durationSeconds && media.durationSeconds > 0 ? media.durationSeconds : DEFAULT_MEDIA_SECONDS;
}

export function planVideoSceneAppend(scenes: SceneData[], media: UploadedMedia): AddSceneInput {
    const end = scenes.reduce((max, scene, index) => (
        Number(scene.trackIndex || 1) === 1 ? Math.max(max, getSceneStart(scene, scenes, index) + getSceneDuration(scene)) : max
    ), 0);
    return {
        afterOrder: scenes.reduce((max, scene) => Math.max(max, scene.order), -1),
        cardType: "source_clip",
        sourceVideoUrl: media.url,
        trackIndex: 1,
        // 0.001, not 0: an exact 0 reads as "unpositioned" (apps/playground/src/sample-project.ts:32).
        timelinePositionSeconds: end > 0 ? end : 0.001,
        duration: mediaSeconds(media),
        caption: media.name,
    };
}

export interface AudioPlacement {
    /** Set when every audio lane is busy: the track list with one more audio track. */
    tracks: TimelineTrack[] | null;
    input: CreateClipInput;
}

export function planAudioClipAtPlayhead(clips: TimelineClip[], tracks: TimelineTrack[], playhead: number, media: UploadedMedia): AudioPlacement {
    const start = Math.max(0, playhead);
    const end = start + mediaSeconds(media);
    const lanes = tracks
        .filter((track) => track.type === "audio" && !track.locked && track.visible !== false)
        .map((track) => track.index)
        .sort((a, b) => a - b);
    let index = trackOps.resolveNonOverlappingTrackIndex(clips, "audio", lanes, start, end);
    let nextTracks: TimelineTrack[] | null = null;
    if (index === null) {
        const added = trackOps.nextTrackForType(tracks, "audio");
        nextTracks = [...tracks, added];
        index = added.index;
    }
    return {
        tracks: nextTracks,
        input: { trackType: "audio", trackIndex: index, startTime: start, endTime: end, mediaUrl: media.url, mediaType: "audio", label: media.name },
    };
}
