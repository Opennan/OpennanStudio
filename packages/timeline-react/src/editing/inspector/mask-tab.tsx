"use client";
// The Mask tab (phase 10c, CapCut's): None and six shapes (linear, mirror, circle, rectangle, heart, star) as a
// card grid with small glyphs, Invert, and sliders for position, size, rotation, feather (and roundness for
// rectangles). Position, size, rotation, and feather carry keyframe diamonds (mask_* channels). Every control
// is one `mask.set` (slider drags coalesce into one undo step); keyed sliders write keyframes at the playhead.
// While the tab is open the preview draws the mask's outline and handles (store.maskEditing).
import { useEffect } from "react";
import { Ban } from "lucide-react";
import { MASK_SHAPES, parseMask, type MaskPatch, type MaskShape, type MaskSpec } from "@opennan/timeline-core/looks/masks";
import type { EditorCommand } from "@opennan/timeline-core/controller/commands";
import type { ItemTarget } from "@opennan/timeline-core/controller/items-plan";
import { useEditorStoreApi } from "../../hooks/use-editor-store";
import { useTimelineController } from "../../hooks/use-timeline-controller";
import { useTimelineMessages } from "../../hooks/use-timeline-messages";
import { SliderRow, Toggle } from "../controls";
import { KeyframedSliders, KeyframeBar, type KeyItem } from "./keyframe-toggle";

export interface MaskedItem {
    id: string;
    target: { clipId: string } | { sceneId: string };
    maskJson: string | null | undefined;
}

/** 20×20 outline glyphs (currentColor), one per shape. */
const GLYPHS: Record<MaskShape, string> = {
    linear: "M2 10h16M2 13.5h16M2 17h16",
    mirror: "M2 6h16M2 14h16",
    circle: "M10 3.5a6.5 6.5 0 1 0 0.01 0",
    rectangle: "M5.5 4h9a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z",
    heart: "M10 16.5S3 12.3 3 7.6A3.6 3.6 0 0 1 10 6a3.6 3.6 0 0 1 7 1.6c0 4.7-7 8.9-7 8.9Z",
    star: "M10 2.8l2.1 4.6 5 .5-3.8 3.3 1.1 4.9L10 13.6l-4.4 2.5 1.1-4.9L2.9 7.9l5-.5Z",
};

export function MaskGlyph({ shape }: { shape: MaskShape }) {
    return (
        <svg viewBox="0 0 20 20" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <path d={GLYPHS[shape]} />
        </svg>
    );
}

const percent = (t: ReturnType<typeof useTimelineMessages<"studioEditor">>) => (v: number) => t("percent", { value: v });

/** None and the six shapes; `pressed`: the current shape, null for no mask, undefined when the items differ (group mode). */
function ShapeGrid({ pressed, onNone, onShape }: { pressed: MaskShape | null | undefined; onNone(): void; onShape(shape: MaskShape): void }) {
    const t = useTimelineMessages("studioEditor");
    return (
        <ul className="on-anim-grid" role="list" aria-label={t("mask_shapes")}>
            <li>
                <button type="button" className="on-card on-anim-card" aria-pressed={pressed === null} data-testid="mask-shape-none" onClick={onNone}>
                    <span className="on-card-thumb on-anim-thumb"><span className="on-anim-none"><Ban aria-hidden="true" /></span></span>
                    <span className="on-card-name">{t("mask_none")}</span>
                </button>
            </li>
            {MASK_SHAPES.map((id) => (
                <li key={id}>
                    <button type="button" className="on-card on-anim-card" aria-pressed={pressed === id} data-testid={`mask-shape-${id}`} onClick={() => onShape(id)}>
                        <span className="on-card-thumb on-anim-thumb"><span className="on-mask-glyph"><MaskGlyph shape={id} /></span></span>
                        <span className="on-card-name">{t(`mask_${id}` as never)}</span>
                    </button>
                </li>
            ))}
        </ul>
    );
}

