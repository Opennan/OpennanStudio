// The GPU export path's timeline (phase 10c): every output frame as an ordered list of draw ops for the WebGL
// compositor (gpu/compositor.ts), built from the same rules the ffmpeg export compiles to filters, so both paths
// show the same frame at every output frame. Pure: no DOM, no GL, no decoding. Rule by rule it mirrors
//
//   compile/index.ts compileExport (layer order, which clips draw)
//   compile/lanes.ts  (scene lanes: gaps, overlaps, frame-snapped items, centered windows, live handles,
//                      head/body/tail reads, shot sequences, speed remaps, static fit vs per-frame motion)
//   compile/clip-lanes.ts, compile/overlays.ts (upper-track clips, text, stickers: time filters, bitmap scale,
//                      crop, looks, legacy fades and dips, flips, opacity, static vs animated placement)
//   compile/effect-spans.ts, gl.ts (effect-track spans on the composite, legacy GL passes)
//
// Frame timing is ffmpeg's: a read with `-ss` and `setpts=PTS-STARTPTS,fps` shows, at its frame i, the last
// source frame before firstFrameAtOrAfter(seek) + (i + ½)/fps; a remapped (sped-up) read shows the source frame
// visible at S(from + (i + ½)/fps) (speed-remap.ts). The reader (gpu/media.ts) resolves `firstFrameAtOrAfter`
// from the file's packets. Pixel math is not here: the compositor runs it with the preview's LookRenderer.
import type { SceneData, TimelineClip } from "@opennan/timeline-core";
import { evaluateScalar } from "@opennan/timeline-core/looks/expr";
import { clipLegacyOps, legacyMediaInput, type LegacyOps } from "@opennan/timeline-core/looks/legacy";
import { isBuiltinEffect } from "@opennan/timeline-core/looks/effects";
import { sceneFitRect } from "@opennan/timeline-core/looks/fit";
import { sceneHandleMedia } from "@opennan/timeline-core/looks/handles";
import { itemLook, type LookPlan, type LookSource } from "@opennan/timeline-core/looks/look-plan";
import type { MaskBox } from "@opennan/timeline-core/looks/masks";
import { planTransitionWindows, type TransitionWindow } from "@opennan/timeline-core/looks/windows";
import { parseTimelineKeyframes } from "@opennan/timeline-core/lib/timeline-editing-properties";
import type { KeyframePoints } from "@opennan/timeline-core/motion/keyframes";
import { keyframeLut, lookAfterKeyframes, lookKeyframeMix, lookKeyframeTimes, type LutStep } from "@opennan/timeline-core/motion/look-keyframes";
import {
    clipSpeedProfile, isIdentitySpeed, sceneSpeedProfile, sourceSpan, sourceTimeAt, type SpeedProfile,
} from "@opennan/timeline-core/motion/speed";
import { isConstantChannel, itemMotion, motionAt, type ItemMotion } from "@opennan/timeline-core/motion/transform";
import { textStatePlan } from "@opennan/timeline-core/text/text-states";
import { clipOpacity, clipTransitionType, crop, effectiveTextFades, fadeDurations, freezeFrame, horizontalFlip, mosaicStrength, reversePlayback, verticalFlip } from "../clip-params";
import { quantize } from "../format";
import { collectGlLayers, planGlPasses } from "../gl";
import { FilterGraph } from "../graph";
import { textAtlasPlan } from "../motion/text-atlas";
import { emojiJobId, isBundledSticker, isEmojiSticker, isExportedText, stickerJobId, textJobId } from "../raster/jobs";
import { REMAP_BIAS_FRAMES, pieceRead, type SpeedRemap } from "../speed-remap";
import {
    buildSceneLanes, placeScenes, playableClips, sceneDuration, sceneImageUrl, sceneShotSequence, sceneTrimStart, sceneVideoUrl, timelineDuration,
    type LaneItem, type SceneLane, type ScenePiece,
} from "../timeline-model";
import type { ExportInput, ExportWarning, GlEffectSpec, GlPass, GraphicsRasterFrame, MediaInfo, OutputFormat, RasterResult } from "../types";
import { graphicsClips } from "../compile/graphics";
import { graphicsEntryKey, type GraphicsClipData } from "../raster/graphics-frame";
import { graphicsFrameEntry } from "../raster/jobs";
import { graphicsOutputFrames } from "@opennan/timeline-core/graphics/layer";
import { planClipLanes } from "../compile/clip-lanes";
import type { CompileContext } from "../compile/context";
import { mediaOverlay, rasterGeometry, type RasterKind } from "../compile/index";
import { laneHandles, sceneMotion, seekSeconds, staticScene, type SceneItem } from "../compile/lanes";
import { MIN_REFERENCE_SCALE, channelPeak, overlayScale } from "../compile/overlay-scale";
import { OVERLAY_MARGIN, constant, legacyOpacity, overlayLook, overlayMaskBox, overlayMediaStart, staticPlacementOf, type OverlaySource } from "../compile/overlays";
import { sceneFit, staticPlacement } from "../compile/placement";
import { effectSpans } from "../compile/effect-spans";

// ── ops ──────────────────────────────────────────────────

/**
 * A sequential media read (one ffmpeg input in the ffmpeg path). Piece frame i shows the last source frame at or
 * before anchor + offsetAt(i), where the anchor is the first frame at or after `seek` ("first") or `seek` itself
 * ("absolute"); null when that time is past the media.
 */
export interface VideoRead {
    /** Unique per read. */
    key: string;
    /** Reads sharing a stream decode in one forward pass (requests never go back within a stream). */
    stream: string;
    url: string;
    /** `-ss` in media seconds (whole milliseconds, floored), 0 for reads from the start. */
    seek: number;
    anchor: "first" | "absolute";
    offsetAt(i: number): number;
    /** Piece frames the read yields. */
    frames: number;
    /**
     * ffmpeg's `reverse` (phase 10d): the frames in [anchor, anchor + span) media seconds play backwards on their own
     * timestamps, so the frame picked forward at a time (the j-th of n) shows the (n − 1 − j)-th instead.
     */
    reverse?: { span: number };
}

export type FrameSource =
    | { kind: "video"; read: VideoRead; index: number }
    | { kind: "image"; url: string }
    | { kind: "raster"; id: string; cell: Rect | null };

