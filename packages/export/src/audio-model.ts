// What the preview makes audible, as timed sources: scene video audio and scene voiceover for the
// active scene, the project soundtrack, timeline audio clips, and V2+ overlay clip audio.
// Rules cite scene-preview.tsx (phase 2 port) and preview-panel.tsx.
import type { SceneData, TimelineClip, TimelineTrack } from "@opennan/timeline-core";
import {
    shouldMuteDetachedSourceVideoAtTime, shouldMuteEmbeddedVideoForTimelineVoiceover, timelineHasMatchingVoiceoverClip,
    timelineOwnsSceneAudioAtTime, timelineOwnsSceneVoiceoverPlayback,
} from "@opennan/timeline-core/lib/preview-timeline-clips";
import { clipMediaStart, clipSpeedProfile, sceneSpeedProfile } from "@opennan/timeline-core/motion/speed";
import { normalizedVolume } from "./clip-params";
import { clamp, num } from "./format";
import { audioStretch, type AudioStretch } from "./speed-remap";
import {
    activeSceneWindows, parseCardConfig, sceneDuration, sceneShotSequence, sceneTrimStart, sceneVideoUrl, type PlacedScene,
} from "./timeline-model";

export interface AudioSource {
    kind: "scene-video" | "scene-voiceover" | "music" | "clip" | "overlay-clip";
    url: string;
    /** Timeline seconds where the source starts and how long it plays. */
    start: number;
    duration: number;
    /** Seconds into the media where playback begins. */
    sourceOffset: number;
    /** Speed (phase 10b): output slices and the media seconds each plays from `sourceOffset`; null plays 1:1. */
    stretch: AudioStretch | null;
    /** Static gain (track faders folded in), except "clip" whose clip volume may be keyframed. */
    volume: number;
    trackVolume: number;
    /** Timeline windows where the preview silences this source. */
    muted: Array<[number, number]>;
    clip: TimelineClip | null;
    /** The scene a scene-video or scene-voiceover source belongs to, for warnings. */
    sceneId?: string;
}

type AudioLayer = { type?: unknown; url?: unknown; volume?: unknown };

function audioLayers(scene: SceneData): AudioLayer[] {
    const layers = parseCardConfig(scene).audio_layers;
    return Array.isArray(layers) ? layers.filter((l): l is AudioLayer => Boolean(l) && typeof l === "object" && !Array.isArray(l)) : [];
}

/** scene-preview.tsx:147-159 */
export function sceneAudioUrl(scene: SceneData): string | null {
    if (scene.audioUrl) return scene.audioUrl;
    for (const layer of audioLayers(scene)) {
        if ((layer.type === "extracted" || layer.type === "voiceover") && typeof layer.url === "string" && layer.url) return layer.url;
    }
    return null;
}

/** scene-preview.tsx:161-174 */
function sceneAudioVolume(scene: SceneData, url: string): number {
    for (const layer of audioLayers(scene)) {
        if (layer.url !== url && (scene.audioUrl || (layer.type !== "extracted" && layer.type !== "voiceover"))) continue;
        const volume = Number(layer.volume ?? 1);
        return Number.isFinite(volume) ? clamp(volume, 0, 1) : 1;
    }
    return 1;
}

/** scene-preview.tsx:176-191: source-clip audio and a direct audioUrl follow the scene trim. */
function sceneAudioBaseOffset(scene: SceneData, url: string): number {
    const usesTrimmedSourceAudio = scene.cardType === "source_clip"
        && audioLayers(scene).some((layer) => layer.url === url || layer.type === "extracted");
    return usesTrimmedSourceAudio || url === scene.audioUrl ? sceneTrimStart(scene) : 0;
}

/**
 * Whether the scene audio is the scene's own SOURCE sound and so follows the scene speed: an extracted layer, or
 * a source clip's audioUrl (trimmed with the video). Voiceovers (a voiceover layer, audioUrl on a generated scene)
 * keep speed 1. Same rule as the preview (scene-preview.tsx sceneAudioFollowsSpeed).
 */
function sceneAudioFollowsSpeed(scene: SceneData, url: string): boolean {
    for (const layer of audioLayers(scene)) {
        if (layer.url === url) return layer.type === "extracted";
    }
    return scene.cardType === "source_clip" && url === scene.audioUrl;
}

/** scene-preview.tsx:193-199 */
function baseAudioTrackAudible(tracks: TimelineTrack[]): boolean {
    const track = tracks.find((t) => t.type === "audio" && t.index === 1);
    if (!track) return true;
    const volume = Number(track.volume ?? 1);
    return track.visible !== false && !track.muted && (!Number.isFinite(volume) || volume > 0.001);
}

