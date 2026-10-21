// The host side of TimelineProviderProps.onToast/onDismissToast: a short list where
// a toast with a known id replaces the earlier one (loading -> success, as the
// canvas upload path does, packages/timeline-react/src/provider/toast.ts:1-2).
import type { TimelineToast, TimelineToastKind } from "@opennan/timeline-core";

export interface QueuedToast extends TimelineToast {
    id: string;
    /** Playing its exit animation; removed TOAST_EXIT_MS later. */
    leaving?: boolean;
}

/** Exit animation length (editor.css .toast[data-leaving]); motion stays under 200 ms. */
export const TOAST_EXIT_MS = 160;

export function markLeaving(list: QueuedToast[], id: string): QueuedToast[] {
    return list.map((item) => (item.id === id ? { ...item, leaving: true } : item));
}

export const MAX_TOASTS = 5;

export function upsertToast(list: QueuedToast[], toast: QueuedToast): QueuedToast[] {
    const index = list.findIndex((item) => item.id === toast.id);
    const next = index >= 0 ? list.map((item, i) => (i === index ? toast : item)) : [...list, toast];
    return next.slice(-MAX_TOASTS);
}

export function removeToast(list: QueuedToast[], id: string): QueuedToast[] {
    return list.filter((item) => item.id !== id);
}

/** null: stays until dismissed (a loading toast is replaced or dismissed by its owner). A toast with an action stays longer. */
export function toastLifetimeMs(kind: TimelineToastKind, hasAction = false): number | null {
    if (kind === "loading") return null;
    const base = kind === "error" ? 6_000 : 4_000;
    return hasAction ? base + 6_000 : base;
}
