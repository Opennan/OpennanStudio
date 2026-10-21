import { EDITOR_SHORTCUT_RULES } from "./editor-keymap";
import { createKeymapHarness, textClip } from "./keymap-test-harness";

/** The rules ported from the source handler (later additions name no editor-layout.tsx lines). */
const PORTED = EDITOR_SHORTCUT_RULES.filter((rule) => rule.source.startsWith("editor-layout.tsx"));

function sourceStart(rule: { source: string }): number {
    return Number(/:(\d+)-\d+$/.exec(rule.source)?.[1]);
}

const C = { ctrlKey: true };
const M = { metaKey: true };
const A = { altKey: true };
const S = { shiftKey: true };

/** One representative key per rule, from the branch's `if` condition, in source order. */
const ROUTES: Array<[string, KeyboardEventInit & { key: string }]> = [
    // editor-layout.tsx:1743-1857, rules-history-split
    ["escape", { key: "Escape" }],
    ["undo-5", { key: "z", ...C, ...A }],
    ["redo-5", { key: "z", ...C, ...A, ...S }],
    ["undo", { key: "z", ...M }],
    ["redo", { key: "Z", ...M, ...S }],
    ["redo-y", { key: "y", ...C }],
    ["split-selection-at-nearest-marker", { key: "B", ...C, ...S }],
    ["split-all-tracks-at-playhead", { key: "B", ...C, ...A, ...S }],
    ["split-at-playhead", { key: "b", ...M }],
    ["split-marker-range-boundaries", { key: "S", ...C, ...A, ...S }],
    // editor-layout.tsx:1859-2104, rules-marker-range
    ["fit-selection-to-marker-range", { key: "F", ...M, ...A, ...S }],
    ["trim-selection-to-marker-range", { key: "T", ...C, ...A, ...S }],
    ["overwrite-duplicate-marker-range", { key: "O", ...C, ...A, ...S }],
    ["insert-duplicate-marker-range", { key: "D", ...C, ...A, ...S }],
    ["insert-duplicate-selection", { key: "D", ...C, ...S }],
    ["duplicate-marker-range", { key: "d", ...C, ...A }],
    ["duplicate-selection", { key: "d", ...C }],
    ["copy-marker-range", { key: "c", ...C, ...A }],
    ["lift-marker-range-to-clipboard", { key: "L", ...C, ...A, ...S }],
    ["extract-marker-range-to-clipboard", { key: "C", ...C, ...A, ...S }],
    // editor-layout.tsx:2106-2223, rules-clipboard
    ["copy-selection", { key: "c", ...C }],
    ["extract-marker-range", { key: "X", ...C, ...A, ...S }],
    ["lift-marker-range", { key: "x", ...C, ...A }],
    ["cut-selection", { key: "x", ...M }],
    ["detach-audio", { key: "E", ...C, ...S }],
    // editor-layout.tsx:2225-2509, rules-paste
    ["replace-marker-range-paste", { key: "R", ...C, ...A, ...S }],
    ["insert-paste-at-marker-in", { key: "Y", ...C, ...A, ...S }],
    ["insert-paste-at-marker-out", { key: "N", ...C, ...A, ...S }],
    ["overwrite-paste-at-marker-in", { key: "U", ...C, ...A, ...S }],
    ["overwrite-paste-at-marker-out", { key: "J", ...C, ...A, ...S }],
    ["replace-selection-paste", { key: "V", ...C, ...A, ...S }],
    ["insert-paste", { key: "V", ...C, ...S }],
    ["overwrite-paste", { key: "v", ...C, ...A }],
    ["paste", { key: "v", ...C }],
    // editor-layout.tsx:2511-2639, rules-markers-gaps
    ["in-out-marker", { key: "i" }],
    ["close-marker-range-gap", { key: "i", ...C, ...A }],
    ["close-marker-out-gap", { key: "h", ...C, ...A }],
    ["close-every-track-gap-at-playhead", { key: "Delete", ...C, ...A }],
    ["close-shared-gap-at-playhead", { key: "Delete", ...C, ...A, ...S }],
    ["close-active-track-gap-at-playhead", { key: "Backspace", ...M, ...S }],
    ["close-every-gap", { key: "P", ...C, ...A, ...S }],
    ["close-active-track-gaps", { key: "p", ...C, ...A }],
    // editor-layout.tsx:2641-2905, rules-delete-select
    ["delete", { key: "Delete" }],
    ["invert-selection", { key: "A", ...C, ...S }],
    ["select-to-playhead", { key: "D", ...A, ...S }],
    ["select-all", { key: "a", ...M }],
    ["insert-marker-range-gap", { key: "I", ...C, ...A, ...S }],
    ["insert-marker-out-gap", { key: "H", ...C, ...A, ...S }],
    ["insert-global-gap", { key: "G", ...C, ...A, ...S }],
    ["insert-active-track-gap", { key: "G", ...C, ...S }],
    // editor-layout.tsx:2908-3009, rules-tools
    ["zoom", { key: "=" }],
    ["zoom-mod", { key: "-", ...C }],
    ["tab-select", { key: "Tab" }],
    ["blade-tool", { key: "b" }],
    ["select-tool", { key: "v" }],
    ["hand-tool", { key: "h" }],
    ["snap", { key: "s" }],
    ["select-at-playhead", { key: "d" }],
    ["add-text", { key: "t" }],
    ["add-caption", { key: "T", ...S }],
    ["add-subtitle", { key: "t", ...A }],
    // editor-layout.tsx:3011-3157, rules-trims-properties
    ["trim-to-playhead", { key: "w" }],
    ["remove-marker-near-playhead", { key: "M", ...S }],
    ["clear-markers", { key: "M", ...C, ...A, ...S }],
    ["select-marker-range", { key: "M", ...C, ...S }],
    ["toggle-mute", { key: "m", ...C }],
    ["reset-volume", { key: "m", ...C, ...A }],
    ["toggle-lock", { key: "l", ...C }],
    ["reset-trim", { key: "t", ...C, ...A }],
    ["toggle-visibility", { key: "H", ...C, ...S }],
    // editor-layout.tsx:3159-3240, rules-transform-markers
    ["flip-or-rotate", { key: "R", ...A, ...S }],
    ["reset-transform", { key: "r", ...C, ...A }],
    ["selected-range-markers", { key: "M", ...A, ...S }],
    ["selected-boundary-markers", { key: "m", ...A }],
    ["toggle-marker", { key: "m" }],
    // editor-layout.tsx:3242-3411, rules-select-jump
    ["trim-selection-to-nearest-marker", { key: "[", ...C, ...A, ...S }],
    ["align-selection-to-nearest-marker", { key: "]", ...C, ...A }],
    ["select-track-range", { key: "[", ...A, ...S }],
    ["select-track", { key: "A", ...A, ...S }],
    ["select-linked", { key: "L", ...C, ...S }],
    ["select-type", { key: "T", ...A, ...S }],
    ["select-range", { key: "]", ...S }],
    ["jump-marker", { key: "[" }],
    ["jump-selection-boundary", { key: "Home", ...C, ...A }],
    ["jump-start-end", { key: "End" }],
    ["play-pause", { key: " " }],
    // editor-layout.tsx:3413-3545, rules-presets
    ["clip-volume-preset", { key: "6", ...A, ...S }],
    ["speed-ramp-preset", { key: "2", ...A, ...S }],
    ["playback-speed-preset", { key: "3", ...A }],
    ["toggle-freeze-frame", { key: "f", ...A }],
    ["toggle-reverse", { key: "r", ...A }],
    ["trim-to-nearest-edit-point", { key: ",", ...C, ...A, ...S }],
    ["jump-keyframe", { key: ".", ...A }],
    // editor-layout.tsx:3547-3647, rules-playback
    ["frame-back", { key: "," }],
    ["frame-forward", { key: "." }],
    ["shuttle-reverse", { key: "j" }],
    ["split-all-at-nearest-marker", { key: "K", ...C, ...A, ...S }],
    ["keyframe", { key: "k", ...A }],
    ["shuttle-stop", { key: "k" }],
    ["shuttle-forward", { key: "l" }],
    // editor-layout.tsx:3649-3834, rules-arrows
    ["slide", { key: "ArrowLeft", ...C, ...A, ...S }],
    ["roll", { key: "ArrowRight", ...C, ...S }],
    ["slip", { key: "ArrowLeft", ...C, ...A }],
    ["nudge", { key: "ArrowRight", ...A }],
    ["move-to-outer-track", { key: "ArrowUp", ...A, ...S }],
    ["move-track", { key: "ArrowDown", ...A }],
    ["jump-edit-point", { key: "ArrowUp" }],
    ["scene-or-second-step", { key: "ArrowRight" }],
];

