// MediaInfo via ffprobe.
import { FFPROBE_ARGS, parseFfprobeJson } from "../probe-json";
import type { MediaInfo } from "../types";
import { runProcess } from "./ffmpeg-binary";

/** `source` must come from a SourcePolicy; `inputGuards` are its whitelists. */
export async function probeFile(ffprobePath: string, source: string, signal?: AbortSignal, inputGuards: string[] = []): Promise<MediaInfo | null> {
    const result = await runProcess(ffprobePath, [...FFPROBE_ARGS, ...inputGuards, source], { signal });
    return result.code === 0 ? parseFfprobeJson(result.stdout) : null;
}
