"use client";
// The Speed tab (phase 10b, CapCut's): Normal (0.1x-100x on a log slider with a numeric field) or Curve
// (presets with a mini drawing, and a curve editor), the resulting length ("5.0 s → 2.5 s"), and keep pitch.
// Every edit is one speed.set (sliders and key nudges coalesce into one undo step; a curve drag commits on
// release). CapCut semantics: a normal speed clears the curve, and a curve plays from 1x.
import { useEffect, useState, type ReactNode } from "react";
import { RotateCcw } from "lucide-react";
import {
    MAX_SPEED, MIN_SPEED, SPEED_CURVE_PRESETS, sourceSpan, speedCurvePreset, timelineDuration, type SpeedCurve, type SpeedProfile,
} from "@opennan/timeline-core/motion/speed";
import { useTimelineController } from "../../hooks/use-timeline-controller";
import { useTimelineMessages } from "../../hooks/use-timeline-messages";
import { Segmented, SliderRow, Toggle } from "../controls";
import { CurveEditor } from "./curve-editor";
import { curvePolyline, roundSpeed, sliderToSpeed, speedToSlider, type CurvePoints } from "./speed-math";

export interface SpeedItem {
    id: string;
    target: { clipId: string } | { sceneId: string };
    profile: SpeedProfile;
    /** Current timeline length in seconds. */
    duration: number;
}

const SLIDER_STEPS = 1000;
const PRESET_IDS = ["none", ...SPEED_CURVE_PRESETS.map((c) => c.id), "custom"] as const;
/** A fresh custom curve: flat at 1x with five points to drag. */
export const FLAT_CURVE: CurvePoints = [[0, 1], [0.25, 1], [0.5, 1], [0.75, 1], [1, 1]];

const formatSpeed = (s: number) => `${s < 1 ? s.toFixed(2) : s < 10 ? s.toFixed(1) : s.toFixed(0)}×`;
const copy = (points: CurvePoints): CurvePoints => points.map(([x, y]): [number, number] => [x, y]);

/** Which preset card a curve selects (legacy ramps and edited curves are Custom). */
export function curveCardId(curve: SpeedCurve | null): string {
    if (!curve) return "none";
    return SPEED_CURVE_PRESETS.some((c) => c.id === curve.id) ? curve.id : "custom";
}