describe("editor keymap", () => {
    it("ports every branch of the source handler once, in source order", () => {
        const starts = PORTED.map(sourceStart);
        expect(starts.every((line) => line >= 1743 && line <= 3834)).toBe(true);
        expect([...starts].sort((a, b) => a - b)).toEqual(starts);
        expect(new Set(EDITOR_SHORTCUT_RULES.map((rule) => rule.id)).size).toBe(EDITOR_SHORTCUT_RULES.length);
        // editor-layout.tsx:1743-3834 has 108 top-level `if` branches.
        expect(PORTED).toHaveLength(108);
        // Rules added after the port run first and fall through when they do not apply (rules-attributes.test.ts).
        expect(EDITOR_SHORTCUT_RULES.slice(0, EDITOR_SHORTCUT_RULES.length - PORTED.length).map((rule) => rule.id)).toEqual([
            "copy-attributes", "paste-attributes", "delete-items", "copy-items", "paste-items", "duplicate-items", "select-all-items",
        ]);
    });

    it("routes each rule's representative key to that rule and no earlier one", () => {
        expect(ROUTES.map(([id]) => id)).toEqual(PORTED.map((rule) => rule.id));
        for (const [id, init] of ROUTES) {
            const event = new KeyboardEvent("keydown", init);
            expect(PORTED.find((rule) => rule.when(event))?.id, `${id}: ${JSON.stringify(init)}`).toBe(id);
        }
    });

    it("lets the documented fall-throughs reach no rule that handles the key", async () => {
        // Nothing selected, an empty clipboard, no markers: copy (:2106-2114), duplicate (:2018-2033), paste (:2490-2509),
        // trim to playhead (:3011-3039), jump to marker (:3361-3374), roll (:3669-3688), and nudge (:3711-3730) return without handling.
        const h = await createKeymapHarness(EDITOR_SHORTCUT_RULES, { clips: [textClip("a", 2, 4)] });
        for (const init of [
            { key: "c", ...C }, { key: "d", ...M }, { key: "v", ...C }, { key: "w" }, { key: "[" },
            { key: "ArrowRight", ...C, ...S }, { key: "ArrowRight", ...A },
        ]) {
            expect(h.press(init).defaultPrevented, JSON.stringify(init)).toBe(false);
        }
        expect(h.clips().map((c) => [c.id, c.startTime, c.endTime])).toEqual([["a", 2, 4]]);
    });

    it("ignores keys aimed at fields, buttons, and text boxes", async () => {
        const h = await createKeymapHarness(EDITOR_SHORTCUT_RULES);
        for (const tag of ["input", "textarea", "select", "button"]) {
            h.press({ key: "t" }, document.createElement(tag));
        }
        const box = document.createElement("div");
        box.setAttribute("role", "textbox");
        const inner = document.createElement("span");
        box.appendChild(inner);
        h.press({ key: "t" }, inner);
        expect(h.store.getState().addTextRequest).toBeNull();
        h.press({ key: "t" }, document.body);
        expect(h.store.getState().addTextRequest).toEqual({ id: 42, preset: "text" });
    });

    it("lets the browser copy selected page text", async () => {
        const h = await createKeymapHarness(EDITOR_SHORTCUT_RULES, { clips: [textClip("a", 0, 2)] });
        h.store.getState().setSelectedClipIds(new Set(["a"]));
        const paragraph = document.createElement("p");
        paragraph.textContent = "Some page text";
        document.body.appendChild(paragraph);
        window.getSelection()?.selectAllChildren(paragraph);
        expect(h.press({ key: "c", ctrlKey: true }).defaultPrevented).toBe(false);
        expect(h.store.getState().timelineClipboard).toBeNull();
        window.getSelection()?.removeAllRanges();
        paragraph.remove();
        expect(h.press({ key: "c", ctrlKey: true }).defaultPrevented).toBe(true);
    });

    it("routes keys across groups: modified keys win over the bare ones", async () => {
        const h = await createKeymapHarness(EDITOR_SHORTCUT_RULES, { clips: [textClip("a", 0, 4)] });
        h.press({ key: "b", ctrlKey: true });
        expect(h.splitCalls).toEqual([false]);
        expect(h.store.getState().toolMode).toBe("select");
        h.press({ key: "b" });
        expect(h.store.getState().toolMode).toBe("blade");
        h.store.getState().setSelectedClipIds(new Set(["a"]));
        h.press({ key: "d", metaKey: true });
        await vi.waitFor(() => expect([...h.store.getState().selectedClipIds]).toEqual(["srv-1"]));
        expect(h.clips()).toHaveLength(2);
        h.press({ key: "z", metaKey: true });
        await vi.waitFor(() => expect(h.clips()).toHaveLength(1));
    });
});
