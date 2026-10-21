"use client";
// The 13 Adjust controls for a scene or a layer clip, grouped as CapCut does (light, color, detail).
// Each slider is one coalesced look.set (one undo step per drag); Reset all is one step too.
import type { ReactNode } from "react";
import type { SceneData, TimelineClip } from "@opennan/timeline-core";
import { DEFAULT_ADJUSTMENTS, adjustmentRange, isNeutral, itemAdjustments, type AdjustmentKey } from "@opennan/timeline-core/looks/adjust";
import { useTimelineController } from "../hooks/use-timeline-controller";
import { useTimelineMessages } from "../hooks/use-timeline-messages";
import { Section, SliderRow } from "./controls";
import type { LookTarget } from "./selection";
import type { ItemTarget } from "@opennan/timeline-core/controller/items-plan";

const GROUPS: Array<{ title: "adjGroupLight" | "adjGroupColor" | "adjGroupDetail"; keys: AdjustmentKey[] }> = [
    { title: "adjGroupLight", keys: ["exposure", "brightness", "contrast", "highlights", "shadows", "fade"] },
    { title: "adjGroupColor", keys: ["saturation", "vibrance", "temperature", "tint"] },
    { title: "adjGroupDetail", keys: ["sharpen", "vignette", "grain"] },
];

/**
 * Keyframed Adjust (phase 10b): values at the playhead shown instead of the static ones for the keys it
 * lists; onChange returns true when it wrote the value (a keyframe), else the slider writes look.set.
 */
export interface AdjustKeyframes {
    values: Partial<Record<AdjustmentKey, number>>;
    /** The keyed sliders cannot be edited (the playhead is outside the item). */
    disabled?: boolean;
    onChange(key: AdjustmentKey, value: number): boolean;
}

export function AdjustControls({ target, item, headerAction, keyframes, itemKind, mixed }: {
    /** One item, or (phase 10c group mode) every selected item through look.set targets. */
    target: LookTarget | { targets: ItemTarget[] };
    /** The item whose values the sliders show (the group's primary item). */
    item: SceneData | TimelineClip;
    /** Group mode: whether `item` is a scene or a clip. */
    itemKind?: "clip" | "scene";
    /** Group mode: the controls whose values differ between the selected items. */
    mixed?: ReadonlySet<AdjustmentKey>;
    /** Beside Reset all (the Adjust keyframe diamond). */
    headerAction?: ReactNode;
    keyframes?: AdjustKeyframes;
}) {
    const t = useTimelineMessages("studioEditor");
    const controller = useTimelineController();
    const kind = "targets" in target ? itemKind ?? "clip" : "sceneId" in target ? "scene" : "clip";
    const values = itemAdjustments(item, kind);
    const id = "targets" in target ? "group" : "sceneId" in target ? target.sceneId : target.clipId;
    return (
        <div className="on-section" data-testid="adjust-controls">
            <div className="on-row-between">
                <h3 className="on-section-title">{t("tabAdjust")}</h3>
                <span className="on-row" style={{ gap: 4 }}>
                    <button
                        type="button"
                        className="on-btn on-btn-ghost"
                        disabled={isNeutral(values)}
                        onClick={() => void controller.execute({ type: "look.set", ...target, adjustments: null })}
                    >
                        {t("resetAll")}
                    </button>
                    {headerAction}
                </span>
            </div>
            {GROUPS.map((group) => (
                <Section key={group.title} title={t(group.title)}>
                    {group.keys.map((key) => {
                        const [min, max] = adjustmentRange(key);
                        const keyed = keyframes?.values[key];
                        return (
                            <SliderRow
                                key={key}
                                testId={`adjust-${key}`}
                                label={t(`adj_${key}` as never)}
                                value={Math.round((keyed ?? values[key]) * 100)}
                                disabled={keyed !== undefined && keyframes?.disabled}
                                min={min * 100}
                                max={max * 100}
                                defaultValue={DEFAULT_ADJUSTMENTS[key] * 100}
                                hint={mixed?.has(key) ? t("groupMixed") : undefined}
                                onChange={(v) => {
                                    if (keyframes?.onChange(key, v / 100)) return;
                                    void controller.execute(
                                        { type: "look.set", ...target, adjustments: { [key]: v / 100 } },
                                        { coalesceKey: `adjust-${id}-${key}`, debounceMs: 120 },
                                    );
                                }}
                            />
                        );
                    })}
                </Section>
            ))}
        </div>
    );
}
