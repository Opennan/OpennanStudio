"use client";
// The inspector's group mode (phase 10c): two or more selected clips and scenes. A header with the item count and the
// tabs every selected item supports (Filter, Adjust, Animation, Effects), plus Mask when any item takes one (phase 10d:
// it applies to those items); every change is ONE command with `targets` (one undo step for all items). Controls show
// the primary item's value with a "Mixed" note where the items differ. Auto cut to beat (phase 11) closes every tab.
import { useMemo, useState } from "react";
import { Layers } from "lucide-react";
import type { SceneData, TimelineClip } from "@opennan/timeline-core";
import { looksCatalog } from "@opennan/timeline-core/looks/catalog";
import { ADJUSTMENT_KEYS, itemAdjustments, type AdjustmentKey } from "@opennan/timeline-core/looks/adjust";
import { DEFAULT_FILTER_INTENSITY, normalizeFilterId } from "@opennan/timeline-core/looks/filters";
import { itemFilterIntensity } from "@opennan/timeline-core/looks/look-plan";
import { clipTakesMask } from "@opennan/timeline-core/looks/masks";
import { parseAnimationSpec } from "@opennan/timeline-core/motion/animation-spec";
import type { AnimationTarget } from "@opennan/timeline-core/motion/registry";
import type { AnimationSlot } from "@opennan/timeline-core/motion/types";
import { getSceneDuration } from "@opennan/timeline-core/timeline/scene-timing";
import { useTimelineController } from "../../hooks/use-timeline-controller";
import { useTimelineMessages } from "../../hooks/use-timeline-messages";
import { AdjustControls } from "../adjust-controls";
import { Section, SliderRow } from "../controls";
import { animationFamilyOf, groupItems, takesLook, type GroupSelection } from "../multi-selection";
import { AnimationTab } from "./animation-tab";
import { GroupMaskTab } from "./mask-tab";
import { AttributeHeadActions } from "../attributes/attribute-head-actions";
import { AutoCutToBeat } from "../../ai/auto-cut";

const CATALOG = looksCatalog();
type GroupTab = "filter" | "adjust" | "animation" | "mask" | "effects";
type Item = { clip?: TimelineClip; scene?: SceneData };
type Translate = ReturnType<typeof useTimelineMessages<"studioEditor">>;

const fieldsOf = (item: Item) => (item.scene ?? item.clip)!;
const kindOf = (item: Item) => (item.scene ? "scene" as const : "clip" as const);
const lengthOf = (item: Item) => (item.scene ? getSceneDuration(item.scene) : Math.max(0, item.clip!.endTime - item.clip!.startTime));

/** Scenes and video, image, text, and sticker clips take a mask (timeline-core looks/masks.ts clipTakesMask). */
export const takesMask = (item: Item) => Boolean(item.scene) || (item.clip ? clipTakesMask(item.clip) : false);

/**
 * The tabs every item supports: looks for scenes and visual clips, animation when all share one animation family; Mask
 * when any item takes a mask (phase 10d: the mask goes on those items, the others are left as they are).
 */
export function groupTabs(items: readonly Item[]): { tabs: GroupTab[]; family: AnimationTarget | null } {
    const tabs: GroupTab[] = [];
    const looks = items.length > 0 && items.every(takesLook);
    const families = new Set(items.map(animationFamilyOf));
    const family = families.size === 1 ? [...families][0] : null;
    if (looks) tabs.push("filter", "adjust");
    if (family) tabs.push("animation");
    if (items.some(takesMask)) tabs.push("mask");
    if (looks) tabs.push("effects");
    return { tabs, family };
}

export function GroupInspector({ t, group }: { t: Translate; group: GroupSelection }) {
    const items = useMemo(() => groupItems(group), [group]);
    const { tabs, family } = groupTabs(items);
    const [tab, setTab] = useState<GroupTab | null>(tabs[0] ?? null);
    const active = tab && tabs.includes(tab) ? tab : tabs[0] ?? null;
    const targets = { targets: group.targets };
    const title = t("groupTitle", { count: items.length });
    const labels: Record<GroupTab, string> = { filter: t("tabFilter"), adjust: t("tabAdjust"), animation: t("anim_tab"), mask: t("tabMask"), effects: t("tabEffects") };
    return (
        <>
            <div className="on-inspector-head" data-testid="inspector-group">
                <span className="on-inspector-icon"><Layers aria-hidden="true" /></span>
                <div style={{ minWidth: 0 }}>
                    <p className="on-inspector-title" data-testid="inspector-group-title">{title}</p>
                    <p className="on-inspector-kind">{t("groupKind", { clips: group.clips.length, scenes: group.scenes.length })}</p>
                </div>
                {/* Copy attributes from the primary item; paste onto every selected item. */}
                <AttributeHeadActions item={items[0].scene ? { kind: "scene", scene: items[0].scene } : { kind: "clip", clip: items[0].clip! }} />
            </div>
            {tabs.length > 0 && (
                <div className="on-tabs" role="tablist" aria-label={title}>
                    {tabs.map((id) => (
                        <button key={id} type="button" role="tab" className="on-tab" aria-selected={active === id} data-testid={`inspector-tab-${id}`} onClick={() => setTab(id)}>{labels[id]}</button>
                    ))}
                </div>
            )}
            <div className="on-inspector-body" role={active ? "tabpanel" : undefined} key={active ?? "none"} data-testid={`inspector-panel-${active ?? "group"}`}>
                <p className="on-hint">{tabs.length > 0 ? t("groupHint") : t("groupNoTabs")}</p>
                {active === "filter" && <GroupFilter t={t} items={items} targets={targets} />}
                {active === "adjust" && <GroupAdjust items={items} targets={targets} />}
                {active === "animation" && family && <GroupAnimation items={items} targets={targets} family={family} />}
                {active === "mask" && <GroupMask items={items} />}
                {active === "effects" && <GroupEffects t={t} targets={targets} />}
                {/* Phase 11: every multi-selection can be cut to the beat of an audio clip. */}
                <Section title={t("ai_autoCut")}>
                    <AutoCutToBeat items={{ clipIds: group.clips.map((c) => c.id), sceneIds: group.scenes.map((s) => s.id) }} />
                </Section>
            </div>
        </>
    );
}

