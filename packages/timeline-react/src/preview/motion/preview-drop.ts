// Library cards dropped onto the preview (phase 10b): a bundled sticker (`{ kind: "sticker", stickerId,
// name }`) or a text template (`{ kind: "text-template", templateId }`) is added at the playhead with its
// centre on the drop point. The position is the inverse of the overlay placement (clip-motion.ts
// placedBox, at clip scale 1 and no animation): centre = frame.x + posX · (W − boxW) + boxW / 2, so
// posX = (dropX − frame.x − boxW / 2) / (W − boxW) (handles.ts solveAnchoredPosition), clamped to 0..1.
// The add itself is the library's own helper, so a drop is the same one clip.create (one undo step).
import type { EditorStore, TimelineController } from "@opennan/timeline-core";
import { layoutPreviewTextBlock, type PreviewTextContext } from "@opennan/timeline-core/lib/preview-text-draw";
import { stickerBox } from "@opennan/timeline-core/stickers/catalog";
import { textTemplateById } from "@opennan/timeline-core/text/templates";
import { STICKER_DRAG_MIME, addStickerClip } from "../../editing/library/stickers-tab";
import { TEXT_TEMPLATE_DRAG_KIND, TEXT_TEMPLATE_DRAG_MIME, addTextFromTemplate } from "../../editing/library/text-library";
import type { FrameRect } from "./clip-motion";
import { solveAnchoredPosition } from "./handles";

export type PreviewDropPayload =
    | { kind: "sticker"; stickerId: string; name?: string }
    | { kind: "text-template"; templateId: string };

/**
 * Whether a drag (its `dataTransfer.types`, all that is readable during dragover) may be a card the preview
 * takes: a sticker or a text template, recognised by their marker types; other cards and files are not taken here.
 */
export function previewDropAccepts(types: readonly string[]): boolean {
    return types.includes(STICKER_DRAG_MIME) || types.includes(TEXT_TEMPLATE_DRAG_MIME);
}

/** The drop's payload, or null for anything the preview does not take. */
export function parsePreviewDrop(json: string | null | undefined): PreviewDropPayload | null {
    if (!json) return null;
    let data: unknown;
    try {
        data = JSON.parse(json);
    } catch {
        return null;
    }
    if (!data || typeof data !== "object") return null;
    const record = data as Record<string, unknown>;
    if (record.kind === "sticker" && typeof record.stickerId === "string" && record.stickerId) {
        return { kind: "sticker", stickerId: record.stickerId, ...(typeof record.name === "string" ? { name: record.name } : {}) };
    }
    if (record.kind === TEXT_TEMPLATE_DRAG_KIND && typeof record.templateId === "string" && textTemplateById(record.templateId)) {
        return { kind: "text-template", templateId: record.templateId };
    }
    return null;
}

/**
 * The new item's box at clip scale 1 on `frame` (CSS px), as the compositor will place it: a sticker's
 * catalog box, or the template's default text laid out like the text bitmap (export-reference px × frameScale).
 * Without a measuring context the text box is unknown (0 × 0: the position is then the plain fraction).
 */
export function previewDropBox(
    payload: PreviewDropPayload, frame: FrameRect, frameScale: number, measure: PreviewTextContext | null,
): { w: number; h: number } {
    if (payload.kind === "sticker") {
        const box = stickerBox(payload.stickerId, frame.h);
        return box ? { w: box.width, h: box.height } : { w: 0, h: 0 };
    }
    const template = textTemplateById(payload.templateId);
    if (!template || !measure) return { w: 0, h: 0 };
    const scale = frameScale > 0 ? frameScale : 1;
    try {
        const block = layoutPreviewTextBlock(measure, {
            text: template.defaultText, textStyle: JSON.stringify(template.style), scale: 1, frameScale: 1, frameWidth: frame.w / scale,
        });
        return { w: block.width * scale, h: block.height * scale };
    } catch {
        return { w: 0, h: 0 };
    }
}

const round4 = (value: number) => Math.round(value * 1e4) / 1e4;

function axis(start: number, size: number, box: number, centre: number): number {
    const solved = solveAnchoredPosition(start, size, box, centre, 0);
    // A box as large as the frame cannot move along this axis: keep it centred.
    if (solved === null || !Number.isFinite(solved)) return 0.5;
    return round4(Math.min(1, Math.max(0, solved)));
}

/** positionX/Y that centre a `box` (scale 1) on `point` (CSS px, same space as `frame`), clamped to the frame. */
export function previewDropPosition(frame: FrameRect, box: { w: number; h: number }, point: { x: number; y: number }): { x: number; y: number } {
    return { x: axis(frame.x, frame.w, box.w, point.x), y: axis(frame.y, frame.h, box.h, point.y) };
}

/** Adds the dropped item at `at` seconds and `position` through the library helper (one clip.create); true when added. */
export async function applyPreviewDrop(
    controller: TimelineController, store: EditorStore, payload: PreviewDropPayload, at: number, position: { x: number; y: number },
): Promise<boolean> {
    if (payload.kind === "sticker") {
        const result = await addStickerClip(controller, store, payload.stickerId, Math.max(0, at), { label: payload.name, position });
        return result.ok;
    }
    const result = await addTextFromTemplate(controller, store, payload.templateId, { at: Math.max(0, at), position });
    return result.ok;
}
