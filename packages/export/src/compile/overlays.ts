// Video, image, sticker and text overlays on top of the scene lanes. Order and math follow the
// preview compositor (preview-panel.tsx:1123-1420); clip filters follow the reference assembler's order.
import type { TimelineClip } from "@opennan/timeline-core";
import { ffNumber } from "@opennan/timeline-core/looks/expr";
import { itemLook, maskLook, type LookPlan } from "@opennan/timeline-core/looks/look-plan";
import { centredMaskBox, type MaskBox } from "@opennan/timeline-core/looks/masks";
import { clipMediaStart, clipSpeedProfile, isIdentitySpeed, sourceSpan } from "@opennan/timeline-core/motion/speed";
import { isConstantChannel, itemMotion, motionFfmpeg, type ItemMotion } from "@opennan/timeline-core/motion/transform";
import type { MotionChannel } from "@opennan/timeline-core/motion/types";
import {
    blendMode, blurStrength, chromaKey, clipOpacity, clipTransitionType, crop, effectiveTextFades,
    fadeDurations, freezeFrame, horizontalFlip, mosaicStrength, reversePlayback, verticalFlip,
} from "../clip-params";
import {
    blendModeFilters, blurFilters, chromaKeyFilters, clipTransitionFilters, cropFilters, flipFilters, freezeFilters,
    mosaicFilters, reverseFilters,
} from "../filters/video";
import { applyLook } from "../looks/look-filters";
import { clipKeyframedLook } from "../motion/lut-keyframes";
import { fmt, sec } from "../format";
import { videoPad } from "../graph";
import { pinEqFormats } from "../lgpl-filters";
import { VIDEO_SLACK_SECONDS, clipRemap, remapFilters } from "../speed-remap";
import type { PlanInput } from "../types";
import type { CompileContext } from "./context";
import { overlayScale, reachesNonPositiveScale } from "./overlay-scale";
import { animatedPlacement, frameClock, staticPlacement, type Size } from "./placement";

export interface OverlaySource {
    clip: TimelineClip;
    input: PlanInput;
    /** A video file: speed, reverse and freeze apply. */
    video: boolean;
    /** Text fades fall back to the transition duration (reference assembler behavior). */
    text: boolean;
    /** Bitmap size and its anchoring box at `baseScale` (equal for media; text adds padding). */
    outer: Size;
    box: Size;
    baseScale: number;
    /** Pixel size of the decoded input when it differs from `outer` (media at its native size). Default `outer`. */
    stream?: Size;
    /** Text state atlas: the per-frame `crop` that picks the current cell (motion/text-atlas.ts); `stream` is the cell. */
    atlasCrop?: string;
}

/** The look an overlay runs: the clip's own (filter, adjust, effects, mask); text draws no look, only its mask (phase 10d). */
export function overlayLook(source: Pick<OverlaySource, "clip" | "text">): LookPlan | null {
    return source.text ? maskLook({ kind: "clip", ...source.clip }) : itemLook({ kind: "clip", ...source.clip });
}

/**
 * The item's box inside the scaled overlay bitmap `outer` for its mask (phase 10d): text and emoji rasters pad their
 * layout box on every side, so the mask is sized and placed by `box`, centred in the bitmap. Null when the bitmap is
 * the item (media, bundled stickers): the mask spans the whole bitmap, as for 10c clips.
 */
export function overlayMaskBox(source: Pick<OverlaySource, "outer" | "box">, outer: Size, box: Size): MaskBox | null {
    const padded = Math.abs(source.outer.width - source.box.width) > 1e-6 || Math.abs(source.outer.height - source.box.height) > 1e-6;
    return padded ? centredMaskBox(outer, box) : null;
}

export const OVERLAY_MARGIN = 2;
const MARGIN = OVERLAY_MARGIN;

/**
 * Speed (phase 10b): one remap through the clip's speed profile (constant speed, curve, or a legacy ramp's
 * step curve; speed-remap.ts). Reverse applies to the SOURCE first, as in CapCut: the read span (its slack
 * trimmed) is reversed, then the curve plays the reversed source. A frozen clip holds its first frame, so it
 * is not remapped.
 */
