// Text tab logic (phase 10b): template and caption-style matching, where a new text clip lands, and the
// controller commands the Text tab and the text inspector run (the same commands agents use over MCP).
import type { EditorStore, TimelineClip, TimelineController, TimelineTrack } from "@opennan/timeline-core";
import type { CreateClipInput } from "@opennan/timeline-core/backend/types";
import { serializeAnimationSpec } from "@opennan/timeline-core/motion/animation-spec";
import { getTimelineTextClipKind } from "@opennan/timeline-core/lib/timeline-text-style";
import { nextTrackForType } from "@opennan/timeline-core/lib/timeline-tracks";
import { withRequiredBaseTimelineTracks } from "@opennan/timeline-core/timeline/scene-helpers";
import { CAPTION_STYLES } from "@opennan/timeline-core/text/captions";
import { TEXT_TEMPLATES, textTemplateById } from "@opennan/timeline-core/text/templates";
import { fontByFamily, fontStack, nearestWeight, primaryFontFamily } from "@opennan/timeline-core/text/fonts";

/** Template categories in Text tab order, then the caption styles chip. */
export const TEXT_TEMPLATE_CATEGORIES = ["basic", "social", "neon", "outline", "gradient", "handwritten", "display"] as const;
export const TEXT_LIBRARY_CATEGORIES = [...TEXT_TEMPLATE_CATEGORIES, "captions"] as const;
export type TextLibraryCategory = "all" | (typeof TEXT_LIBRARY_CATEGORIES)[number];

/** Drag payload kind of a template card: `{ kind, templateId, name }` as application/json. */
export const TEXT_TEMPLATE_DRAG_KIND = "text-template";
/** Drag marker so drop targets can recognise text-template cards during dragover (payloads are unreadable then). */
export const TEXT_TEMPLATE_DRAG_MIME = "application/x-text-template";

/** The template "Add text" uses. */
export const DEFAULT_TEXT_TEMPLATE = "plain";
/** Length of a new text clip, seconds (the timeline toolbar's Add text uses the same). */
export const NEW_TEXT_SECONDS = 5;

const round = (value: number) => Math.round(value * 1000) / 1000;

export function styleObject(json: string | null | undefined): Record<string, unknown> {
    if (!json) return {};
    try {
        const parsed = JSON.parse(json);
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
        return {};
    }
}

/** One key of a text style JSON (undefined when missing or unparsable). */
export function styleField(json: string | null | undefined, key: string): unknown {
    return styleObject(json)[key];
}

