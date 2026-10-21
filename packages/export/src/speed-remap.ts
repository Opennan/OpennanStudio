// Speed in the export (phase 10b, plan Architecture item 7): speed profiles (timeline-core motion/speed.ts)
// as ffmpeg time remaps for video and as atempo / asetrate segment chains for audio.
//
// Video. A remapped stream gets `settb=AVTB` (µs timestamps, so the result never depends on the media's
// own timebase: setpts truncates to it) and `setpts='(out(σ) + push + bias)/TB'`, where σ is the item
// source second of the frame and out = outputTimeExpr, the exact inverse of the time map. The `fps`
// filter after it (round=near) then shows, at output frame n, the last source frame whose remapped time
// rounds to n or earlier:
//
//     frame(n) = max { k : out(t_k) + bias < (n + ½) / fps }  =  the source frame visible at S((n + ½) / fps),
//
// the middle of the output frame. This is ffmpeg's own rule for `setpts=PTS/s,fps` (10a exports and the
// legacy ramps keep their frames), measured on FFmpeg 7.1.5 and ffmpeg.wasm 5.1.4. A source frame exactly
// at an output frame's middle (2×: every odd frame) is a tie that round-half-away sends to the next output
// frame; `bias` (1e-4 frame) keeps that decision away from float noise and settb's µs truncation, so both
// versions agree exactly. Frames at or past the source span get two frames of `push` (never shown), and
// the read includes them on purpose: fps then emits the last frame without relying on EOF flushing.
//
// Audio. A stretched source is cut into the profile's contiguous output slices (audioSegments: exact for
// constant speed and step curves; sloped curve parts are split finely enough that the audio stays within
// half a frame of the picture, capped at MAX_AUDIO_SLICE_DENSITY slices per item length). Each slice is
// atrimmed from one shared read, stretched (atempo chain keeps pitch, asetrate+aresample lets it follow),
// padded/trimmed to its exact sample count (atempo drops up to ~180 ms at the end otherwise), and the
// slices are concatenated.
import { ffNumber, add, div, emitFfmpeg, v, type Expr } from "@opennan/timeline-core/looks/expr";
import {
    AUDIO_CURVE_SEGMENTS, audioSegments, isIdentitySpeed, outputTimeAt, outputTimeExpr, sourceSpan, sourceTimeAt,
    type AudioSegment, type SpeedProfile,
} from "@opennan/timeline-core/motion/speed";
import { tempoFilters } from "./filters/audio";

/** Remapped frames land this fraction of an output frame late (see the header): ties go to the next frame. */
export const REMAP_BIAS_FRAMES = 1e-4;
/** Source seconds read past a remapped span: pushed past the end, they make fps emit the last frame. */
export const VIDEO_SLACK_SECONDS = 0.25;
/** Source seconds read before a remapped scene piece: the frame visible at the piece's first output frame. */
export const VIDEO_PREROLL_SECONDS = 0.25;
/** Most audio slices per item length for sloped curves (each slice is an atrim + tempo chain). */
export const MAX_AUDIO_SLICE_DENSITY = 128;
/** The export's audio rate (compile/audio.ts normalizes every source to it before stretching). */
export const AUDIO_RATE = 48000;

/** How a video stream's timestamps map to item output time. */
export interface SpeedRemap {
    profile: SpeedProfile;
    /** Timeline length D the profile spans (the whole item). */
    length: number;
    /** Item-local output second the stream starts at (0 for a whole clip; a scene piece's start). */
    from: number;
    /** Item source second at stream time T = 0. */
    sourceAtZero: number;
    /** Media seconds per item source second (1, or a shot sequence's stretch). */
    rate: number;
}

/** The remap of a whole clip read from its media start (null at identity speed: no remap). */
export function clipRemap(profile: SpeedProfile, length: number): SpeedRemap | null {
    if (isIdentitySpeed(profile) || !(length > 0)) return null;
    return { profile, length, from: 0, sourceAtZero: 0, rate: 1 };
}

