// compileMux: the export's audio track alone, next to a video stream that was encoded elsewhere (the GPU export
// path). Input 0 is the pre-encoded video (MUX_VIDEO_SOURCE, resolved by the runner's mux()); the graph is the
// exact audio chain compileExport builds (compileAudio over buildAudioSources), so both export paths produce the
// same sound. Pure: media facts are passed in.
import { buildAudioSources } from "../audio-model";
import { quantize } from "../format";
import { FilterGraph } from "../graph";
import { DEFAULT_AUDIO_BITRATE_KBPS } from "../presets";
import { placeScenes, playableClips, timelineDuration } from "../timeline-model";
import { ExportError, type ExportInput, type ExportSettings, type ExportWarning, type MediaInfo, type OutputFormat, type PlanInput } from "../types";
import { compileAudio } from "./audio";
import type { CompileContext } from "./context";
import { exportFormat } from "./index";

/** PlanInput.source of the pre-encoded video in a MuxPlan (never a media URL, never written by the compiler). */
export const MUX_VIDEO_SOURCE = "gpu-video";

export interface MuxPlan {
    format: OutputFormat;
    durationSeconds: number;
    /** inputs[0] is the video ({ kind: "file", source: MUX_VIDEO_SOURCE }); the rest are audio media. */
    inputs: PlanInput[];
    filterGraph: string;
    audioLabel: string;
    audioBitrateKbps: number;
    warnings: ExportWarning[];
}

export function compileMux(input: ExportInput, settings: ExportSettings, options: { media: ReadonlyMap<string, MediaInfo> }): MuxPlan {
    const format = exportFormat(input, settings);
    const clips = playableClips(input.clips, input.tracks);
    const placed = placeScenes(input.scenes, input.tracks);
    const duration = quantize(timelineDuration(input.scenes, clips), format.fps);
    if (duration < 1 / format.fps) throw new ExportError("empty-timeline", "The timeline is empty: add a clip before exporting.");
    const graph = new FilterGraph();
    graph.input("file", MUX_VIDEO_SOURCE, []);
    const ctx: CompileContext = { graph, format, duration, media: options.media, rasters: new Map(), warnings: [], files: [], fileKeys: new Map() };
    const audioLabel = compileAudio(ctx, buildAudioSources({
        placed, tracks: input.tracks, clips, musicUrl: input.project.musicUrl, musicVolume: input.project.musicVolume, duration, fps: format.fps,
    }));
    return {
        format,
        durationSeconds: duration,
        inputs: graph.inputs,
        filterGraph: graph.toString(),
        audioLabel,
        audioBitrateKbps: settings.audioBitrateKbps ?? DEFAULT_AUDIO_BITRATE_KBPS,
        warnings: ctx.warnings,
    };
}

/**
 * The mux plan without its video input (the streaming web mux renders the audio track alone, then copies packets):
 * inputs[0] dropped and every input pad `[n:a]` / `[n:v]` of the graph renumbered to n − 1. Labels the compiler
 * names (`a3`, `amix0`) never take that form.
 */
export function audioOnlyPlan(plan: MuxPlan): MuxPlan {
    const filterGraph = plan.filterGraph.replace(/\[(\d+):([av])\]/g, (_match, n: string, kind: string) => {
        const index = Number(n);
        if (index === 0) throw new Error("the audio graph reads the video input"); // i18n-ignore
        return `[${index - 1}:${kind}]`;
    });
    return { ...plan, inputs: plan.inputs.slice(1), filterGraph };
}
