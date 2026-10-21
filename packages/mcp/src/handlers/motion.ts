// Text templates and styles, animations, stickers, keyframes, speed, and caption styles for agents (phase 10b;
// keyframe retime and multi-clip speed in 10c): the same controller commands the editor's Text, Stickers,
// Animation, and Speed panels and the keyframe graph run (text.template.apply, text.style.set, animation.set,
// keyframe.*, speed.set, caption.style.apply, clip.create), so each call is one undo_last_edit group and shows
// in the open editor at once.
import {
    getSceneDuration, sceneHelpers, textStyle as textStyles,
    type ControllerSnapshot, type CreateClipInput, type SceneData, type TimelineClip, type TimelineTrack,
} from "@opennan/timeline-core";
import { parseAnimationSpec, serializeAnimationSpec } from "@opennan/timeline-core/motion/animation-spec";
import { motionCatalog } from "@opennan/timeline-core/motion/catalog";
import { EASING_IDS, type EasingId } from "@opennan/timeline-core/motion/easing";
import { animationsFor, type AnimationTarget } from "@opennan/timeline-core/motion/registry";
import { parseSpeedCurve, speedCurvePreset } from "@opennan/timeline-core/motion/speed";
import type { AnimationSlot } from "@opennan/timeline-core/motion/types";
import { STICKER_CATEGORIES, searchStickers, stickerById, type StickerCategory } from "@opennan/timeline-core/stickers/catalog";
import { CAPTION_STYLES } from "@opennan/timeline-core/text/captions";
import { TEXT_FONTS, fontByFamily, fontStack, primaryFontFamily } from "@opennan/timeline-core/text/fonts";
import { TEXT_TEMPLATES, templateStyleJson, textTemplateById } from "@opennan/timeline-core/text/templates";
import { TEXT_STYLE_KEYS, TEXT_STYLE_LIMITS } from "@opennan/mcp-schema";
import { clipById, round3, type Args } from "../args";
import { commandFailure, failure, success, type ToolOutcome } from "../outcome";
import type { StudioSession } from "../session";
import { commandTarget, lookTarget, type Target, type TargetKinds } from "./looks";
import { lockReason, placeClip } from "./placement";
import type { ToolHandler } from "./types";

const SLOTS: readonly AnimationSlot[] = ["in", "out", "combo", "loop"];
// Graphics (remotion) clips take clip animations and transform keyframes, as animation.set and keyframe.* allow.
const ANIMATION_KINDS: TargetKinds = { trackTypes: ["video", "text", "sticker", "remotion"], applies: "animations apply to video, text, sticker, and graphics clips" };
const KEYFRAME_KINDS: TargetKinds = { trackTypes: ["video", "audio", "text", "sticker", "remotion"], applies: "keyframes apply to video, audio, text, sticker, and graphics clips" };
const SPEED_KINDS: TargetKinds = { trackTypes: ["video", "audio"], applies: "speed applies to video and audio clips" };
/** CSS colors are short; the text drawer ignores longer strings (lib/preview-text-draw.ts colorString). */
const MAX_COLOR_LENGTH = 64;

const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

const COLOR_NUMBER = String.raw`[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:%|deg)?`;
const COLOR_PATTERNS = [
    /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i,
    // rgb()/rgba()/hsl()/hsla() with numeric arguments: comma syntax, or space syntax with an optional "/ alpha".
    new RegExp(String.raw`^(?:rgba?|hsla?)\(\s*${COLOR_NUMBER}(?:\s*,\s*${COLOR_NUMBER}){2}(?:\s*,\s*${COLOR_NUMBER})?\s*\)$`, "i"),
    new RegExp(String.raw`^(?:rgba?|hsla?)\(\s*${COLOR_NUMBER}(?:\s+${COLOR_NUMBER}){2}(?:\s*\/\s*${COLOR_NUMBER})?\s*\)$`, "i"),
];
const COLOR_NAMES = new Set([
    "transparent", "black", "white", "red", "green", "blue", "yellow", "orange", "purple", "pink", "gray", "grey", "cyan", "magenta",
    "lime", "navy", "teal", "maroon", "olive", "silver", "aqua", "fuchsia", "gold", "brown",
]);
const COLOR_HELP = "#rgb, #rrggbb, #rrggbbaa, rgb()/rgba()/hsl()/hsla() with numbers, or a basic color name";