export function MaskTab({ item, keyItem }: { item: MaskedItem; keyItem: KeyItem }) {
    const t = useTimelineMessages("studioEditor");
    const controller = useTimelineController();
    const storeApi = useEditorStoreApi();
    useEffect(() => {
        storeApi.getState().setMaskEditing(true);
        return () => storeApi.getState().setMaskEditing(false);
    }, [storeApi]);
    const mask = parseMask(item.maskJson);
    const run = (command: Omit<Extract<EditorCommand, { type: "mask.set" }>, "type" | "clipId" | "sceneId">, coalesce?: string) => void controller.execute(
        { type: "mask.set", ...item.target, ...command },
        coalesce ? { coalesceKey: `mask-${item.id}-${coalesce}`, debounceMs: 120 } : undefined,
    );
    const patch = (value: MaskPatch, key: string) => run({ mask: value }, key);
    const pct = percent(t);
    const shape = mask?.shape ?? null;
    const sized = shape !== null && shape !== "linear";
    const twoSizes = shape !== null && shape !== "linear" && shape !== "mirror";

    return (
        <div className="on-anim" data-testid="mask-tab">
            <ShapeGrid pressed={shape} onNone={() => run({ mask: null })} onShape={(id) => (shape === id ? undefined : run({ mask: { shape: id } }))} />
            {mask && (
                <>
                    <KeyframeBar item={keyItem} />
                    <div data-testid="mask-invert">
                        <Toggle label={t("mask_invert")} checked={mask.invert} onChange={(invert) => run({ mask: { invert } })} />
                    </div>
                    <KeyframedSliders item={keyItem} name="mask-position" label={t("mask_position")} rows={[
                        {
                            channel: "mask_x", base: mask.x, label: t("positionX"), testId: "mask-position-x", min: -50, max: 150, defaultValue: 50, format: pct,
                            toSlider: (v) => Math.round(v * 100), toChannel: (v) => v / 100, onStatic: (v) => patch({ x: v / 100 }, "x"),
                        },
                        {
                            channel: "mask_y", base: mask.y, label: t("positionY"), testId: "mask-position-y", min: -50, max: 150, defaultValue: 50, format: pct,
                            toSlider: (v) => Math.round(v * 100), toChannel: (v) => v / 100, onStatic: (v) => patch({ y: v / 100 }, "y"),
                        },
                    ]} />
                    {sized && (
                        <KeyframedSliders item={keyItem} name="mask-size" label={t("mask_size")} rows={[
                            {
                                channel: "mask_w", base: mask.width, label: twoSizes ? t("mask_width") : t("mask_band"), testId: "mask-width", min: 1, max: 400, format: pct,
                                toSlider: (v) => Math.round(v * 100), toChannel: (v) => v / 100, onStatic: (v) => patch({ width: v / 100 }, "width"),
                            },
                            ...(twoSizes ? [{
                                channel: "mask_h", base: mask.height, label: t("mask_height"), testId: "mask-height", min: 1, max: 400, format: pct,
                                toSlider: (v: number) => Math.round(v * 100), toChannel: (v: number) => v / 100, onStatic: (v: number) => patch({ height: v / 100 }, "height"),
                            }] : []),
                        ]} />
                    )}
                    <KeyframedSliders item={keyItem} name="mask-rotation" label={t("rotation")} rows={[{
                        channel: "mask_rotation", base: mask.rotation, label: t("rotation"), testId: "mask-rotation", min: -180, max: 180, defaultValue: 0,
                        format: (v) => t("degrees", { value: v }), toSlider: Math.round, toChannel: (v) => v, onStatic: (v) => patch({ rotation: v }, "rotation"),
                    }]} />
                    <KeyframedSliders item={keyItem} name="mask-feather" label={t("mask_feather")} rows={[{
                        channel: "mask_feather", base: mask.feather, label: t("mask_feather"), testId: "mask-feather", min: 0, max: 100, defaultValue: 0, format: pct,
                        toSlider: (v) => Math.round(v * 100), toChannel: (v) => v / 100, onStatic: (v) => patch({ feather: v / 100 }, "feather"),
                    }]} />
                    {shape === "rectangle" && (
                        <SliderRow
                            testId="mask-roundness" label={t("mask_roundness")} value={Math.round(mask.roundness * 100)} min={0} max={100} defaultValue={0} format={pct}
                            onChange={(v) => patch({ roundness: v / 100 }, "roundness")}
                        />
                    )}
                    <p className="on-hint">{t("mask_hint")}</p>
                    <button type="button" className="on-btn on-btn-ghost" data-testid="mask-reset" onClick={() => run({ mask: { shape: mask.shape }, replace: true })}>{t("mask_reset")}</button>
                </>
            )}
        </div>
    );
}

