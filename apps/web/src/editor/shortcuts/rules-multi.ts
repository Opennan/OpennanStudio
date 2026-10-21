// Multi-item selection (phase 10c): when the selection holds scenes, Delete, Ctrl/Cmd+C, +V, and +D act on every
// selected clip and scene through one controller command (one undo step); Ctrl/Cmd+A selects every clip and scene.
// Selections without scenes fall through to the clip rules ported from the source handler.
import {
    allEditableItems, clipboardHasScenes, copySelectedItems, deleteSelectedItems, duplicateSelectedItems, isMixedSelection, pasteItems,
} from "@opennan/timeline-react";
import { deleteKey, is, mod, plain, type ShortcutRule } from "./keymap-context";

const modOnly = (event: KeyboardEvent) => mod(event) && !event.altKey && !event.shiftKey;

export const MULTI_ITEM_RULES: readonly ShortcutRule[] = [
    {
        id: "delete-items",
        source: "phase 10c multi-select",
        when: (e) => deleteKey(e) && plain(e),
        run: (r) => {
            if (r.event.defaultPrevented || r.store.selectedMarkerId || r.store.selectedTransition || !isMixedSelection(r.store)) return false;
            r.event.preventDefault();
            void deleteSelectedItems(r.ctx.controller, r.ctx.store);
            return true;
        },
    },
    {
        id: "copy-items",
        source: "phase 10c multi-select",
        when: (e) => is(e, "c", "C") && modOnly(e),
        run: (r) => {
            if (r.store.selectedSceneIds.size === 0) return false;
            const clipboard = copySelectedItems(r.store);
            if (!clipboard) return false;
            r.event.preventDefault();
            r.store.setTimelineClipboard(clipboard);
            return true;
        },
    },
    {
        id: "paste-items",
        source: "phase 10c multi-select",
        when: (e) => is(e, "v", "V") && modOnly(e),
        run: (r) => {
            const clipboard = r.store.timelineClipboard;
            if (!clipboard || !clipboardHasScenes(clipboard)) return false;
            r.event.preventDefault();
            void pasteItems(r.ctx.controller, r.ctx.store, clipboard);
            return true;
        },
    },
    {
        id: "duplicate-items",
        source: "phase 10c multi-select",
        when: (e) => is(e, "d", "D") && modOnly(e),
        run: (r) => {
            if (r.store.selectedSceneIds.size === 0) return false;
            r.event.preventDefault();
            void duplicateSelectedItems(r.ctx.controller, r.ctx.store);
            return true;
        },
    },
    {
        id: "select-all-items",
        source: "phase 10c multi-select",
        when: (e) => is(e, "a", "A") && modOnly(e),
        run: (r) => {
            const all = allEditableItems(r.store);
            // Without scenes the clip rule (select every editable clip) runs.
            if (all.sceneIds.length === 0) return false;
            r.event.preventDefault();
            r.store.setSelection(all);
            return true;
        },
    },
];
