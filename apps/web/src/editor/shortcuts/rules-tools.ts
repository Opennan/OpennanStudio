// editor-layout.tsx:2908-3009: zoom, Tab, tools, snap, select at playhead, and text requests.
import { editing } from "@opennan/timeline-core";
import { is, mod, plain, replaceSelection, type ShortcutRule } from "./keymap-context";

export const TOOL_RULES: readonly ShortcutRule[] = [
    {
        id: "zoom",
        source: "editor-layout.tsx:2908-2913",
        when: (e) => plain(e) && is(e, "+", "=", "-"),
        run: (r) => {
            r.event.preventDefault();
            r.store.setTimelineZoom(editing.getNextTimelineZoom(r.store.timelineZoom, r.event.key === "-" ? -1 : 1));
            return true;
        },
    },
    {
        id: "zoom-mod",
        source: "editor-layout.tsx:2915-2920",
        when: (e) => mod(e) && is(e, "+", "=", "-"),
        run: (r) => {
            r.event.preventDefault();
            r.store.setTimelineZoom(editing.getNextTimelineZoom(r.store.timelineZoom, r.event.key === "-" ? -1 : 1));
            return true;
        },
    },
    {
        id: "tab-select",
        source: "editor-layout.tsx:2922-2939",
        when: (e) => e.key === "Tab" && !mod(e),
        run: (r) => {
            r.event.preventDefault();
            const adjacent = r.event.altKey ? editing.getAdjacentTimelineTrackClipSelectionId : editing.getAdjacentTimelineClipSelectionId;
            const target = adjacent(r.clips, r.tracks, r.store.selectedClipIds, r.clipId, r.store.currentTime, r.event.shiftKey ? -1 : 1);
            if (target) {
                r.store.setSelectedClipId(target);
                r.store.setSelectedClipIds(new Set([target]));
            }
            return true;
        },
    },
    {
        id: "blade-tool",
        source: "editor-layout.tsx:2941-2946",
        when: (e) => is(e, "b", "B") && plain(e),
        run: (r) => {
            r.event.preventDefault();
            r.store.setToolMode(r.store.toolMode === "blade" ? "select" : "blade");
            return true;
        },
    },
    {
        id: "select-tool",
        source: "editor-layout.tsx:2948-2953",
        when: (e) => is(e, "v", "V") && plain(e),
        run: (r) => {
            r.event.preventDefault();
            r.store.setToolMode("select");
            return true;
        },
    },
    {
        id: "hand-tool",
        source: "editor-layout.tsx:2955-2960",
        when: (e) => is(e, "h", "H") && plain(e),
        run: (r) => {
            r.event.preventDefault();
            r.store.setToolMode(r.store.toolMode === "hand" ? "select" : "hand");
            return true;
        },
    },
    {
        id: "snap",
        source: "editor-layout.tsx:2962-2967",
        when: (e) => is(e, "s", "S") && plain(e),
        run: (r) => {
            r.event.preventDefault();
            r.store.setSnapEnabled(editing.getToggledTimelineSnap(r.store.snapEnabled));
            return true;
        },
    },
    {
        id: "select-at-playhead",
        source: "editor-layout.tsx:2969-2988",
        when: (e) => is(e, "d", "D") && !mod(e) && !e.altKey,
        run: (r) => {
            r.event.preventDefault();
            replaceSelection(r, r.event.shiftKey
                ? editing.getTimelineTrackClipSelectionAtPlayhead(r.clips, r.tracks, r.store.selectedClipIds, r.clipId, r.store.currentTime)
                : editing.getTimelineClipSelectionAtPlayhead(r.clips, r.tracks, r.store.currentTime));
            return true;
        },
    },
    {
        id: "add-text",
        source: "editor-layout.tsx:2990-2995",
        when: (e) => is(e, "t", "T") && plain(e),
        run: (r) => {
            r.event.preventDefault();
            r.store.setAddTextRequest({ id: r.ctx.now(), preset: "text" });
            return true;
        },
    },
    {
        id: "add-caption",
        source: "editor-layout.tsx:2997-3002",
        when: (e) => is(e, "t", "T") && e.shiftKey && !mod(e) && !e.altKey,
        run: (r) => {
            r.event.preventDefault();
            r.store.setAddTextRequest({ id: r.ctx.now(), preset: "caption" });
            return true;
        },
    },
    {
        id: "add-subtitle",
        source: "editor-layout.tsx:3004-3009",
        when: (e) => is(e, "t", "T") && e.altKey && !e.shiftKey && !mod(e),
        run: (r) => {
            r.event.preventDefault();
            r.store.setAddTextRequest({ id: r.ctx.now(), preset: "subtitle" });
            return true;
        },
    },
];