function GroupFilter({ t, items, targets }: { t: Translate; items: Item[]; targets: { targets: GroupSelection["targets"] } }) {
    const controller = useTimelineController();
    const primary = fieldsOf(items[0]);
    const current = normalizeFilterId(primary.visualFilter);
    const filters = new Set(items.map((item) => normalizeFilterId(fieldsOf(item).visualFilter)));
    const intensityOf = (item: Item) => (normalizeFilterId(fieldsOf(item).visualFilter) === "none" ? DEFAULT_FILTER_INTENSITY : itemFilterIntensity(fieldsOf(item)));
    const intensity = intensityOf(items[0]);
    const intensityMixed = new Set(items.map((item) => Math.round(intensityOf(item) * 100))).size > 1;
    const pick = (filter: string) => void controller.execute({ type: "look.set", ...targets, filter, intensity });
    return (
        <>
            {filters.size > 1 && <p className="on-hint" data-testid="group-filter-mixed">{t("groupMixedHint")}</p>}
            {current !== "none" && (
                <SliderRow
                    testId="group-filter-intensity"
                    label={t("intensity")}
                    value={Math.round(intensity * 100)}
                    min={0}
                    max={100}
                    defaultValue={Math.round(DEFAULT_FILTER_INTENSITY * 100)}
                    format={(v) => t("percent", { value: v })}
                    hint={intensityMixed ? t("groupMixed") : undefined}
                    onChange={(v) => void controller.execute({ type: "look.set", ...targets, intensity: v / 100 }, { coalesceKey: "group-intensity", debounceMs: 120 })}
                />
            )}
            {(["life", "movies", "retro", "bw", "food", "landscape"] as const).map((category) => (
                <Section key={category} title={t(`fltCat_${category}` as never)}>
                    <div className="on-chips" style={{ flexWrap: "wrap", padding: 0, overflow: "visible" }}>
                        {CATALOG.filters.filter((f) => f.category === category).map((f) => (
                            <button key={f.id} type="button" className="on-chip" aria-pressed={filters.size === 1 && current === f.id} data-testid={`group-filter-${f.id}`} onClick={() => pick(current === f.id && filters.size === 1 ? "none" : f.id)}>
                                {t(`flt_${f.id}` as never)}
                            </button>
                        ))}
                    </div>
                </Section>
            ))}
            {[...filters].some((f) => f !== "none") && <button type="button" className="on-btn on-btn-ghost" onClick={() => pick("none")}>{t("filterNone")}</button>}
        </>
    );
}

function GroupAdjust({ items, targets }: { items: Item[]; targets: { targets: GroupSelection["targets"] } }) {
    const mixed = useMemo(() => {
        const values = items.map((item) => itemAdjustments(fieldsOf(item), kindOf(item)));
        return new Set<AdjustmentKey>(ADJUSTMENT_KEYS.filter((key) => new Set(values.map((v) => Math.round(v[key] * 100))).size > 1));
    }, [items]);
    return <AdjustControls target={targets} item={fieldsOf(items[0])} itemKind={kindOf(items[0])} mixed={mixed} />;
}

function GroupAnimation({ items, targets, family }: { items: Item[]; targets: { targets: GroupSelection["targets"] }; family: AnimationTarget }) {
    const mixedSlots = useMemo(() => {
        const specs = items.map((item) => parseAnimationSpec(fieldsOf(item).animationJson));
        return new Set<AnimationSlot>((["in", "out", "combo", "loop"] as const).filter((slot) => new Set(specs.map((spec) => spec[slot]?.id ?? null)).size > 1));
    }, [items]);
    const duration = Math.min(...items.map(lengthOf));
    return (
        <AnimationTab
            item={{ id: "group", target: targets, animationJson: fieldsOf(items[0]).animationJson, duration }}
            kind={family === "text" ? "text" : family}
            mixedSlots={mixedSlots}
        />
    );
}

function GroupMask({ items }: { items: Item[] }) {
    const maskable = items.filter(takesMask);
    const targets = maskable.map((item) => (item.scene ? { sceneId: item.scene.id } : { clipId: item.clip!.id }));
    return <GroupMaskTab items={maskable.map(fieldsOf)} targets={targets} total={items.length} />;
}

function GroupEffects({ t, targets }: { t: Translate; targets: { targets: GroupSelection["targets"] } }) {
    const controller = useTimelineController();
    return (
        <>
            <p className="on-hint">{t("groupEffectsHint")}</p>
            {(["basic", "color", "motion", "retro", "glitch"] as const).map((category) => (
                <Section key={category} title={t(`fxCat_${category}` as never)}>
                    <div className="on-chips" style={{ flexWrap: "wrap", padding: 0, overflow: "visible" }}>
                        {CATALOG.effects.filter((e) => e.category === category).map((e) => (
                            <button key={e.id} type="button" className="on-chip" data-testid={`group-effect-${e.id}`} onClick={() => void controller.execute({ type: "clip.effect.add", ...targets, effectId: e.id })}>
                                {t(`fx_${e.id.replace(/^fx_/, "")}` as never)}
                            </button>
                        ))}
                    </div>
                </Section>
            ))}
        </>
    );
}
