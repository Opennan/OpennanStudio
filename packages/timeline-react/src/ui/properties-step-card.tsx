"use client";
// Shared card surfaces used inside PropertiesStepSection bodies.
// Every step workflow (AI video, podcast, copy video) was hand-rolling the same
// `rounded-md border … bg-[#101012] p-3` block with its own header markup, so
// the panels drifted apart. These wrap the two surfaces we actually use:
//   - PropertiesStepCard: the panel-level card (uppercase label + meta, or an
//     icon + title heading), with an optional right-aligned action slot.
//   - PropertiesStepSubCard: the quieter nested block inside a card.

import type React from "react";
import { cn } from "./cn";

export function PropertiesStepCard({
    label,
    meta,
    icon,
    title,
    actions,
    children,
    className,
    contentClassName,
    testId,
}: {
    /** Uppercase eyebrow label, e.g. "Line actions". */
    label?: React.ReactNode;
    /** Small secondary line under the label — counts, state, hints. */
    meta?: React.ReactNode;
    /** Leading icon, paired with `title`. */
    icon?: React.ReactNode;
    /** Sentence-case heading, e.g. "Generate talking video". */
    title?: React.ReactNode;
    /** Right-aligned controls on the header row. */
    actions?: React.ReactNode;
    children?: React.ReactNode;
    className?: string;
    contentClassName?: string;
    /** Optional hook for behaviour tests that assert on the card. */
    testId?: string;
}) {
    const hasHeader = !!(label || meta || icon || title || actions);
    return (
        <div data-testid={testId} className={cn("rounded-md border border-[rgba(255,255,255,0.08)] bg-[#101012] p-3", className)}>
            {hasHeader && (
                <div className={cn("flex items-center justify-between gap-2", children ? "mb-2" : undefined)}>
                    <div className="flex min-w-0 items-center gap-2">
                        {icon}
                        <div className="min-w-0">
                            {title && <span className="block truncate text-[11px] font-medium text-[#E5E7EB]">{title}</span>}
                            {label && <span className="block truncate text-[10px] font-medium uppercase tracking-wider text-[#74747D]">{label}</span>}
                            {meta && <span className="block truncate text-[9px] text-[#55555D]">{meta}</span>}
                        </div>
                    </div>
                    {actions && <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
                </div>
            )}
            {children && <div className={contentClassName}>{children}</div>}
        </div>
    );
}

export function PropertiesStepSubCard({
    label,
    actions,
    children,
    className,
    testId,
}: {
    label?: React.ReactNode;
    actions?: React.ReactNode;
    children?: React.ReactNode;
    className?: string;
    testId?: string;
}) {
    return (
        <div data-testid={testId} className={cn("space-y-2 rounded-md border border-white/[0.06] bg-black/25 p-2.5", className)}>
            {(label || actions) && (
                <div className="flex items-center justify-between gap-2">
                    {label && <span className="text-[10px] font-medium uppercase tracking-wider text-[#74747D]">{label}</span>}
                    {actions && <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
                </div>
            )}
            {children}
        </div>
    );
}

/** One row inside a card list — numbered chip, badge row, body text. */
export function PropertiesStepListRow({
    index,
    badges,
    children,
    actions,
    className,
}: {
    index?: number;
    badges?: React.ReactNode;
    children?: React.ReactNode;
    actions?: React.ReactNode;
    className?: string;
}) {
    return (
        <div className={cn("rounded-md border border-white/[0.07] bg-black/20 p-2", className)}>
            <div className="flex items-start gap-2">
                {index != null && (
                    <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded bg-white/[0.06] text-[10px] font-medium text-[#D7D7DB]">{index}</div>
                )}
                <div className="min-w-0 flex-1">
                    {badges && <div className="mb-1 flex flex-wrap items-center gap-1.5">{badges}</div>}
                    {children}
                </div>
                {actions && <div className="flex shrink-0 items-center gap-1">{actions}</div>}
            </div>
        </div>
    );
}

/** Dashed call-to-action used as a card's empty state. */
export function PropertiesStepEmptyAction({
    onClick,
    disabled,
    children,
    title,
}: {
    onClick: () => void;
    disabled?: boolean;
    children: React.ReactNode;
    title?: string;
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            disabled={disabled}
            title={title}
            className="w-full rounded border border-dashed border-white/[0.14] bg-white/[0.03] px-3 py-5 text-[10px] text-[#A0A0A8] hover:border-white/25 hover:text-white disabled:opacity-40"
        >
            {children}
        </button>
    );
}

/**
 * Panel header bar — the same row `PropertiesStepper` renders at the top of the
 * AI video and Podcast panels. Non-stepper panels (Graphics, Effects,
 * Transitions, Image, Source clip) use this so every right-panel header is the
 * same object: shell, `border-b` row, icon, 11px title, right-aligned trail.
 */
export function PropertiesPanelHeader({
    icon,
    title,
    trail,
    actions,
    children,
    testId,
    className,
}: {
    icon?: React.ReactNode;
    title: React.ReactNode;
    /** Small right-aligned note — counts, duration, state. */
    trail?: React.ReactNode;
    /** Controls on the header row, right of the trail. */
    actions?: React.ReactNode;
    /** Optional body under the header row (caption, hint). */
    children?: React.ReactNode;
    testId?: string;
    className?: string;
}) {
    return (
        <div
            data-testid={testId}
            className={cn("overflow-hidden rounded-md border border-[rgba(255,255,255,0.08)] bg-[#101012]", className)}
        >
            <div className="flex items-center justify-between gap-2 border-b border-[rgba(255,255,255,0.06)] px-3 py-2">
                <div className="flex min-w-0 items-center gap-2">
                    {icon}
                    <span className="truncate text-[11px] font-medium text-[#E5E7EB]">{title}</span>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                    {trail && <span className="text-[9px] text-[#55555D]">{trail}</span>}
                    {actions}
                </div>
            </div>
            {children && <div className="px-3 py-2">{children}</div>}
        </div>
    );
}
