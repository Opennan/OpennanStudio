// Scene tracks as full-frame video sequences: V1 is opaque with black gaps, V2+ transparent with
// clear gaps, so they stack like the preview's ScenePreview layers. Shot-sequenced scenes play shot
// by shot, as the preview's ShotSequencerV2 does. Each scene carries its look (filter, adjustments,
// effects); cuts carry centered transition windows (phase 10a).
import type { SceneData } from "@opennan/timeline-core";
import { XFADE_THREADS, xfadeExpression } from "@opennan/timeline-core/looks/expr";
import { itemLook, type LookPlan } from "@opennan/timeline-core/looks/look-plan";
import { transitionById } from "@opennan/timeline-core/looks/transitions";
import { planTransitionWindows } from "@opennan/timeline-core/looks/windows";
import { sceneHandleMedia, snapHandles, transitionHandles, type HandleMedia, type TransitionHandles } from "@opennan/timeline-core/looks/handles";
import { isIdentitySpeed, sceneSpeedProfile, type SpeedProfile } from "@opennan/timeline-core/motion/speed";
import { sceneFitRect } from "@opennan/timeline-core/looks/fit";
import { isConstantChannel, itemMotion, motionAt, motionFfmpeg, type ItemMotion } from "@opennan/timeline-core/motion/transform";
import { fmt, num, sec } from "../format";
import { videoPad } from "../graph";
import { applyLook } from "../looks/look-filters";
import { sceneKeyframedLook, type ExportKeyedLook } from "../motion/lut-keyframes";
import { MIN_REFERENCE_SCALE, channelPeak, reachesNonPositiveScale } from "./overlay-scale";
import { pieceRead, remapFilters } from "../speed-remap";
import {
    sceneDuration, sceneImageUrl, sceneShotSequence, sceneTrimStart, sceneVideoUrl, type LaneItem, type SceneLane, type ScenePiece,
} from "../timeline-model";
import type { CompileContext } from "./context";
import { frameClock, nearestEven, padShift, sceneFit } from "./placement";

interface Segment {
    label: string;
    duration: number;
}

/**
 * `color` emits frames while t < d, so d is floored to the millisecond: a whole number of frames rounded up
 * (59/30 s → "1.967") would add a frame and shift everything after it on the lane.
 */
const frameSafeSeconds = (seconds: number) => (Math.floor(Math.max(0, seconds) * 1000 + 1e-6) / 1000).toFixed(3);

export function gapSegment(ctx: CompileContext, duration: number, opaque: boolean): Segment {
    const { width, height, fps } = ctx.format;
    const label = ctx.graph.chain([], [
        `color=c=${opaque ? "black" : "black@0"}:s=${width}x${height}:r=${fps}:d=${frameSafeSeconds(duration)}`,
        `format=${opaque ? "yuv420p" : "yuva420p"}`,
        `settb=1/${fps}`,
    ], ctx.graph.label("gap"));
    return { label, duration };
}

interface FootageWindow {
    url: string;
    /** False for stills (looped). */
    isVideo: boolean;
    /** Seconds into the media (read 1:1 when `speed` is null). */
    offset: number;
    /** Timeline seconds the window fills. */
    duration: number;
    /** A sped-up window (speed-remap.ts pieceRead): item output [from, from + duration) of a profile over `length`. */
    speed: WindowSpeed | null;
}

interface WindowSpeed {
    profile: SpeedProfile;
    /** The item's timeline length D. */
    length: number;
    /** Scene-local timeline second the window starts at. */
    from: number;
    /** Media second of scene source second 0, and media seconds per source second. */
    origin: number;
    rate: number;
}

/** A scene's look: the static plan, or the Adjust-keyframe cross-fade (motion/lut-keyframes.ts) and the steps after it. */
interface SceneLook {
    plan: LookPlan | null;
    keyed: ExportKeyedLook | null;
}

const EPS = 1e-6;