/** Item source second of stream time T. */
function sourceExpr(remap: SpeedRemap): Expr {
    const t = remap.rate === 1 ? v("T") : div(v("T"), remap.rate);
    return remap.sourceAtZero === 0 ? t : add(t, remap.sourceAtZero);
}

/** `settb` + `setpts` for a remapped stream; `fps=<fps>` must follow. */
export function remapFilters(remap: SpeedRemap, fps: number): string[] {
    const scalar = { target: "scalar" as const, time: "T" };
    const source = sourceExpr(remap);
    const out = emitFfmpeg(outputTimeExpr(remap.profile, remap.length, source), scalar);
    const shifted = remap.from > 0 ? `max(0,${out}-${ffNumber(remap.from)})` : out;
    const push = `gte(${emitFfmpeg(source, scalar)},${ffNumber(sourceSpan(remap.profile, remap.length))})*${ffNumber(2 / fps)}`;
    return ["settb=AVTB", `setpts='(${shifted}+${push}+${ffNumber(REMAP_BIAS_FRAMES / fps)})/TB'`];
}

const floorMs = (seconds: number) => Math.floor(seconds * 1000 + 1e-7) / 1000;
const ceilMs = (seconds: number) => Math.ceil(seconds * 1000 - 1e-7) / 1000;

export interface PieceRead {
    /** `-ss`: media seconds, whole milliseconds (exactly what ffmpeg parses). */
    readStart: number;
    /** `-t`: media seconds, whole milliseconds. */
    readLength: number;
    remap: SpeedRemap;
}

export interface PieceReadInput {
    profile: SpeedProfile;
    /** Item timeline length D. */
    length: number;
    /** Item-local output second the piece starts at, and its timeline length. */
    from: number;
    duration: number;
    /** Media second of item source second 0 (a scene's trim start; −shot start for a shot), and media seconds per source second. */
    origin: number;
    rate: number;
}

/**
 * The media read and remap for item output [from, from + duration) of a sped-up item: media from a pre-roll
 * before S(from) (so the frame visible at the piece start is decoded) to past S(from + duration). Stream
 * timestamps stay absolute after `-ss` (no setpts=PTS-STARTPTS): T = media second − readStart on both
 * ffmpeg versions, so the remap is exact whatever frame the seek lands on.
 */
export function pieceRead(input: PieceReadInput): PieceRead {
    const { profile, length, from, duration, origin, rate } = input;
    const mediaFrom = origin + rate * sourceTimeAt(profile, from, length);
    const mediaTo = origin + rate * sourceTimeAt(profile, from + duration, length);
    const readStart = Math.max(0, floorMs(mediaFrom - VIDEO_PREROLL_SECONDS));
    const readLength = ceilMs(mediaTo - readStart + VIDEO_SLACK_SECONDS);
    return { readStart, readLength, remap: { profile, length, from, sourceAtZero: (readStart - origin) / rate, rate } };
}

/**
 * The reference rule (tests and the preview contract): the item source frame (at `sourceFps`, item source
 * second k / sourceFps) shown at output frame n of a stream starting at item output second `from`.
 */
export function pickSourceFrame(profile: SpeedProfile, length: number, n: number, fps: number, sourceFps: number, from = 0): number {
    const span = sourceSpan(profile, length);
    const limit = (n + 0.5) / fps;
    const shown = (k: number) => k / sourceFps < span && Math.max(0, outputTimeAt(profile, k / sourceFps, length) - from) + REMAP_BIAS_FRAMES / fps < limit;
    let lo = 0;
    let hi = Math.max(1, Math.ceil(span * sourceFps));
    while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (shown(mid)) lo = mid;
        else hi = mid;
    }
    return lo;
}

// ── audio ────────────────────────────────────────────────

export interface AudioStretch {
    /** Contiguous output slices (seconds from the source's start) and the media seconds they play (from its read offset). */
    segments: AudioSegment[];
    preservePitch: boolean;
    /** Largest audio-to-picture offset inside a sloped curve slice, in seconds (0 when exact). */
    drift: number;
}