export function timeFilters(source: OverlaySource, duration: number, fps: number): string[] {
    const clip = source.clip;
    const filters = ["setpts=PTS-STARTPTS"];
    const freeze = source.video && freezeFrame(clip);
    if (source.video) {
        const profile = clipSpeedProfile(clip);
        const reverse = reversePlayback(clip);
        if (reverse && !isIdentitySpeed(profile)) filters.push(`trim=end=${ffNumber(sourceSpan(profile, duration))}`);
        filters.push(...reverseFilters(reverse));
        const remap = freeze ? null : clipRemap(profile, duration);
        if (remap) filters.push(...remapFilters(remap, fps));
    }
    filters.push(`fps=${fps}`);
    if (source.video) filters.push(...freezeFilters(freeze, duration, fps));
    filters.push(`trim=duration=${sec(duration)}`);
    return filters;
}

/**
 * Media second where a video overlay's frames start: the clip's trimStart (motion/speed.ts clipMediaStart). Its input
 * seeks there, so every time filter below counts source seconds from it: plain clips show trimStart + local, speed
 * remaps from it, reverse plays [trimStart, trimStart + span] backwards, freeze holds its frame. Stills, rasters and
 * GIFs (which loop from their first frame, as the preview's image element plays them) start at 0.
 */
export function overlayMediaStart(source: Pick<OverlaySource, "clip" | "video" | "input">): number {
    if (!source.video || source.input.kind !== "media" || GIF_URL.test(source.input.source)) return 0;
    return clipMediaStart(source.clip);
}

/** The `-ss` of a whole-clip video overlay read: none from media zero, so untrimmed clips read exactly as before. */
export function overlaySeek(clip: TimelineClip): string[] {
    const start = clipMediaStart(clip);
    return start > 0 ? ["-ss", floorMs(start)] : [];
}

/**
 * A clip drawn over item-local seconds [from, to) only, onto a canvas that starts at item-local `from` (clip
 * transition lanes, compile/clip-lanes.ts). `from` may be negative and `to` may pass the clip length: frames
 * outside the clip's media hold its first / last frame, except `after` seconds of real media past the clip's
 * end (a live transition handle) and stills, which simply continue. Both ends are whole frames.
 */
export interface OverlayRange {
    from: number;
    to: number;
    after: number;
    /** Seconds of real media before the clip's start (a live incoming transition handle: media before its trimStart). */
    before?: number;
}

