// MediaInfo from `ffprobe -show_entries stream=codec_type,width,height:format=duration -of json`.
import type { MediaInfo } from "./types";

export const FFPROBE_ARGS = ["-v", "error", "-show_entries", "stream=codec_type,width,height:format=duration", "-of", "json"];

export function parseFfprobeJson(text: string): MediaInfo | null {
    let data: { streams?: Array<{ codec_type?: string; width?: number; height?: number }>; format?: { duration?: string } };
    try {
        data = JSON.parse(text);
    } catch {
        return null;
    }
    const streams = data.streams ?? [];
    const video = streams.find((s) => s.codec_type === "video");
    const hasAudio = streams.some((s) => s.codec_type === "audio");
    if (!video && !hasAudio) return null;
    const duration = Number(data.format?.duration);
    return {
        durationSeconds: Number.isFinite(duration) && duration > 0 ? duration : 0,
        hasVideo: Boolean(video),
        hasAudio,
        width: video?.width ?? 0,
        height: video?.height ?? 0,
    };
}