/** scene-preview.tsx:204-208 */
function audioTrackVolume(tracks: TimelineTrack[], index: number): number {
    return normalizedVolume(tracks.find((t) => t.type === "audio" && t.index === index)?.volume ?? 1);
}

/** scene-preview.tsx:213-218 */
function videoTrackVolume(tracks: TimelineTrack[], index: number): number {
    const track = tracks.find((t) => t.type === "video" && t.index === index);
    if (track?.muted) return 0;
    return normalizedVolume(track?.volume ?? 1);
}

/** scene-preview.tsx:220-228 */
function sceneVideoHasEmbeddedAudio(scene: SceneData): boolean {
    if (scene.cardType === "podcast" && scene.videoUrl) return true;
    if (sceneAudioUrl(scene)) return false;
    return scene.cardType === "source_clip" || (scene as SceneData & { autoGenerateAudio?: boolean | null }).autoGenerateAudio === true;
}

/** Clip ranges where `holds(clip, mid)` is true: each preview predicate is "some clip covering t". */
function windowsWhere(clips: TimelineClip[], holds: (single: TimelineClip[], time: number) => boolean): Array<[number, number]> {
    return clips
        .filter((clip) => clip.endTime > clip.startTime && holds([clip], (clip.startTime + clip.endTime) / 2))
        .map((clip): [number, number] => [clip.startTime, clip.endTime]);
}

/** shouldPlaySceneVideoAudio (scene-preview.tsx:230-256) as mute windows. */
function sceneVideoMuteWindows(scene: SceneData, clips: TimelineClip[]): Array<[number, number]> {
    const boundVoiceover = Boolean(sceneAudioUrl(scene));
    return [
        ...windowsWhere(clips, (c, t) => timelineOwnsSceneAudioAtTime(scene.id, c, t)),
        ...(scene.cardType === "source_clip" && scene.sourceVideoUrl
            ? windowsWhere(clips, (c, t) => shouldMuteDetachedSourceVideoAtTime(scene.sourceVideoUrl, c, t))
            : []),
        ...(scene.videoUrl ? windowsWhere(clips, (c, t) => shouldMuteDetachedSourceVideoAtTime(scene.videoUrl, c, t)) : []),
        ...windowsWhere(clips, (c, t) => shouldMuteEmbeddedVideoForTimelineVoiceover(boundVoiceover, c, t)),
    ];
}

export interface AudioModelInput {
    placed: PlacedScene[];
    tracks: TimelineTrack[];
    /** Playable clips (filterPreviewTimelineClips). */
    clips: TimelineClip[];
    musicUrl: string | null;
    musicVolume: number;
    duration: number;
    /** Scene windows snap to frames like the video lanes (buildSceneLanes). */
    fps: number;
}