/**
 * A colour set_text_style accepts: hex, numeric colour functions, or a basic CSS name. Anything else is refused
 * (the canvas throws on an unparsable gradient stop, and ignores other bad colours, so preview and export would
 * silently differ from what the agent asked for).
 */
export function isTextStyleColor(value: unknown): value is string {
    if (typeof value !== "string") return false;
    const color = value.trim();
    if (!color || color.length > MAX_COLOR_LENGTH) return false;
    return COLOR_NAMES.has(color.toLowerCase()) || COLOR_PATTERNS.some((pattern) => pattern.test(color));
}
const optionalNumber = (value: unknown): number | undefined => (isNumber(value) ? value : undefined);

/** The clip or scene a target names, from a snapshot. */
function itemOf(snap: ControllerSnapshot, target: Target): TimelineClip | SceneData | undefined {
    return "sceneId" in target ? snap.scenes.find((s) => s.id === target.sceneId) : snap.clips.find((c) => c.id === target.clipId);
}

function itemLength(item: TimelineClip | SceneData): number {
    return "trackType" in item ? item.endTime - item.startTime : getSceneDuration(item);
}

/** A text clip the editor would let a person restyle, or why not. */
function editableTextClip(snap: ControllerSnapshot, clipId: unknown): TimelineClip | string {
    const clip = clipById(snap, clipId);
    if (clip.trackType !== "text") return `Clip ${clip.id} is a ${clip.trackType} clip, not a text clip.`;
    return lockReason(snap, clip) ?? clip;
}

function newTrackRow(type: TimelineTrack["type"], index: number): TimelineTrack {
    return { type, index, label: `${type[0].toUpperCase()}${index}`, muted: false, locked: false, visible: true, volume: 1 };
}

/**
 * Creates one clip on the first free editable track of its type (or the requested one). A track that does not
 * exist yet is written by the same clip.create (one undo entry), as the editor's libraries do.
 */
async function createOnFreeTrack(
    session: StudioSession, input: Omit<CreateClipInput, "trackIndex"> & { trackType: TimelineTrack["type"]; startTime: number; endTime: number }, requested?: number,
): Promise<{ clipId: string | null; trackIndex: number } | ToolOutcome> {
    if (!(input.endTime > input.startTime)) return failure("end_time must be after start_time");
    if (!(input.startTime >= 0)) return failure("start_time must be 0 or later");
    const snap = await session.snapshot();
    const placed = placeClip(snap, input.trackType, input.startTime, input.endTime, { requested });
    if (!placed.ok) return failure(placed.error);
    const exists = snap.tracks.some((t) => t.type === input.trackType && t.index === placed.trackIndex);
    const tracks = exists ? undefined : [...sceneHelpers.withRequiredBaseTimelineTracks(snap.tracks).tracks, newTrackRow(input.trackType, placed.trackIndex)];
    const clipInput = { ...input, trackIndex: placed.trackIndex } as CreateClipInput;
    const result = await session.execute({ type: "clip.create", input: clipInput, ...(tracks ? { tracks } : {}) });
    return commandFailure("clip.create", result) ?? { clipId: result.createdClipIds?.[0] ?? null, trackIndex: placed.trackIndex };
}

// ── text ───────────────────────────────────────────────

const listTextTemplates: ToolHandler = async (args) => {
    const catalog = motionCatalog();
    const names = new Map(catalog.textTemplates.map((t) => [t.id, t.name]));
    const category = typeof args.category === "string" ? args.category : undefined;
    const templates = TEXT_TEMPLATES.filter((t) => !category || t.category === category).map((t) => ({
        id: t.id,
        name: names.get(t.id) ?? t.id,
        category: t.category,
        default_text: t.defaultText,
        font_family: typeof t.style.fontFamily === "string" ? primaryFontFamily(t.style.fontFamily) : null,
        animation: t.animation ?? null,
    }));
    const captionNames = new Map(catalog.captionStyles.map((s) => [s.id, s.name]));
    return success(`${templates.length} text templates: ${templates.map((t) => t.id).join(", ")}.`, {
        templates,
        fonts: TEXT_FONTS.map((f) => ({ family: f.family, weights: [...f.weights], category: f.category })),
        caption_styles: CAPTION_STYLES.map((s) => ({ id: s.id, name: captionNames.get(s.id) ?? s.id, karaoke: s.karaoke })),
    });
};