type MaskNumberField = "x" | "y" | "width" | "height" | "rotation" | "feather" | "roundness";

/**
 * The Mask tab in the inspector's group mode (phase 10d): one mask for every selected item that takes one. Every
 * control is ONE `mask.set` with `targets` (one undo step for all items); a patch merges into each item's own mask, so
 * a shape keeps each item's geometry and a slider sets the same value on every item (masks are item-relative, so the
 * same values cut every item alike). The shape grid presses a shape only when every item has it; sliders show the
 * first masked item's values with "Mixed" where the items differ. Keyed mask channels are keyed per item at its own
 * playhead time (mask.set's rule); there are no keyframe diamonds here (they belong to one item).
 */
export function GroupMaskTab({ items, targets, total }: { items: ReadonlyArray<{ maskJson?: string | null }>; targets: ItemTarget[]; total: number }) {
    const t = useTimelineMessages("studioEditor");
    const controller = useTimelineController();
    const masks = items.map((item) => parseMask(item.maskJson));
    const masked = masks.filter((mask): mask is MaskSpec => mask !== null);
    const shapes = new Set(masks.map((mask) => mask?.shape ?? null));
    const pressed = shapes.size === 1 ? [...shapes][0] : undefined;
    const primary = masked[0] ?? null;
    const run = (command: Omit<Extract<EditorCommand, { type: "mask.set" }>, "type" | "clipId" | "sceneId" | "targets">, coalesce?: string) => void controller.execute(
        { type: "mask.set", targets, ...command },
        coalesce ? { coalesceKey: `mask-group-${coalesce}`, debounceMs: 120 } : undefined,
    );
    const mixed = (field: MaskNumberField | "invert") => masked.length < masks.length || new Set(masked.map((mask) => (field === "invert" ? String(mask.invert) : Math.round(mask[field] * 100)))).size > 1;
    const hint = (field: MaskNumberField) => (mixed(field) ? t("groupMixed") : undefined);
    const pct = percent(t);
    const shape = primary?.shape ?? null;
    const twoSizes = shape !== null && shape !== "linear" && shape !== "mirror";
    const slider = (field: MaskNumberField, testId: string, label: string, min: number, max: number, scale: number, format: (v: number) => string, defaultValue?: number) => (
        <SliderRow
            testId={testId} label={label} value={Math.round(primary![field] * scale)} min={min} max={max} defaultValue={defaultValue} format={format} hint={hint(field)}
            onChange={(v) => run({ mask: { [field]: v / scale } }, field)}
        />
    );
    return (
        <div className="on-anim" data-testid="group-mask-tab">
            {items.length < total && <p className="on-hint" data-testid="group-mask-partial">{t("groupMaskPartial", { count: items.length, total })}</p>}
            {pressed === undefined && <p className="on-hint" data-testid="group-mask-mixed">{t("groupMixedHint")}</p>}
            <ShapeGrid pressed={pressed} onNone={() => run({ mask: null })} onShape={(id) => (pressed === id ? undefined : run({ mask: { shape: id } }))} />
            {primary && (
                <>
                    <div data-testid="mask-invert">
                        <Toggle label={t("mask_invert")} checked={primary.invert} onChange={(invert) => run({ mask: { invert } })} />
                    </div>
                    {slider("x", "mask-position-x", t("positionX"), -50, 150, 100, pct, 50)}
                    {slider("y", "mask-position-y", t("positionY"), -50, 150, 100, pct, 50)}
                    {shape !== "linear" && slider("width", "mask-width", twoSizes ? t("mask_width") : t("mask_band"), 1, 400, 100, pct)}
                    {twoSizes && slider("height", "mask-height", t("mask_height"), 1, 400, 100, pct)}
                    {slider("rotation", "mask-rotation", t("rotation"), -180, 180, 1, (v) => t("degrees", { value: v }), 0)}
                    {slider("feather", "mask-feather", t("mask_feather"), 0, 100, 100, pct, 0)}
                    {shape === "rectangle" && slider("roundness", "mask-roundness", t("mask_roundness"), 0, 100, 100, pct, 0)}
                    <button type="button" className="on-btn on-btn-ghost" data-testid="mask-reset" onClick={() => run({ mask: { shape: primary.shape }, replace: true })}>{t("mask_reset")}</button>
                </>
            )}
        </div>
    );
}

