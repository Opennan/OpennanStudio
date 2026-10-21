// Normalized clip parameters: the reference assembler's clip field rules, re-implemented for the
// camelCase TimelineClip.
import type { TimelineClip } from "@opennan/timeline-core";
import { normalizeTimelineTransitionType } from "@opennan/timeline-core/lib/timeline-editing-navigation";
import { clamp, num, round3, truthy } from "./format";

export type SpeedRamp = "none" | "montage" | "hero" | "bullet";
export type AudioEq = "none" | "bass" | "vocal" | "treble";
export type VisualFilter = "none" | "warm" | "cool" | "cinematic";
export type MotionPreset = "none" | "zoom_in" | "zoom_out" | "pulse";
export type BlendMode = "normal" | "multiply" | "screen" | "overlay";

export interface CropFractions {
    left: number;
    right: number;
    top: number;
    bottom: number;
}

export interface ColorAdjustments {
    brightness: number;
    contrast: number;
    saturation: number;
}

export interface ChromaKey {
    enabled: boolean;
    /** "0xRRGGBB". */
    color: string;
    similarity: number;
    blend: number;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
    const text = String(value ?? "").trim().toLowerCase();
    return (allowed as readonly string[]).includes(text) ? (text as T) : fallback;
}

/** `normalizedVolume`: reference assembler behavior. */
export function normalizedVolume(value: unknown, fallback = 1): number {
    return clamp(num(value, fallback), 0, 1);
}

/** Playback speed, 0.1-100 (phase 10b); 0 and missing mean 1x (reference assembler behavior). */
export function playbackSpeed(clip: Pick<TimelineClip, "playbackSpeed">): number {
    const speed = num(clip.playbackSpeed, 1) || 1;
    return speed <= 0 ? 1 : clamp(speed, 0.1, 100);
}

/** `speedRamp`: reference assembler behavior. */
export function speedRamp(clip: Pick<TimelineClip, "speedRamp">): SpeedRamp {
    return oneOf(clip.speedRamp, ["none", "montage", "hero", "bullet"], "none");
}

/** `audioPan`: reference assembler behavior. */
export function audioPan(clip: Pick<TimelineClip, "audioPan">): number {
    return round3(clamp(num(clip.audioPan, 0), -1, 1));
}

/** `audioPitch`: reference assembler behavior. */
export function audioPitch(clip: Pick<TimelineClip, "audioPitch">): number {
    return round3(clamp(num(clip.audioPitch, 0), -12, 12));
}

/** `audioEq`: reference assembler behavior. */
export function audioEq(clip: Pick<TimelineClip, "audioEq">): AudioEq {
    return oneOf(clip.audioEq, ["none", "bass", "vocal", "treble"], "none");
}

/** Boolean clip flags with the reference assembler's coercion. */
export const audioDenoise = (clip: Pick<TimelineClip, "audioDenoise">): boolean => truthy(clip.audioDenoise);
export const audioNormalize = (clip: Pick<TimelineClip, "audioNormalize">): boolean => truthy(clip.audioNormalize);
export const reversePlayback = (clip: Pick<TimelineClip, "reversePlayback">): boolean => truthy(clip.reversePlayback);
export const freezeFrame = (clip: Pick<TimelineClip, "freezeFrame">): boolean => truthy(clip.freezeFrame);
export const horizontalFlip = (clip: Pick<TimelineClip, "horizontalFlip">): boolean => truthy(clip.horizontalFlip);
export const verticalFlip = (clip: Pick<TimelineClip, "verticalFlip">): boolean => truthy(clip.verticalFlip);

/** Each side 0..0.95, a pair scaled down to sum to at most 0.95 (reference assembler behavior). */
function cropPair(first: unknown, second: unknown): [number, number] {
    const a = clamp(num(first, 0), 0, 0.95);
    const b = clamp(num(second, 0), 0, 0.95);
    if (a + b <= 0.95) return [round3(a), round3(b)];
    const scale = 0.95 / (a + b);
    return [round3(a * scale), round3(b * scale)];
}

/** `crop`: reference assembler behavior. */
export function crop(clip: Pick<TimelineClip, "cropLeft" | "cropRight" | "cropTop" | "cropBottom">): CropFractions {
    const [left, right] = cropPair(clip.cropLeft, clip.cropRight);
    const [top, bottom] = cropPair(clip.cropTop, clip.cropBottom);
    return { left, right, top, bottom };
}

