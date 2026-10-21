// The editor's placement rules for agent edits (spec §5.1.1: agents edit like a
// person in the editor). A locked or hidden track and a locked clip cannot be
// edited (timeline-core lib/timeline-editing-properties.ts getEditableTimelineClipIds),
// and a new clip never lands on top of another one (createTimelineTextClipAction).
import { tracks as trackUtils, type ControllerSnapshot, type TimelineClip, type TimelineTrack } from "@opennan/timeline-core";
import { round3 } from "../args";

export interface PlacementRequest {
    /** A track the caller asked for; it must be editable and free. */
    requested?: number;
    /** Lowest track index to consider when none was requested (video overlays start at 2). */
    firstIndex?: number;
    /** The clip being moved, which does not block itself. */
    ignoreClipId?: string;
}

export type Placement = { ok: true; trackIndex: number } | { ok: false; error: string };

function trackRow(snap: ControllerSnapshot, type: string, index: number): TimelineTrack | undefined {
    return snap.tracks.find((track) => track.type === type && track.index === index);
}

function trackReason(snap: ControllerSnapshot, type: string, index: number): string | null {
    const row = trackRow(snap, type, index);
    if (row?.locked) return `Track ${type}${index} is locked. Unlock it with manage_timeline_tracks or pick another track.`;
    if (row && row.visible === false) return `Track ${type}${index} is hidden. Show it with manage_timeline_tracks or pick another track.`;
    return null;
}

/** Why a person in the editor could not edit this clip, or null when they could. */
export function lockReason(snap: ControllerSnapshot, clip: TimelineClip): string | null {
    if (clip.locked) return `Clip ${clip.id} is locked. Unlock it first (edit_timeline_clip with locked: false).`;
    const row = trackRow(snap, clip.trackType, clip.trackIndex);
    if (row?.locked) return `Clip ${clip.id} is on locked track ${clip.trackType}${clip.trackIndex}. Unlock the track with manage_timeline_tracks first.`;
    if (row && row.visible === false) return `Clip ${clip.id} is on hidden track ${clip.trackType}${clip.trackIndex}. Show the track with manage_timeline_tracks first.`;
    return null;
}

/** Why a person in the editor could not edit this main-track (or V2+) scene, or null when they could. */
export function sceneLockReason(snap: ControllerSnapshot, scene: { id: string; trackIndex?: number | null }, label: string): string | null {
    const index = Number(scene.trackIndex || 1);
    const row = trackRow(snap, "video", index);
    if (row?.locked) return `The ${label} clip is on locked track video${index}. Unlock the track with manage_timeline_tracks first.`;
    if (row && row.visible === false) return `The ${label} clip is on hidden track video${index}. Show the track with manage_timeline_tracks first.`;
    return null;
}

/** The track a clip at [start, end) goes on, or why it cannot go where it was asked. */
export function placeClip(snap: ControllerSnapshot, type: string, start: number, end: number, request: PlacementRequest = {}): Placement {
    const clips = request.ignoreClipId ? snap.clips.filter((clip) => clip.id !== request.ignoreClipId) : snap.clips;
    if (request.requested !== undefined) {
        const index = request.requested;
        const reason = trackReason(snap, type, index);
        if (reason) return { ok: false, error: reason };
        const busy = clips.filter((clip) => clip.trackType === type && clip.trackIndex === index && clip.startTime < end && clip.endTime > start);
        if (busy.length > 0) {
            const list = busy.map((clip) => `${clip.id} (${round3(clip.startTime)}-${round3(clip.endTime)}s)`).join(", ");
            return {
                ok: false,
                error: `${type}${index} already has ${list} in ${round3(start)}-${round3(end)}s. Pick a free time or track, or leave track_index out to use the first free track.`,
            };
        }
        return { ok: true, trackIndex: index };
    }
    const first = request.firstIndex ?? 1;
    const used = [
        ...snap.tracks.filter((track) => track.type === type).map((track) => track.index),
        ...snap.clips.filter((clip) => clip.trackType === type).map((clip) => clip.trackIndex),
    ];
    const highest = Math.max(first - 1, ...used);
    const candidates = Array.from({ length: Math.max(0, highest - first + 1) }, (_v, i) => first + i)
        .filter((index) => trackReason(snap, type, index) === null);
    const trackType = type as Parameters<typeof trackUtils.resolveNonOverlappingTrackIndex>[1];
    const free = trackUtils.resolveNonOverlappingTrackIndex(clips, trackType, candidates, start, end);
    return { ok: true, trackIndex: free ?? highest + 1 };
}