const applyTextTemplate: ToolHandler = async (args, { session }) => {
    const templateId = String(args.template_id);
    const template = textTemplateById(templateId);
    if (!template) return failure(`Unknown text template ${templateId}. list_text_templates lists them.`);
    if (args.clip_id !== undefined) {
        const clip = editableTextClip(await session.snapshot(), args.clip_id);
        if (typeof clip === "string") return failure(clip);
        const result = await session.execute({ type: "text.template.apply", clipIds: [clip.id], templateId });
        return commandFailure("text.template.apply", result) ?? success(`Applied the ${templateId} template to clip ${clip.id}.`, { clipId: clip.id, templateId });
    }
    if (!isNumber(args.start_time) || !isNumber(args.end_time)) {
        return failure("apply_text_template needs clip_id, or text with start_time and end_time for a new text clip.");
    }
    const animationJson = template.animation ? serializeAnimationSpec(template.animation) : null;
    const created = await createOnFreeTrack(session, {
        trackType: "text",
        startTime: args.start_time,
        endTime: args.end_time,
        textContent: typeof args.text === "string" && args.text.length > 0 ? args.text : template.defaultText,
        textStyle: templateStyleJson(templateId, null),
        ...(animationJson ? { animationJson } : {}),
        positionX: optionalNumber(args.position_x) ?? 0.5,
        positionY: optionalNumber(args.position_y) ?? 0.5,
        scale: 1,
        opacity: 1,
    }, optionalNumber(args.track_index));
    if ("ok" in created) return created;
    return success(`Created text clip ${created.clipId} with the ${templateId} template on text${created.trackIndex} from ${args.start_time}s to ${args.end_time}s.`, {
        clipId: created.clipId, templateId, trackIndex: created.trackIndex,
    });
};

/** set_text_style arguments as a text.style.set patch (null removes a key), or why they are invalid. */
function textStylePatch(args: Args, current: Record<string, unknown>): Record<string, unknown> | string {
    const patch: Record<string, unknown> = {};
    for (const [arg, key] of Object.entries(TEXT_STYLE_KEYS)) {
        const value = args[arg];
        if (value === undefined) continue;
        if (value === null) {
            patch[key] = null;
            continue;
        }
        if (arg === "font_family") {
            const font = typeof value === "string" ? fontByFamily(value) : undefined;
            if (!font) return `${String(value)} is not a bundled font; list_text_templates lists the fonts.`;
            patch[key] = fontStack(font.family);
        } else if (arg === "text_align") {
            if (value !== "left" && value !== "center" && value !== "right") return "text_align must be left, center, or right.";
            patch[key] = value;
        } else if (arg.endsWith("color")) {
            if (!isTextStyleColor(value)) return `${arg} must be a CSS color (${COLOR_HELP}).`;
            patch[key] = value.trim();
        } else {
            if (!isNumber(value)) return `${arg} must be a number.`;
            const limit = (TEXT_STYLE_LIMITS as Record<string, { minimum: number; maximum: number }>)[arg];
            if (limit && (value < limit.minimum || value > limit.maximum)) return `${arg} must be a number from ${limit.minimum} to ${limit.maximum}.`;
            patch[key] = arg === "font_weight" ? String(Math.round(value)) : value;
        }
    }
    const from = args.gradient_from;
    const to = args.gradient_to;
    const angle = args.gradient_angle;
    if (from !== undefined || to !== undefined || angle !== undefined) {
        if (from === null || to === null) {
            patch.gradient = null;
        } else {
            if (from !== undefined && !isTextStyleColor(from)) return `gradient_from must be a CSS color (${COLOR_HELP}).`;
            if (to !== undefined && !isTextStyleColor(to)) return `gradient_to must be a CSS color (${COLOR_HELP}).`;
            const prior = current.gradient && typeof current.gradient === "object" ? current.gradient as Record<string, unknown> : {};
            const color = (value: unknown) => (isTextStyleColor(value) ? value.trim() : null);
            const nextFrom = color(from ?? prior.from);
            const nextTo = color(to ?? prior.to);
            if (!nextFrom || !nextTo) return "A gradient needs gradient_from and gradient_to (CSS colors).";
            const nextAngle = isNumber(angle) ? angle : angle === null ? 90 : isNumber(prior.angle) ? prior.angle : 90;
            patch.gradient = { from: nextFrom, to: nextTo, angle: nextAngle };
        }
    }
    return patch;
}