export function buildAudioSources(input: AudioModelInput): AudioSource[] {
    const { tracks, clips, duration } = input;
    const sources: AudioSource[] = [];
    const audible = baseAudioTrackAudible(tracks);
    const a1 = audioTrackVolume(tracks, 1);
    const audioClips = clips.filter((clip) => clip.trackType === "audio");

    const frame = (seconds: number) => Math.round(seconds * input.fps) / input.fps;
    for (const window of activeSceneWindows(input.placed)) {
        if (!audible) break;
        const scene = window.placed.scene;
        const start = frame(window.start);
        const intoScene = Math.max(0, start - frame(window.placed.start));
        const span = Math.min(frame(window.end), duration) - start;
        if (span <= 0) continue;
        // Speed: the scene's source sound reads from S(into the scene) and follows the profile (speed-remap.ts).
        const profile = sceneSpeedProfile(scene);
        const length = sceneDuration(scene);
        const videoUrl = sceneVideoUrl(scene);
        const shots = sceneShotSequence(scene);
        if (shots && sceneVideoHasEmbeddedAudio(scene)) {
            // ShotSequencerV2 plays each shot's own audio at the A1 fader (scene-preview.tsx:3693-3695).
            const muted = sceneVideoMuteWindows(scene, clips);
            for (const shot of shots) {
                const from = Math.max(shot.start, intoScene);
                const to = Math.min(shot.end, intoScene + span);
                if (to - from <= 0) continue;
                const timed = audioStretch(profile, length, from, to, shot.rate, input.fps);
                sources.push({
                    kind: "scene-video", url: shot.url, start: start + (from - intoScene), duration: to - from,
                    sourceOffset: timed.stretch ? Math.max(0, timed.mediaStart - shot.rate * shot.sourceStart) : from - shot.start,
                    stretch: timed.stretch, volume: a1, trackVolume: 1, muted, clip: null, sceneId: scene.id,
                });
            }
        } else if (videoUrl && sceneVideoHasEmbeddedAudio(scene)) {
            const timed = audioStretch(profile, length, intoScene, intoScene + span, 1, input.fps);
            sources.push({
                kind: "scene-video", url: videoUrl, start, duration: span, sourceOffset: sceneTrimStart(scene) + timed.mediaStart,
                stretch: timed.stretch, volume: a1 * videoTrackVolume(tracks, window.placed.trackIndex), trackVolume: 1,
                muted: sceneVideoMuteWindows(scene, clips), clip: null, sceneId: scene.id,
            });
        }
        // syncVoiceover (scene-preview.tsx:1182-1222)
        const voiceUrl = sceneAudioUrl(scene);
        if (!voiceUrl || (scene.cardType === "podcast" && scene.videoUrl)) continue;
        const voiceVolume = sceneAudioVolume(scene, voiceUrl);
        if (voiceVolume <= 0.001 || timelineHasMatchingVoiceoverClip(voiceUrl, audioClips)) continue;
        const timed = sceneAudioFollowsSpeed(scene, voiceUrl)
            ? audioStretch(profile, length, intoScene, intoScene + span, 1, input.fps)
            : { mediaStart: intoScene, stretch: null };
        sources.push({
            kind: "scene-voiceover", url: voiceUrl, start, duration: span,
            sourceOffset: sceneAudioBaseOffset(scene, voiceUrl) + timed.mediaStart, stretch: timed.stretch, volume: a1 * voiceVolume, trackVolume: 1,
            muted: windowsWhere(audioClips, (c, t) => timelineOwnsSceneVoiceoverPlayback(voiceUrl, c, t)), clip: null, sceneId: scene.id,
        });
    }

    // Soundtrack follows the playhead from 0 at musicVolume × A1 fader (scene-preview.tsx:855-862, 876-885).
    if (input.musicUrl && audible) {
        sources.push({
            kind: "music", url: input.musicUrl, start: 0, duration, sourceOffset: 0, stretch: null,
            volume: normalizedVolume(input.musicVolume) * a1, trackVolume: 1, muted: [], clip: null,
        });
    }

    // Timeline audio clips: offset (t - start) + trimStart, volume × track fader (scene-preview.tsx:1253-1279).
    for (const clip of audioClips) {
        if (!clip.mediaUrl || clip.endTime <= clip.startTime) continue;
        const length = clip.endTime - clip.startTime;
        sources.push({
            kind: "clip", url: clip.mediaUrl, start: clip.startTime, duration: Math.min(clip.endTime, duration) - clip.startTime,
            sourceOffset: Math.max(0, num(clip.trimStart, 0)), stretch: audioStretch(clipSpeedProfile(clip), length, 0, length, 1, input.fps).stretch,
            volume: normalizedVolume(clip.volume),
            trackVolume: audioTrackVolume(tracks, clip.trackIndex), muted: [], clip,
        });
    }

    // V2+ overlay video clip audio: clip volume × video fader, silent when the track is muted (preview-panel.tsx:1163-1177).
    for (const clip of clips) {
        if (clip.trackType !== "video" || (clip.trackIndex ?? 2) < 2 || !clip.mediaUrl || clip.endTime <= clip.startTime) continue;
        if (clip.mediaType === "image" || /\.(png|jpe?g|webp|gif)(\?|#|$)/i.test(clip.mediaUrl)) continue;
        const gain = normalizedVolume(clip.volume) * videoTrackVolume(tracks, clip.trackIndex ?? 2);
        if (gain <= 0.001) continue;
        // From the clip's trimStart; speed, curves and legacy ramps follow the picture's time map (speed-remap.ts audioStretch).
        const length = clip.endTime - clip.startTime;
        sources.push({
            kind: "overlay-clip", url: clip.mediaUrl, start: clip.startTime, duration: Math.min(clip.endTime, duration) - clip.startTime,
            sourceOffset: clipMediaStart(clip), stretch: audioStretch(clipSpeedProfile(clip), length, 0, length, 1, input.fps).stretch,
            volume: gain, trackVolume: 1, muted: [], clip,
        });
    }
    return sources.filter((source) => source.duration > 0);
}
