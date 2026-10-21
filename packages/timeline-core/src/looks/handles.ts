// Live transition handles (phase 10b): a transition window is centered on its cut (looks/windows.ts), so
// the outgoing item is shown for `half` seconds after its end and the incoming one for `half` seconds before
// its start. Where the media really continues there (the outgoing item's media after its trim end, the
// incoming item's media before its trim start), the window shows those real frames; the rest of each side
// stays frozen on the item's last / first frame (phase 10a). Nothing moves on the timeline.
//
// One rule for the preview and the export, from data both have: scene trims (cardConfig timelineTrimStart /
// timelineTrimEnd), the stored content length (cardConfig timelineSourceDuration — unknown means no media
// after the trim end), the scene speed factor (handles are timeline seconds; media runs at the scene's mean
// speed beyond its edges), stills (infinite media: full handles), and shot-sequenced scenes (frozen). Clips
// on upper tracks play their media from their trimStart (motion/speed.ts clipMediaStart), so they have the
// media before it and the media after their span, measured by the host's probe of the file.
import type { TimelineClip } from "../model/timeline";
import type { SceneData } from "../timeline/canvas/types";
import { parseShotBreakdown } from "../lib/shot-utils";
import { clipMediaStart, clipSpeedProfile, isIdentitySpeed } from "../motion/speed";
import { sceneSpeedFactor } from "../timeline/scene-duration";
import { getSceneSourceDuration, parseSceneCardConfig } from "../timeline/scene-timing";

/** Where an item's frames sit in its media. */
export interface HandleMedia {
    /** Media second of the item's first frame. */
    sourceStart: number;
    /** Media second just after its last frame. */
    sourceEnd: number;
    /** Media length in seconds; null when unknown (no media after `sourceEnd` is assumed). */
    mediaLength: number | null;
    /** Media seconds per timeline second beyond the item's edges. */
    rate: number;
    /** A still image: the same frame at every time, so both handles are full. */
    still: boolean;
}

export interface TransitionHandles {
    /** Timeline seconds of real outgoing media after the cut (≤ half). */
    outgoingAfter: number;
    /** Timeline seconds of real incoming media before the cut (≤ half). */
    incomingBefore: number;
}

const clamp = (value: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, value));

/** Real media on each side of a window of half-length `half`; a null side keeps its frozen frame. */
export function transitionHandles(outgoing: HandleMedia | null, incoming: HandleMedia | null, half: number): TransitionHandles {
    const limit = Math.max(0, half);
    const after = (m: HandleMedia | null) => {
        if (!m) return 0;
        if (m.still) return limit;
        if (m.mediaLength === null || !(m.rate > 0)) return 0;
        return clamp((m.mediaLength - m.sourceEnd) / m.rate, 0, limit);
    };
    const before = (m: HandleMedia | null) => {
        if (!m) return 0;
        if (m.still) return limit;
        if (!(m.rate > 0)) return 0;
        return clamp(m.sourceStart / m.rate, 0, limit);
    };
    return { outgoingAfter: round9(after(outgoing)), incomingBefore: round9(before(incoming)) };
}

/** Float noise off (media seconds are ms-rounded; 0.1 / 1 must stay 0.1). */
const round9 = (value: number) => Math.round(value * 1e9) / 1e9;

/** Handles floored to whole frames (the export's windows are whole frames). */
export function snapHandles(handles: TransitionHandles, fps: number): TransitionHandles {
    const snap = (seconds: number) => Math.floor(seconds * fps + 1e-6) / fps;
    return { outgoingAfter: snap(handles.outgoingAfter), incomingBefore: snap(handles.incomingBefore) };
}

/** Media second shown `seconds` timeline seconds after the item's end ("after") or before its start ("before"). */
export function handleMediaTime(media: HandleMedia, edge: "after" | "before", seconds: number): number {
    if (media.still) return 0;
    return edge === "after" ? media.sourceEnd + seconds * media.rate : Math.max(0, media.sourceStart - seconds * media.rate);
}