/**
 * `-ss` in whole milliseconds, floored: ffmpeg drops frames before the seek point, so a rounded-up value
 * (a window piece at 23/30 s written "0.767") would skip the piece's first frame. Values already on whole
 * milliseconds print as before.
 */
export const seekSeconds = (seconds: number) => (Math.floor(Math.max(0, seconds) * 1000 + 1e-6) / 1000).toFixed(3);

/** The scene's motion over its timeline length (timeline-core motion/transform.ts, scene units). */
export function sceneMotion(scene: SceneData): ItemMotion {
    return itemMotion({ kind: "scene", scene, duration: sceneDuration(scene) });
}

/**
 * True when the scene draws exactly what its static fields draw (the preview's plainScene /
 * isIdentitySceneMotion rule, preview/scene-motion.ts): then the 10a static fit applies unchanged.
 */
export function staticScene(scene: SceneData, motion: ItemMotion): boolean {
    const plain = !scene.keyframesJson && !scene.animationJson && Math.abs(num(scene.rotationDegrees, 0) % 360) <= EPS && num(scene.opacity, 1) >= 1 - EPS;
    if (plain) return true;
    if (motion.animated) return false;
    const values = motionAt(motion, 0);
    const scale = num(scene.transformScale, 1);
    return Math.abs(values.scale - (scale > 0 ? scale : 1)) <= EPS
        && Math.abs(values.posX - num(scene.transformOffsetX, 0)) <= EPS
        && Math.abs(values.posY - num(scene.transformOffsetY, 0)) <= EPS
        && Math.abs(values.dx) <= EPS && Math.abs(values.dy) <= EPS
        && Math.abs(Math.abs(values.scaleX) - 1) <= EPS
        && Math.abs(values.rotation % 360) <= EPS
        && values.opacity >= 1 - EPS;
}

const MARGIN = 2;
const evenCeil = (value: number) => Math.ceil(value / 2) * 2;
const even = (value: number) => Math.max(2, Math.round(value / 2) * 2);

/**
 * The placement contract of the preview's scenePlacement (preview/scene-motion.ts): the media fitted at scale 1
 * (sceneFitRect) times max(0, scale), centred on the frame centre moved by (posX% + dx·100%) of the width and
 * (posY% + dy·100%) of the height, |scaleX| on the width, rotated clockwise about its centre, alpha × opacity,
 * over the window's background (black on V1, clear on V2+). The media is fitted once at the largest scale any
 * frame reaches, then scaled down per frame. `time` is the scene-local second of the window's first frame.
 */