export interface Rect {
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface LookAt {
    /** Steps (after the keyframed CLUT when `mix` is set). */
    plan: LookPlan | null;
    /** Adjust keyframes: the CLUT cross-fade (LookRenderer.lutMix) before `plan`. */
    mix: { a: LutStep; b: LutStep; w: number } | null;
    /** Item-local seconds (look passes, grain). */
    time: number;
    /** The keyframe clock (masks): scene-local for scenes, item-local for clips. */
    keyframeTime: number;
    /** The item's box inside the bitmap for the mask (phase 10d: padded text and emoji rasters); absent: the whole bitmap. */
    maskBox?: MaskBox | null;
}

/** Where the processed bitmap lands on the frame: its centre, drawn size, and clockwise rotation in radians. */
export interface Placement {
    cx: number;
    cy: number;
    width: number;
    height: number;
    rotation: number;
}

export interface LayerOp {
    kind: "layer";
    source: FrameSource;
    /** The decoded source (or raster cell) resized to this size first (ffmpeg `scale`). */
    bitmap: { width: number; height: number };
    /** Crop of the resized bitmap (clip crop fractions), or null. */
    crop: Rect | null;
    look: LookAt | null;
    /** Mosaic block size (> 1), else 0. */
    mosaic: number;
    /** Legacy fades: alpha factor, and a colour dip (rgb → colour by `amount`). */
    fadeAlpha: number;
    dip: { color: [number, number, number]; amount: number } | null;
    flipX: boolean;
    flipY: boolean;
    /** Alpha multiplier (base opacity or the opacity channel). */
    opacity: number;
    place: Placement;
    /** Legacy blur slider, chroma key, and blend mode (after the look, before the mosaic), with ffmpeg's plane modes. */
    legacy?: LegacyOps | null;
}

/** A lane frame: one side, or a transition window between two sides, on black (opaque) or clear. */
export interface LaneOp {
    kind: "lane";
    opaque: boolean;
    a: LayerOp | null;
    b?: LayerOp | null;
    transition?: string;
    /** CapCut progress 0 → 1. */
    p?: number;
}

export interface SpanOp {
    kind: "span";
    plan: LookPlan;
    time: number;
}

export interface GlOp {
    kind: "gl";
    effects: GlEffectSpec[];
    time: number;
}

/**
 * A built-in graphics clip's frame (phase 10d): the shared Canvas 2D frame (raster/graphics-frame.ts: template
 * frame, placement, and opacity baked in) composited over the frame as is — the ffmpeg path overlays the very
 * same picture from its image sequence.
 */
export interface GraphicsOp {
    kind: "graphics";
    clipId: string;
    clip: GraphicsClipData;
    entry: GraphicsRasterFrame;
    /** Equal keys draw equal pixels (graphicsEntryKey). */
    key: string;
}

export type DrawOp = LaneOp | LayerOp | SpanOp | GlOp | GraphicsOp;

// ── plan ─────────────────────────────────────────────────

export interface GpuPlanOptions {
    media: ReadonlyMap<string, MediaInfo>;
    rasters: ReadonlyMap<string, RasterResult>;
    /** Plan legacy GL catalog effects (needs a GlFrameProcessor in the compositor). */
    gl: boolean;
}

export interface GpuPlan {
    format: OutputFormat;
    durationSeconds: number;
    frameCount: number;
    /** Every video read with the output frames [first, last] that use it (decoder lifetimes). */
    reads: Array<{ read: VideoRead; first: number; last: number }>;
    /** Still images and the output frames that use them. */
    images: Array<{ url: string; first: number; last: number }>;
    /** Raster bitmaps (text, emoji, stickers) and the output frames that use them. */
    rasters: Array<{ id: string; first: number; last: number }>;
    /** Built-in graphics clips and the output frames they draw on (their canvases live that long). */
    graphics: Array<{ clipId: string; clip: GraphicsClipData; first: number; last: number }>;
    warnings: ExportWarning[];
    /** The draw list of output frame k. */
    drawList(k: number): DrawOp[];
}

const EPS = 1e-6;
const evenCeil = (value: number) => Math.ceil(value / 2) * 2;
const even = (value: number) => Math.max(2, Math.round(value / 2) * 2);
const nearestEven = (value: number) => 2 * Math.floor(value / 2 + 0.5);
const num = (value: unknown, fallback: number) => (typeof value === "number" && Number.isFinite(value) ? value : fallback);

interface Builder {
    fps: number;
    width: number;
    height: number;
    media: ReadonlyMap<string, MediaInfo>;
    reads: Map<string, VideoRead>;
    counter: number;
}

/** A `-ss` read with PTS-STARTPTS + fps: frame i ≈ firstFrameAtOrAfter(seek) + (i + ½)/fps. */
function seekRead(b: Builder, stream: string, url: string, offset: number, duration: number): VideoRead {
    const seek = Number(seekSeconds(offset));
    const frames = Math.max(1, Math.round(duration * b.fps));
    const read: VideoRead = {
        key: `r${b.counter++}`, stream, url, seek, anchor: "first", frames,
        // Just under the frame middle: fps rounds a source frame exactly there to the next output frame.
        offsetAt: (i) => (i + 0.5) / b.fps - EPS,
    };
    b.reads.set(read.key, read);
    return read;
}

/** A remapped read (speed-remap.ts pieceRead/remapFilters): frame i shows the source frame visible at S(from + (i + ½)/fps). */
function remapRead(b: Builder, stream: string, url: string, readStart: number, remap: SpeedRemap, duration: number, anchor: "first" | "absolute"): VideoRead {
    const span = sourceSpan(remap.profile, remap.length);
    const frames = Math.max(1, Math.round(duration * b.fps));
    const read: VideoRead = {
        key: `r${b.counter++}`, stream, url, seek: readStart, anchor, frames,
        offsetAt: (i) => {
            const t = remap.from + (i + 0.5 - REMAP_BIAS_FRAMES) / b.fps;
            // Frames at or past the source span are pushed out of the stream (never shown): hold the last one before it.
            const sigma = Math.min(sourceTimeAt(remap.profile, Math.min(remap.length, Math.max(0, t)), remap.length), span - 1e-4);
            return remap.rate * (sigma - remap.sourceAtZero);
        },
    };
    b.reads.set(read.key, read);
    return read;
}

// ── scene lanes ──────────────────────────────────────────

/** A scene's look: static, or keyframed (the preview's lutMix of the two CLUTs around the time). */
interface ItemLook {
    plan: LookPlan | null;
    keyed: { rest: LookPlan | null; points: KeyframePoints; source: LookSource; luts: Map<number, LutStep> } | null;
}

function itemLookOf(source: LookSource, keyframesJson: string | null | undefined): ItemLook {
    const points = keyframesJson ? parseTimelineKeyframes(keyframesJson) : [];
    if (lookKeyframeTimes(points).length === 0) return { plan: itemLook(source), keyed: null };
    return { plan: null, keyed: { rest: lookAfterKeyframes(itemLook(source)), points, source, luts: new Map() } };
}

function lookAt(look: ItemLook, time: number, keyframeTime: number): LookAt | null {
    if (!look.keyed) return look.plan && look.plan.steps.length > 0 ? { plan: look.plan, mix: null, time, keyframeTime } : null;
    const { rest, points, source, luts } = look.keyed;
    const at = lookKeyframeMix(points, keyframeTime);
    if (!at) return rest ? { plan: rest, mix: null, time, keyframeTime } : null;
    const lut = (t: number) => {
        let step = luts.get(t);
        if (!step) {
            step = keyframeLut(source, points, t);
            luts.set(t, step);
        }
        return step;
    };
    return { plan: rest, mix: { a: lut(at.from), b: lut(at.to), w: at.w }, time, keyframeTime };
}

/** How a scene's media is drawn onto the lane frame (lanes.ts footageSegment). */
interface Footage {
    url: string;
    still: boolean;
    /** Size the media is scaled to (the fit, or the scale-1 fit at the peak scale for moving scenes). */
    size: { width: number; height: number };
    /** Static: the fit's top-left. */
    at: { x: number; y: number } | null;
    /** Moving: the per-frame placement inputs. */
    motion: { motion: ItemMotion; reference: number; scaleXPeak: number; flips: boolean; rotated: boolean } | null;
}

function footageOf(b: Builder, scene: SceneData, url: string, info: MediaInfo, motion: ItemMotion, still: boolean): Footage {
    const moving = !staticScene(scene, motion);
    const frame = { width: b.width, height: b.height };
    if (!moving) {
        const fit = sceneFit(scene.fitMode, { width: info.width, height: info.height }, frame, num(scene.transformScale, 1) || 1, num(scene.transformOffsetX, 0), num(scene.transformOffsetY, 0));
        return { url, still, size: { width: fit.width, height: fit.height }, at: { x: fit.x, y: fit.y }, motion: null };
    }
    const peak = channelPeak(motion, "scale", b.fps);
    const reference = Math.max(MIN_REFERENCE_SCALE, peak);
    const base = sceneFitRect(scene.fitMode, { width: info.width, height: info.height }, frame, 1, 0, 0);
    const scaleX = motion.channels.scaleX;
    return {
        url, still,
        size: { width: even(base.width * reference), height: even(base.height * reference) },
        at: null,
        motion: {
            motion, reference: peak > 0 ? reference : 0,
            scaleXPeak: Math.max(1, channelPeak(motion, "scaleX", b.fps, Math.abs)),
            flips: !(isConstantChannel(motion, "scaleX") && Math.abs((scaleX as { v: number }).v) === 1),
            rotated: motion.channels.rotation.k !== "num" || Math.abs((motion.channels.rotation as { v: number }).v % 360) > 0.001,
        },
    };
}

/** lanes.ts placeSceneMotion at scene-local time t; null when the scale is 0 or less (background only). */
function scenePlacement(b: Builder, f: Footage, t: number): { place: Placement; opacity: number } | null {
    if (f.at) return { place: { cx: f.at.x + f.size.width / 2, cy: f.at.y + f.size.height / 2, width: f.size.width, height: f.size.height, rotation: 0 }, opacity: 1 };
    const m = f.motion!;
    if (!(m.reference > 0)) return null;
    const v = motionAt(m.motion, t);
    if (!(v.scale > 0)) return null;
    const rel = Math.max(0, v.scale) / m.reference;
    const w = Math.max(1, Math.round(f.size.width * rel * (m.flips ? Math.abs(v.scaleX) : 1)));
    const h = Math.max(1, Math.round(f.size.height * rel));
    const pad = { width: evenCeil(Math.ceil(f.size.width * m.scaleXPeak) + OVERLAY_MARGIN * 2), height: evenCeil(f.size.height + OVERLAY_MARGIN * 2) };
    const radians = m.rotated ? (v.rotation * Math.PI) / 180 : 0;
    const side = m.rotated ? evenCeil(Math.hypot(pad.width, pad.height)) : null;
    const shift = padShift(pad, w, h, m.rotated ? radians : undefined);
    const cx = b.width / 2 + (v.posX / 100 + v.dx) * b.width;
    const cy = b.height / 2 + (v.posY / 100 + v.dy) * b.height;
    const x = nearestEven(cx - (side ?? pad.width) / 2 - shift.x);
    const y = nearestEven(cy - (side ?? pad.height) / 2 - shift.y);
    const opacityChannel = m.motion.channels.opacity;
    const opacity = opacityChannel.k === "num" ? (opacityChannel.v < 0.999 ? opacityChannel.v : 1) : Math.min(1, Math.max(0, v.opacity));
    return {
        place: { cx: x + (side ?? pad.width) / 2 + shift.x, cy: y + (side ?? pad.height) / 2 + shift.y, width: w, height: h, rotation: radians },
        opacity,
    };
}

/** placement.ts padShift, evaluated: the bitmap centre relative to the pad centre (rotated with the layer). */
function padShift(pad: { width: number; height: number }, w: number, h: number, radians?: number): { x: number; y: number } {
    const dx = -(((pad.width - w) % 2) + 2) % 2 / 2;
    const dy = -(((pad.height - h) % 2) + 2) % 2 / 2;
    if (radians === undefined) return { x: dx, y: dy };
    return { x: dx * Math.cos(radians) - dy * Math.sin(radians), y: dx * Math.sin(radians) + dy * Math.cos(radians) };
}

/** One read of a scene: item-local seconds [from, to) and what is shown there. */
interface SceneRead {
    from: number;
    to: number;
    footage: Footage | null;
    read: VideoRead | null;
}

interface PlannedScene {
    item: SceneItem;
    look: ItemLook;
    /** Reads keyed by the range string of the compileLane call that made them. */
    calls: Map<string, SceneRead[]>;
    stream: string;
}

/** lanes.ts footageSegment: the read for one media window (null when unreadable: black). */
function footageRead(b: Builder, p: PlannedScene, window: { url: string; isVideo: boolean; offset: number; duration: number; speed: null | { profile: SpeedProfile; length: number; from: number; origin: number; rate: number } }, from: number): SceneRead {
    const info = b.media.get(window.url);
    const to = from + window.duration;
    if (!info || !info.hasVideo) return { from, to, footage: null, read: null };
    const scene = p.item.placed.scene;
    const still = !window.isVideo || info.durationSeconds <= 0;
    const footage = footageOf(b, scene, window.url, info, sceneMotion(scene), still);
    if (still) return { from, to, footage, read: null };
    if (window.speed) {
        const pr = pieceRead({ ...window.speed, duration: window.duration });
        return { from, to, footage, read: remapRead(b, `${p.stream}|${window.url}`, window.url, pr.readStart, pr.remap, window.duration, "absolute") };
    }
    return { from, to, footage, read: seekRead(b, `${p.stream}|${window.url}`, window.url, window.offset, window.duration) };
}

/** lanes.ts shotSequenceSegment. */
function shotReads(b: Builder, p: PlannedScene, shots: ScenePiece[], range: { from: number; to: number }): SceneRead[] {
    const { fps } = b;
    const scene = p.item.placed.scene;
    const frame = (seconds: number) => Math.round(seconds * fps) / fps;
    const local = p.item.offset;
    const profile = sceneSpeedProfile(scene);
    const identity = isIdentitySpeed(profile);
    const length = sceneDuration(scene);
    const reads: SceneRead[] = [];
    shots.forEach((shot, index) => {
        const shotFrom = frame(Math.min(p.item.duration, Math.max(0, shot.start - local)));
        const shotTo = index === shots.length - 1 ? p.item.duration : frame(Math.min(p.item.duration, Math.max(0, shot.end - local)));
        const from = Math.max(shotFrom, range.from);
        const to = Math.min(shotTo, range.to);
        if (to - from < 1 / fps / 2) return;
        const speed = identity && shot.rate === 1 ? null : { profile, length, from: local + from, origin: -shot.rate * shot.sourceStart, rate: shot.rate };
        reads.push(footageRead(b, p, { url: shot.url, isVideo: true, offset: Math.max(0, local + from - shot.start), duration: to - from, speed }, from));
    });
    if (reads.length === 0) return [{ from: range.from, to: range.to, footage: null, read: null }];
    return reads;
}

/** lanes.ts sceneSegment. */
function sceneReads(b: Builder, p: PlannedScene, range: { from: number; to: number }): SceneRead[] {
    const scene = p.item.placed.scene;
    const shots = sceneShotSequence(scene);
    if (shots) return shotReads(b, p, shots, range);
    const videoUrl = sceneVideoUrl(scene);
    const url = videoUrl ?? sceneImageUrl(scene);
    if (!url) return [{ from: range.from, to: range.to, footage: null, read: null }];
    const profile = sceneSpeedProfile(scene);
    const speed = isIdentitySpeed(profile) ? null : { profile, length: sceneDuration(scene), from: p.item.offset + range.from, origin: sceneTrimStart(scene), rate: 1 };
    return [footageRead(b, p, { url, isVideo: Boolean(videoUrl), offset: p.item.trimStart + range.from, duration: range.to - range.from, speed }, range.from)];
}

/** lanes.ts handleSegment: item-local [from, to) including live handle seconds outside the item. */
function handleReads(b: Builder, p: PlannedScene, range: { from: number; to: number }): SceneRead[] {
    const key = `${range.from}|${range.to}`;
    const cached = p.calls.get(key);
    if (cached) return cached;
    const { fps } = b;
    const scene = p.item.placed.scene;
    const inside = { from: Math.max(0, range.from), to: Math.min(p.item.duration, range.to) };
    const lead = inside.from - range.from;
    const trail = range.to - inside.to;
    let reads: SceneRead[];
    if ((lead <= EPS && trail <= EPS) || isIdentitySpeed(sceneSpeedProfile(scene))) {
        reads = sceneReads(b, p, range);
    } else {
        const media = sceneHandleMedia(scene)!;
        const url = sceneVideoUrl(scene) ?? sceneImageUrl(scene)!;
        const extension = (offset: number, duration: number, from: number) => {
            const speed = media.still ? null : { profile: { speed: media.rate, curve: null, preservePitch: true }, length: duration, from: 0, origin: offset, rate: 1 };
            return footageRead(b, p, { url, isVideo: !media.still, offset, duration, speed }, from);
        };
        reads = [];
        if (lead > EPS) reads.push(extension(Math.max(0, p.item.trimStart - lead * media.rate), lead, range.from));
        if (inside.to - inside.from >= 1 / fps / 2) reads.push(...sceneReads(b, p, inside));
        if (trail > EPS) reads.push(extension(media.sourceEnd, trail, p.item.duration));
    }
    p.calls.set(key, reads);
    return reads;
}

/** The layer that draws item-local second `u` of a planned scene through `reads` (null: background only). */
function sceneLayer(b: Builder, p: PlannedScene, reads: SceneRead[], u: number): LayerOp | null {
    const read = reads.find((r) => u >= r.from - EPS && u < r.to - EPS) ?? reads[reads.length - 1];
    if (!read?.footage) return null;
    const motionTime = p.item.offset + u;
    const placed = scenePlacement(b, read.footage, motionTime);
    if (!placed) return null;
    let source: FrameSource;
    if (read.read) source = { kind: "video", read: read.read, index: Math.max(0, Math.min(read.read.frames - 1, Math.round((u - read.from) * b.fps))) };
    else source = { kind: "image", url: read.footage.url };
    return {
        kind: "layer", source, bitmap: read.footage.size, crop: null,
        look: lookAt(p.look, u, motionTime), mosaic: 0, fadeAlpha: 1, dip: null, flipX: false, flipY: false,
        opacity: placed.opacity, place: placed.place,
    };
}

type LanePiece =
    | { f0: number; f1: number; kind: "gap" }
    | { f0: number; f1: number; kind: "body"; scene: PlannedScene; reads: SceneRead[]; from: number }
    | {
        f0: number; f1: number; kind: "window"; transition: string;
        a: { scene: PlannedScene; reads: SceneRead[]; from: number; frames: number };
        b: { scene: PlannedScene; reads: SceneRead[]; from: number; frames: number; frozen: number };
    };

interface PlannedLane {
    opaque: boolean;
    frames: number;
    pieces: LanePiece[];
}

/** lanes.ts compileLane as frame ranges. */
function planLane(b: Builder, ctx: Pick<CompileContext, "media" | "format">, lane: SceneLane, opaque: boolean, length: number): PlannedLane {
    const { fps } = b;
    const items: LaneItem[] = [...lane.items];
    const tail = length - lane.end;
    if (tail >= 1 / fps / 2) items.push({ kind: "gap", start: lane.end, duration: tail });
    const windows = planTransitionWindows(items.map((item) => (item.kind === "scene" ? item.duration : 0)), lane.joins, fps);
    const handles = new Map<number, ReturnType<typeof laneHandles>>();
    for (const [i, window] of windows) {
        const a = items[i];
        const c = items[i + 1];
        if (a.kind === "scene" && c.kind === "scene") handles.set(i, laneHandles(ctx, a, c, window.half));
    }
    const planned = new Map<number, PlannedScene>();
    const plannedScene = (i: number) => {
        let p = planned.get(i);
        if (!p) {
            const item = items[i] as SceneItem;
            const scene = item.placed.scene;
            p = { item, look: itemLookOf({ kind: "scene", ...scene }, scene.keyframesJson), calls: new Map(), stream: `lane${lane.trackIndex}:${i}` };
            planned.set(i, p);
        }
        return p;
    };
    const pieces: LanePiece[] = [];
    let cursor = 0;
    const push = (frames: number, piece: Omit<Extract<LanePiece, { kind: "gap" }>, "f0" | "f1"> | Record<string, unknown>) => {
        if (frames <= 0) return;
        pieces.push({ ...(piece as object), f0: cursor, f1: cursor + frames } as LanePiece);
        cursor += frames;
    };
    let pendingTail: { scene: PlannedScene; reads: SceneRead[]; from: number; frames: number; window: TransitionWindow; live: number } | null = null;
    for (let i = 0; i < items.length; i += 1) {
        const item = items[i];
        if (item.kind === "gap") {
            push(Math.round(item.duration * fps), { kind: "gap" });
            continue;
        }
        const p = plannedScene(i);
        const incoming = windows.get(i - 1);
        const outgoing = windows.get(i);
        const headHalf = incoming?.half ?? 0;
        const tailHalf = outgoing?.half ?? 0;
        const before = handles.get(i - 1)?.incomingBefore ?? 0;
        const after = handles.get(i)?.outgoingAfter ?? 0;
        if (incoming && pendingTail) {
            const frames = Math.round(2 * incoming.half * fps);
            const headFrames = Math.round((before + headHalf) * fps);
            const frozen = Math.round(incoming.half * fps) - Math.round(before * fps);
            push(frames, {
                kind: "window", transition: incoming.type,
                a: { scene: pendingTail.scene, reads: pendingTail.reads, from: pendingTail.from, frames: pendingTail.frames },
                b: { scene: p, reads: handleReads(b, p, { from: -before, to: headHalf }), from: -before, frames: headFrames, frozen },
            });
        }
        if (item.duration - headHalf - tailHalf >= 1 / fps / 2) {
            push(Math.round((item.duration - headHalf - tailHalf) * fps), { kind: "body", scene: p, reads: handleReads(b, p, { from: headHalf, to: item.duration - tailHalf }), from: headHalf });
        }
        pendingTail = outgoing
            ? { scene: p, reads: handleReads(b, p, { from: item.duration - tailHalf, to: item.duration + after }), from: item.duration - tailHalf, frames: Math.round((tailHalf + after) * fps), window: outgoing, live: after }
            : null;
    }
    return { opaque, frames: Math.round(length * fps), pieces };
}

function laneOpAt(b: Builder, lane: PlannedLane, k: number): LaneOp | null {
    if (k >= lane.frames) return null;
    const piece = lane.pieces.find((pc) => k >= pc.f0 && k < pc.f1);
    if (!piece || piece.kind === "gap") return { kind: "lane", opaque: lane.opaque, a: null };
    const j = k - piece.f0;
    if (piece.kind === "body") return { kind: "lane", opaque: lane.opaque, a: sceneLayer(b, piece.scene, piece.reads, piece.from + j / b.fps) };
    const frames = piece.f1 - piece.f0;
    // The tail holds its last frame after its live frames run out; the head holds its first frame before its own.
    const ja = Math.min(j, Math.max(0, piece.a.frames - 1));
    const jb = Math.min(Math.max(0, j - piece.b.frozen), Math.max(0, piece.b.frames - 1));
    return {
        kind: "lane", opaque: lane.opaque,
        a: sceneLayer(b, piece.a.scene, piece.a.reads, piece.a.from + ja / b.fps),
        b: sceneLayer(b, piece.b.scene, piece.b.reads, piece.b.from + jb / b.fps),
        transition: piece.transition,
        p: j / frames,
    };
}

// ── overlays (clips, text, stickers) ─────────────────────

interface PlannedOverlay {
    source: OverlaySource;
    raster: { id: string } | null;
    url: string | null;
    motion: ItemMotion;
    placedStatic: boolean;
    reference: number;
    scaleXPeak: number;
    flips: boolean;
    rotated: boolean;
    outer: { width: number; height: number };
    box: { width: number; height: number };
    scaled: { width: number; height: number };
    cropRect: Rect | null;
    look: ItemLook | null;
    /** compile/overlays.ts overlayMaskBox (phase 10d). */
    maskBox: MaskBox | null;
    legacy: boolean;
    dipColor: [number, number, number] | null;
    fadeIn: number;
    fadeOut: number;
    duration: number;
    mosaic: number;
    atlas: { stateAt: ReturnType<typeof textStatePlan>["stateAt"]; cols: number; cellWidth: number; cellHeight: number } | null;
    /** Legacy blur, chroma key, blend mode (null: none). */
    legacyOps: LegacyOps | null;
    /** Video time per item-local frame: the read (whole clip or ranged). */
    read: VideoRead | null;
    readFrames: number;
    /** Read frames before item-local frame 0 (a clip lane's live incoming handle): item-local frame f is read frame f + lead. */
    lead: number;
}

/** Live transition handles of a clip-lane clip (compile/clip-lanes.ts): real media read before and after the clip. */
interface OverlayHandles {
    before: number;
    after: number;
}

function planOverlay(b: Builder, source: OverlaySource, raster: { id: string } | null, stream: string, handles: OverlayHandles = { before: 0, after: 0 }): PlannedOverlay | null {
    const clip = source.clip;
    const duration = Math.max(0, clip.endTime - clip.startTime);
    if (duration < 1 / b.fps) return null;
    const motion = itemMotion({ kind: "clip", clip });
    const scale = overlayScale(clip, b.fps);
    const placedStatic = staticPlacementOf(motion);
    if (placedStatic && constant(motion, "scale") <= 0) return null;
    const prepared = placedStatic ? constant(motion, "scale") : scale.reference;
    const factor = prepared / source.baseScale;
    const cropped = crop(clip);
    const keepW = 1 - cropped.left - cropped.right;
    const keepH = 1 - cropped.top - cropped.bottom;
    const scaledW = Math.max(2, Math.round(source.outer.width * factor));
    const scaledH = Math.max(2, Math.round(source.outer.height * factor));
    const outer = { width: Math.max(2, Math.round(scaledW * keepW)), height: Math.max(2, Math.round(scaledH * keepH)) };
    const box = { width: source.box.width * factor * keepW, height: source.box.height * factor * keepH };
    const anyCrop = Math.max(cropped.left, cropped.right, cropped.top, cropped.bottom) > 0;
    // filters/video.ts cropFilters: w=iw*(1-l-r) at x=iw*l (crop truncates to whole pixels).
    const cropRect = anyCrop ? { x: Math.floor(scaledW * cropped.left), y: Math.floor(scaledH * cropped.top), width: outer.width, height: outer.height } : null;
    const type = clipTransitionType(clip);
    const fades = source.text ? effectiveTextFades(clip, duration) : fadeDurations(clip, duration);
    const legacy = legacyOpacity(clip);
    const atlasPlan = source.atlasCrop && raster ? textAtlasPlan(clip) : null;
    let atlas: PlannedOverlay["atlas"] = null;
    if (atlasPlan && source.stream) {
        atlas = { stateAt: atlasPlan.stateAt, cols: 0, cellWidth: source.stream.width, cellHeight: source.stream.height };
    }
    let read: VideoRead | null = null;
    const readFrames = Math.max(1, Math.ceil(duration * b.fps - 1e-9));
    let lead = 0;
    if (source.video && source.input.kind === "media") {
        const profile = clipSpeedProfile(clip);
        const freeze = freezeFrame(clip);
        const url = source.input.source;
        // From the clip's trimStart (compile/overlays.ts overlayMediaStart): the ffmpeg input seeks there too.
        const origin = overlayMediaStart(source);
        const seek = Number(seekSeconds(origin));
        if (freeze) {
            read = { key: `r${b.counter++}`, stream, url, seek, anchor: "first", frames: 1, offsetAt: () => 0.5 / b.fps - EPS };
        } else if (isIdentitySpeed(profile)) {
            // Clip lanes read their live handles from the same stream: `before` ahead of trimStart, `after` past the clip.
            lead = Math.min(Math.round(Math.max(0, handles.before) * b.fps), Math.floor(origin * b.fps + 1e-6));
            const tail = Math.max(0, Math.round((duration + Math.max(0, handles.after)) * b.fps) - readFrames);
            read = {
                key: `r${b.counter++}`, stream, url, seek: lead > 0 ? Number(seekSeconds(origin - lead / b.fps)) : seek, anchor: "first",
                frames: lead + readFrames + tail, offsetAt: (i) => (i + 0.5) / b.fps - EPS,
            };
        } else {
            read = remapRead(b, stream, url, seek, { profile, length: duration, from: 0, sourceAtZero: 0, rate: 1 }, duration, "first");
            read.frames = readFrames;
        }
        // overlays.ts timeFilters: the read span (a remapped one trimmed to its source span) reversed before the
        // remap; a frozen reversed clip holds the span's last frame.
        if (reversePlayback(clip)) read.reverse = { span: sourceSpan(profile, duration) };
        b.reads.set(read.key, read);
    }
    // Text draws no look, only its mask (phase 10d, overlays.ts overlayLook); Adjust keyframes do not apply to it.
    const look = source.text ? { plan: overlayLook(source), keyed: null } : itemLookOf({ kind: "clip", ...clip }, clip.keyframesJson);
    const mosaic = mosaicStrength(clip) > 1 ? mosaicStrength(clip) : 0;
    const legacyFades = legacy && type !== "dip_black" && type !== "dip_white" && (fades.fadeIn > 0 || fades.fadeOut > 0);
    return {
        source, raster, url: source.input.kind === "media" ? source.input.source : null, motion, placedStatic, reference: scale.reference,
        scaleXPeak: scale.scaleXPeak,
        flips: !(isConstantChannel(motion, "scaleX") && Math.abs(constant(motion, "scaleX")) === 1),
        rotated: !isConstantChannel(motion, "rotation") || Math.abs(constant(motion, "rotation") % 360) > 0.001,
        outer, box, scaled: { width: scaledW, height: scaledH }, cropRect,
        look,
        maskBox: overlayMaskBox(source, outer, box),
        legacy, dipColor: type === "dip_black" ? [0, 0, 0] : type === "dip_white" ? [1, 1, 1] : null,
        fadeIn: fades.fadeIn, fadeOut: fades.fadeOut, duration,
        mosaic,
        atlas, read, readFrames, lead,
        // compile/overlays.ts's blurFilters, chromaKeyFilters, blendModeFilters as layer ops.
        legacyOps: clipLegacyOps(clip, { input: legacyInput(source, raster, look), yuva444Fades: Boolean(legacyFades) && mosaic === 0 }),
    };
}

/** What reaches the legacy filters in the ffmpeg chain: decoded 4:2:0 video/JPEG/WebP, or RGB (after a look; PNG, GIF, rasters). */
function legacyInput(source: OverlaySource, raster: { id: string } | null, look: ItemLook | null): "yuv420" | "rgb" {
    if (raster || source.input.kind !== "media") return "rgb";
    if (look && (look.keyed || (look.plan && look.plan.steps.length > 0))) return "rgb";
    return legacyMediaInput(source.input.source, source.video);
}


/** ffmpeg `fade` factor at item-local t (in: 0 → 1 over [0, d]; out: 1 → 0 over [D − d, D]). */
function fadeFactor(o: PlannedOverlay, t: number): number {
    let f = 1;
    if (o.fadeIn > 0) f *= Math.min(1, Math.max(0, t / o.fadeIn));
    if (o.fadeOut > 0) f *= Math.min(1, Math.max(0, (o.duration - t) / o.fadeOut));
    return f;
}

/**
 * The overlay's layer at item-local frame n (layer clock n/fps) and main-clock item-local second `mainT`.
 * `sourceIndex` overrides the read frame (clip lanes clone first/last frames); null: not drawn.
 */
function overlayLayer(b: Builder, o: PlannedOverlay, n: number, mainT: number, sourceIndex: number | "still" = n): LayerOp | null {
    const layerT = n / b.fps;
    const clip = o.source.clip;
    let source: FrameSource;
    if (o.raster) {
        let cell: Rect | null = null;
        if (o.atlas) {
            const raster = o.atlas;
            const state = Math.max(0, Math.floor(evaluateScalar(raster.stateAt, layerT) + 1e-9));
            cell = { ...atlasCellAt(o, state), width: raster.cellWidth, height: raster.cellHeight };
        }
        source = { kind: "raster", id: o.raster.id, cell };
    } else if (o.read) {
        const index = sourceIndex === "still" ? 0 : Math.max(0, Math.min(o.read.frames - 1, sourceIndex));
        source = { kind: "video", read: o.read, index };
    } else if (o.url) {
        source = { kind: "image", url: o.url };
    } else {
        return null;
    }
    const v = motionAt(o.motion, layerT);
    const vMain = motionAt(o.motion, mainT);
    let place: Placement;
    if (o.placedStatic) {
        const degrees = constant(o.motion, "rotation");
        const sp = staticPlacement({ width: b.width, height: b.height }, o.box, o.outer, constant(o.motion, "posX"), constant(o.motion, "posY"), degrees);
        const side = sp.rotatedSide;
        place = {
            cx: sp.x + (side ?? o.outer.width) / 2,
            cy: sp.y + (side ?? o.outer.height) / 2,
            width: o.outer.width, height: o.outer.height,
            rotation: side ? (degrees * Math.PI) / 180 : 0,
        };
    } else {
        if (!(vMain.scale > 0)) return null;
        const rel = (scale: number) => scale / o.reference;
        const w = Math.max(1, Math.round(o.outer.width * rel(v.scale) * (o.flips ? Math.abs(v.scaleX) : 1)));
        const h = Math.max(1, Math.round(o.outer.height * rel(v.scale)));
        const wMain = Math.max(1, Math.round(o.outer.width * rel(vMain.scale) * (o.flips ? Math.abs(vMain.scaleX) : 1)));
        const hMain = Math.max(1, Math.round(o.outer.height * rel(vMain.scale)));
        const pad = { width: evenCeil(Math.ceil(o.outer.width * o.scaleXPeak) + OVERLAY_MARGIN * 2), height: evenCeil(o.outer.height + OVERLAY_MARGIN * 2) };
        const side = o.rotated ? evenCeil(Math.hypot(pad.width, pad.height)) : null;
        const radiansMain = o.rotated ? (vMain.rotation * Math.PI) / 180 : undefined;
        const s = rel(vMain.scale);
        const boxW = o.box.width * s;
        const boxH = o.box.height * s;
        const cx = vMain.posX * Math.max(0, b.width - boxW) + boxW / 2 + vMain.dx * b.width;
        const cy = vMain.posY * Math.max(0, b.height - boxH) + boxH / 2 + vMain.dy * b.height;
        const shift = padShift(pad, wMain, hMain, radiansMain);
        const x = nearestEven(cx - (side ?? pad.width) / 2 - shift.x);
        const y = nearestEven(cy - (side ?? pad.height) / 2 - shift.y);
        // The bitmap's own pad offset at the layer clock (what the layer chain actually drew).
        const layerShift = padShift(pad, w, h, o.rotated ? (v.rotation * Math.PI) / 180 : undefined);
        place = {
            cx: x + (side ?? pad.width) / 2 + layerShift.x,
            cy: y + (side ?? pad.height) / 2 + layerShift.y,
            width: w, height: h,
            rotation: o.rotated ? (v.rotation * Math.PI) / 180 : 0,
        };
    }
    const legacy = o.legacy || o.dipColor !== null;
    const fade = legacy ? fadeFactor(o, layerT) : 1;
    const dip = o.dipColor && fade < 1 ? { color: o.dipColor, amount: 1 - fade } : null;
    const opacity = o.legacy ? clipOpacity(clip) : Math.min(1, Math.max(0, v.opacity));
    return {
        kind: "layer", source,
        bitmap: o.scaled,
        crop: o.cropRect,
        look: o.look ? withMaskBox(lookAt(o.look, layerT, layerT), o.maskBox) : null,
        mosaic: o.mosaic,
        fadeAlpha: o.dipColor ? 1 : fade,
        dip,
        flipX: horizontalFlip(clip),
        flipY: verticalFlip(clip),
        opacity: o.legacy ? (opacity < 0.999 ? opacity : 1) : opacity,
        place,
        ...(o.legacyOps ? { legacy: o.legacyOps } : {}),
    };
}

/** The look with the overlay's mask box (phase 10d), when it has one. */
function withMaskBox(look: LookAt | null, maskBox: MaskBox | null): LookAt | null {
    return look && maskBox ? { ...look, maskBox } : look;
}

function atlasCellAt(o: PlannedOverlay, state: number): { x: number; y: number } {
    const a = o.atlas!;
    return { x: (state % a.cols) * a.cellWidth, y: Math.floor(state / a.cols) * a.cellHeight };
}

/** A per-clip overlay: visible output frames [first, first + frames). */
interface GraphicsEntry {
    kind: "graphics";
    clip: TimelineClip;
    data: GraphicsClipData;
    first: number;
    count: number;
}

interface OverlayEntry {
    kind: "overlay";
    o: PlannedOverlay;
    start: number;
}

/** A clip lane (compile/clip-lanes.ts): frames counted from `startFrame`, pieces like a scene lane. */
interface ClipLaneEntry {
    kind: "clip-lane";
    startFrame: number;
    frames: number;
    pieces: Array<
        | { f0: number; f1: number; kind: "body"; o: PlannedOverlay; shift: number; from: number; after: number }
        | {
            f0: number; f1: number; kind: "window"; transition: string;
            a: { o: PlannedOverlay; shift: number; from: number; frames: number; after: number };
            b: { o: PlannedOverlay; shift: number; from: number; frames: number; frozen: number; after: number };
        }
    >;
}

/** overlays.ts rangeTime: the read frame of item-local frame f of a ranged (clip lane) overlay, clamped like its tpad clones. */
function rangedIndex(b: Builder, o: PlannedOverlay, f: number, after: number): number | "still" {
    if (!o.read) return "still";
    const total = Math.round(o.duration * b.fps);
    const limit = o.read.frames > 1 || total <= 1 ? Math.round((o.duration + Math.max(0, after)) * b.fps) : 1;
    // Frames before the clip read its live incoming handle (`lead` frames), then hold the first one.
    return Math.max(0, Math.min(Math.max(0, limit - 1), f) + o.lead);
}

function clipLaneOp(b: Builder, lane: ClipLaneEntry, k: number): LaneOp | null {
    const m = k - lane.startFrame;
    if (m < 0 || m >= lane.frames) return null;
    const piece = lane.pieces.find((pc) => m >= pc.f0 && m < pc.f1);
    if (!piece) return null;
    const j = m - piece.f0;
    const layerAt = (o: PlannedOverlay, shift: number, from: number, i: number, after: number) => {
        const local = shift + from + i / b.fps;
        const f = Math.round(local * b.fps);
        return overlayLayer(b, o, f, local, rangedIndex(b, o, f, after));
    };
    if (piece.kind === "body") return { kind: "lane", opaque: false, a: layerAt(piece.o, piece.shift, piece.from, j, piece.after) };
    const frames = piece.f1 - piece.f0;
    const ja = Math.min(j, Math.max(0, piece.a.frames - 1));
    const jb = Math.min(Math.max(0, j - piece.b.frozen), Math.max(0, piece.b.frames - 1));
    return {
        kind: "lane", opaque: false,
        a: layerAt(piece.a.o, piece.a.shift, piece.a.from, ja, piece.a.after),
        b: layerAt(piece.b.o, piece.b.shift, piece.b.from, jb, piece.b.after),
        transition: piece.transition, p: j / frames,
    };
}

// ── the plan ─────────────────────────────────────────────

export function planGpuExport(input: ExportInput, format: OutputFormat, options: GpuPlanOptions): GpuPlan {
    const { fps, width, height } = format;
    const clips = playableClips(input.clips, input.tracks);
    const placed = placeScenes(input.scenes, input.tracks);
    const duration = quantize(timelineDuration(input.scenes, clips), fps);
    const frameCount = Math.round(duration * fps);
    const warnings: ExportWarning[] = [];
    const ctx: CompileContext = { graph: new FilterGraph(), format, duration, media: options.media, rasters: options.rasters, warnings, files: [], fileKeys: new Map() };
    const b: Builder = { fps, width, height, media: options.media, reads: new Map(), counter: 0 };

    // Scene lanes: V1 opaque (or black), V2+ transparent, in track order.
    const sceneLanes = buildSceneLanes(placed, fps);
    const planned: PlannedLane[] = [];
    const base = sceneLanes.find((lane) => lane.trackIndex === 1);
    if (base) planned.push(planLane(b, ctx, base, true, duration));
    for (const lane of sceneLanes.filter((l) => l.trackIndex >= 2)) planned.push(planLane(b, ctx, lane, false, Math.min(lane.end, duration)));

    // Overlay video/image clips (lower tracks first), clip lanes at their first clip.
    const overlayClips = clips
        .filter((clip) => clip.trackType === "video" && (clip.trackIndex ?? 2) >= 2 && clip.mediaUrl)
        .sort((a, c) => (a.trackIndex ?? 2) - (c.trackIndex ?? 2) || a.startTime - c.startTime);
    const lanes = planClipLanes(ctx, overlayClips, (clip) => mediaOverlay(ctx, clip));
    const laneAt = new Map(lanes.map((lane) => [lane.clips[0].source.clip.id, lane]));
    const inLane = new Set(lanes.flatMap((lane) => lane.clips.map((item) => item.source.clip.id)));
    const entries: Array<OverlayEntry | ClipLaneEntry | GraphicsEntry> = [];
    for (const clip of overlayClips) {
        const lane = laneAt.get(clip.id);
        if (lane) entries.push(planClipLane(b, lane));
        if (inLane.has(clip.id)) continue;
        const source = mediaOverlay(ctx, clip);
        const o = source ? planOverlay(b, source, null, `clip:${clip.id}`) : null;
        if (o) entries.push({ kind: "overlay", o, start: clip.startTime });
    }
    // Built-in graphics in track order, above video and below text (compile/graphics.ts).
    const graphics: Array<{ clipId: string; clip: GraphicsClipData; first: number; last: number }> = [];
    for (const clip of graphicsClips(clips)) {
        const span = graphicsOutputFrames(clip, fps, frameCount);
        if (span.count === 0) continue;
        const data: GraphicsClipData = { templateId: clip.remotionTemplateId!, propsJson: clip.remotionPropsJson ?? null, startTime: clip.startTime, endTime: clip.endTime };
        graphics.push({ clipId: clip.id, clip: data, first: span.first, last: span.first + span.count - 1 });
        entries.push({ kind: "graphics", clip, data, first: span.first, count: span.count });
    }
    // Text and stickers in clip order.
    for (const clip of clips) {
        let o: PlannedOverlay | null = null;
        if (isExportedText(clip)) o = rasterOverlay(b, ctx, clip, textJobId(clip.id), "text");
        else if (isBundledSticker(clip)) o = rasterOverlay(b, ctx, clip, stickerJobId(clip.id), "sticker");
        else if (isEmojiSticker(clip)) o = rasterOverlay(b, ctx, clip, emojiJobId(clip.id), "emoji");
        else if (clip.trackType === "sticker" && clip.mediaUrl) {
            const source = mediaOverlay(ctx, clip);
            o = source ? planOverlay(b, source, null, `clip:${clip.id}`) : null;
        }
        if (o) entries.push({ kind: "overlay", o, start: clip.startTime });
    }

    // Effect-track spans with built-in effects, then legacy GL passes.
    const spans = effectSpans(clips).map((clip) => {
        const startFrame = Math.round(Math.max(0, clip.startTime) * fps);
        const endFrame = Math.round(Math.min(duration, clip.endTime) * fps);
        const plan = itemLook({ kind: "scene", effects: (clip.effects ?? []).filter((row) => isBuiltinEffect(row.effectId)) });
        return { startFrame, endFrame, plan };
    }).filter((span) => span.plan && span.endFrame - span.startFrame >= 1);
    const glPasses: GlPass[] = options.gl ? planGlPasses(collectGlLayers(clips, placed, input.effects ?? [], []), duration) : [];

    const drawList = (k: number): DrawOp[] => {
        const ops: DrawOp[] = [];
        for (const lane of planned) {
            const op = laneOpAt(b, lane, k);
            if (op) ops.push(op);
        }
        const t = k / fps;
        for (const entry of entries) {
            if (entry.kind === "clip-lane") {
                const op = clipLaneOp(b, entry, k);
                if (op) ops.push(op);
                continue;
            }
            if (entry.kind === "graphics") {
                if (k < entry.first || k >= entry.first + entry.count) continue;
                const graphic = graphicsFrameEntry(entry.clip, k, format);
                if (graphic) ops.push({ kind: "graphics", clipId: entry.clip.id, clip: entry.data, entry: graphic, key: graphicsEntryKey(graphic) });
                continue;
            }
            const { o, start } = entry;
            // The layer's `setpts=PTS-STARTPTS+start/TB` truncates start to the frame grid; `enable` starts at start itself.
            const n = k - Math.floor(start * fps + 1e-6);
            if (n < 0 || n >= o.readFrames || t < start - 1e-9 || t > o.source.clip.endTime + 1e-9) continue;
            const layer = overlayLayer(b, o, n, t - start);
            if (layer) ops.push(layer);
        }
        for (const span of spans) {
            if (k >= span.startFrame && k < span.endFrame) ops.push({ kind: "span", plan: span.plan!, time: (k - span.startFrame) / fps });
        }
        for (const pass of glPasses) {
            if (t >= pass.start - EPS && t < pass.end - EPS) ops.push({ kind: "gl", effects: pass.effects, time: t });
        }
        return ops;
    };

    // Decoder and image lifetimes: one sweep over the frames (cheap: no pixels).
    const readUse = new Map<string, { read: VideoRead; first: number; last: number }>();
    const imageUse = new Map<string, { url: string; first: number; last: number }>();
    const rasterUse = new Map<string, { id: string; first: number; last: number }>();
    const note = (source: FrameSource, k: number) => {
        if (source.kind === "video") {
            const use = readUse.get(source.read.key);
            if (use) use.last = k;
            else readUse.set(source.read.key, { read: source.read, first: k, last: k });
        } else if (source.kind === "image") {
            const use = imageUse.get(source.url);
            if (use) use.last = k;
            else imageUse.set(source.url, { url: source.url, first: k, last: k });
        } else {
            const use = rasterUse.get(source.id);
            if (use) use.last = k;
            else rasterUse.set(source.id, { id: source.id, first: k, last: k });
        }
    };
    for (let k = 0; k < frameCount; k += 1) {
        for (const op of drawList(k)) {
            if (op.kind === "layer") note(op.source, k);
            else if (op.kind === "lane") {
                if (op.a) note(op.a.source, k);
                if (op.b) note(op.b.source, k);
            }
        }
    }

    return {
        format, durationSeconds: duration, frameCount,
        reads: [...readUse.values()].sort((x, y) => x.first - y.first),
        images: [...imageUse.values()],
        rasters: [...rasterUse.values()],
        graphics,
        warnings,
        drawList,
    };
}

function rasterOverlay(b: Builder, ctx: CompileContext, clip: TimelineClip, jobId: string, kind: RasterKind): PlannedOverlay | null {
    const raster = ctx.rasters.get(jobId);
    if (!raster) {
        ctx.warnings.push({ code: "text-unsupported", message: "Text, emoji, and stickers need a canvas rasterizer, which this export host does not have; this clip is left out.", clipId: clip.id });
        return null;
    }
    const geometry = rasterGeometry(ctx, clip, raster, kind);
    if (!geometry) {
        ctx.warnings.push({ code: "text-unsupported", message: "The text's animation bitmap does not match the clip; this clip is left out.", clipId: clip.id });
        return null;
    }
    const source: OverlaySource = {
        clip, input: { kind: "file", source: jobId, options: [] }, video: false, text: kind === "text", ...geometry, baseScale: raster.scale,
    };
    const o = planOverlay(b, source, { id: jobId }, `raster:${clip.id}`);
    if (o?.atlas && raster.atlas) o.atlas.cols = raster.atlas.cols;
    if (o?.atlas && !raster.atlas) o.atlas = null;
    return o;
}

function planClipLane(b: Builder, lane: ReturnType<typeof planClipLanes>[number]): ClipLaneEntry {
    const { fps } = b;
    const pieces: ClipLaneEntry["pieces"] = [];
    let cursor = 0;
    let pendingTail: { o: PlannedOverlay; shift: number; from: number; frames: number; after: number } | null = null;
    const planned = lane.clips.map((item, i) => planOverlay(b, item.source, null, `lane-clip:${item.source.clip.id}`, {
        before: lane.handles.get(i - 1)?.incomingBefore ?? 0,
        after: lane.handles.get(i)?.outgoingAfter ?? 0,
    }));
    lane.clips.forEach((item, i) => {
        const o = planned[i];
        const duration = item.end - item.start;
        const incoming = lane.windows.get(i - 1);
        const outgoing = lane.windows.get(i);
        const headHalf = incoming?.half ?? 0;
        const tailHalf = outgoing?.half ?? 0;
        const before = lane.handles.get(i - 1)?.incomingBefore ?? 0;
        const after = lane.handles.get(i)?.outgoingAfter ?? 0;
        if (!o) return;
        if (incoming && pendingTail) {
            const frames = Math.round(2 * incoming.half * fps);
            pieces.push({
                f0: cursor, f1: cursor + frames, kind: "window", transition: incoming.type,
                a: pendingTail,
                b: { o, shift: item.shift, from: -before, frames: Math.round((before + headHalf) * fps), frozen: Math.round(incoming.half * fps) - Math.round(before * fps), after },
            });
            cursor += frames;
        }
        const bodyFrames = Math.round((duration - headHalf - tailHalf) * fps);
        if (duration - headHalf - tailHalf >= 1 / fps / 2) {
            pieces.push({ f0: cursor, f1: cursor + bodyFrames, kind: "body", o, shift: item.shift, from: headHalf, after });
            cursor += bodyFrames;
        }
        pendingTail = outgoing ? { o, shift: item.shift, from: duration - tailHalf, frames: Math.round((tailHalf + after) * fps), after } : null;
    });
    const start = lane.clips[0].start;
    return { kind: "clip-lane", startFrame: Math.round(start * fps), frames: cursor, pieces };
}

