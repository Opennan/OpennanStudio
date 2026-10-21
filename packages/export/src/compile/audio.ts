// Mixes every audible source into one 48 kHz stereo track of exactly the export duration.
import { audioDenoise, audioEq, audioNormalize, audioPan, audioPitch, fadeDurations, reversePlayback } from "../clip-params";
import {
    audioFadeFilters, denoiseFilters, eqFilters, muteFilters, normalizeFilters, panFilters, pitchFilters, volumeFilters,
} from "../filters/audio";
import { fmt, sec } from "../format";
import { audioPad } from "../graph";
import { clipKeyframes } from "../keyframes";
import type { AudioSource } from "../audio-model";
import { AUDIO_RATE, audioSegmentOverlap, audioTempoFilters, type AudioStretch } from "../speed-remap";
import type { CompileContext } from "./context";

const NORMALIZE = ["aresample=48000", "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo"];

/** Source seconds the stretch plays (from the read offset). */
const stretchSpan = (stretch: AudioStretch) => stretch.segments[stretch.segments.length - 1].sourceEnd;

/** Seconds a source reads: its stretched span plus atempo's flush overlap, else its duration. */
function readSpan(source: AudioSource): number {
    const stretch = source.stretch;
    if (!stretch) return source.duration;
    const last = stretch.segments[stretch.segments.length - 1];
    return Math.ceil((stretchSpan(stretch) + audioSegmentOverlap(last.speed)) * 1000 - 1e-7) / 1000;
}

/** Samples of output [0, t) at the export rate; segment lengths are differences, so they add up exactly. */
const samplesAt = (seconds: number) => Math.round(seconds * AUDIO_RATE);

/**
 * One slice's tempo, then exactly its sample count (atempo drops its last window: pad or cut to the slice).
 * atempo's output timestamps do not follow its sample count, so they are renumbered first; later
 * time-based filters (atrim, fades, volume keyframes, mutes) then see the stretched clock.
 */
function segmentTempo(segment: AudioStretch["segments"][number], preservePitch: boolean): string[] {
    const samples = samplesAt(segment.outputEnd) - samplesAt(segment.outputStart);
    return [...audioTempoFilters(segment.speed, preservePitch), "asetpts=N/SR/TB", `apad=whole_len=${samples}`, `atrim=end_sample=${samples}`];
}

/** Filters before the stretch: timestamps, 48 kHz stereo, and reverse (the source first, as the picture does). */
function headFilters(source: AudioSource): string[] {
    const filters = ["asetpts=PTS-STARTPTS", ...NORMALIZE];
    const clip = source.clip;
    if ((source.kind === "clip" || source.kind === "overlay-clip") && clip && reversePlayback(clip)) {
        // The read carries flush overlap past the span: trim it so the span itself plays backwards.
        if (source.stretch) filters.push(`atrim=end=${fmt(stretchSpan(source.stretch))}`);
        filters.push("areverse");
    }
    return filters;
}

/** Filters after the stretch: clip effects, the exact duration, gain, mutes, and the delay to the source start. */
function tailFilters(source: AudioSource): string[] {
    const filters: string[] = [];
    const clip = source.clip;
    if (source.kind === "clip" && clip) {
        // Reference assembler order (normalize resamples to 48 kHz before pitch); volume before adelay keeps keyframe times clip-local.
        const fades = fadeDurations(clip, source.duration);
        filters.push(
            ...denoiseFilters(audioDenoise(clip)),
            ...normalizeFilters(audioNormalize(clip)),
            ...eqFilters(audioEq(clip)),
            ...panFilters(audioPan(clip)),
            ...pitchFilters(audioPitch(clip)),
            `atrim=0:${sec(source.duration)}`,
            ...audioFadeFilters(fades.fadeIn, fades.fadeOut, source.duration),
            ...volumeFilters(clipKeyframes(clip.keyframesJson), source.volume, source.trackVolume),
        );
    } else {
        // Overlay clip audio (reverse and speed only, reference assembler behavior), scene audio, voiceover, music.
        filters.push(`atrim=0:${sec(source.duration)}`);
        if (Math.abs(source.volume - 1) > 0.001) filters.push(`volume=${fmt(source.volume)}`);
    }
    const local = source.muted
        .map(([a, b]): [number, number] => [Math.max(0, a - source.start), Math.min(source.duration, b - source.start)])
        .filter(([a, b]) => b > a);
    filters.push(...muteFilters(local));
    const delayMs = Math.round(source.start * 1000);
    if (delayMs > 0) filters.push(`adelay=delays=${delayMs}:all=1`);
    return filters;
}