type SceneFields = Partial<Pick<SceneData, "cardConfig" | "videoUrl" | "sourceVideoUrl" | "cardType" | "shotBreakdown" | "startImageUrl" | "startImageThumbUrl"
    | "duration" | "endTime" | "startTime" | "playbackSpeed" | "speedCurveJson" | "preservePitch">>;

/**
 * A scene's handle media: its video (stitched or a source clip's footage) at its trim, a still for an image
 * scene, null (frozen) for shot-sequenced and empty scenes.
 */
export function sceneHandleMedia(scene: SceneFields): HandleMedia | null {
    const video = scene.videoUrl || (scene.cardType === "source_clip" ? scene.sourceVideoUrl : null);
    if (!video) {
        const shots = parseShotBreakdown<{ video_url?: string }>(scene.shotBreakdown ?? null);
        if (shots.length > 0 && shots.every((shot) => Boolean(shot.video_url))) return null;
        const image = scene.startImageUrl || scene.startImageThumbUrl;
        return image ? { sourceStart: 0, sourceEnd: 0, mediaLength: null, rate: 1, still: true } : null;
    }
    const config = parseSceneCardConfig({ cardConfig: scene.cardConfig ?? null });
    const trimStart = Number(config.timelineTrimStart ?? config.trimStart);
    const trimEnd = Number(config.timelineTrimEnd ?? config.trimEnd);
    const trimmed = Number.isFinite(trimStart) && Number.isFinite(trimEnd) && trimEnd > trimStart;
    const sourceStart = Number.isFinite(trimStart) && trimStart > 0 ? trimStart : 0;
    const sourceEnd = trimmed ? trimEnd : sourceStart + untrimmedSpan(scene);
    const stored = Number(config.timelineSourceDuration);
    const mediaLength = Number.isFinite(stored) && stored > 0 ? stored : null;
    return { sourceStart, sourceEnd, mediaLength, rate: sceneSpeedFactor(scene), still: false };
}

/** The media span of an untrimmed scene (scene-timing.ts); 0 for partial scene shapes the preview passes around. */
function untrimmedSpan(scene: SceneFields): number {
    if (scene.duration == null && (typeof scene.startTime !== "string" || typeof scene.endTime !== "string")) return 0;
    return getSceneSourceDuration(scene as SceneData);
}

type ClipFields = Pick<TimelineClip, "startTime" | "endTime" | "mediaUrl" | "mediaType">
    & Partial<Pick<TimelineClip, "playbackSpeed" | "speedRamp" | "speedCurveJson" | "preservePitch" | "reversePlayback" | "freezeFrame" | "trimStart">>;

const GIF = /\.gif(\?|#|$)/i;
const STILL = /\.(png|jpe?g|webp)(\?|#|$)/i;

/**
 * An upper-track video/image clip's handle media, from its trimStart. `mediaLength` is the file's length as the host knows it
 * (the export's probe, the preview's decoder); null when unknown. Sped-up, reversed, frozen, and GIF clips
 * keep frozen frames.
 */
export function clipHandleMedia(clip: ClipFields, mediaLength: number | null): HandleMedia | null {
    const url = clip.mediaUrl ?? "";
    if (!url || GIF.test(url)) return null;
    if (clip.mediaType === "image" || STILL.test(url)) return { sourceStart: 0, sourceEnd: 0, mediaLength: null, rate: 1, still: true };
    if (clip.reversePlayback || clip.freezeFrame) return null;
    if (!isIdentitySpeed(clipSpeedProfile(clip))) return null;
    const length = Number.isFinite(mediaLength) && (mediaLength as number) > 0 ? (mediaLength as number) : null;
    const sourceStart = clipMediaStart(clip);
    return { sourceStart, sourceEnd: round9(sourceStart + Math.max(0, clip.endTime - clip.startTime)), mediaLength: length, rate: 1, still: false };
}
