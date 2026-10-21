"use client";
// Small, accessible controls for the inspector and libraries (tokens only, see editing.css).
import { useEffect, useId, useState, type ReactNode } from "react";
import { RotateCcw } from "lucide-react";
import { useTimelineMessages } from "../hooks/use-timeline-messages";

export interface SliderRowProps {
    label: string;
    value: number;
    min: number;
    max: number;
    step?: number;
    /** Value the reset button restores (also marks the row "changed" when different). */
    defaultValue?: number;
    format?(value: number): string;
    onChange(value: number): void;
    testId?: string;
    /** Rendered after the value (the keyframe diamond). */
    adornment?: ReactNode;
    disabled?: boolean;
    /** A short note beside the label (phase 10c group mode: "Mixed" when the selected items differ). */
    hint?: string;
}

/** A labelled range with its value and a reset button; local state while dragging keeps it smooth. */
export function SliderRow({ label, value, min, max, step = 1, defaultValue, format, onChange, testId, adornment, disabled, hint }: SliderRowProps) {
    const t = useTimelineMessages("studioEditor");
    const id = useId();
    const [local, setLocal] = useState(value);
    useEffect(() => setLocal(value), [value]);
    const pct = ((local - min) / (max - min || 1)) * 100;
    const changed = defaultValue !== undefined && Math.abs(local - defaultValue) > step / 2;
    const set = (next: number) => {
        setLocal(next);
        onChange(next);
    };
    return (
        <div className="on-slider-row" data-changed={changed || undefined} data-testid={testId}>
            <div className="on-field-label">
                <label htmlFor={id}>{label}{hint && <span className="on-field-hint" data-testid={testId ? `${testId}-hint` : undefined}>{hint}</span>}</label>
                <span className="on-row" style={{ gap: 2 }}>
                    {defaultValue !== undefined && (
                        <button type="button" className="on-icon-btn" aria-label={t("resetNamed", { name: label })} disabled={!changed || disabled} onClick={() => set(defaultValue)}>
                            <RotateCcw aria-hidden="true" />
                        </button>
                    )}
                    <span className="on-field-value">{format ? format(local) : local}</span>
                    {adornment}
                </span>
            </div>
            <input
                id={id}
                className="on-range"
                type="range"
                min={min}
                max={max}
                step={step}
                value={local}
                disabled={disabled}
                data-signed={min < 0 && max > 0 ? "true" : undefined}
                style={{ ["--pct" as string]: `${pct}%` }}
                onChange={(e) => set(Number(e.target.value))}
            />
        </div>
    );
}

export interface SegmentedOption<T extends string> {
    value: T;
    label: string;
    /** A choice that does not apply (phase 11: an upscale tier the media already meets); `title` says why. */
    disabled?: boolean;
    title?: string;
}

export function Segmented<T extends string>({ label, value, options, onChange, testId }: { label: string; value: T; options: ReadonlyArray<SegmentedOption<T>>; onChange(value: T): void; testId?: string }) {
    return (
        <div className="on-field">
            <span className="on-field-label">{label}</span>
            <div className="on-segmented" role="group" aria-label={label} data-testid={testId}>
                {options.map((o) => (
                    <button
                        key={o.value} type="button" aria-pressed={value === o.value} disabled={o.disabled} title={o.title} aria-description={o.title}
                        data-testid={testId ? `${testId}-${o.value}` : undefined} onClick={() => onChange(o.value)}
                    >
                        {o.label}
                    </button>
                ))}
            </div>
        </div>
    );
}

export function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange(checked: boolean): void }) {
    return (
        <div className="on-row-between">
            <span className="on-field-label">{label}</span>
            <button type="button" role="switch" className="on-toggle" aria-checked={checked} aria-label={label} onClick={() => onChange(!checked)} />
        </div>
    );
}

export function Section({ title, action, children }: { title?: string; action?: ReactNode; children: ReactNode }) {
    return (
        <section className="on-section">
            {(title || action) && (
                <div className="on-section-head">
                    {title && <h3 className="on-section-title">{title}</h3>}
                    {action}
                </div>
            )}
            {children}
        </section>
    );
}