export function SpeedTab({ item, children }: { item: SpeedItem; children?: ReactNode }) {
    const t = useTimelineMessages("studioEditor");
    const controller = useTimelineController();
    const { profile } = item;
    const [mode, setMode] = useState<"normal" | "curve">(profile.curve ? "curve" : "normal");
    const [preview, setPreview] = useState<CurvePoints | null>(null);
    const span = sourceSpan(profile, item.duration);
    const set = (patch: { speed?: number; curve?: SpeedCurve | null; preservePitch?: boolean }, coalesce = false) => void controller.execute(
        { type: "speed.set", ...item.target, ...patch },
        coalesce ? { coalesceKey: `speed-${item.id}`, debounceMs: 120 } : undefined,
    );
    const length = preview ? timelineDuration({ ...profile, curve: { id: "custom", points: preview } }, span) : item.duration;
    const readout = (
        <div className="on-row-between" data-testid="speed-length">
            <span className="on-field-label">{t("speed_length")}</span>
            <span className="on-field-value">{t("speed_lengthValue", { from: span.toFixed(1), to: length.toFixed(1) })}</span>
        </div>
    );
    const card = curveCardId(profile.curve);
    const applyPreset = (id: string) => {
        if (id === "none") set({ curve: null });
        else if (id === "custom") set({ curve: { id: "custom", points: profile.curve ? copy(profile.curve.points) : copy(FLAT_CURVE) }, speed: 1 });
        else set({ curve: speedCurvePreset(id), speed: 1 });
    };
    const reset = () => {
        const preset = profile.curve && card !== "custom" ? speedCurvePreset(card) : null;
        set({ curve: preset ?? { id: "custom", points: copy(FLAT_CURVE) } });
    };
    return (
        <div className="on-speed" data-testid="speed-tab">
            <Segmented<"normal" | "curve">
                label={t("speed_mode")}
                value={mode}
                options={[{ value: "normal", label: t("speed_normal") }, { value: "curve", label: t("speed_curve") }]}
                onChange={(next) => setMode(next)}
            />
            {mode === "normal" ? (
                <NormalSpeed speed={profile.speed} onChange={(speed, coalesce) => set(profile.curve ? { speed, curve: null } : { speed }, coalesce)} />
            ) : (
                <>
                    <ul className="on-speed-presets" role="list">
                        {PRESET_IDS.map((id) => {
                            const points = id === "none" ? [[0, 1], [1, 1]] as CurvePoints : id === "custom" ? (card === "custom" && profile.curve ? profile.curve.points : FLAT_CURVE) : speedCurvePreset(id)!.points;
                            return (
                                <li key={id}>
                                    <button type="button" className="on-card on-speed-card" aria-pressed={card === id} data-testid={`speed-preset-${id}`} onClick={() => applyPreset(id)}>
                                        <span className="on-card-thumb on-speed-thumb">
                                            <svg viewBox="-2 -2 60 32" aria-hidden="true" preserveAspectRatio="none">
                                                <line className="on-speed-unit" x1={0} x2={56} y1={14} y2={14} />
                                                <polyline points={curvePolyline(points, 56, 28)} />
                                            </svg>
                                        </span>
                                        <span className="on-card-name">{t(`speed_preset_${id}` as never)}</span>
                                    </button>
                                </li>
                            );
                        })}
                    </ul>
                    {profile.curve && (
                        <>
                            <div className="on-row-between">
                                <span className="on-section-title">{t("speed_editor")}</span>
                                <button type="button" className="on-btn on-btn-ghost" data-testid="speed-curve-reset" onClick={reset}><RotateCcw aria-hidden="true" />{t("speed_reset")}</button>
                            </div>
                            <CurveEditor
                                points={profile.curve.points}
                                onPreview={setPreview}
                                onCommit={(points, coalesce) => set({ curve: { id: "custom", points } }, coalesce)}
                            />
                        </>
                    )}
                </>
            )}
            {readout}
            <Toggle label={t("speed_keepPitch")} checked={profile.preservePitch} onChange={(preservePitch) => set({ preservePitch })} />
            {children}
        </div>
    );
}

function NormalSpeed({ speed, onChange }: { speed: number; onChange(speed: number, coalesce: boolean): void }) {
    const t = useTimelineMessages("studioEditor");
    const [text, setText] = useState(String(roundSpeed(speed)));
    useEffect(() => setText(String(roundSpeed(speed))), [speed]);
    const commitText = () => {
        const value = Number(text.replace(",", "."));
        if (!Number.isFinite(value) || value <= 0) {
            setText(String(roundSpeed(speed)));
            return;
        }
        const next = Math.min(MAX_SPEED, Math.max(MIN_SPEED, Math.round(value * 100) / 100));
        setText(String(next));
        if (Math.abs(next - speed) > 1e-6) onChange(next, false);
    };
    return (
        <>
            <SliderRow
                testId="speed-slider"
                label={t("speed_value")}
                value={Math.round(speedToSlider(speed) * SLIDER_STEPS)}
                min={0}
                max={SLIDER_STEPS}
                defaultValue={Math.round(speedToSlider(1) * SLIDER_STEPS)}
                format={(v) => formatSpeed(sliderToSpeed(v / SLIDER_STEPS))}
                onChange={(v) => onChange(sliderToSpeed(v / SLIDER_STEPS), true)}
            />
            <label className="on-row-between">
                <span className="on-field-label">{t("speed_input")}</span>
                <span className="on-speed-input">
                    <input
                        className="on-text-input"
                        data-testid="speed-input"
                        inputMode="decimal"
                        value={text}
                        onChange={(e) => setText(e.target.value)}
                        onBlur={commitText}
                        onKeyDown={(e) => e.key === "Enter" && (e.currentTarget as HTMLInputElement).blur()}
                    />
                    <span aria-hidden="true">×</span>
                </span>
            </label>
        </>
    );
}
