// Window keydown bindings scoped to one editor instance. Replaces the global
// listener at nle-timeline.tsx:3196-3217, which acted for every editor on a page.
import { useEffect, useRef, type RefObject } from "react";

export interface TimelineShortcut {
    match(event: KeyboardEvent): boolean;
    run(): void;
}

export function useTimelineShortcuts(
    shortcuts: TimelineShortcut[],
    options: { enabled?: boolean; rootRef?: RefObject<HTMLElement | null> } = {},
): void {
    const latest = useRef(shortcuts);
    latest.current = shortcuts;
    const { enabled = true, rootRef } = options;
    useEffect(() => {
        if (!enabled) return;
        const onKeyDown = (event: KeyboardEvent) => {
            const target = event.target as HTMLElement | null;
            // Same editable-target guard as the source (nle-timeline.tsx:3198-3199).
            if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
            const owner = target?.closest?.(".opennan-studio") ?? null;
            const mine = rootRef?.current?.closest(".opennan-studio") ?? null;
            if (owner && mine && owner !== mine) return;
            for (const shortcut of latest.current) {
                if (shortcut.match(event)) {
                    event.preventDefault();
                    shortcut.run();
                    return;
                }
            }
        };
        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    }, [enabled, rootRef]);
}
