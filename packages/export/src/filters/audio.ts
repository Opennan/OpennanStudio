// Per-clip ffmpeg audio filters, re-implementing the reference assembler's audio behavior.
import type { AudioEq } from "../clip-params";
import { fmt } from "../format";
import { keyframeExpression, hasChannel, type KeyframePoints } from "../keyframes";

/** Constant tempo. atempo only accepts 0.5..2, so chain steps. */
export function tempoFilters(speed: number): string[] {
    if (Math.abs(speed - 1) <= 0.001) return [];
    const parts: string[] = [];
    let remaining = speed;
    while (remaining > 2.001) {
        parts.push("atempo=2");
        remaining /= 2;
    }
    while (remaining < 0.499) {
        parts.push("atempo=0.5");
        remaining /= 0.5;
    }
    parts.push(`atempo=${fmt(remaining)}`);
    return parts;
}

/** `panFilters`: reference assembler behavior. */
export function panFilters(pan: number): string[] {
    if (Math.abs(pan) <= 0.001) return [];
    const left = 1 - Math.max(0, Math.min(1, pan));
    const right = 1 + Math.min(0, Math.max(-1, pan));
    return [`pan=stereo|c0=${fmt(left)}*c0|c1=${fmt(right)}*c1`];
}

/** Pitch shift by resampling, tempo restored (at 48 kHz: the export mixes at 48 kHz). */
export function pitchFilters(semitones: number): string[] {
    if (Math.abs(semitones) <= 0.001) return [];
    const factor = 2 ** (semitones / 12);
    return [`asetrate=48000*${fmt(factor)}`, "aresample=48000", ...tempoFilters(1 / factor)];
}

/** `denoiseFilters`: reference assembler behavior. */
export function denoiseFilters(enabled: boolean): string[] {
    return enabled ? ["afftdn=nf=-25"] : [];
}

/** EBU R128 loudness normalize. loudnorm outputs 192 kHz, so resample back before asetrate-based pitch. */
export function normalizeFilters(enabled: boolean): string[] {
    return enabled ? ["loudnorm=I=-16:TP=-1.5:LRA=11", "aresample=48000"] : [];
}

/** `eqFilters`: reference assembler behavior. */
export function eqFilters(eq: AudioEq): string[] {
    if (eq === "bass") return ["equalizer=f=100:t=q:w=1:g=5"];
    if (eq === "vocal") return ["equalizer=f=1000:t=q:w=1:g=4", "equalizer=f=120:t=q:w=1:g=-2"];
    if (eq === "treble") return ["equalizer=f=6000:t=q:w=1:g=4"];
    return [];
}

/** `audioFadeFilters`: reference assembler behavior. */
export function audioFadeFilters(fadeIn: number, fadeOut: number, duration: number): string[] {
    const parts: string[] = [];
    if (fadeIn > 0) parts.push(`afade=t=in:st=0:d=${fmt(fadeIn)}`);
    if (fadeOut > 0) parts.push(`afade=t=out:st=${fmt(Math.max(0, duration - fadeOut))}:d=${fmt(fadeOut)}`);
    return parts;
}

/**
 * Clip volume (keyframed when authored) times the track fader. Runs before adelay so keyframe times
 * stay clip-local.
 */
export function volumeFilters(points: KeyframePoints, clipVolume: number, trackVolume: number): string[] {
    if (hasChannel(points, "volume")) {
        return [`volume='(${keyframeExpression(points, "volume", clipVolume)})*${fmt(trackVolume)}':eval=frame`];
    }
    const gain = clipVolume * trackVolume;
    return Math.abs(gain - 1) <= 0.001 ? [] : [`volume=${fmt(gain)}`];
}

/** Silence inside clip-local [start, end) windows (preview mute rules). */
export function muteFilters(windows: Array<[number, number]>): string[] {
    return windows
        .filter(([start, end]) => end > start)
        .map(([start, end]) => `volume=0:enable='between(t,${fmt(start)},${fmt(end)})'`);
}