const setTextStyle: ToolHandler = async (args, { session }) => {
    const clip = editableTextClip(await session.snapshot(), args.clip_id);
    if (typeof clip === "string") return failure(clip);
    const patch = textStylePatch(args, textStyles.parseTimelineTextStyle(clip.textStyle));
    if (typeof patch === "string") return failure(patch);
    if (Object.keys(patch).length === 0) return failure("set_text_style needs at least one style field (font_family, color, …).");
    const result = await session.execute({ type: "text.style.set", clipIds: [clip.id], patch });
    const failed = commandFailure("text.style.set", result);
    if (failed) return failed;
    const after = (await session.snapshot()).clips.find((c) => c.id === clip.id);
    return success(`Set ${Object.keys(patch).join(", ")} on text clip ${clip.id}.`, { clipId: clip.id, style: textStyles.parseTimelineTextStyle(after?.textStyle) });
};

// ── animations ─────────────────────────────────────────

const listAnimations: ToolHandler = async (args) => {
    const kind = String(args.kind) as AnimationTarget;
    if (kind !== "clip" && kind !== "text" && kind !== "sticker") return failure("kind must be clip, text, or sticker.");
    const slots = typeof args.slot === "string" ? SLOTS.filter((s) => s === args.slot) : SLOTS;
    const names = new Map(motionCatalog().animations.map((a) => [`${a.kind}:${a.slot}:${a.id}`, a.name]));
    const animations = slots.flatMap((slot) => animationsFor(kind, slot).map((def) => ({
        id: def.id,
        name: names.get(`${def.kind}:${slot}:${def.id}`) ?? def.id,
        slot,
        default_duration: def.defaultDuration,
    })));
    return success(`${animations.length} ${kind} animations (a default_duration of 0 spans the whole item): ${animations.map((a) => `${a.slot}:${a.id}`).join(", ")}.`, { kind, animations });
};

const setAnimation: ToolHandler = async (args, { session, tool }) => {
    const target = lookTarget(await session.snapshot(), args, tool.name, ANIMATION_KINDS);
    if (typeof target === "string") return failure(target);
    const slot = String(args.slot) as AnimationSlot;
    if (!SLOTS.includes(slot)) return failure("slot must be in, out, combo, or loop.");
    const id = typeof args.animation_id === "string" && args.animation_id !== "none" ? args.animation_id : null;
    const duration = optionalNumber(args.duration);
    if (duration !== undefined && !(duration > 0)) return failure("duration must be more than 0 seconds.");
    const result = await session.execute({ type: "animation.set", ...commandTarget(target), slot, animationId: id, ...(duration !== undefined ? { duration } : {}) });
    const failed = commandFailure("animation.set", result);
    if (failed) return failed;
    const item = itemOf(await session.snapshot(), target);
    const animation = item?.animationJson ? parseAnimationSpec(item.animationJson) : null;
    return success(id ? `Set the ${slot} animation ${id} on ${target.label}.` : `Removed the ${slot} animation from ${target.label}.`, {
        ...commandTarget(target), slot, animation,
    });
};

// ── stickers ───────────────────────────────────────────

const listStickers: ToolHandler = async (args) => {
    const category = typeof args.category === "string" ? args.category : undefined;
    if (category && !(STICKER_CATEGORIES as readonly string[]).includes(category)) return failure(`Unknown sticker category ${category}.`);
    const limit = isNumber(args.limit) ? Math.min(200, Math.max(1, Math.round(args.limit))) : 50;
    const found = searchStickers(typeof args.query === "string" ? args.query : "", category as StickerCategory | undefined);
    const stickers = found.slice(0, limit).map((s) => ({ id: s.id, name: s.name, category: s.category, ...(s.emoji ? { emoji: s.emoji } : {}) }));
    const categories = motionCatalog().stickerCategories;
    return success(`${found.length} stickers match${found.length > limit ? ` (showing ${limit})` : ""}: ${stickers.map((s) => s.id).join(", ")}.`, {
        total: found.length, stickers, categories,
    });
};