function same(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (typeof a === "string" && typeof b === "string") return a.trim().toLowerCase() === b.trim().toLowerCase();
    if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
    const ka = Object.keys(a as object);
    const kb = Object.keys(b as object);
    return ka.length === kb.length && ka.every((k) => same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/** Keys a template or caption style leaves alone (kind, position, wrap), so they never break a match. */
const LAYOUT_KEYS = new Set(["captionKind", "textClipKind", "role", "captionPosition", "wordsPerLine", "maxWidthRatio"]);

/** True when `style` is exactly `look` (ignoring layout keys): every look key equal, no other style key set. */
function matchesLook(style: Record<string, unknown>, look: Record<string, unknown>): boolean {
    for (const [key, value] of Object.entries(look)) {
        if (LAYOUT_KEYS.has(key)) continue;
        if (!same(style[key], value)) return false;
    }
    return Object.keys(style).every((key) => LAYOUT_KEYS.has(key) || key in look);
}

/** The template a text style is (unchanged since it was applied), else null. */
export function matchingTemplateId(textStyle: string | null | undefined): string | null {
    const style = styleObject(textStyle);
    if (Object.keys(style).length === 0) return null;
    return TEXT_TEMPLATES.find((t) => matchesLook(style, t.style))?.id ?? null;
}

/** The caption style a caption's style is, else null. */
export function matchingCaptionStyleId(textStyle: string | null | undefined): string | null {
    const style = styleObject(textStyle);
    if (Object.keys(style).length === 0) return null;
    return CAPTION_STYLES.find((c) => matchesLook(style, c.style))?.id ?? null;
}

export function isCaptionClip(clip: Pick<TimelineClip, "trackType" | "textStyle" | "label">): boolean {
    return clip.trackType === "text" && getTimelineTextClipKind(clip.textStyle, clip.label) !== "text";
}

/** Selected text clips, in timeline order. */
export function selectedTextClips(clips: readonly TimelineClip[], selected: ReadonlySet<string>): TimelineClip[] {
    return clips.filter((c) => c.trackType === "text" && selected.has(c.id)).sort((a, b) => a.startTime - b.startTime);
}

export interface TextClipPlacement {
    /** The full track list to write first when no text track is free at the playhead. */
    tracks: TimelineTrack[] | null;
    trackIndex: number;
    startTime: number;
    endTime: number;
}

/**
 * Where a new text clip goes: at `at` for NEW_TEXT_SECONDS on the first unlocked, visible text track
 * that is free for that span (`preferredTrackIndex` first, e.g. the track under a drop; CapCut stacks
 * text rather than shifting it), else on a new text track.
 */
export function planTextClipPlacement(
    tracks: readonly TimelineTrack[], clips: readonly TimelineClip[], at: number, seconds = NEW_TEXT_SECONDS, preferredTrackIndex?: number,
): TextClipPlacement {
    const startTime = round(Math.max(0, at));
    const endTime = round(startTime + seconds);
    const busy = (index: number) => clips.some((c) => c.trackType === "text" && c.trackIndex === index && startTime < c.endTime - 0.001 && endTime > c.startTime + 0.001);
    const free = tracks
        .filter((t) => t.type === "text" && !t.locked && t.visible !== false)
        .sort((a, b) => (a.index === preferredTrackIndex ? -1 : b.index === preferredTrackIndex ? 1 : a.index - b.index))
        .find((t) => !busy(t.index));
    if (free) return { tracks: null, trackIndex: free.index, startTime, endTime };
    const base = withRequiredBaseTimelineTracks([...tracks]).tracks;
    const track = nextTrackForType(base, "text") as TimelineTrack;
    return { tracks: [...base, track], trackIndex: track.index, startTime, endTime };
}

/** The clip.create input of a template's text clip (its style and default animation in one create). */
export function templateClipInput(templateId: string, placement: TextClipPlacement, stylePatch?: Record<string, unknown>): CreateClipInput | null {
    const template = textTemplateById(templateId);
    if (!template) return null;
    const animationJson = template.animation ? serializeAnimationSpec(template.animation) : null;
    return {
        trackType: "text",
        trackIndex: placement.trackIndex,
        startTime: placement.startTime,
        endTime: placement.endTime,
        textContent: template.defaultText,
        textStyle: JSON.stringify({ ...template.style, ...stylePatch }),
        animationJson,
        positionX: 0.5,
        positionY: 0.5,
        scale: 1,
        opacity: 1,
    } as CreateClipInput;
}

export type TextActionResult = { ok: true; clipIds: string[] } | { ok: false; reason: "no-target" | "failed" | "unknown" };

/**
 * Adds a template's text clip at the playhead (or `at`) and selects it: one clip.create carries the
 * style, the animation, and (only when no text track is free there) the new track list, so adding text
 * is always one undo step.
 */
export async function addTextFromTemplate(
    controller: TimelineController, store: EditorStore, templateId: string, options: { at?: number; stylePatch?: Record<string, unknown>; preferredTrackIndex?: number; position?: { x: number; y: number } } = {},
): Promise<TextActionResult> {
    const state = store.getState();
    const timeline = state.timelineData;
    const placement = planTextClipPlacement(timeline?.tracks ?? [], timeline?.clips ?? [], options.at ?? state.currentTime, NEW_TEXT_SECONDS, options.preferredTrackIndex);
    const template = templateClipInput(templateId, placement, options.stylePatch);
    if (!template) return { ok: false, reason: "unknown" };
    // `position`: positionX/Y (0..1 of the free space), e.g. a drop on the preview centred on the pointer.
    const input = options.position ? { ...template, positionX: options.position.x, positionY: options.position.y } : template;
    const result = await controller.execute({ type: "clip.create", input, ...(placement.tracks ? { tracks: placement.tracks } : {}) }, { toastOnError: false });
    if (!result.ok) return { ok: false, reason: "failed" };
    const ids = result.createdClipIds ?? result.changed.clips ?? [];
    if (ids[0]) store.getState().setSelectedClipIds(new Set([ids[0]]));
    return { ok: true, clipIds: ids };
}

/** Applies a template (style and animation) to text clips: one undo step. */
export async function applyTextTemplate(controller: TimelineController, clipIds: string[], templateId: string): Promise<TextActionResult> {
    if (clipIds.length === 0) return { ok: false, reason: "no-target" };
    const result = await controller.execute({ type: "text.template.apply", clipIds, templateId }, { toastOnError: false });
    return result.ok ? { ok: true, clipIds } : { ok: false, reason: "failed" };
}

/**
 * Applies a caption style to the selected caption clips, else to every caption clip (one undo step).
 * `no-target` when the project has no captions.
 */
export async function applyCaptionStyle(controller: TimelineController, clips: readonly TimelineClip[], selected: ReadonlySet<string>, styleId: string): Promise<TextActionResult> {
    const captions = clips.filter(isCaptionClip);
    if (captions.length === 0) return { ok: false, reason: "no-target" };
    const chosen = captions.filter((c) => selected.has(c.id)).map((c) => c.id);
    const result = await controller.execute(
        chosen.length > 0 ? { type: "caption.style.apply", clipIds: chosen, styleId } : { type: "caption.style.apply", styleId },
        { toastOnError: false },
    );
    return result.ok ? { ok: true, clipIds: chosen.length > 0 ? chosen : captions.map((c) => c.id) } : { ok: false, reason: "failed" };
}

/** The style patch that switches a text style to a bundled family, keeping the nearest bundled weight. */
export function fontFamilyPatch(family: string, currentWeight: unknown): Record<string, unknown> {
    const entry = fontByFamily(family);
    if (!entry) return { fontFamily: family };
    return { fontFamily: fontStack(entry.family), fontWeight: String(nearestWeight(entry, typeof currentWeight === "number" || typeof currentWeight === "string" ? currentWeight : 400)) };
}

/** The bundled family of a CSS font-family list, else null (a system font). */
export function bundledFamilyOf(fontFamily: string | null | undefined): string | null {
    if (!fontFamily) return null;
    return fontByFamily(primaryFontFamily(fontFamily))?.family ?? null;
}