function placeSceneMotion(ctx: CompileContext, motion: ItemMotion, footage: string, fitted: { width: number; height: number }, reference: number, background: string, time: number, opaque: boolean): string {
    const { width, height, fps } = ctx.format;
    // The frame's own timestamp: scale and rotate count `n` from 1 (their input link's frame count after the
    // frame is taken), so n/fps would run one frame ahead of the preview.
    const layerTime = frameClock("t", fps);
    const mainTime = frameClock("t", fps);
    const at = (channel: Parameters<typeof motionFfmpeg>[1], variable: string) => motionFfmpeg(motion, channel, variable, -time);
    const filters: string[] = [];
    const opacity = motion.channels.opacity;
    if (opacity.k === "num" && opacity.v < 0.999) filters.push("format=rgba", `colorchannelmixer=aa=${fmt(opacity.v)}`);
    filters.push("format=yuva444p");
    if (opacity.k !== "num") {
        filters.push(`geq=lum='lum(X,Y)':cb='cb(X,Y)':cr='cr(X,Y)':a='alpha(X,Y)*${at("opacity", frameClock("T", fps))}+0.5'`);
    }
    const relative = (variable: string) => `max(0,${at("scale", variable)})/${fmt(reference)}`;
    const scaleXPeak = Math.max(1, channelPeak(motion, "scaleX", fps, Math.abs));
    const flips = !(isConstantChannel(motion, "scaleX") && Math.abs((motion.channels.scaleX as { v: number }).v) === 1);
    const layerSize = (variable: string) => ({
        width: `max(1,round(${fitted.width}*${relative(variable)}${flips ? `*abs(${at("scaleX", variable)})` : ""}))`,
        height: `max(1,round(${fitted.height}*${relative(variable)}))`,
    });
    const radians = (variable: string) => `(${at("rotation", variable)})*PI/180`;
    const size = layerSize(layerTime);
    filters.push(`scale=w='${size.width}':h='${size.height}':eval=frame`);
    const pad = { width: evenCeil(Math.ceil(fitted.width * scaleXPeak) + MARGIN * 2), height: evenCeil(fitted.height + MARGIN * 2) };
    filters.push(`pad=w=${pad.width}:h=${pad.height}:x='(ow-iw)/2':y='(oh-ih)/2':color=black@0:eval=frame`);
    const rotation = motion.channels.rotation;
    const rotated = rotation.k !== "num" || Math.abs(rotation.v % 360) > 0.001;
    const side = rotated ? evenCeil(Math.hypot(pad.width, pad.height)) : null;
    // c=black@0, not none: "none" leaves the corners unwritten, and pooled frames then show earlier frames there.
    if (side) filters.push(`rotate=a='${radians(layerTime)}':c=black@0:ow=${side}:oh=${side}`);
    const layer = ctx.graph.chain([footage], filters, ctx.graph.label("sm"));
    const cx = `(${width / 2}+((${at("posX", mainTime)})/100+${at("dx", mainTime)})*${width})`;
    const cy = `(${height / 2}+((${at("posY", mainTime)})/100+${at("dy", mainTime)})*${height})`;
    const shift = padShift(pad, { ...layerSize(mainTime), radians: rotated ? radians(mainTime) : undefined });
    const x = nearestEven(`${cx}-${(side ?? pad.width) / 2}-${shift.x}`);
    const y = nearestEven(`${cy}-${(side ?? pad.height) / 2}-${shift.y}`);
    // Frames whose scale is 0 or less show only the background (the preview draws nothing; scale keeps 1 px).
    const gate = reachesNonPositiveScale(motion, fps) ? `:enable='gt(${at("scale", mainTime)},0)'` : "";
    return ctx.graph.chain([background, layer], [
        `overlay=x='${x}':y='${y}':eval=frame:eof_action=pass:format=auto${gate}`,
        `format=${opaque ? "yuv420p" : "yuva420p"}`,
        `settb=1/${fps}`,
    ], ctx.graph.label("sc"));
}

/**
 * One media window fitted onto a full-frame background of exactly `window.duration`; null when unreadable.
 * `lookTime` is the item-local second of the window's first frame (look passes and grain), `motionTime` its
 * scene-local second (motion and keyframed looks: keyframe times are scene-local).
 */
