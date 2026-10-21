// The media an AI tool runs on (phase 11): a clip's or a scene's used range in SOURCE seconds (what Studio trims and
// uploads), its window on the timeline, and its constant speed, so a result maps back onto the timeline exactly:
//   timeline t  =  timelineStart + (source s − startSeconds) / speed.
// Items whose source range is not one straight span are refused with a reason instead of guessed: speed curves (and
// legacy ramps), reversed or frozen clips, shot-sequenced scenes (storyboards that play one file per shot), generative
// placeholders without media, and items on locked tracks. Pure.
import type { TimelineClip, TimelineTrack } from "../model/timeline";
import type { SceneData } from "../timeline/canvas/types";
import type { AiTargetRef } from "../controller/ai-run";
import { clipMediaStart, clipSpeedProfile, sceneSpeedProfile } from "../motion/speed";
import { getSceneDuration, getSceneSourceDuration, getSceneStart, parseSceneCardConfig } from "../timeline/scene-timing";
import { parseShotBreakdown } from "../lib/shot-utils";

/** The parts of a ControllerSnapshot the AI planners read. */
export interface AiSnapshot {
    clips: TimelineClip[];
    scenes: SceneData[];
    tracks: TimelineTrack[];
}

export type AiMediaKind = "video" | "audio" | "image";

export interface AiMediaSource {
    /** The item, as `{ clipId }` or `{ sceneId }`. */
    target: { clipId: string; sceneId?: undefined } | { sceneId: string; clipId?: undefined };
    mediaUrl: string;
    /** Used range of the media, source seconds (images: 0 .. the timeline length). */
    startSeconds: number;
    endSeconds: number;
    /** The item's window, timeline seconds. */
    timelineStart: number;
    timelineEnd: number;
    /** Source seconds per timeline second (constant). */
    speed: number;
    kind: AiMediaKind;
    /** The media carries sound Studio can send (audio clips, video clips, source-clip scenes, scenes made with audio). */
    hasAudio: boolean;
    width?: number;
    height?: number;
    /** The item's track ("video" for scenes) and its index. */
    trackType: string;
    trackIndex: number;
    /** A short name for job rows: the clip label, the scene caption, or the media file name. */
    label: string;
}

export type AiMediaSourceResult = { ok: true; source: AiMediaSource } | { ok: false; error: string };

/** Media seconds where a clip's used range starts (motion/speed.ts). */
export { clipMediaStart };

