"use client";
// The Animation tab (phase 10b, CapCut's): In / Out / Combo for video, image, and sticker clips and scenes,
// In / Out / Loop for text (stickers get Loop too). A card grid (None first) with a hover preview, the
// applied card ringed in white, and a duration slider for the slot's animation (a loop's period). Every
// click is one animation.set; a slider drag coalesces into one undo step.
import { useState } from "react";
import { Ban } from "lucide-react";
import { MIN_ANIMATION_SECONDS, parseAnimationSpec } from "@opennan/timeline-core/motion/animation-spec";
import { animationsFor, type AnimationTarget } from "@opennan/timeline-core/motion/registry";
import type { AnimationSlot } from "@opennan/timeline-core/motion/types";
import { useTimelineController } from "../../hooks/use-timeline-controller";
import { useTimelineMessages } from "../../hooks/use-timeline-messages";
import { SliderRow } from "../controls";
import { MotionThumb } from "./motion-thumb";

export const LOOP_PERIOD_MIN = 0.2;
export const LOOP_PERIOD_MAX = 3;

export function animationSlots(target: AnimationTarget): AnimationSlot[] {
    if (target === "text") return ["in", "out", "loop"];
    if (target === "sticker") return ["in", "out", "combo", "loop"];
    return ["in", "out", "combo"];
}

const round1 = (x: number) => Math.round(x * 10) / 10;
const humanize = (id: string) => id.replace(/^combo_/, "").replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

export interface AnimatedItem {
    id: string;
    /** One item, or (phase 10c group mode) every selected item through animation.set targets. */
    target: { clipId: string } | { sceneId: string } | { targets: Array<{ clipId?: string; sceneId?: string }> };
    animationJson: string | null | undefined;
    /** Item length in seconds. */
    duration: number;
}

export function AnimationTab({ item, kind, mixedSlots }: { item: AnimatedItem; kind: AnimationTarget; mixedSlots?: ReadonlySet<AnimationSlot> }) {
    const t = useTimelineMessages("studioEditor");
    const controller = useTimelineController();
    const slots = animationSlots(kind);
    const [slot, setSlot] = useState<AnimationSlot>(slots[0]);
    const [hover, setHover] = useState<string | null>(null);
    const spec = parseAnimationSpec(item.animationJson);
    const defs = animationsFor(kind, slot);
    const current = spec[slot]?.id ?? null;
    const name = (id: string) => {
        const key = `anim_${slot}_${id}`;
        const text = t(key as never);
        return text === `studioEditor.${key}` ? humanize(id) : text;
    };
    const apply = (animationId: string | null) => void controller.execute({ type: "animation.set", ...item.target, slot, animationId });
    const setDuration = (seconds: number) => {
        if (!current) return;
        void controller.execute(
            { type: "animation.set", ...item.target, slot, animationId: current, duration: seconds },
            { coalesceKey: `anim-${item.id}-${slot}`, debounceMs: 120 },
        );
    };

    const half = Math.max(MIN_ANIMATION_SECONDS, round1(item.duration / 2));
    const full = Math.max(MIN_ANIMATION_SECONDS, round1(item.duration));
    let slider: { min: number; max: number; value: number; label: string } | null = null;
    if (current && (slot === "in" || slot === "out")) {
        slider = { min: MIN_ANIMATION_SECONDS, max: half, value: Math.min(half, round1(spec[slot]!.duration)), label: t("anim_duration") };
    } else if (current && slot === "combo") {
        slider = { min: MIN_ANIMATION_SECONDS, max: full, value: Math.min(full, round1(spec.combo!.duration ?? item.duration)), label: t("anim_duration") };
    } else if (current && slot === "loop") {
        slider = { min: LOOP_PERIOD_MIN, max: LOOP_PERIOD_MAX, value: Math.min(LOOP_PERIOD_MAX, Math.max(LOOP_PERIOD_MIN, round1(spec.loop!.period))), label: t("anim_period") };
    }

    return (
        <div className="on-anim" data-testid="animation-tab">
            <div className="on-segmented" role="group" aria-label={t("anim_slots")}>
                {slots.map((s) => (
                    <button
                        key={s}
                        type="button"
                        aria-pressed={slot === s}
                        data-testid={`anim-slot-${s}`}
                        data-applied={spec[s] ? "true" : undefined}
                        onClick={() => setSlot(s)}
                    >
                        {t(`anim_slot_${s}` as never)}
                    </button>
                ))}
            </div>
            {mixedSlots?.has(slot) && <p className="on-hint" data-testid="anim-mixed">{t("groupMixedHint")}</p>}
            {slot === "combo" && <p className="on-hint">{t("anim_comboHint")}</p>}
            {slot === "loop" && <p className="on-hint">{t("anim_loopHint")}</p>}
            <ul className="on-anim-grid" role="list">
                <li>
                    <button type="button" className="on-card on-anim-card" aria-pressed={current === null} data-testid={`anim-card-${slot}-none`} onClick={() => apply(null)}>
                        <span className="on-card-thumb on-anim-thumb"><span className="on-anim-none"><Ban aria-hidden="true" /></span></span>
                        <span className="on-card-name">{t("anim_none")}</span>
                    </button>
                </li>
                {defs.map((def) => (
                    <li key={def.id}>
                        <button
                            type="button"
                            className="on-card on-anim-card"
                            aria-pressed={current === def.id}
                            aria-label={name(def.id)}
                            data-testid={`anim-card-${slot}-${def.id}`}
                            onClick={() => apply(def.id)}
                            onPointerEnter={() => setHover(def.id)}
                            onPointerLeave={() => setHover((h) => (h === def.id ? null : h))}
                            onFocus={() => setHover(def.id)}
                            onBlur={() => setHover((h) => (h === def.id ? null : h))}
                        >
                            <span className="on-card-thumb on-anim-thumb">
                                <MotionThumb def={def} slot={slot} target={kind} active={hover === def.id} />
                            </span>
                            <span className="on-card-name">{name(def.id)}</span>
                        </button>
                    </li>
                ))}
            </ul>
            {defs.length === 0 && <p className="on-hint">{t("anim_emptySlot")}</p>}
            {slider && (
                <SliderRow
                    key={`${slot}-${current}`}
                    testId="anim-duration"
                    label={slider.label}
                    value={slider.value}
                    min={slider.min}
                    max={slider.max}
                    step={0.1}
                    format={(v) => t("seconds", { value: v.toFixed(1) })}
                    onChange={setDuration}
                />
            )}
        </div>
    );
}
