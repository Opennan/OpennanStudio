"use client";
// src/components/editor/effects/effect-param-panel.tsx
// Shared param editor for anything driven by the effect registry — applied
// effects (Effects tab) and applied transitions (Transitions tab) render the
// exact same controls, so a knob looks and behaves identically wherever the
// registry declares it.

import { useState } from "react";
import { useTimelineMessages } from "../hooks/use-timeline-messages";
import { Slider } from "../ui/slider";
import { PropertiesStepSubCard } from "../ui/properties-step-card";
import type { EffectParam } from "@opennan/timeline-core";

export type ParamValue = number | string | boolean;

/** Applied-row params are stored as a JSON blob; unparseable falls back to defaults. */
export function parseParams(json: string | null | undefined): Record<string, ParamValue> {
    if (!json) return {};
    try {
        return JSON.parse(json) ?? {};
    } catch {
        return {};
    }
}

export function ParamControl({
    param,
    value,
    disabled,
    onCommit,
}: {
    param: EffectParam;
    value: ParamValue | undefined;
    disabled: boolean;
    onCommit: (v: ParamValue) => void;
}) {
    // Local drag state — commit only on release (no save per slider tick).
    const [drag, setDrag] = useState<number | null>(null);

    if (param.type === "color") {
        const current = typeof value === "string" ? value : "#00ff00";
        return (
            <PropertiesStepSubCard testId={`effect-param-${param.key}`} className="space-y-0">
                <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                        <p className="truncate text-[11px] font-medium text-[#D7D7DB]">{param.label}</p>
                        <p className="mt-0.5 font-mono text-[10px] text-[#74747D]">{current}</p>
                    </div>
                    <label className="flex shrink-0 items-center gap-2">
                        <span
                            className="h-5 w-5 rounded border border-[rgba(255,255,255,0.12)]"
                            style={{ backgroundColor: current }}
                        />
                        <input
                            type="color"
                            value={current}
                            disabled={disabled}
                            onChange={(e) => onCommit(e.target.value)}
                            className="h-7 w-9 cursor-pointer rounded border border-[rgba(255,255,255,0.1)] bg-transparent disabled:cursor-not-allowed disabled:opacity-50"
                        />
                    </label>
                </div>
            </PropertiesStepSubCard>
        );
    }

    if (param.type === "toggle") {
        const current = typeof value === "boolean" ? value : Number(value ?? param.default) > 0.5;
        return (
            <PropertiesStepSubCard testId={`effect-param-${param.key}`} className="space-y-0">
                <div className="flex items-center justify-between gap-3">
                    <p className="truncate text-[11px] font-medium text-[#D7D7DB]">{param.label}</p>
                    <button
                        type="button"
                        disabled={disabled}
                        onClick={() => onCommit(!current)}
                        className={`flex h-6 w-10 shrink-0 items-center rounded-full border p-0.5 transition-colors disabled:opacity-50 ${
                            current
                                ? "justify-end border-primary/40 bg-primary/25"
                                : "justify-start border-[rgba(255,255,255,0.1)] bg-[rgba(255,255,255,0.04)]"
                        }`}
                    >
                        <span className="h-4 w-4 rounded-full bg-[#E8E8EA]" />
                    </button>
                </div>
            </PropertiesStepSubCard>
        );
    }

    const parsedValue = typeof value === "number"
        ? value
        : typeof value === "string" && value.trim() !== ""
            ? Number(value)
            : NaN;
    const numeric = Number.isFinite(parsedValue) ? parsedValue : param.default;
    const live = drag ?? numeric;
    const step = (param.max - param.min) / 100 || 0.01;
    return (
        <PropertiesStepSubCard testId={`effect-param-${param.key}`} className="space-y-0">
            <div className="mb-2 flex items-center justify-between gap-3">
                <span className="min-w-0 truncate text-[11px] font-medium text-[#D7D7DB]">{param.label}</span>
                <span className="rounded border border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.04)] px-1.5 py-0.5 text-[10px] tabular-nums text-[#A0A0A8]">
                    {live.toFixed(2)}
                </span>
            </div>
            <Slider
                value={[live]}
                min={param.min}
                max={param.max}
                step={step}
                onValueChange={([v]) => (disabled ? undefined : setDrag(v))}
                onValueCommit={([v]) => {
                    setDrag(null);
                    if (!disabled && v !== numeric) onCommit(v);
                }}
            />
        </PropertiesStepSubCard>
    );
}

/**
 * "Parameters" section: header with the knob count plus one control per param,
 * or the empty-state line when the registry entry declares none.
 */
export function EffectParamPanel({
    params,
    values,
    disabled = false,
    emptyLabel,
    onCommit,
}: {
    params: EffectParam[];
    values: Record<string, ParamValue>;
    disabled?: boolean;
    emptyLabel: string;
    onCommit: (key: string, value: ParamValue) => void;
}) {
    const t = useTimelineMessages("effectsTab");

    if (params.length === 0) {
        return (
            <p className="mt-3 rounded-md border border-white/[0.06] bg-black/25 px-3 py-2 text-[11px] text-[#74747D]">
                {emptyLabel}
            </p>
        );
    }

    return (
        <div className="mt-3">
            <div className="mb-2 flex items-center justify-between gap-2">
                <span className="text-[10px] font-medium uppercase tracking-wider text-[#74747D]">{t("parameters")}</span>
                <span className="text-[9px] tabular-nums text-[#55555D]">{params.length}</span>
            </div>
            <div className="space-y-2">
                {params.map((param) => (
                    <ParamControl
                        key={param.key}
                        param={param}
                        value={values[param.key]}
                        disabled={disabled}
                        onCommit={(v) => onCommit(param.key, v)}
                    />
                ))}
            </div>
        </div>
    );
}
