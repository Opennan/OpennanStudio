import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeOverrides, pickMessages, renderModule } from "./extract-timeline-messages.mjs";

const en = {
    timeline: { undo: "Undo", sceneCount: "{n, plural, one {# scene} other {# scenes}}" },
    modals: { close: "Close", other: "Other" },
};

test("copies full namespaces and picked keys only", () => {
    assert.deepEqual(pickMessages(en, ["timeline"], { modals: ["close"] }), {
        timeline: { undo: "Undo", sceneCount: "{n, plural, one {# scene} other {# scenes}}" },
        modals: { close: "Close" },
    });
});

test("fails loudly on missing namespaces, keys, and nested messages", () => {
    assert.throws(() => pickMessages(en, ["nope"], {}), /missing namespace "nope"/);
    assert.throws(() => pickMessages(en, [], { modals: ["gone"] }), /missing modals\.gone/);
    assert.throws(() => pickMessages({ timeline: { a: { b: "x" } } }, ["timeline"], {}), /timeline\.a is not a string/);
});

test("overrides add and replace keys", () => {
    assert.deepEqual(mergeOverrides({ timeline: { undo: "Undo" } }, { timeline: { redo: "Redo" }, canvasTimeline: { editImage: "Edit image" } }), {
        timeline: { undo: "Undo", redo: "Redo" },
        canvasTimeline: { editImage: "Edit image" },
    });
});

test("renders a typed module", () => {
    const out = renderModule({ timeline: { undo: "Undo" } });
    assert.match(out, /^\/\/ GENERATED/);
    assert.match(out, /export const en = \{\n {4}"timeline": \{\n {8}"undo": "Undo"\n {4}\}\n\} as const;/);
    assert.match(out, /export type TimelineMessages = /);
});