/**
 * Behind atempo, adelay's leading silence carries timestamps that a later atrim drops (measured on FFmpeg 7.1.5
 * and 5.1.4: a 0.5 s delay came out 0.45 s short). The chain starts at 0 and is gapless, so renumbering by
 * sample count after the delay restores the clock.
 */
const hasTempo = (filters: string[]) => filters.some((filter) => filter.startsWith("atempo="));

function withTempoClock(filters: string[], tempo = hasTempo(filters)): string[] {
    const delay = filters.findIndex((filter) => filter.startsWith("adelay="));
    if (delay < 0 || !tempo) return filters;
    return [...filters.slice(0, delay + 1), "asetpts=N/SR/TB", ...filters.slice(delay + 1)];
}

/**
 * One source as a chain from its input. A stretched source with several slices splits its one read: each
 * slice is atrimmed (plus flush overlap), stretched to its exact sample count, and the slices are concatenated.
 */
function compileSource(ctx: CompileContext, input: number, source: AudioSource): string {
    const { graph } = ctx;
    const stretch = source.stretch;
    if (!stretch || stretch.segments.length === 1) {
        const middle = stretch ? segmentTempo(stretch.segments[0], stretch.preservePitch) : [];
        return graph.chain([audioPad(input)], withTempoClock([...headFilters(source), ...middle, ...tailFilters(source)]), graph.label("a"));
    }
    const count = stretch.segments.length;
    const splits = graph.chainOutputs([audioPad(input)], [...headFilters(source), `asplit=${count}`], stretch.segments.map(() => graph.label("as")));
    const labels = stretch.segments.map(() => graph.label("ag"));
    let tempo = false;
    stretch.segments.forEach((segment, i) => {
        const end = segment.sourceEnd + audioSegmentOverlap(segment.speed);
        const filters = segmentTempo(segment, stretch.preservePitch);
        tempo ||= hasTempo(filters);
        graph.chain([splits[i]], [`atrim=start=${fmt(segment.sourceStart)}:end=${fmt(end)}`, "asetpts=PTS-STARTPTS", ...filters], labels[i]);
    });
    return graph.chain(labels, [`concat=n=${count}:v=0:a=1`, ...withTempoClock(tailFilters(source), tempo)], graph.label("a"));
}

/**
 * Returns the audio pad. Media missing from the probe map (rejected or unreadable) is left out with a
 * `media-unreadable` warning, except scene video, whose lane already reports it; media that was read and has
 * no audio stream is skipped silently.
 */
export function compileAudio(ctx: CompileContext, sources: AudioSource[]): string {
    const { graph } = ctx;
    const labels: string[] = [];
    for (const source of sources) {
        const info = ctx.media.get(source.url);
        if (!info) {
            if (source.kind !== "scene-video") {
                ctx.warnings.push({
                    code: "media-unreadable",
                    message: "Audio media could not be read; it is left out.",
                    ...(source.clip ? { clipId: source.clip.id } : {}),
                    ...(source.kind === "scene-voiceover" && source.sceneId ? { sceneId: source.sceneId } : {}),
                });
            }
            continue;
        }
        if (!info.hasAudio) continue;
        // Sloped speed curves stretch audio in slices at their mean speeds (speed-remap.ts): reported only when
        // the slice limit leaves the audio more than a frame away from the picture.
        if (source.stretch && source.stretch.drift > 1 / ctx.format.fps) {
            ctx.warnings.push({
                code: "speed-ramp-audio-approximated",
                message: `This speed curve changes faster than the audio can follow: the sound can drift up to ${Math.round(source.stretch.drift * 1000)} ms from the picture inside the curve.`,
                ...(source.clip ? { clipId: source.clip.id } : {}),
                ...(!source.clip && source.sceneId ? { sceneId: source.sceneId } : {}),
            });
        }
        const input = graph.input("media", source.url, ["-ss", sec(source.sourceOffset), "-t", sec(readSpan(source))]);
        labels.push(compileSource(ctx, input, source));
    }
    const total = sec(ctx.duration);
    if (labels.length === 0) {
        return graph.chain([], ["anullsrc=r=48000:cl=stereo", `atrim=0:${total}`, ...NORMALIZE], "aout");
    }
    return graph.chain(labels, [
        `amix=inputs=${labels.length}:normalize=0:duration=longest:dropout_transition=0`,
        `apad=whole_dur=${total}`,
        `atrim=0:${total}`,
        ...NORMALIZE,
    ], "aout");
}
