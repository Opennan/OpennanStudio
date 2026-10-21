// Captions from ai.run (audio.transcribe) go on a new text track labeled "Captions", one clip per cue, styled
// with the caption or subtitle preset the SRT/VTT import uses (subtitle-import.ts).
import type { TimelineClip, TimelineTrack } from "../model/timeline";
import type { CreateClipInput } from "../backend/types";
import { getTimelineSubtitleImportInputs, type SubtitleCue } from "./subtitle-import";
import { captionStyleById, captionStyleJson } from "../text/captions";

export const CAPTIONS_TRACK_LABEL = "Captions";

export interface CaptionPlacementPlan {
    track: TimelineTrack;
    /** Every track, the new one last. */
    tracks: TimelineTrack[];
    inputs: CreateClipInput[];
}

function uniqueLabel(tracks: TimelineTrack[], base: string): string {
    const taken = new Set(tracks.filter((t) => t.type === "text").map((t) => t.label));
    if (!taken.has(base)) return base;
    for (let n = 2; ; n += 1) if (!taken.has(`${base} ${n}`)) return `${base} ${n}`;
}

export function planCaptionPlacement(
    cues: SubtitleCue[],
    tracks: TimelineTrack[],
    /** style: "caption", "subtitle", or a caption style id (text/captions.ts) applied to every caption clip. */
    options: { style?: string; label?: string } = {},
): CaptionPlacementPlan {
    const index = Math.max(0, ...tracks.filter((t) => t.type === "text").map((t) => t.index)) + 1;
    const track: TimelineTrack = {
        type: "text", index, label: uniqueLabel(tracks, options.label ?? CAPTIONS_TRACK_LABEL),
        muted: false, locked: false, visible: true, volume: 1,
    };
    // Only the new, empty track is offered, so captions never land on (or get carved around) existing clips.
    const base = options.style === "subtitle" ? "subtitle" : "caption";
    const inputs = getTimelineSubtitleImportInputs(cues, [track], base, null, [] as TimelineClip[]) as CreateClipInput[];
    // A caption style id styles the clips as they are created (one undo step with the track).
    if (options.style && options.style !== base && captionStyleById(options.style)) {
        for (const input of inputs) input.textStyle = captionStyleJson(options.style, input.textStyle as string | null) ?? input.textStyle;
    }
    return { track, tracks: [...tracks, track], inputs };
}