const addSticker: ToolHandler = async (args, { session }) => {
    const stickerId = String(args.sticker_id);
    const sticker = stickerById(stickerId);
    if (!sticker) return failure(`Unknown sticker ${stickerId}. list_stickers lists the bundled ones.`);
    const scale = optionalNumber(args.scale) ?? 1;
    if (!(scale > 0)) return failure("scale must be more than 0.");
    const start = Number(args.start_time);
    const end = Number(args.end_time);
    const created = await createOnFreeTrack(session, {
        trackType: "sticker",
        startTime: start,
        endTime: end,
        mediaType: "sticker",
        stickerId,
        label: sticker.name,
        positionX: optionalNumber(args.position_x) ?? 0.5,
        positionY: optionalNumber(args.position_y) ?? 0.5,
        scale,
        opacity: 1,
    }, optionalNumber(args.track_index));
    if ("ok" in created) return created;
    return success(`Added sticker ${sticker.name} (${stickerId}) as clip ${created.clipId} on sticker${created.trackIndex} from ${start}s to ${end}s.`, {
        clipId: created.clipId, stickerId, trackIndex: created.trackIndex,
    });
};

// ── keyframes ──────────────────────────────────────────

const keyframeCount = (item: TimelineClip | SceneData | undefined): number => {
    try {
        const parsed = item?.keyframesJson ? JSON.parse(item.keyframesJson) : null;
        return Array.isArray(parsed?.keyframes) ? parsed.keyframes.length : 0;
    } catch {
        return 0;
    }
};

function bezierArg(value: unknown): [number, number, number, number] | undefined | string {
    if (value === undefined) return undefined;
    if (!Array.isArray(value) || value.length !== 4 || !value.every(isNumber)) return "bezier must be four numbers [x1, y1, x2, y2].";
    return value as [number, number, number, number];
}

const setKeyframe: ToolHandler = async (args, { session, tool }) => {
    const target = lookTarget(await session.snapshot(), args, tool.name, KEYFRAME_KINDS);
    if (typeof target === "string") return failure(target);
    if (!isNumber(args.time)) return failure("time must be a number of item-local seconds.");
    const time = args.time;
    const values = args.values && typeof args.values === "object" ? args.values as Record<string, number> : {};
    const easing = args.easing === undefined ? undefined : String(args.easing) as EasingId;
    if (easing !== undefined && !EASING_IDS.includes(easing)) return failure(`easing must be one of ${EASING_IDS.join(", ")}.`);
    const bezier = bezierArg(args.bezier);
    if (typeof bezier === "string") return failure(bezier);
    const extras = { ...(easing ? { easing } : {}), ...(bezier ? { bezier } : {}) };
    let type: "keyframe.set" | "keyframe.easing";
    let result;
    if (Object.keys(values).length > 0) {
        type = "keyframe.set";
        result = await session.execute({ type, ...commandTarget(target), time, values, ...extras });
    } else if (easing) {
        type = "keyframe.easing";
        result = await session.execute({ type, ...commandTarget(target), time, easing, ...(bezier ? { bezier } : {}) });
    } else {
        return failure("set_keyframe needs values or an easing.");
    }
    const failed = commandFailure(type, result);
    if (failed) return failed;
    const count = keyframeCount(itemOf(await session.snapshot(), target));
    const what = type === "keyframe.set" ? `Set ${Object.keys(values).join(", ")}` : `Set the ${easing} easing`;
    return success(`${what} at ${time}s on ${target.label} (${count} keyframes).`, {
        ...commandTarget(target), time, keyframes: count, ...(easing ? { easing } : {}),
    });
};

const removeKeyframe: ToolHandler = async (args, { session, tool }) => {
    const target = lookTarget(await session.snapshot(), args, tool.name, KEYFRAME_KINDS);
    if (typeof target === "string") return failure(target);
    if (!isNumber(args.time)) return failure("time must be a number of item-local seconds.");
    const channels = Array.isArray(args.channels) ? args.channels.map(String) : undefined;
    const result = await session.execute({ type: "keyframe.remove", ...commandTarget(target), time: args.time, ...(channels ? { channels } : {}) });
    const failed = commandFailure("keyframe.remove", result);
    if (failed) return failed;
    const count = keyframeCount(itemOf(await session.snapshot(), target));
    return success(`Removed ${channels ? channels.join(", ") : "the keyframe"} at ${args.time}s on ${target.label} (${count} keyframes left).`, {
        ...commandTarget(target), time: args.time, keyframes: count,
    });
};

