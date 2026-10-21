"use client";
// The text inspector's style controls (phase 10b, CapCut "Text > Basic"): template strip, bundled font
// and weight, size, colour, case and emphasis, alignment, letter and line spacing, wrap width, stroke,
// shadow, glow, background box, and gradient fill. Every control writes one `text.style.set` patch (a
// null value removes a key); sliders coalesce while dragged. Values are read live from the clip, so
// undo/redo and agent edits show up at once.
import { useId, useState } from "react";
import { AlignCenter, AlignLeft, AlignRight } from "lucide-react";
import type { TimelineClip } from "@opennan/timeline-core";
import { toColorInputValue } from "@opennan/timeline-core/lib/color-input";
import { DEFAULT_TEXT_LINE_HEIGHT, parsePreviewTextStyle } from "@opennan/timeline-core/lib/preview-text-draw";
import { TEXT_FONTS, fontByFamily, fontStack, nearestWeight, primaryFontFamily } from "@opennan/timeline-core/text/fonts";
import { TEXT_TEMPLATES } from "@opennan/timeline-core/text/templates";
import { useTimelineController } from "../../hooks/use-timeline-controller";
import { useTimelineMessages } from "../../hooks/use-timeline-messages";
import { Section, SliderRow, Toggle } from "../controls";
import { matchingTemplateId, styleObject } from "../library/text-library";
import { TextThumb } from "../library/text-thumb";

/** Debounce of slider writes (one backend write and one undo step per drag). */
export const TEXT_SLIDER_DEBOUNCE_MS = 120;

const LEGACY_WEIGHTS = ["normal", "bold", "100", "300", "600", "900"] as const;
const WEIGHT_KEYS: Record<number, string> = { 100: "txt_w100", 300: "txt_w300", 400: "txt_w400", 600: "txt_w600", 700: "txt_w700", 800: "txt_w800", 900: "txt_w900" };
const DEFAULT_SHADOW = "rgba(0,0,0,0.6)";
const TEMPLATE_STYLE_JSON = new Map(TEXT_TEMPLATES.map((tpl) => [tpl.id, JSON.stringify(tpl.style)]));

const isNoColor = (value: string | null | undefined) => !value || value === "transparent";
const fmt = (digits: number, suffix = "") => (v: number) => `${Number(v.toFixed(digits))}${suffix}`;

function ColorRow({ label, value, fallback = "#ffffff", onChange, testId }: { label: string; value: string; fallback?: string; onChange(value: string): void; testId: string }) {
    const id = useId();
    return (
        <div className="on-row-between on-color-row" data-testid={testId}>
            <label className="on-field-label" htmlFor={id}>{label}</label>
            <span className="on-color-swatch">
                <input id={id} type="color" value={toColorInputValue(value, fallback)} onChange={(e) => onChange(e.target.value)} />
            </span>
        </div>
    );
}

/** A section whose switch turns the effect on (writing its defaults) or off (removing it). */
function EffectSection({ title, on, onToggle, children, testId }: { title: string; on: boolean; onToggle(on: boolean): void; children: React.ReactNode; testId: string }) {
    return (
        <section className="on-section on-text-effect" data-testid={testId} data-on={on || undefined}>
            <Toggle label={title} checked={on} onChange={onToggle} />
            {on && <div className="on-text-effect-body">{children}</div>}
        </section>
    );
}

