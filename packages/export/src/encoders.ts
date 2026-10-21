// Video encoder choice. Shipped desktop builds use an LGPL ffmpeg (spec §3), so H.264 comes from
// platform encoders or OpenH264; libx264 (GPL) is used only when the caller allows it.
export type ExportContainer = "mp4" | "webm" | "mkv" | "gif";

export interface EncoderChoice {
    /** ffmpeg encoder name. */
    name: string;
    container: ExportContainer;
    /** Needs a GPL ffmpeg build. */
    gpl: boolean;
    /** Options placed before the first -i (hardware device setup). */
    globalArgs: string[];
    /** Filters appended to the final video pad (hardware upload). */
    videoFilters: string[];
    videoArgs: string[];
    audioArgs: string[];
    /** The output has no audio (GIF): the graph's audio is discarded. */
    noAudio?: boolean;
}

/** LGPL-safe H.264 encoders in preference order: macOS, Windows, Linux VAAPI, OpenH264. */
export const LGPL_H264_ENCODERS = ["h264_videotoolbox", "h264_mf", "h264_vaapi", "libopenh264"] as const;

export interface EncoderOptions {
    videoBitrateKbps: number;
    audioBitrateKbps: number;
    /** Allow GPL encoders (libx264). Default false. */
    allowGpl?: boolean;
    /** VAAPI render node. Default /dev/dri/renderD128. */
    vaapiDevice?: string;
}

/** Encoder names from `ffmpeg -encoders` output. */
export function parseEncoderList(text: string): Set<string> {
    const names = new Set<string>();
    for (const line of text.split(/\r?\n/)) {
        const match = line.match(/^\s*[VAS][.A-Z]{5}\s+(\S+)/);
        if (match && match[1] !== "=") names.add(match[1]);
    }
    return names;
}

const aac = (kbps: number) => ["-c:a", "aac", "-b:a", `${kbps}k`, "-ar", "48000", "-ac", "2"];

export function encoderChoice(name: string, options: EncoderOptions): EncoderChoice {
    const v = `${options.videoBitrateKbps}k`;
    const base = { name, container: "mp4" as ExportContainer, gpl: false, globalArgs: [] as string[], videoFilters: [] as string[], audioArgs: aac(options.audioBitrateKbps) };
    switch (name) {
        case "h264_videotoolbox":
            return { ...base, videoArgs: ["-c:v", name, "-b:v", v, "-allow_sw", "1", "-pix_fmt", "yuv420p"] };
        case "h264_mf":
            return { ...base, videoArgs: ["-c:v", name, "-b:v", v, "-pix_fmt", "nv12"] };
        case "h264_vaapi":
            return {
                ...base,
                globalArgs: ["-vaapi_device", options.vaapiDevice ?? "/dev/dri/renderD128"],
                videoFilters: ["format=nv12", "hwupload"],
                videoArgs: ["-c:v", name, "-b:v", v],
            };
        case "libopenh264":
            return { ...base, videoArgs: ["-c:v", name, "-b:v", v, "-pix_fmt", "yuv420p"] };
        case "libx264":
            return { ...base, gpl: true, videoArgs: ["-c:v", name, "-preset", "veryfast", "-b:v", v, "-pix_fmt", "yuv420p"] };
        case "libvpx-vp9":
            return {
                ...base, container: "webm",
                videoArgs: ["-c:v", name, "-b:v", v, "-deadline", "realtime", "-cpu-used", "8", "-row-mt", "1", "-pix_fmt", "yuv420p"],
                audioArgs: ["-c:a", "libopus", "-b:a", `${options.audioBitrateKbps}k`, "-ar", "48000", "-ac", "2"],
            };
        case "mpeg4":
            return { ...base, videoArgs: ["-c:v", name, "-b:v", v, "-pix_fmt", "yuv420p"] };
        default:
            throw new Error(`unsupported encoder ${name}`);
    }
}

/**
 * Candidates in order: LGPL H.264 encoders, libx264 when GPL is allowed, VP9/Opus WebM, then the
 * native MPEG-4 Part 2 encoder that every ffmpeg build has.
 */
export function encoderCandidates(available: Set<string>, options: EncoderOptions): EncoderChoice[] {
    const names: string[] = LGPL_H264_ENCODERS.filter((name) => available.has(name));
    if (options.allowGpl && available.has("libx264")) names.push("libx264");
    if (available.has("libvpx-vp9") && available.has("libopus")) names.push("libvpx-vp9");
    names.push("mpeg4");
    return names.map((name) => encoderChoice(name, options));
}

/** Lossless intermediate for two-pass GL export (FFV1 + FLAC in Matroska, both LGPL). */
export const INTERMEDIATE_ENCODER: EncoderChoice = {
    name: "ffv1",
    container: "mkv",
    gpl: false,
    globalArgs: [],
    videoFilters: [],
    videoArgs: ["-c:v", "ffv1", "-level", "3", "-pix_fmt", "yuv420p"],
    audioArgs: ["-c:a", "flac", "-ar", "48000", "-ac", "2"],
};

export function containerMimeType(container: ExportContainer): string {
    if (container === "gif") return "image/gif";
    return container === "webm" ? "video/webm" : container === "mkv" ? "video/x-matroska" : "video/mp4";
}

// ── GIF output (phase 10d) ───────────────────────────────

/** The GIF's frame rate and size, pinned before the palette (the frames already have them; the filters keep both engines equal). */
export function gifFrameFilters(format: { width: number; height: number; fps: number }): string[] {
    return [`fps=${format.fps}`, `scale=${format.width}:${format.height}:flags=lanczos`];
}

/**
 * The GIF encoder for the ffmpeg path: the frame filters, then one palette for the whole clip (palettegen over every
 * frame) applied with paletteuse's default dithering — LGPL filters in every bundled build and the ffmpeg.wasm
 * core — written by the gif muxer looping forever, without audio.
 */
export function gifEncoder(format: { width: number; height: number; fps: number }): EncoderChoice {
    return {
        name: "gif",
        container: "gif",
        gpl: false,
        globalArgs: [],
        videoFilters: [...gifFrameFilters(format), "split[gifa][gifb];[gifa]palettegen[gifp];[gifb][gifp]paletteuse"],
        videoArgs: ["-c:v", "gif", "-loop", "0"],
        audioArgs: [],
        noAudio: true,
    };
}
