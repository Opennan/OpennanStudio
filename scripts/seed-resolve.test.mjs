import { test } from "node:test";
import assert from "node:assert/strict";
import { buildIndex, resolveSpecifier, rewriteForSeed, toPackageSpecifier } from "./seed-resolve.mjs";

const index = buildIndex([
    { source: "lib/shot-utils.ts", target: toPackageSpecifier("@opennan/timeline-core", "src/lib/shot-utils.ts") },
    { source: "components/editor/timeline/canvas/timeline-renderer.ts", target: "@opennan/timeline-core/timeline/canvas/timeline-renderer" },
    { source: "components/editor/timeline/canvas/canvas-context-menu.tsx", target: "src/timeline/canvas/canvas-context-menu.tsx" },
]);
const rules = { "@/stores/editor-store": "src/compat/editor-store.ts" };
const FROM = "components/editor/timeline/canvas/canvas-timeline.tsx";
const DEST = "src/timeline/canvas/canvas-timeline.tsx";

test("toPackageSpecifier drops src/ and the extension", () => {
    assert.equal(toPackageSpecifier("@opennan/timeline-core", "src/lib/shot-utils.ts"), "@opennan/timeline-core/lib/shot-utils");
});

test("maps @/ app paths through the index", () => {
    assert.deepEqual(resolveSpecifier("@/lib/shot-utils", FROM, { index, rules }), { target: "@opennan/timeline-core/lib/shot-utils" });
});

test("maps relative paths that now live in another package", () => {
    assert.deepEqual(resolveSpecifier("./timeline-renderer", FROM, { index, rules }), { target: "@opennan/timeline-core/timeline/canvas/timeline-renderer" });
});

test("explicit rules win and keep externals untouched", () => {
    assert.deepEqual(resolveSpecifier("@/stores/editor-store", FROM, { index, rules }), { target: "src/compat/editor-store.ts" });
    assert.deepEqual(resolveSpecifier("react", FROM, { index, rules }), { keep: true });
});

test("applies @/ rules to relative imports of the same file", () => {
    assert.deepEqual(
        resolveSpecifier("../../../stores/editor-store", "components/editor/timeline/x.tsx", { index, rules }),
        { target: "src/compat/editor-store.ts" },
    );
});

test("reports unmapped app paths", () => {
    assert.deepEqual(resolveSpecifier("@/lib/firebase", FROM, { index, rules }), { unresolved: true });
});

test("rewriteForSeed renders package paths relative to the destination", () => {
    const { code, unresolved } = rewriteForSeed(
        [
            `import { a } from "./canvas-context-menu";`,
            `import { useEditorStore } from "@/stores/editor-store";`,
            `import { b } from "./timeline-renderer";`,
            `import { useRef } from "react";`,
            `import { c } from "@/lib/firebase";`,
        ].join("\n"),
        { fromSource: FROM, destFile: DEST, index, rules },
    );
    assert.equal(code, [
        `import { a } from "./canvas-context-menu";`,
        `import { useEditorStore } from "../../compat/editor-store";`,
        `import { b } from "@opennan/timeline-core/timeline/canvas/timeline-renderer";`,
        `import { useRef } from "react";`,
        `import { c } from "@/lib/firebase";`,
    ].join("\n"));
    assert.deepEqual(unresolved, ["@/lib/firebase"]);
});

test("bare rules rewrite only import contexts", () => {
    const { code } = rewriteForSeed(
        `import { toast } from "sonner";\nvi.mock("sonner", () => ({}));\nconst label = "sonner";`,
        { fromSource: FROM, destFile: DEST, index, rules, bareRules: { sonner: "src/compat/sonner.ts" } },
    );
    assert.equal(code, `import { toast } from "../../compat/sonner";\nvi.mock("../../compat/sonner", () => ({}));\nconst label = "sonner";`);
});