/** `colorAdjustments`: reference assembler behavior. */
export function colorAdjustments(clip: Pick<TimelineClip, "brightness" | "contrast" | "saturation">): ColorAdjustments {
    return {
        brightness: round3(clamp(num(clip.brightness, 0), -1, 1)),
        contrast: round3(clamp(num(clip.contrast, 1), 0, 3)),
        saturation: round3(clamp(num(clip.saturation, 1), 0, 3)),
    };
}

/** `visualFilter`: reference assembler behavior. */
export function visualFilter(clip: Pick<TimelineClip, "visualFilter">): VisualFilter {
    return oneOf(clip.visualFilter, ["none", "warm", "cool", "cinematic"], "none");
}

/** `motionPreset`: reference assembler behavior. */
export function motionPreset(clip: Pick<TimelineClip, "motionPreset">): MotionPreset {
    return oneOf(clip.motionPreset, ["none", "zoom_in", "zoom_out", "pulse"], "none");
}

/** Canonical transition type (the reference assembler's alias table). */
export function clipTransitionType(clip: Pick<TimelineClip, "transitionType">): string {
    return normalizeTimelineTransitionType(String(clip.transitionType ?? "none"));
}

/** `blurStrength`: reference assembler behavior. */
export function blurStrength(clip: Pick<TimelineClip, "blurStrength">): number {
    return round3(clamp(num(clip.blurStrength, 0), 0, 20));
}

/** `chromaKey`: reference assembler behavior. */
export function chromaKey(clip: Pick<TimelineClip, "chromaKeyEnabled" | "chromaKeyColor" | "chromaKeySimilarity" | "chromaKeyBlend">): ChromaKey {
    const match = String(clip.chromaKeyColor ?? "").trim().match(/^(?:#|0x)?([0-9a-fA-F]{6})$/);
    return {
        enabled: truthy(clip.chromaKeyEnabled),
        color: match ? `0x${match[1]}` : "0x00FF00",
        similarity: round3(clamp(num(clip.chromaKeySimilarity, 0.1), 0, 1)),
        blend: round3(clamp(num(clip.chromaKeyBlend, 0), 0, 1)),
    };
}

/** `blendMode`: reference assembler behavior. */
export function blendMode(clip: Pick<TimelineClip, "blendMode">): BlendMode {
    return oneOf(clip.blendMode, ["normal", "multiply", "screen", "overlay"], "normal");
}

/** `mosaicStrength`: reference assembler behavior. */
export function mosaicStrength(clip: Pick<TimelineClip, "mosaicStrength">): number {
    return Math.trunc(clamp(num(clip.mosaicStrength, 0), 0, 64));
}

/**
 * Any angle, like the preview (preview-panel.tsx:1143, 1194, 1268 rotate by the raw degrees).
 * The reference assembler snaps to 90° steps; the preview is the reference here.
 */
export function rotationDegrees(clip: Pick<TimelineClip, "rotationDegrees">): number {
    return num(clip.rotationDegrees, 0);
}

export function clipOpacity(clip: Pick<TimelineClip, "opacity">): number {
    return clamp(num(clip.opacity, 1), 0, 1);
}

export function clipScale(clip: Pick<TimelineClip, "scale">): number {
    const scale = num(clip.scale, 1);
    return scale > 0 ? scale : 1;
}

export interface FadeDurations {
    fadeIn: number;
    fadeOut: number;
}

/** Each fade at most half the clip (reference assembler behavior). */
export function fadeDurations(clip: Pick<TimelineClip, "fadeInDuration" | "fadeOutDuration">, duration: number): FadeDurations {
    const max = Math.max(0, duration / 2);
    return {
        fadeIn: clamp(num(clip.fadeInDuration, 0), 0, max),
        fadeOut: clamp(num(clip.fadeOutDuration, 0), 0, max),
    };
}

/** Text clips without fades fade over their transition duration (reference assembler behavior). */
export function effectiveTextFades(
    clip: Pick<TimelineClip, "fadeInDuration" | "fadeOutDuration" | "transitionType" | "transitionDuration">,
    duration: number,
): FadeDurations {
    const fades = fadeDurations(clip, duration);
    if (fades.fadeIn > 0 || fades.fadeOut > 0 || clipTransitionType(clip) === "none") return fades;
    const value = clamp(num(clip.transitionDuration, 0), 0, Math.max(0, duration / 2));
    return { fadeIn: value, fadeOut: value };
}