const retimeKeyframe: ToolHandler = async (args, { session, tool }) => {
    const snap = await session.snapshot();
    const target = lookTarget(snap, args, tool.name, KEYFRAME_KINDS);
    if (typeof target === "string") return failure(target);
    if (!isNumber(args.from) || !isNumber(args.to)) return failure("from and to must be numbers of item-local seconds.");
    let channels: string[] | undefined;
    if (args.channels !== undefined) {
        if (!Array.isArray(args.channels) || args.channels.length === 0) return failure("channels must be a non-empty list of keyframe channels.");
        channels = args.channels.map(String);
    }
    let values: Record<string, number> | undefined;
    if (args.values !== undefined) {
        if (!args.values || typeof args.values !== "object" || Array.isArray(args.values)) return failure("values must be an object of channel values.");
        values = args.values as Record<string, number>;
    }
    const item = itemOf(snap, target);
    const to = round3(Math.min(item ? itemLength(item) : args.to, Math.max(0, args.to)));
    const result = await session.execute({
        type: "keyframe.retime", ...commandTarget(target), from: args.from, to: args.to,
        ...(channels ? { channels } : {}), ...(values && Object.keys(values).length > 0 ? { values } : {}),
    });
    const failed = commandFailure("keyframe.retime", result);
    if (failed) return failed;
    const count = keyframeCount(itemOf(await session.snapshot(), target));
    const what = channels ? `${channels.join(", ")} of the keyframe` : "the keyframe";
    return success(`Moved ${what} at ${args.from}s to ${to}s on ${target.label} (${count} keyframes).`, {
        ...commandTarget(target), from: args.from, to, keyframes: count,
    });
};

// ── speed ──────────────────────────────────────────────

/** set_speed clip_ids: every clip a video or audio clip the editor would let a person change, or why not. */
function speedClips(snap: ControllerSnapshot, ids: unknown[]): TimelineClip[] | string {
    const clips: TimelineClip[] = [];
    for (const id of ids) {
        const clip = clipById(snap, id);
        if (!SPEED_KINDS.trackTypes.includes(clip.trackType)) return `Clip ${clip.id} is a ${clip.trackType} clip; ${SPEED_KINDS.applies}.`;
        const locked = lockReason(snap, clip);
        if (locked) return locked;
        if (!clips.includes(clip)) clips.push(clip);
    }
    return clips;
}

const setSpeed: ToolHandler = async (args, { session, tool }) => {
    const snap = await session.snapshot();
    let target: Target | string;
    let many: TimelineClip[] | undefined;
    if (args.clip_ids !== undefined) {
        if (args.clip_id !== undefined || args.scene_order !== undefined) return failure("set_speed takes clip_ids, clip_id, or scene_order (one of them).");
        if (!Array.isArray(args.clip_ids) || args.clip_ids.length === 0) return failure("clip_ids must list at least one clip.");
        const clips = speedClips(snap, args.clip_ids);
        if (typeof clips === "string") return failure(clips);
        many = clips;
        target = { clipId: clips[0].id, label: clips.length === 1 ? `clip ${clips[0].id}` : `${clips.length} clips` };
    } else {
        target = lookTarget(snap, args, tool.name, SPEED_KINDS);
    }
    if (typeof target === "string") return failure(target);
    if (args.curve_id !== undefined && args.curve_points !== undefined) return failure("Give curve_id or curve_points, not both.");
    if (args.speed === undefined && args.curve_id === undefined && args.curve_points === undefined && args.preserve_pitch === undefined) {
        return failure("set_speed needs speed, curve_id, curve_points, or preserve_pitch.");
    }
    if (args.speed !== undefined && !isNumber(args.speed)) return failure("speed must be a number from 0.1 to 100.");
    let curve: { id: string; points: Array<[number, number]> } | null | undefined;
    if (args.curve_id !== undefined) {
        const id = String(args.curve_id);
        curve = id === "none" ? null : speedCurvePreset(id);
        if (curve === null && id !== "none") return failure(`Unknown speed curve ${id}.`);
    } else if (args.curve_points !== undefined) {
        const parsed = parseSpeedCurve({ id: "custom", points: args.curve_points });
        if (!parsed) return failure("curve_points needs 2 to 10 points [x, y] with x from 0 to 1.");
        curve = parsed;
    }
    const result = await session.execute({
        type: "speed.set", ...(many ? { clipIds: many.map((clip) => clip.id) } : commandTarget(target)),
        ...(isNumber(args.speed) ? { speed: args.speed } : {}),
        ...(curve !== undefined ? { curve } : {}),
        ...(typeof args.preserve_pitch === "boolean" ? { preservePitch: args.preserve_pitch } : {}),
    });
    const failed = commandFailure("speed.set", result);
    if (failed) return failed;
    if (many) {
        const after = await session.snapshot();
        const clips = many.map((clip) => {
            const now = after.clips.find((c) => c.id === clip.id);
            return {
                clipId: clip.id, speed: now?.playbackSpeed ?? null, curve: parseSpeedCurve(now?.speedCurveJson ?? null)?.id ?? null,
                preserve_pitch: now?.preservePitch ?? true, length: now ? round3(itemLength(now)) : null,
            };
        });
        return success(`Set the speed of ${target.label}: ${clips.map((c) => `${c.clipId} ${c.speed}x, ${c.length}s`).join("; ")}.`, {
            clipIds: clips.map((c) => c.clipId), clips,
        });
    }
    const item = itemOf(await session.snapshot(), target);
    const length = item ? round3(itemLength(item)) : null;
    const speed = item?.playbackSpeed ?? null;
    const curveId = parseSpeedCurve(item?.speedCurveJson ?? null)?.id ?? null;
    return success(`Set ${target.label} to ${speed}x${curveId ? ` with the ${curveId} curve` : ""}; it is now ${length}s long.`, {
        ...commandTarget(target), speed, curve: curveId, preserve_pitch: item?.preservePitch ?? true, length,
    });
};

