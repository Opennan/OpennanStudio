import { useEffect, useRef, type RefObject } from "react";
import {
    useAttributeActions, useEditorStoreApi, useTimelineCommandAdapters, useTimelineController, useTimelineMessages, useTimelineToast, type TimelineHandle,
} from "@opennan/timeline-react";
import { handleEditorKeyDown } from "./editor-keymap";
import type { EditorKeymapContext } from "./keymap-context";

/**
 * Keydown for the editor keymap. It listens on document, so it runs before the timeline's
 * own window listeners (CanvasTimeline scene keys, canvas-timeline.tsx:2827-2941; NleTimeline
 * zoom keys) every time, instead of in the order of the last re-registration as the source's
 * window listener did (editor-layout.tsx:3837-3839). See the plan's "Keyboard shortcut parity".
 */
export function useEditorShortcuts(timeline: RefObject<TimelineHandle | null>, options: { enabled?: boolean } = {}): void {
    const store = useEditorStoreApi();
    const ops = useTimelineCommandAdapters();
    const controller = useTimelineController();
    const toast = useTimelineToast();
    const t = useTimelineMessages("timeline");
    const attributes = useAttributeActions();
    const enabled = options.enabled ?? true;
    const context = useRef<EditorKeymapContext | null>(null);
    context.current = {
        store,
        controller,
        ops,
        splitAtPlayhead: (activeTrackOnly) => timeline.current?.splitAtPlayhead({ activeTrackOnly }),
        toast: (message, toastOptions) => {
            toast(message, toastOptions);
        },
        messages: { audioLockedDelete: t("audioLockedDelete") },
        now: () => performance.now(),
        attributes,
    };
    useEffect(() => {
        if (!enabled) return;
        const onKeyDown = (event: KeyboardEvent) => {
            if (context.current) handleEditorKeyDown(event, context.current);
        };
        document.addEventListener("keydown", onKeyDown);
        return () => document.removeEventListener("keydown", onKeyDown);
    }, [enabled]);
}
