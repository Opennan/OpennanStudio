// Copy attributes / Paste attributes (phase 10c, not a source branch): ⌥⌘C copies the selected clip's or scene's
// attributes, ⌥⌘V opens the picker for the selection (Ctrl+Alt on other platforms), as in CapCut. The same keys
// were the source's copy-marker-range and overwrite-paste, which keep working when these do not apply: ⌥⌘C with
// nothing selected, ⌥⌘V with no copied attributes or nothing selected. So these run first and fall through.
// `code` is matched because Option changes `key` on macOS (⌥C types "ç").
import { selectionAttributeItem, selectionAttributeTargets } from "@opennan/timeline-react";
import { is, mod, type ShortcutRule } from "./keymap-context";

const attributeKey = (event: KeyboardEvent, letter: "c" | "v"): boolean => (
    mod(event) && event.altKey && !event.shiftKey && (event.code === `Key${letter.toUpperCase()}` || is(event, letter, letter.toUpperCase()))
);

export const ATTRIBUTE_RULES: readonly ShortcutRule[] = [
    {
        id: "copy-attributes",
        source: "phase 10c: copy attributes, else copy-marker-range",
        when: (e) => attributeKey(e, "c"),
        run: (r) => {
            if (!selectionAttributeItem(r.store)) return false;
            r.event.preventDefault();
            r.ctx.attributes.copy();
            return true;
        },
    },
    {
        id: "paste-attributes",
        source: "phase 10c: paste attributes, else overwrite-paste",
        when: (e) => attributeKey(e, "v"),
        run: (r) => {
            if (!r.store.attributeClipboard || selectionAttributeTargets(r.store).length === 0) return false;
            r.event.preventDefault();
            r.ctx.attributes.openPaste();
            return true;
        },
    },
];
