// The editor keymap: every branch of the source editor's keydown handler
// (SRC/app/(dashboard)/video/[projectId]/editor-layout.tsx:1700-3838), in source order.
// Timeline-local keys stay in the packages: Shift/Alt+Z zoom in NleTimeline
// (packages/timeline-react/src/timeline/nle-timeline.tsx:2389-2393) and scene
// copy/paste/delete plus Space-to-pan in CanvasTimeline (canvas-timeline.tsx:2822-2922,3360-3382).
import { dispatchShortcut, type EditorKeymapContext, type ShortcutRule } from "./keymap-context";
import { ATTRIBUTE_RULES } from "./rules-attributes";
import { MULTI_ITEM_RULES } from "./rules-multi";
import { HISTORY_SPLIT_RULES } from "./rules-history-split";
import { MARKER_RANGE_RULES } from "./rules-marker-range";
import { CLIPBOARD_RULES } from "./rules-clipboard";
import { PASTE_RULES } from "./rules-paste";
import { MARKER_GAP_RULES } from "./rules-markers-gaps";
import { DELETE_SELECT_RULES } from "./rules-delete-select";
import { TOOL_RULES } from "./rules-tools";
import { TRIM_PROPERTY_RULES } from "./rules-trims-properties";
import { TRANSFORM_MARKER_RULES } from "./rules-transform-markers";
import { SELECT_JUMP_RULES } from "./rules-select-jump";
import { PRESET_RULES } from "./rules-presets";
import { PLAYBACK_RULES } from "./rules-playback";
import { ARROW_RULES } from "./rules-arrows";

export const EDITOR_SHORTCUT_RULES: readonly ShortcutRule[] = [
    ...ATTRIBUTE_RULES, // phase 10c: ⌥⌘C / ⌥⌘V before the clipboard's Ctrl/Cmd+C / +V
    ...MULTI_ITEM_RULES, // phase 10c: selections with scenes (falls through otherwise)
    ...HISTORY_SPLIT_RULES, // :1743-1857
    ...MARKER_RANGE_RULES, // :1859-2104
    ...CLIPBOARD_RULES, // :2106-2223
    ...PASTE_RULES, // :2225-2509
    ...MARKER_GAP_RULES, // :2511-2639
    ...DELETE_SELECT_RULES, // :2641-2905
    ...TOOL_RULES, // :2908-3009
    ...TRIM_PROPERTY_RULES, // :3011-3157
    ...TRANSFORM_MARKER_RULES, // :3159-3240
    ...SELECT_JUMP_RULES, // :3242-3411
    ...PRESET_RULES, // :3413-3545
    ...PLAYBACK_RULES, // :3547-3647
    ...ARROW_RULES, // :3649-3834
];

export function handleEditorKeyDown(event: KeyboardEvent, ctx: EditorKeymapContext): void {
    dispatchShortcut(EDITOR_SHORTCUT_RULES, event, ctx);
}
