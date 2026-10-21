// compileAudioMix: the timeline's audio alone (scene audio, voiceovers, audio clips, overlay clip audio, music),
// mixed exactly like the export's audio track (compileAudio), for transcription. No video filters.
import { buildAudioSources, type AudioSource } from "../audio-model";
import { quantize } from "../format";
import { FilterGraph } from "../graph";
import { resolveOutputFormat } from "../presets";
import { placeScenes, playableClips, timelineDuration } from "../timeline-model";
import { ExportError, type ExportInput, type ExportWarning, type MediaInfo, type PlanInput } from "../types";
import { compileAudio } from "./audio";
import type { CompileContext } from "./context";

/** Scene windows snap to this rate, as in a 30 fps export. */
const MIX_FPS = 30;

export interface AudioMixPlan {
    durationSeconds: number;
    inputs: PlanInput[];
    filterGraph: string;
    audioLabel: string;
    /** Sources with an audio stream that reach the mix. */
    sourceCount: number;
    warnings: ExportWarning[];
}

export function compileAudioMix(input: ExportInput, options: { media: ReadonlyMap<string, MediaInfo> }): AudioMixPlan {
    const clips = playableClips(input.clips, input.tracks);
    const placed = placeScenes(input.scenes, input.tracks);
    const duration = quantize(timelineDuration(input.scenes, clips), MIX_FPS);
    if (duration < 1 / MIX_FPS) throw new ExportError("empty-timeline", "The timeline is empty: add a clip first.");
    const sources = buildAudioSources({
        placed, tracks: input.tracks, clips, musicUrl: input.project.musicUrl, musicVolume: input.project.musicVolume, duration, fps: MIX_FPS,
    });
    const sourceCount = sources.filter((source) => options.media.get(source.url)?.hasAudio).length;
    if (sourceCount === 0) throw new ExportError("no-audio", "The timeline has no audio to transcribe.");
    const graph = new FilterGraph();
    const ctx: CompileContext = {
        graph, format: resolveOutputFormat(input.project.aspectRatio, "720p", MIX_FPS), duration, media: options.media, rasters: new Map(), warnings: [], files: [], fileKeys: new Map(),
    };
    const audioLabel = compileAudio(ctx, sources);
    return { durationSeconds: duration, inputs: graph.inputs, filterGraph: graph.toString(), audioLabel, sourceCount, warnings: ctx.warnings };
}

/**
 * The timeline's audible sources (the export's own audio model) and its length, without probing media (phase 11):
 * hosts without an ffmpeg runner (the browser) mix them for transcription. Sources whose media has no audio stream
 * are the caller's to skip.
 */
export function timelineAudioSources(input: ExportInput): { durationSeconds: number; sources: AudioSource[] } {
    const clips = playableClips(input.clips, input.tracks);
    const placed = placeScenes(input.scenes, input.tracks);
    const duration = quantize(timelineDuration(input.scenes, clips), MIX_FPS);
    if (duration < 1 / MIX_FPS) throw new ExportError("empty-timeline", "The timeline is empty: add a clip first.");
    const sources = buildAudioSources({
        placed, tracks: input.tracks, clips, musicUrl: input.project.musicUrl, musicVolume: input.project.musicVolume, duration, fps: MIX_FPS,
    });
    return { durationSeconds: duration, sources };
}
