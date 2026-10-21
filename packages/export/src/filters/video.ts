// Per-clip ffmpeg video filters. Each builder re-implements one reference assembler behavior and
// returns a list of filters.
import type { BlendMode, ChromaKey, ColorAdjustments, CropFractions, MotionPreset, SpeedRamp, VisualFilter } from "../clip-params";
import { fmt } from "../format";
import { BLEND_MODE_ADJUSTMENTS } from "@opennan/timeline-core/looks/legacy";
import { eqLookup } from "../lgpl-filters";

const lookups = (...entries: Array<string | null>): string[] => entries.filter((entry): entry is string => entry !== null);

/** `cropFilters`: reference assembler behavior. */
export function cropFilters(crop: CropFractions): string[] {
    if (Math.max(crop.left, crop.right, crop.top, crop.bottom) <= 0) return [];
    const l = fmt(crop.left);
    const r = fmt(crop.right);
    const t = fmt(crop.top);
    const b = fmt(crop.bottom);
    return [`crop=w=iw*(1-${l}-${r}):h=ih*(1-${t}-${b}):x=iw*${l}:y=ih*${t}`];
}

/** `colorFilters`: reference assembler behavior (eq), as an LGPL lutyuv with eq's exact lookup. */
export function colorFilters(color: ColorAdjustments): string[] {
    if (Math.abs(color.brightness) <= 0.001 && Math.abs(color.contrast - 1) <= 0.001 && Math.abs(color.saturation - 1) <= 0.001) return [];
    return lookups(eqLookup(color));
}

/** `visualFilterPreset`: reference assembler behavior (eq), as an LGPL lutyuv with eq's exact lookup. */
export function visualFilterPreset(filter: VisualFilter): string[] {
    if (filter === "warm") return lookups(eqLookup({ brightness: 0.03, contrast: 1.08, saturation: 1.12 }));
    if (filter === "cool") return ["colorbalance=bs=0.08:rs=-0.04", ...lookups(eqLookup({ brightness: 0, contrast: 1, saturation: 0.95 }))];
    if (filter === "cinematic") return lookups(eqLookup({ brightness: -0.04, contrast: 1.18, saturation: 0.92 }));
    return [];
}

/** `blurFilters`: reference assembler behavior (a box blur of the given radius on every plane). LGPL avgblur, not GPL boxblur. */
export function blurFilters(strength: number): string[] {
    const radius = Math.trunc(strength);
    return radius >= 1 ? [`avgblur=sizeX=${radius}:sizeY=${radius}`] : [];
}

/** `chromaKeyFilters`: reference assembler behavior. */
export function chromaKeyFilters(key: ChromaKey): string[] {
    return key.enabled ? [`chromakey=${key.color}:${fmt(key.similarity)}:${fmt(key.blend)}`] : [];
}

/** Blend modes, approximated by contrast/brightness as the reference assembler does (eq), as an LGPL lutyuv with eq's exact lookup. */
export function blendModeFilters(mode: BlendMode): string[] {
    return mode === "normal" ? [] : lookups(eqLookup(BLEND_MODE_ADJUSTMENTS[mode]));
}

/** `mosaicFilters`: reference assembler behavior. */
export function mosaicFilters(strength: number): string[] {
    if (strength <= 1) return [];
    return [`scale=iw/${strength}:ih/${strength}:flags=neighbor`, `scale=iw*${strength}:ih*${strength}:flags=neighbor`];
}

/** `flipFilters`: reference assembler behavior. */
export function flipFilters(horizontal: boolean, vertical: boolean): string[] {
    return [...(horizontal ? ["hflip"] : []), ...(vertical ? ["vflip"] : [])];
}

/** `reverseFilters`: reference assembler behavior. */
export function reverseFilters(reverse: boolean): string[] {
    return reverse ? ["reverse"] : [];
}

/** One ramp segment: [from, to) as fractions of the clip's timeline length, at `speed` × the clip speed. */
export interface RampSegment {
    from: number;
    to: number;
    speed: number;
}

/**
 * Ramp presets (reference assembler tables), bounds read as fractions of the clip length. The export now
 * plays `speedRamp` through its step curve (timeline-core LEGACY_RAMP_CURVES, the same segments) like any
 * speed curve (speed-remap.ts); these tables stay for callers that need the legacy numbers.
 */
