import { useCallback, useEffect, useRef, useState } from "react";
import type { TimelineToast } from "@opennan/timeline-core";
import { TOAST_EXIT_MS, markLeaving, removeToast, toastLifetimeMs, upsertToast, type QueuedToast } from "./toast-queue";

export function useToastQueue() {
    const [toasts, setToasts] = useState<QueuedToast[]>([]);
    const counter = useRef(0);
    const timers = useRef(new Map<string, number>());

    const dismiss = useCallback((id: string) => {
        window.clearTimeout(timers.current.get(id));
        // Exit animation first (skipped under prefers-reduced-motion by CSS; the delay is harmless).
        setToasts((list) => markLeaving(list, id));
        timers.current.set(id, window.setTimeout(() => {
            timers.current.delete(id);
            setToasts((list) => removeToast(list, id));
        }, TOAST_EXIT_MS));
    }, []);

    const push = useCallback((toast: TimelineToast): string => {
        const id = toast.id ?? `toast-${++counter.current}`;
        setToasts((list) => upsertToast(list, { ...toast, id, leaving: false }));
        window.clearTimeout(timers.current.get(id));
        const lifetime = toastLifetimeMs(toast.kind, Boolean(toast.action));
        if (lifetime !== null) timers.current.set(id, window.setTimeout(() => dismiss(id), lifetime));
        return id;
    }, [dismiss]);

    useEffect(() => {
        const pending = timers.current;
        return () => {
            for (const timer of pending.values()) window.clearTimeout(timer);
        };
    }, []);

    return { toasts, push, dismiss };
}