function footageSegment(ctx: CompileContext, scene: SceneData, window: FootageWindow, opaque: boolean, look: SceneLook, lookTime = 0, motionTime = lookTime): Segment | null {
    const { width, height, fps } = ctx.format;
    const info = ctx.media.get(window.url);
    if (!info || !info.hasVideo) return null;
    const isStill = !window.isVideo || info.durationSeconds <= 0;
    // Speed: read from a pre-roll before S(from) and keep absolute timestamps (no PTS-STARTPTS), then remap.
    const read = !isStill && window.speed ? pieceRead({ ...window.speed, duration: window.duration }) : null;
    const input = ctx.graph.input("media", window.url, isStill
        ? ["-loop", "1", "-framerate", String(fps), "-t", sec(window.duration)]
        : read ? ["-ss", read.readStart.toFixed(3), "-t", read.readLength.toFixed(3)] : ["-ss", seekSeconds(window.offset), "-t", sec(window.duration)]);
    const motion = sceneMotion(scene);
    const moving = !staticScene(scene, motion);
    const fit = sceneFit(
        scene.fitMode,
        { width: info.width, height: info.height },
        { width, height },
        num(scene.transformScale, 1) || 1,
        num(scene.transformOffsetX, 0),
        num(scene.transformOffsetY, 0),
    );
    // Moving scenes: the scale-1 fit at the largest scale reached (the bitmap only ever scales down).
    // The reference is clamped (MIN_REFERENCE_SCALE) so the per-frame scale never divides by a zero-formatted peak.
    const peak = moving ? channelPeak(motion, "scale", fps) : 1;
    const reference = Math.max(MIN_REFERENCE_SCALE, peak);
    const base = sceneFitRect(scene.fitMode, { width: info.width, height: info.height }, { width, height }, 1, 0, 0);
    const size = moving ? { width: even(base.width * reference), height: even(base.height * reference) } : fit;
    const scaled = ctx.graph.chain([videoPad(input)], [
        ...(read ? remapFilters(read.remap, fps) : ["setpts=PTS-STARTPTS"]),
        `fps=${fps}`,
        `scale=${size.width}:${size.height}`,
        "setsar=1",
    ], ctx.graph.label("sf"));
    // The scene's look runs on its own fitted pixels, before the background (preview: lane-look-overlay).
    // Stills and webm may carry alpha (overlays.ts uses the same rule): keep it through the look.
    const alpha = isStill || /\.webm(\?|#|$)/i.test(window.url);
    const footage = applyLook(ctx, scaled, look.plan, {
        width: size.width, height: size.height, alpha, duration: window.duration, timeOffset: lookTime, keyframeOffset: motionTime,
    }, look.keyed);
    const background = gapSegment(ctx, window.duration, opaque).label;
    if (moving && peak > 0) {
        return { label: placeSceneMotion(ctx, motion, footage, size, reference, background, motionTime, opaque), duration: window.duration };
    }
    // A scene that never reaches a positive scale shows only its background.
    const label = moving
        ? ctx.graph.chain([background, footage], ["overlay=x=main_w:y=0:eof_action=pass:format=auto", `format=${opaque ? "yuv420p" : "yuva420p"}`, `settb=1/${fps}`], ctx.graph.label("sc"))
        : ctx.graph.chain([background, footage], [
            `overlay=x=${fit.x}:y=${fit.y}:eof_action=pass:format=auto`,
            `format=${opaque ? "yuv420p" : "yuva420p"}`,
            `settb=1/${fps}`,
        ], ctx.graph.label("sc"));
    return { label, duration: window.duration };
}

/**
 * A shot-sequenced scene (timeline-model sceneShotSequence): each shot's own video over its frame-snapped
 * share of the item, joined with concat, then the item's dip fades.
 */
/** Item-local seconds [from, to) of a lane item. */
interface Range {
    from: number;
    to: number;
}

function shotSequenceSegment(ctx: CompileContext, item: Extract<LaneItem, { kind: "scene" }>, shots: ScenePiece[], opaque: boolean, look: SceneLook, range: Range): Segment {
    const { fps } = ctx.format;
    const scene = item.placed.scene;
    const frame = (seconds: number) => Math.round(seconds * fps) / fps;
    // Scene-local second the item starts at (an overlapped scene keeps only its tail).
    const local = item.offset;
    const profile = sceneSpeedProfile(scene);
    const identity = isIdentitySpeed(profile);
    const length = sceneDuration(scene);
    const pieces: Segment[] = [];
    shots.forEach((shot, index) => {
        const shotFrom = frame(Math.min(item.duration, Math.max(0, shot.start - local)));
        const shotTo = index === shots.length - 1 ? item.duration : frame(Math.min(item.duration, Math.max(0, shot.end - local)));
        const from = Math.max(shotFrom, range.from);
        const to = Math.min(shotTo, range.to);
        if (to - from < 1 / fps / 2) return;
        // Shot media second = rate·(S(t) − sourceStart): 1:1 only without speed and without a stretched shot list.
        const speed = identity && shot.rate === 1 ? null : { profile, length, from: local + from, origin: -shot.rate * shot.sourceStart, rate: shot.rate };
        const window = { url: shot.url, isVideo: true, offset: Math.max(0, local + from - shot.start), duration: to - from, speed };
        const piece = footageSegment(ctx, scene, window, opaque, look, from, local + from);
        if (!piece) ctx.warnings.push({ code: "media-unreadable", message: "A shot video could not be read; that shot exports as black.", sceneId: scene.id });
        pieces.push(piece ?? gapSegment(ctx, to - from, opaque));
    });
    const duration = range.to - range.from;
    if (pieces.length === 0) return gapSegment(ctx, duration, opaque);
    if (pieces.length === 1) return pieces[0];
    const label = ctx.graph.chain(pieces.map((piece) => piece.label), [`concat=n=${pieces.length}:v=1:a=0`, `settb=1/${fps}`], ctx.graph.label("sh"));
    return { label, duration };
}

/**
 * Item-local seconds [from, to) of a scene as its own stream. Head, body, and tail of a scene with
 * transitions are separate reads of the media (no split/trim): every stream keeps the constant frame
 * rate xfade needs on FFmpeg 7, and FFmpeg 5.1 drops no end frame.
 */
function sceneSegment(ctx: CompileContext, item: Extract<LaneItem, { kind: "scene" }>, opaque: boolean, range: Range, look: SceneLook): Segment {
    const scene = item.placed.scene;
    const duration = range.to - range.from;
    const shots = sceneShotSequence(scene);
    if (shots) return shotSequenceSegment(ctx, item, shots, opaque, look, range);
    const videoUrl = sceneVideoUrl(scene);
    const url = videoUrl ?? sceneImageUrl(scene);
    if (!url) {
        ctx.warnings.push({ code: "media-missing", message: "Scene has no video or image; it exports as black.", sceneId: scene.id });
        return gapSegment(ctx, duration, opaque);
    }
    const profile = sceneSpeedProfile(scene);
    const speed = isIdentitySpeed(profile) ? null : { profile, length: sceneDuration(scene), from: item.offset + range.from, origin: sceneTrimStart(scene), rate: 1 };
    const segment = footageSegment(ctx, scene, { url, isVideo: Boolean(videoUrl), offset: item.trimStart + range.from, duration, speed }, opaque, look, range.from, item.offset + range.from);
    if (!segment) {
        ctx.warnings.push({ code: "media-unreadable", message: "Scene media could not be read; it exports as black.", sceneId: scene.id });
        return gapSegment(ctx, duration, opaque);
    }
    return segment;
}

/**
 * Legacy catalog effects on the scene are GL layers over its range (gl.ts collectGlLayers), which also reports
 * unknown ones. Adjust keyframes replace the static adjust CLUT with the keyframes' cross-fade.
 */
function sceneLook(ctx: CompileContext, scene: SceneData): SceneLook {
    const keyed = sceneKeyframedLook(ctx, scene);
    return keyed ? { plan: keyed.rest, keyed } : { plan: itemLook({ kind: "scene", ...scene }), keyed: null };
}

/**
 * Live handles of a scene window (looks/handles.ts), floored to frames and never past the probed end of the
 * file (a stored content length can be wrong; reading past the end would leave frames missing).
 */
export function laneHandles(ctx: Pick<CompileContext, "media" | "format">, a: SceneItem, b: SceneItem, half: number): TransitionHandles {
    const probed = (item: SceneItem): HandleMedia | null => {
        const media = sceneHandleMedia(item.placed.scene);
        if (!media || media.still) return media;
        const url = sceneVideoUrl(item.placed.scene);
        const info = url ? ctx.media.get(url) : undefined;
        if (!info || !info.hasVideo) return null;
        const probe = info.durationSeconds > 0 ? info.durationSeconds : null;
        const length = media.mediaLength === null || probe === null ? media.mediaLength : Math.min(media.mediaLength, probe);
        return { ...media, mediaLength: length };
    };
    return snapHandles(transitionHandles(probed(a), probed(b), half), ctx.format.fps);
}

export type SceneItem = Extract<LaneItem, { kind: "scene" }>;

/**
 * Item-local seconds [from, to) of a scene including live handle seconds before 0 or after its length. At
 * speed 1 the media simply continues (one read); a sped-up scene's handles play at its speed factor
 * (looks/handles.ts) as their own pieces, concatenated to the piece inside the scene.
 */
function handleSegment(ctx: CompileContext, item: SceneItem, opaque: boolean, range: Range, look: SceneLook): string {
    const { fps } = ctx.format;
    const scene = item.placed.scene;
    const inside = { from: Math.max(0, range.from), to: Math.min(item.duration, range.to) };
    const lead = inside.from - range.from;
    const trail = range.to - inside.to;
    if ((lead <= EPS && trail <= EPS) || isIdentitySpeed(sceneSpeedProfile(scene))) return sceneSegment(ctx, item, opaque, range, look).label;
    const media = sceneHandleMedia(scene)!;
    const url = sceneVideoUrl(scene) ?? sceneImageUrl(scene)!;
    const extension = (offset: number, duration: number, from: number) => {
        const speed = media.still ? null : { profile: { speed: media.rate, curve: null, preservePitch: true }, length: duration, from: 0, origin: offset, rate: 1 };
        const piece = footageSegment(ctx, scene, { url, isVideo: !media.still, offset, duration, speed }, opaque, look, from, item.offset + from);
        return piece?.label ?? gapSegment(ctx, duration, opaque).label;
    };
    const pieces: string[] = [];
    if (lead > EPS) pieces.push(extension(Math.max(0, item.trimStart - lead * media.rate), lead, range.from));
    if (inside.to - inside.from >= 1 / fps / 2) pieces.push(sceneSegment(ctx, item, opaque, inside, look).label);
    if (trail > EPS) pieces.push(extension(media.sourceEnd, trail, item.duration));
    if (pieces.length === 1) return pieces[0];
    return ctx.graph.chain(pieces, [`concat=n=${pieces.length}:v=1:a=0`, `settb=1/${fps}`], ctx.graph.label("cc"));
}

/**
 * One lane as a single stream lasting `length` seconds (trailing gap added when needed). A transition
 * is centered on its cut (looks/windows.ts): the window is its own 2·half segment built from the
 * outgoing item's last `half` seconds and the incoming item's first `half` seconds, mixed by the shared
 * transition expression in xfade custom. Each side shows real media beyond the cut where the media has it
 * (live handles, looks/handles.ts) and holds its last / first frame for the rest. Only window frames go
 * through RGB; the total length and every item position never change.
 */
export function compileLane(ctx: CompileContext, lane: SceneLane, opaque: boolean, length: number): string {
    const { fps } = ctx.format;
    const items: LaneItem[] = [...lane.items];
    const tail = length - lane.end;
    if (tail >= 1 / fps / 2) items.push({ kind: "gap", start: lane.end, duration: tail });
    const windows = planTransitionWindows(items.map((item) => (item.kind === "scene" ? item.duration : 0)), lane.joins, fps);
    const handles = new Map<number, TransitionHandles>();
    for (const [i, window] of windows) {
        const a = items[i];
        const b = items[i + 1];
        if (a.kind === "scene" && b.kind === "scene") handles.set(i, laneHandles(ctx, a, b, window.half));
    }
    const pieces: string[] = [];
    let pendingTail: { pad: string; live: number } | null = null;
    for (let i = 0; i < items.length; i += 1) {
        const item = items[i];
        if (item.kind === "gap") {
            pieces.push(gapSegment(ctx, item.duration, opaque).label);
            continue;
        }
        const look = sceneLook(ctx, item.placed.scene);
        const incoming = windows.get(i - 1);
        const outgoing = windows.get(i);
        const headHalf = incoming?.half ?? 0;
        const tailHalf = outgoing?.half ?? 0;
        const before = handles.get(i - 1)?.incomingBefore ?? 0;
        const after = handles.get(i)?.outgoingAfter ?? 0;
        const segment = (from: number, to: number) => handleSegment(ctx, item, opaque, { from, to }, look);
        if (incoming && pendingTail) {
            pieces.push(transitionWindow(ctx, pendingTail.pad, segment(-before, headHalf), incoming.type, incoming.half, opaque, { tail: pendingTail.live, head: before }));
        }
        if (item.duration - headHalf - tailHalf >= 1 / fps / 2) pieces.push(segment(headHalf, item.duration - tailHalf));
        pendingTail = outgoing ? { pad: segment(item.duration - tailHalf, item.duration + after), live: after } : null;
    }
    if (pieces.length === 0) return gapSegment(ctx, length, opaque).label;
    if (pieces.length === 1) return pieces[0];
    return ctx.graph.chain(pieces, [`concat=n=${pieces.length}:v=1:a=0`, `settb=1/${fps}`], ctx.graph.label("cc"));
}

/** Live seconds at the end of a window's tail input (after the cut) and at the start of its head input (before it). */
export interface WindowLive {
    tail: number;
    head: number;
}

/**
 * The 2·half window between an outgoing tail and an incoming head. The tail pad lasts half + live.tail seconds
 * (live frames after the cut), the head pad live.head + half (live frames before it); the rest of each side is
 * its frozen last / first frame. Opaque lanes blend on gbrp, transparent ones (V2+ scene and clip lanes) on gbrap.
 */
export function transitionWindow(ctx: CompileContext, tailPad: string, headPad: string, type: string, half: number, opaque: boolean, live: WindowLive = { tail: 0, head: 0 }): string {
    const { fps } = ctx.format;
    const def = transitionById(type)!;
    const planar = opaque ? "gbrp" : "gbrap";
    // Version quirks, all neutralized here: FFmpeg 5.1's tpad gives the first cloned frame the previous
    // frame's timestamp (so every frame is renumbered), 7.1 needs a constant-rate stream after that (fps),
    // 5.1's fps drops a stream's last frame and its xfade drops the last transition frame when the second
    // input ends with it (so both inputs get two spare frames, and the output is trimmed to the window).
    const frames = Math.round(2 * half * fps);
    const frozenTail = Math.round(half * fps) - Math.round(live.tail * fps);
    const frozenHead = Math.round(half * fps) - Math.round(live.head * fps);
    const renumber = [`setpts=N/${fps}/TB`, `fps=${fps}`];
    const a = ctx.graph.chain([tailPad], [`tpad=stop_mode=clone:stop=${frozenTail + 2}`, ...renumber, `format=${planar}`], ctx.graph.label("wa"));
    const b = ctx.graph.chain([headPad], [`tpad=start_mode=clone:start=${frozenHead}:stop_mode=clone:stop=2`, ...renumber, `format=${planar}`], ctx.graph.label("wb"));
    const expr = xfadeExpression((ch) => def.channel(ch), opaque ? 3 : 4);
    return ctx.graph.chain([a, b], [
        `xfade=transition=custom:duration=${fmt(2 * half)}:offset=0:${XFADE_THREADS}:expr='${expr}'`,
        `trim=end_frame=${frames}`,
        `format=${opaque ? "yuv420p" : "yuva420p"}`,
        `settb=1/${fps}`,
    ], ctx.graph.label("xf"));
}

/** All scene lanes: V1 (or black) at the bottom, higher tracks stacked on top. Returns the video pad. */
export function compileSceneLanes(ctx: CompileContext, lanes: SceneLane[]): string {
    const base = lanes.find((lane) => lane.trackIndex === 1);
    let video = base ? compileLane(ctx, base, true, ctx.duration) : gapSegment(ctx, ctx.duration, true).label;
    for (const lane of lanes.filter((l) => l.trackIndex >= 2)) {
        const layer = compileLane(ctx, lane, false, Math.min(lane.end, ctx.duration));
        video = ctx.graph.chain([video, layer], ["overlay=0:0:eof_action=pass:format=auto"], ctx.graph.label("ln"));
    }
    return video;
}
