"use client";
// The playhead for keyframe rows (phase 10b): only the rows that need it subscribe, and they re-render at
// most every `intervalMs` while the playhead moves (a leading update, so a seek shows at once, and a
// trailing one, so the last position always lands). The rest of the inspector never sees playback ticks.
import { useEffect, useState } from "react";
import { useEditorStoreApi } from "../../hooks/use-editor-store";

export const PLAYHEAD_THROTTLE_MS = 80;

export function usePlayhead(enabled = true, intervalMs = PLAYHEAD_THROTTLE_MS): number {
    const api = useEditorStoreApi();
    const [time, setTime] = useState(() => api.getState().currentTime);
    useEffect(() => {
        if (!enabled) return;
        let latest = api.getState().currentTime;
        let last = 0;
        let timer: ReturnType<typeof setTimeout> | null = null;
        setTime(latest);
        const unsubscribe = api.subscribe((state) => {
            const next = state.currentTime;
            if (next === latest) return;
            latest = next;
            const now = Date.now();
            if (now - last >= intervalMs) {
                last = now;
                setTime(next);
            } else if (timer === null) {
                timer = setTimeout(() => {
                    timer = null;
                    last = Date.now();
                    setTime(latest);
                }, intervalMs - (now - last));
            }
        });
        return () => {
            unsubscribe();
            if (timer !== null) clearTimeout(timer);
        };
    }, [api, enabled, intervalMs]);
    return enabled ? time : api.getState().currentTime;
}