/** Slice density for audioSegments and the drift it leaves (see the header). */
function audioSliceDensity(profile: SpeedProfile, length: number, fps: number): { density: number; drift: number } {
    const points = profile.curve?.points ?? [];
    const sloped: Array<{ width: number; slope: number; low: number }> = [];
    for (let i = 0; i + 1 < points.length; i += 1) {
        const width = points[i + 1][0] - points[i][0];
        if (width > 0 && points[i + 1][1] !== points[i][1]) {
            sloped.push({ width, slope: Math.abs(points[i + 1][1] - points[i][1]) / width, low: Math.min(points[i][1], points[i + 1][1]) });
        }
    }
    if (sloped.length === 0) return { density: AUDIO_CURVE_SEGMENTS, drift: 0 };
    // Within a slice of output length h the picture's source time S is quadratic (S'' = s·m/D) and the audio
    // is linear between the same ends: they differ by at most s·m·h²/(8D) source seconds, i.e.
    // m·D·(w/count)²/(8·y_min) output seconds (the base speed cancels).
    const tolerance = 0.5 / fps;
    let density = AUDIO_CURVE_SEGMENTS;
    for (const g of sloped) density = Math.max(density, Math.ceil(Math.sqrt((g.slope * length) / (8 * g.low * tolerance))));
    density = Math.min(density, MAX_AUDIO_SLICE_DENSITY);
    let drift = 0;
    for (const g of sloped) {
        const count = Math.max(1, Math.ceil(density * g.width - 1e-9));
        drift = Math.max(drift, (g.slope * length * (g.width / count) ** 2) / (8 * g.low));
    }
    return { density, drift };
}

/**
 * Audio for item output [from, to) of an item of length D whose media second is origin + rate·S(t):
 * `mediaStart` is rate·S(from) (add the origin), `stretch` null when the audio plays 1:1.
 */
export function audioStretch(profile: SpeedProfile, length: number, from: number, to: number, rate: number, fps: number): { mediaStart: number; stretch: AudioStretch | null } {
    if (isIdentitySpeed(profile) && rate === 1) return { mediaStart: from, stretch: null };
    const start = sourceTimeAt(profile, from, length);
    const { density, drift } = audioSliceDensity(profile, length, fps);
    const segments: AudioSegment[] = [];
    for (const g of audioSegments(profile, length, density)) {
        const a = Math.max(g.outputStart, from);
        const b = Math.min(g.outputEnd, to);
        if (!(b - a > 1e-9)) continue;
        const sa = a === g.outputStart ? g.sourceStart : sourceTimeAt(profile, a, length);
        const sb = b === g.outputEnd ? g.sourceEnd : sourceTimeAt(profile, b, length);
        segments.push({ outputStart: a - from, outputEnd: b - from, sourceStart: rate * (sa - start), sourceEnd: rate * (sb - start), speed: (rate * (sb - sa)) / (b - a) });
    }
    if (segments.length === 0) return { mediaStart: rate * start, stretch: null };
    return { mediaStart: rate * start, stretch: { segments, preservePitch: profile.preservePitch, drift } };
}

/** Tempo for one slice: atempo steps inside 0.5-2 (pitch kept; atempo skips samples above 2), or a resample (pitch follows). */
export function audioTempoFilters(speed: number, preservePitch: boolean): string[] {
    if (preservePitch) return tempoFilters(speed);
    if (Math.abs(speed - 1) <= 1e-9) return [];
    return [`asetrate=${Math.max(1, Math.round(AUDIO_RATE * speed))}`, `aresample=${AUDIO_RATE}`];
}

/** Extra source seconds each slice reads past its end so atempo's tail flush is real audio (trimmed after). */
export function audioSegmentOverlap(speed: number): number {
    return Math.max(0.1, 0.1 * speed);
}