const GIF_URL = /\.gif(\?|#|$)/i;
const floorMs = (seconds: number) => (Math.floor(Math.max(0, seconds) * 1000 + 1e-6) / 1000).toFixed(3);

/**
 * The read and time filters of a ranged overlay: exactly round((to − from)·fps) frames timed from 0 (the
 * canvas clock); every time-dependent filter after it shifts its clock by `from` (scene pieces do the same).
 * Plain 1:1 video seeks to the range from its trimStart (whole milliseconds, floored so the first frame is never
 * skipped), reading `before` seconds of real media ahead of the clip;
 * stills loop; sped-up, reversed, frozen, and GIF clips decode the whole clip and keep the range's frames.
 */
function rangeTime(source: OverlaySource, duration: number, fps: number, range: OverlayRange): { options: string[]; filters: string[] } {
    const clip = source.clip;
    const frames = (seconds: number) => Math.round(seconds * fps);
    const f0 = frames(range.from);
    const f1 = frames(range.to);
    const pad = (missingStart: number, missingEnd: number) => [
        ...(missingStart > 0 ? [`tpad=start_mode=clone:start=${missingStart}`] : []),
        ...(missingEnd > 0 ? [`tpad=stop_mode=clone:stop=${missingEnd}`] : []),
        `setpts=N/${fps}/TB`,
    ];
    if (!source.video) {
        return {
            options: ["-loop", "1", "-framerate", String(fps), "-t", sec((f1 - f0) / fps)],
            filters: ["setpts=PTS-STARTPTS", `fps=${fps}`, `trim=end_frame=${f1 - f0}`, ...pad(0, 0)],
        };
    }
    const plain = isIdentitySpeed(clipSpeedProfile(clip)) && !reversePlayback(clip) && !freezeFrame(clip) && !GIF_URL.test(source.input.source);
    if (plain) {
        const origin = overlayMediaStart(source);
        const lead = Math.min(frames(Math.max(0, range.before ?? 0)), Math.floor(origin * fps + 1e-6));
        const r0 = Math.min(Math.max(-lead, f0), Math.max(0, f1));
        const r1 = Math.max(r0, Math.min(f1, frames(duration + Math.max(0, range.after))));
        return {
            options: ["-ss", floorMs(origin + r0 / fps), "-t", sec((r1 - r0) / fps)],
            filters: ["setpts=PTS-STARTPTS", `fps=${fps}`, `trim=end_frame=${r1 - r0}`, ...pad(r0 - f0, f1 - r1)],
        };
    }
    const total = frames(duration);
    const k0 = Math.min(total, Math.max(0, f0));
    const k1 = Math.max(k0, Math.min(total, f1));
    return {
        options: source.input.options,
        filters: [...timeFilters(source, duration, fps), `trim=start_frame=${k0}:end_frame=${k1}`, ...pad(k0 - f0, f1 - k1)],
    };
}

/**
 * Source seconds a video overlay consumes: the speed profile's span s·D·mean(y) (constant speed, curve, or
 * a legacy ramp's step curve, which matches its old table exactly).
 */
export function overlaySourceSpan(clip: TimelineClip): number {
    return sourceSpan(clipSpeedProfile(clip), Math.max(0, clip.endTime - clip.startTime));
}

/** Seconds a video overlay reads (`-t`): its span, plus slack frames when it is remapped (speed-remap.ts). */
export function overlayReadSpan(clip: TimelineClip): number {
    const span = overlaySourceSpan(clip);
    return isIdentitySpeed(clipSpeedProfile(clip)) ? span : span + VIDEO_SLACK_SECONDS;
}

const PLACEMENT_CHANNELS: readonly MotionChannel[] = ["scale", "scaleX", "posX", "posY", "dx", "dy", "rotation"];

/** A constant channel's value (callers check isConstantChannel first). */
export const constant = (motion: ItemMotion, channel: MotionChannel) => (motion.channels[channel] as { v: number }).v;

/** Placement never changes: every placement channel is constant and neutral where 10a had no field (|scaleX| 1, dx = dy = 0). */
export function staticPlacementOf(motion: ItemMotion): boolean {
    if (!PLACEMENT_CHANNELS.every((channel) => isConstantChannel(motion, channel))) return false;
    return Math.abs(Math.abs(constant(motion, "scaleX")) - 1) < 1e-9 && constant(motion, "dx") === 0 && constant(motion, "dy") === 0;
}

/**
 * True when the clip's opacity is its base opacity times the legacy alpha fades only (no opacity keyframes or
 * animation): the 10a filters (alpha `fade`, then colorchannelmixer) express it exactly and cheaply, since the
 * model's fade factors are the `fade` filter's own (t − st) / d at frame timestamps (motion/transform.ts).
 */
export function legacyOpacity(clip: TimelineClip): boolean {
    return isConstantChannel(itemMotion({ kind: "clip", clip: { ...clip, fadeInDuration: 0, fadeOutDuration: 0, transitionType: "none" } }), "opacity");
}

/**
 * Adds one overlay above `below` and returns the new composite pad. Placement follows the transform model
 * (timeline-core motion/transform.ts itemMotion; the preview's placedBox): a clip whose placement channels are
 * all constant keeps the 10a static graph; any other clip is scaled per frame (w × |scaleX|, h), padded,
 * rotated, and placed through the overlay's per-frame x/y with the animation's centre offsets. Opacity is the
 * model's opacity channel: the 10a fade filters when it is base × legacy fades, else a per-frame geq alpha.
 * With a `range` (clip transition lanes), only that item-local span is drawn, onto a canvas that starts at
 * `range.from` (OverlayRange): every clock below is shifted by `range.from`, nothing else changes.
 */
export function compileOverlay(ctx: CompileContext, below: string, source: OverlaySource, range?: OverlayRange): string {
    const { graph } = ctx;
    const { width, height, fps } = ctx.format;
    const clip = source.clip;
    const start = clip.startTime;
    const end = clip.endTime;
    const duration = Math.max(0, end - start);
    if (duration < 1 / fps) return below;
    const timed = range ? rangeTime(source, duration, fps, range) : null;
    // Item-local seconds of the stream's first frame, and the overlay clock's offset (item-local = t − origin).
    const shift = range ? range.from : 0;
    const origin = range ? -range.from : start;
    const layerOffset = range && range.from !== 0 ? -range.from : undefined;
    const input = graph.input(source.input.kind, source.input.source, timed ? timed.options : source.input.options);
    const motion = itemMotion({ kind: "clip", clip });
    const scale = overlayScale(clip, fps);
    const placedStatic = staticPlacementOf(motion);
    // A constant scale of 0 or less (a lone scale keyframe) draws nothing, as in the preview.
    if (placedStatic && constant(motion, "scale") <= 0) return below;
    // The bitmap's scale: the constant scale when nothing moves (a lone scale keyframe included), else the peak.
    const prepared = placedStatic ? constant(motion, "scale") : scale.reference;
    const factor = prepared / source.baseScale;
    const cropped = crop(clip);
    const keepW = 1 - cropped.left - cropped.right;
    const keepH = 1 - cropped.top - cropped.bottom;
    const scaledW = Math.max(2, Math.round(source.outer.width * factor));
    const scaledH = Math.max(2, Math.round(source.outer.height * factor));
    const outer: Size = { width: Math.max(2, Math.round(scaledW * keepW)), height: Math.max(2, Math.round(scaledH * keepH)) };
    const box: Size = { width: source.box.width * factor * keepW, height: source.box.height * factor * keepH };

    const head = timed ? [...timed.filters] : timeFilters(source, duration, fps);
    if (source.atlasCrop) head.push(source.atlasCrop);
    const stream = source.stream ?? source.outer;
    if (scaledW !== stream.width || scaledH !== stream.height) head.push(`scale=${scaledW}:${scaledH}`);
    head.push(...cropFilters(cropped));
    // Filter, Adjust, and the clip's effect stack (looks): the same steps the preview runs on the clip's pixels.
    const look = overlayLook(source);
    for (const effectId of look?.unknownEffects ?? []) {
        ctx.warnings.push({ code: "clip-effect-ignored", message: `Effect "${effectId}" is not built in; it is left out of this clip.`, effectId, clipId: clip.id });
    }
    const keyed = source.text ? null : clipKeyframedLook(ctx, clip);
    const decoded = graph.chain([videoPad(input)], head, graph.label("op"));
    const looked = applyLook(ctx, decoded, keyed ? keyed.rest : look, {
        width: outer.width, height: outer.height, alpha: !source.video || /\.webm(\?|#|$)/i.test(source.input.source),
        duration: range ? (Math.round(range.to * fps) - Math.round(range.from * fps)) / fps : duration,
        ...(shift !== 0 ? { timeOffset: shift } : {}),
        maskBox: overlayMaskBox(source, outer, box),
    }, keyed);
    // The eq lookups are 8-bit: pin eq's input formats before the first one (lgpl-filters.ts).
    const filters = pinEqFormats([
        ...blurFilters(blurStrength(clip)),
        ...chromaKeyFilters(chromaKey(clip)),
        ...blendModeFilters(blendMode(clip)),
        ...mosaicFilters(mosaicStrength(clip)),
    ]);
    const legacy = legacyOpacity(clip);
    const type = clipTransitionType(clip);
    const fades = source.text ? effectiveTextFades(clip, duration) : fadeDurations(clip, duration);
    // Legacy: alpha fades or colour dips as in 10a. Otherwise the opacity channel carries the alpha fades, and
    // only the colour dips (which the model does not express) stay here.
    if (legacy || type === "dip_black" || type === "dip_white") {
        const fadeFilters = clipTransitionFilters(type, fades.fadeIn, fades.fadeOut, duration);
        // The fade filters read the frame's own timestamp: a ranged stream runs them on item-local time.
        if (shift !== 0 && fadeFilters.length > 0) filters.push(`setpts=PTS+${fmt(shift)}/TB`, ...fadeFilters, "setpts=PTS-STARTPTS");
        else filters.push(...fadeFilters);
    }
    filters.push(...flipFilters(horizontalFlip(clip), verticalFlip(clip)));
    filters.push("format=rgba");

    // The frame's own timestamp: scale and rotate count `n` from 1 (their input link's frame count after the
    // frame is taken), so n/fps would run one frame ahead of the preview.
    const layerTime = frameClock("t", fps);
    const mainTime = frameClock("t", fps);
    const opacity = clipOpacity(clip);
    if (legacy && opacity < 0.999) filters.push(`colorchannelmixer=aa=${fmt(opacity)}`);
    const opacityKeyed = !legacy;
    if (opacityKeyed || !placedStatic) filters.push("format=yuva444p");
    if (opacityKeyed) {
        // geq stores the double into the 8-bit plane by truncation: +0.5 rounds (the channel is already clipped to [0, 1]).
        filters.push(`geq=lum='lum(X,Y)':cb='cb(X,Y)':cr='cr(X,Y)':a='alpha(X,Y)*${motionFfmpeg(motion, "opacity", frameClock("T", fps), layerOffset)}+0.5'`);
    }

    const enable = `enable='between(t,${fmt(start)},${fmt(end)})'`;
    if (placedStatic) {
        const degrees = constant(motion, "rotation");
        const place = staticPlacement({ width, height }, box, outer, constant(motion, "posX"), constant(motion, "posY"), degrees);
        if (place.rotatedSide) {
            filters.push(`rotate=a=${fmt((degrees * Math.PI) / 180)}:c=none:ow=${place.rotatedSide}:oh=${place.rotatedSide}`);
        }
        filters.push(range ? "setpts=PTS-STARTPTS" : `setpts=PTS-STARTPTS+${fmt(start)}/TB`);
        const layer = graph.chain([looked], filters, graph.label("ol"));
        return graph.chain([below, layer], [`overlay=x=${place.x}:y=${place.y}:eof_action=pass:format=auto${range ? "" : `:${enable}`}`], graph.label("ov"));
    }

    // Animated: per-frame scale and rotation on the layer (its frame time t), position through the overlay's
    // per-frame x/y (main clock t - start). LGPL filters only (no perspective).
    const relative = (time: string, offset?: number) => `(${motionFfmpeg(motion, "scale", time, offset)})/${fmt(scale.reference)}`;
    const flips = !(isConstantChannel(motion, "scaleX") && Math.abs(constant(motion, "scaleX")) === 1);
    const widthFactor = (time: string, offset?: number) => (flips ? `*abs(${motionFfmpeg(motion, "scaleX", time, offset)})` : "");
    // The layer's per-frame size, written once for the layer clock and once for the overlay's (main) clock.
    const layerSize = (time: string, offset?: number) => ({
        width: `max(1,round(${outer.width}*(${relative(time, offset)})${widthFactor(time, offset)}))`,
        height: `max(1,round(${outer.height}*(${relative(time, offset)})))`,
    });
    const radians = (time: string, offset?: number) => `(${motionFfmpeg(motion, "rotation", time, offset)})*PI/180`;
    const rotated = !isConstantChannel(motion, "rotation") || Math.abs(constant(motion, "rotation") % 360) > 0.001;
    const place = animatedPlacement({
        frame: { width, height }, outer, box, margin: MARGIN, rotated, scaleXPeak: scale.scaleXPeak,
        scale: relative(mainTime, origin),
        posX: motionFfmpeg(motion, "posX", mainTime, origin),
        posY: motionFfmpeg(motion, "posY", mainTime, origin),
        dx: motionFfmpeg(motion, "dx", mainTime, origin),
        dy: motionFfmpeg(motion, "dy", mainTime, origin),
        layer: { ...layerSize(mainTime, origin), radians: rotated ? radians(mainTime, origin) : undefined },
    });
    const size = layerSize(layerTime, layerOffset);
    filters.push(`scale=w='${size.width}':h='${size.height}':eval=frame`);
    filters.push(`pad=w=${place.pad.width}:h=${place.pad.height}:x='(ow-iw)/2':y='(oh-ih)/2':color=black@0:eval=frame`);
    // c=black@0, not none: "none" leaves the corners unwritten, and pooled frames then show earlier frames there.
    if (place.side) filters.push(`rotate=a='${radians(layerTime, layerOffset)}':c=black@0:ow=${place.side}:oh=${place.side}`);
    filters.push(range ? "setpts=PTS-STARTPTS" : `setpts=PTS-STARTPTS+${fmt(start)}/TB`);
    const layer = graph.chain([looked], filters, graph.label("ol"));
    // Frames whose scale is 0 or less show nothing (the preview draws nothing; the scale filter keeps 1 px).
    const visible = reachesNonPositiveScale(motion, fps) ? `gt(${motionFfmpeg(motion, "scale", mainTime, origin)},0)` : null;
    const gate = range
        ? (visible ? `:enable='${visible}'` : "")
        : visible ? `:enable='between(t,${fmt(start)},${fmt(end)})*${visible}'` : `:${enable}`;
    return graph.chain([below, layer], [`overlay=x='${place.x}':y='${place.y}':eval=frame:eof_action=pass:format=auto${gate}`], graph.label("ov"));
}