const IMAGE_URL = /\.(png|jpe?g|webp|gif|svg|avif|bmp)(\?|#|$)/i;
const EPS = 1e-9;

/** The last path segment of a media URL, decoded ("Interview.mp4"); "" when there is none. */
export function mediaFileName(url: string | null | undefined): string {
    if (!url) return "";
    const path = url.split(/[?#]/)[0];
    const last = path.split("/").filter(Boolean).pop() ?? "";
    try {
        return decodeURIComponent(last);
    } catch {
        return last;
    }
}

function trackLocked(tracks: TimelineTrack[], type: string, index: number): boolean {
    return tracks.some((track) => track.type === type && track.index === index && track.locked);
}

const fail = (error: string): AiMediaSourceResult => ({ ok: false, error });

function positive(value: unknown): number | undefined {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : undefined;
}

function clipSource(snapshot: AiSnapshot, clipId: string): AiMediaSourceResult {
    const clip = snapshot.clips.find((c) => c.id === clipId);
    if (!clip) return fail("No matching clip");
    if (clip.id.startsWith("temp-")) return fail("This clip is still being created");
    if (clip.trackType !== "video" && clip.trackType !== "audio") return fail("Select a video, audio, or image clip");
    if (clip.locked || trackLocked(snapshot.tracks, clip.trackType, clip.trackIndex)) return fail("The track is locked");
    if (!clip.mediaUrl) return fail(clip.mediaType === "ai_generate" ? "This clip has no media yet: generate it first" : "This clip has no media");
    const profile = clipSpeedProfile(clip);
    if (profile.curve) return fail("Speed curves are not supported here: set a constant speed first");
    if (clip.reversePlayback) return fail("Reversed clips are not supported here");
    if (clip.freezeFrame) return fail("Frozen clips are not supported here");
    const kind: AiMediaKind = clip.trackType === "audio" ? "audio" : clip.mediaType === "image" || IMAGE_URL.test(clip.mediaUrl) ? "image" : "video";
    const duration = Math.max(0, clip.endTime - clip.startTime);
    const speed = kind === "image" ? 1 : profile.speed;
    const startSeconds = kind === "image" ? 0 : clipMediaStart(clip);
    return {
        ok: true,
        source: {
            target: { clipId: clip.id },
            mediaUrl: clip.mediaUrl,
            startSeconds,
            endSeconds: startSeconds + duration * speed,
            timelineStart: clip.startTime,
            timelineEnd: clip.endTime,
            speed,
            kind,
            hasAudio: kind !== "image",
            trackType: clip.trackType,
            trackIndex: clip.trackIndex,
            label: clip.label || mediaFileName(clip.mediaUrl) || (kind === "audio" ? "Audio" : kind === "image" ? "Image" : "Video"),
        },
    };
}

/** The scene's single video file: a source clip's footage, else the generated video. */
export function sceneMediaUrl(scene: SceneData): string | null {
    if (scene.cardType === "source_clip") return scene.sourceVideoUrl || scene.videoUrl || null;
    return scene.videoUrl || null;
}

/** Scenes whose video plays shot by shot (one file per shot), or copy-video storyboards without a stitched video. */
export function isShotSequencedScene(scene: SceneData): boolean {
    if (sceneMediaUrl(scene)) return false;
    if (scene.cardType === "copy_video") return true;
    const shots = parseShotBreakdown<{ video_url?: string }>(scene.shotBreakdown);
    return shots.length > 0 && shots.some((shot) => Boolean(shot?.video_url));
}

function sceneSource(snapshot: AiSnapshot, sceneId: string): AiMediaSourceResult {
    const index = snapshot.scenes.findIndex((s) => s.id === sceneId);
    if (index < 0) return fail("No matching scene");
    const scene = snapshot.scenes[index];
    if (scene.id.startsWith("temp-")) return fail("This scene is still being created");
    const trackIndex = Math.max(1, Number(scene.trackIndex || 1));
    if (trackLocked(snapshot.tracks, "video", trackIndex)) return fail("The track is locked");
    if (isShotSequencedScene(scene)) return fail("This scene plays a storyboard of shots: render it to one video first");
    const video = sceneMediaUrl(scene);
    const image = video ? null : scene.startImageUrl || null;
    if (!video && !image) return fail("This scene has no media yet: generate it first");
    const profile = sceneSpeedProfile(scene);
    if (profile.curve) return fail("Speed curves are not supported here: set a constant speed first");
    const timelineStart = getSceneStart(scene, snapshot.scenes, index);
    const duration = getSceneDuration(scene);
    const config = parseSceneCardConfig(scene);
    const kind: AiMediaKind = video && !IMAGE_URL.test(video) ? "video" : "image";
    const trim = Number(config.timelineTrimStart ?? config.trimStart ?? 0);
    const startSeconds = kind === "image" || !(Number.isFinite(trim) && trim > 0) ? 0 : trim;
    const span = kind === "image" ? duration : getSceneSourceDuration(scene);
    const embeddedAudio = scene.cardType === "source_clip" || (scene as SceneData & { autoGenerateAudio?: boolean | null }).autoGenerateAudio === true;
    const mediaUrl = (video ?? image)!;
    const width = positive(scene.sourceWidth);
    const height = positive(scene.sourceHeight);
    return {
        ok: true,
        source: {
            target: { sceneId: scene.id },
            mediaUrl,
            startSeconds,
            endSeconds: startSeconds + span,
            timelineStart,
            timelineEnd: timelineStart + duration,
            speed: kind === "image" ? 1 : profile.speed,
            kind,
            hasAudio: kind === "video" && embeddedAudio,
            ...(width && height ? { width, height } : {}),
            trackType: "video",
            trackIndex,
            label: scene.caption?.trim() || mediaFileName(mediaUrl) || `Scene ${index + 1}`,
        },
    };
}

/** The media an AI tool would send for a clip or a scene, or why it cannot run on it. */
export function aiMediaSourceResult(snapshot: AiSnapshot, target: AiTargetRef): AiMediaSourceResult {
    if (target.sceneId) return sceneSource(snapshot, target.sceneId);
    if (target.clipId) return clipSource(snapshot, target.clipId);
    return fail("Select a clip or a scene");
}

/** The media an AI tool would send for a clip or a scene; null when it cannot run (aiMediaSourceError says why). */
export function aiMediaSource(snapshot: AiSnapshot, target: AiTargetRef): AiMediaSource | null {
    const result = aiMediaSourceResult(snapshot, target);
    return result.ok ? result.source : null;
}

/** Why aiMediaSource refuses the item; null when it does not. */
export function aiMediaSourceError(snapshot: AiSnapshot, target: AiTargetRef): string | null {
    const result = aiMediaSourceResult(snapshot, target);
    return result.ok ? null : result.error;
}

/** A source second of the item as timeline seconds (not clamped). */
export function sourceToTimeline(source: Pick<AiMediaSource, "startSeconds" | "timelineStart" | "speed">, seconds: number): number {
    return source.timelineStart + (seconds - source.startSeconds) / (source.speed > EPS ? source.speed : 1);
}

/** A timeline second inside the item as source seconds (not clamped). */
export function timelineToSource(source: Pick<AiMediaSource, "startSeconds" | "timelineStart" | "speed">, seconds: number): number {
    return source.startSeconds + (seconds - source.timelineStart) * (source.speed > EPS ? source.speed : 1);
}