export function TextStylePanel({ clip }: { clip: TimelineClip }) {
    const t = useTimelineMessages("studioEditor");
    const controller = useTimelineController();
    const raw = styleObject(clip.textStyle);
    const style = parsePreviewTextStyle(clip.textStyle);
    const [showTemplates, setShowTemplates] = useState(true);

    const set = (patch: Record<string, unknown>) => {
        void controller.execute({ type: "text.style.set", clipIds: [clip.id], patch }, { toastOnError: false });
    };
    const slide = (key: string, value: number) => {
        void controller.execute(
            { type: "text.style.set", clipIds: [clip.id], patch: { [key]: value } },
            { coalesceKey: `text-style:${clip.id}:${key}`, debounceMs: TEXT_SLIDER_DEBOUNCE_MS, toastOnError: false },
        );
    };

    const family = primaryFontFamily(style.fontFamily);
    const bundled = fontByFamily(family);
    const weight = bundled ? String(nearestWeight(bundled, style.fontWeight)) : String(style.fontWeight);
    const appliedTemplate = matchingTemplateId(clip.textStyle);

    const strokeOn = style.strokeWidth > 0;
    const shadowOn = !isNoColor(style.shadowColor) && (style.shadowBlur > 0 || style.shadowOffsetX !== 0 || style.shadowOffsetY !== 0);
    const glowOn = Boolean(style.glowColor) && (style.glowSize ?? 0) > 0;
    const boxOn = !isNoColor(style.bgColor);
    const gradient = style.gradient ?? null;
    const caseOptions = [
        { value: "uppercase", label: "TT", title: t("txt_upper") },
        { value: "lowercase", label: "tt", title: t("txt_lower") },
        { value: "capitalize", label: "Tt", title: t("txt_title") },
    ] as const;

    return (
        <div className="on-text-panel" data-testid="text-style-panel">
            <Section
                title={t("txt_templates")}
                action={(
                    <button type="button" className="on-btn on-btn-ghost on-btn-xs" aria-expanded={showTemplates} onClick={() => setShowTemplates((v) => !v)}>
                        {showTemplates ? t("txt_hide") : t("txt_show")}
                    </button>
                )}
            >
                {showTemplates && (
                    <ul className="on-tpl-strip" aria-label={t("txt_templates")}>
                        {TEXT_TEMPLATES.map((tpl) => (
                            <li key={tpl.id}>
                                <button
                                    type="button"
                                    className="on-tpl-mini"
                                    data-testid={`txt-template-${tpl.id}`}
                                    aria-pressed={appliedTemplate === tpl.id}
                                    aria-label={t(`txt_tpl_${tpl.id}` as never)}
                                    title={t(`txt_tpl_${tpl.id}` as never)}
                                    onClick={() => void controller.execute({ type: "text.template.apply", clipIds: [clip.id], templateId: tpl.id }, { toastOnError: false })}
                                >
                                    <TextThumb text="Aa" styleJson={TEMPLATE_STYLE_JSON.get(tpl.id)!} width={64} height={44} />
                                </button>
                            </li>
                        ))}
                    </ul>
                )}
            </Section>

            <Section title={t("txt_font")}>
                <div className="on-text-font-row">
                    <label className="on-field">
                        <span className="on-field-label">{t("txt_family")}</span>
                        <select
                            className="on-select"
                            data-testid="txt-font-family"
                            value={bundled ? bundled.family : style.fontFamily}
                            style={{ fontFamily: style.fontFamily }}
                            onChange={(e) => {
                                const entry = fontByFamily(e.target.value);
                                set(entry ? { fontFamily: fontStack(entry.family), fontWeight: String(nearestWeight(entry, style.fontWeight)) } : { fontFamily: e.target.value });
                            }}
                        >
                            {TEXT_FONTS.map((f) => (
                                <option key={f.id} value={f.family} style={{ fontFamily: fontStack(f.family) }}>{f.family}</option>
                            ))}
                            {!bundled && (
                                <optgroup label={t("txt_systemFont")}>
                                    <option value={style.fontFamily}>{family || style.fontFamily}</option>
                                </optgroup>
                            )}
                        </select>
                    </label>
                    <label className="on-field">
                        <span className="on-field-label">{t("txt_weight")}</span>
                        <select className="on-select" data-testid="txt-font-weight" value={weight} onChange={(e) => set({ fontWeight: e.target.value })}>
                            {bundled
                                ? bundled.weights.map((w) => <option key={w} value={String(w)}>{t((WEIGHT_KEYS[w] ?? "txt_w400") as never)}</option>)
                                : LEGACY_WEIGHTS.map((w) => <option key={w} value={w}>{w === "normal" ? t("txt_w400") : w === "bold" ? t("txt_w700") : t((WEIGHT_KEYS[Number(w)] ?? "txt_w400") as never)}</option>)}
                        </select>
                    </label>
                </div>
                <SliderRow testId="txt-size" label={t("txt_size")} value={style.fontSize} min={8} max={200} defaultValue={64} format={fmt(0, "px")} onChange={(v) => slide("fontSize", v)} />
                <ColorRow testId="txt-color" label={t("txt_color")} value={style.color} onChange={(v) => set({ color: v })} />
                <div className="on-row-between">
                    <div className="on-segmented on-text-toggles" role="group" aria-label={t("txt_emphasis")}>
                        <button type="button" aria-pressed={style.fontStyle === "italic"} aria-label={t("txt_italic")} title={t("txt_italic")} onClick={() => set({ fontStyle: style.fontStyle === "italic" ? null : "italic" })}><em>I</em></button>
                        <button type="button" aria-pressed={style.textDecoration === "underline"} aria-label={t("txt_underline")} title={t("txt_underline")} onClick={() => set({ textDecoration: style.textDecoration === "underline" ? null : "underline" })}><u>U</u></button>
                    </div>
                    <div className="on-segmented on-text-toggles" role="group" aria-label={t("txt_case")}>
                        {caseOptions.map((o) => (
                            <button key={o.value} type="button" aria-pressed={style.textTransform === o.value} aria-label={o.title} title={o.title} onClick={() => set({ textTransform: style.textTransform === o.value ? null : o.value })}>{o.label}</button>
                        ))}
                    </div>
                </div>
            </Section>

            <Section title={t("txt_layout")}>
                <div className="on-field">
                    <span className="on-field-label">{t("txt_align")}</span>
                    <div className="on-segmented" role="group" aria-label={t("txt_align")}>
                        {([["left", AlignLeft, "txt_alignLeft"], ["center", AlignCenter, "txt_alignCenter"], ["right", AlignRight, "txt_alignRight"]] as const).map(([value, Icon, key]) => (
                            <button key={value} type="button" data-testid={`txt-align-${value}`} aria-pressed={style.textAlign === value} aria-label={t(key)} title={t(key)} onClick={() => set({ textAlign: value })}>
                                <Icon aria-hidden="true" />
                            </button>
                        ))}
                    </div>
                </div>
                <SliderRow testId="txt-letter-spacing" label={t("txt_letterSpacing")} value={style.letterSpacing} min={0} max={20} step={0.5} defaultValue={0} format={fmt(1)} onChange={(v) => slide("letterSpacing", v)} />
                <SliderRow testId="txt-line-height" label={t("txt_lineSpacing")} value={style.lineHeight ?? DEFAULT_TEXT_LINE_HEIGHT} min={0.8} max={2.5} step={0.05} defaultValue={DEFAULT_TEXT_LINE_HEIGHT} format={fmt(2, "×")} onChange={(v) => slide("lineHeight", v)} />
                <SliderRow testId="txt-box-width" label={t("txt_wrapWidth")} value={Math.round((style.maxWidthRatio ?? 0.9) * 100)} min={20} max={100} defaultValue={90} format={fmt(0, "%")} onChange={(v) => slide("maxWidthRatio", v / 100)} />
            </Section>

            <EffectSection testId="txt-stroke" title={t("txt_stroke")} on={strokeOn} onToggle={(on) => set(on ? { strokeWidth: 4, strokeColor: raw.strokeColor ?? "#000000" } : { strokeWidth: null })}>
                <ColorRow testId="txt-stroke-color" label={t("txt_color")} value={style.strokeColor} fallback="#000000" onChange={(v) => set({ strokeColor: v })} />
                <SliderRow testId="txt-stroke-width" label={t("txt_thickness")} value={style.strokeWidth} min={0} max={20} defaultValue={4} onChange={(v) => slide("strokeWidth", v)} />
            </EffectSection>

            <EffectSection
                testId="txt-shadow"
                title={t("txt_shadow")}
                on={shadowOn}
                onToggle={(on) => set(on
                    ? { shadowColor: isNoColor(style.shadowColor) ? DEFAULT_SHADOW : style.shadowColor, shadowBlur: 6, shadowOffsetX: 0, shadowOffsetY: 3 }
                    : { shadowBlur: null, shadowOffsetX: null, shadowOffsetY: null })}
            >
                <ColorRow testId="txt-shadow-color" label={t("txt_color")} value={style.shadowColor} fallback="#000000" onChange={(v) => set({ shadowColor: v })} />
                <SliderRow testId="txt-shadow-blur" label={t("txt_blur")} value={style.shadowBlur} min={0} max={40} defaultValue={6} onChange={(v) => slide("shadowBlur", v)} />
                <SliderRow testId="txt-shadow-x" label={t("txt_offsetX")} value={style.shadowOffsetX} min={-40} max={40} defaultValue={0} onChange={(v) => slide("shadowOffsetX", v)} />
                <SliderRow testId="txt-shadow-y" label={t("txt_offsetY")} value={style.shadowOffsetY} min={-40} max={40} defaultValue={3} onChange={(v) => slide("shadowOffsetY", v)} />
            </EffectSection>

            <EffectSection testId="txt-glow" title={t("txt_glow")} on={glowOn} onToggle={(on) => set(on ? { glowColor: style.glowColor || "#FFFFFF", glowSize: 12 } : { glowColor: null, glowSize: null })}>
                <ColorRow testId="txt-glow-color" label={t("txt_color")} value={style.glowColor || "#FFFFFF"} onChange={(v) => set({ glowColor: v })} />
                <SliderRow testId="txt-glow-size" label={t("txt_glowSize")} value={style.glowSize ?? 0} min={1} max={40} defaultValue={12} onChange={(v) => slide("glowSize", v)} />
            </EffectSection>

            <EffectSection
                testId="txt-box"
                title={t("txt_background")}
                on={boxOn}
                onToggle={(on) => set(on ? { bgColor: "rgba(0,0,0,0.6)", bgPadding: style.bgPadding ?? 12, bgRadius: style.bgRadius || 8 } : { bgColor: null, bgPadding: null, bgRadius: null })}
            >
                <ColorRow testId="txt-box-color" label={t("txt_color")} value={style.bgColor} fallback="#000000" onChange={(v) => set({ bgColor: v })} />
                <SliderRow testId="txt-box-padding" label={t("txt_padding")} value={style.bgPadding ?? 2} min={0} max={60} defaultValue={12} onChange={(v) => slide("bgPadding", v)} />
                <SliderRow testId="txt-box-radius" label={t("txt_radius")} value={Math.min(100, style.bgRadius ?? 0)} min={0} max={100} defaultValue={8} onChange={(v) => slide("bgRadius", v)} />
            </EffectSection>

            <EffectSection
                testId="txt-gradient"
                title={t("txt_gradient")}
                on={Boolean(gradient)}
                onToggle={(on) => set({ gradient: on ? { from: toColorInputValue(style.color, "#ffffff"), to: "#3a86ff", angle: 90 } : null })}
            >
                {gradient && (
                    <>
                        <ColorRow testId="txt-gradient-from" label={t("txt_from")} value={gradient.from} onChange={(v) => set({ gradient: { ...gradient, from: v } })} />
                        <ColorRow testId="txt-gradient-to" label={t("txt_to")} value={gradient.to} onChange={(v) => set({ gradient: { ...gradient, to: v } })} />
                        <SliderRow
                            testId="txt-gradient-angle"
                            label={t("txt_angle")}
                            value={gradient.angle}
                            min={0}
                            max={360}
                            defaultValue={90}
                            format={fmt(0, "°")}
                            onChange={(v) => void controller.execute(
                                { type: "text.style.set", clipIds: [clip.id], patch: { gradient: { ...gradient, angle: v } } },
                                { coalesceKey: `text-style:${clip.id}:gradient`, debounceMs: TEXT_SLIDER_DEBOUNCE_MS, toastOnError: false },
                            )}
                        />
                    </>
                )}
            </EffectSection>
        </div>
    );
}