// ── captions ───────────────────────────────────────────

const applyCaptionStyle: ToolHandler = async (args, { session }) => {
    const styleId = String(args.style_id);
    if (!CAPTION_STYLES.some((s) => s.id === styleId)) return failure(`Unknown caption style ${styleId}. list_text_templates lists them.`);
    const snap = await session.snapshot();
    const isCaption = (clip: TimelineClip) => clip.trackType === "text" && textStyles.getTimelineTextClipKind(clip.textStyle, clip.label) !== "text";
    let targets: TimelineClip[];
    if (Array.isArray(args.clip_ids) && args.clip_ids.length > 0) {
        targets = args.clip_ids.map((id) => clipById(snap, id));
        const notText = targets.find((clip) => clip.trackType !== "text");
        if (notText) return failure(`Clip ${notText.id} is a ${notText.trackType} clip, not a text clip.`);
    } else {
        const track = optionalNumber(args.track_index);
        targets = snap.clips.filter((clip) => isCaption(clip) && (track === undefined || clip.trackIndex === track));
    }
    if (targets.length === 0) return failure("There are no caption clips to style. Captions come from transcribe_audio or subtitle import; clip_ids styles plain text clips.");
    // Clips on locked or hidden tracks are left alone, as the editor does.
    const editable = targets.filter((clip) => lockReason(snap, clip) === null);
    const skipped = targets.filter((clip) => !editable.includes(clip)).map((clip) => clip.id);
    if (editable.length === 0) return failure(`Every matching caption clip is locked or on a locked or hidden track (${skipped.join(", ")}).`);
    const clipIds = editable.map((clip) => clip.id);
    const result = await session.execute({ type: "caption.style.apply", clipIds, styleId });
    return commandFailure("caption.style.apply", result) ?? success(
        `Applied the ${styleId} caption style to ${clipIds.length} clip${clipIds.length === 1 ? "" : "s"}${skipped.length ? `; skipped ${skipped.length} on locked tracks` : ""}.`,
        { styleId, clipIds, skipped },
    );
};

export const MOTION_HANDLERS: Record<string, ToolHandler> = {
    list_text_templates: listTextTemplates,
    apply_text_template: applyTextTemplate,
    set_text_style: setTextStyle,
    list_animations: listAnimations,
    set_animation: setAnimation,
    list_stickers: listStickers,
    add_sticker: addSticker,
    set_keyframe: setKeyframe,
    remove_keyframe: removeKeyframe,
    retime_keyframe: retimeKeyframe,
    set_speed: setSpeed,
    apply_caption_style: applyCaptionStyle,
};