export const SPEED_RAMPS: Readonly<Record<Exclude<SpeedRamp, "none">, readonly RampSegment[]>> = {
    montage: [{ from: 0, to: 0.25, speed: 0.55 }, { from: 0.25, to: 0.75, speed: 1.85 }, { from: 0.75, to: 1, speed: 0.75 }],
    hero: [{ from: 0, to: 0.35, speed: 0.45 }, { from: 0.35, to: 0.65, speed: 1.35 }, { from: 0.65, to: 1, speed: 0.65 }],
    bullet: [{ from: 0, to: 0.2, speed: 1.5 }, { from: 0.2, to: 0.8, speed: 0.35 }, { from: 0.8, to: 1, speed: 1.25 }],
};

export interface RampTable {
    /** Per segment: clip-local source second it starts at, output second it starts at, effective speed. */
    segments: Array<{ sourceStart: number; outputStart: number; speed: number }>;
    /** Source seconds the whole clip consumes. */
    sourceSpan: number;
}

/** Forward-only time table for a ramp over `duration` output seconds at clip speed `speed`; null without a ramp. */
export function speedRampTable(ramp: SpeedRamp, duration: number, speed = 1): RampTable | null {
    if (ramp === "none" || duration <= 0) return null;
    let source = 0;
    const segments = SPEED_RAMPS[ramp].map((segment) => {
        const entry = { sourceStart: source, outputStart: segment.from * duration, speed: segment.speed * speed };
        source += (segment.to - segment.from) * duration * entry.speed;
        return entry;
    });
    return { segments, sourceSpan: source };
}

/** Source seconds per timeline second, ramp included (audio tempo and input spans). */
export function averageSourceSpeed(ramp: SpeedRamp, duration: number, speed: number): number {
    const table = speedRampTable(ramp, duration, speed);
    return table && duration > 0 ? table.sourceSpan / duration : speed;
}

/**
 * Hold the first frame for the whole clip (reference assembler behavior): one frame per output frame of the
 * clip, ceil(duration · fps). `loop`, not `tpad`: tpad emits no clones after a stream trimmed to one frame (the
 * 10b graph showed a frozen clip for a single frame).
 */
export function freezeFilters(freeze: boolean, duration: number, fps: number): string[] {
    if (!freeze || duration <= 0) return [];
    const frames = Math.max(1, Math.ceil(duration * fps - 1e-9));
    return ["trim=end_frame=1", "setpts=PTS-STARTPTS", `loop=loop=${frames - 1}:size=1:start=0`, `setpts=N/${fps}/TB`];
}

/** Alpha fades (the stream must carry alpha) (reference assembler behavior). */
export function alphaFadeFilters(fadeIn: number, fadeOut: number, duration: number): string[] {
    const parts: string[] = [];
    if (fadeIn > 0 || fadeOut > 0) parts.push("format=yuva444p");
    if (fadeIn > 0) parts.push(`fade=t=in:st=0:d=${fmt(fadeIn)}:alpha=1`);
    if (fadeOut > 0) parts.push(`fade=t=out:st=${fmt(Math.max(0, duration - fadeOut))}:d=${fmt(fadeOut)}:alpha=1`);
    return parts;
}

/** Dips fade through a color, every other type is an alpha fade (reference assembler behavior). */
export function clipTransitionFilters(type: string, fadeIn: number, fadeOut: number, duration: number): string[] {
    const color = type === "dip_black" ? "black" : type === "dip_white" ? "white" : "";
    if (!color) return alphaFadeFilters(fadeIn, fadeOut, duration);
    const parts: string[] = [];
    if (fadeIn > 0) parts.push(`fade=t=in:st=0:d=${fmt(fadeIn)}:color=${color}`);
    if (fadeOut > 0) parts.push(`fade=t=out:st=${fmt(Math.max(0, duration - fadeOut))}:d=${fmt(fadeOut)}:color=${color}`);
    return parts;
}

/** Motion preset scale factor over `timeVar` (reference assembler presets), relative to the clip scale. */
export function motionScaleExpression(preset: MotionPreset, duration: number, timeVar: string): string | null {
    const d = fmt(Math.max(0.001, duration));
    if (preset === "zoom_in") return `(1+0.08*${timeVar}/${d})`;
    if (preset === "zoom_out") return `(1.08-0.08*${timeVar}/${d})`;
    if (preset === "pulse") return `(1+0.04*sin(2*PI*${timeVar}/${d}))`;
    return null;
}

/** Largest factor motionScaleExpression reaches (sizes the base bitmap so it is never upscaled). */
export function motionScalePeak(preset: MotionPreset): number {
    if (preset === "zoom_in" || preset === "zoom_out") return 1.08;
    if (preset === "pulse") return 1.04;
    return 1;
}
