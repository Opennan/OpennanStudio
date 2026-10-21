import { test } from "node:test";
import assert from "node:assert/strict";
import { rewriteImports, findUnresolvedAppImports } from "./rewrite-imports.mjs";

const RULES = {
    "@/hooks/use-timeline": "src/model/timeline.ts",
    "@/stores/editor-store": "src/model/editor.ts",
};

test("rewrites mapped app import to relative path", () => {
    const out = rewriteImports(
        `import type { TimelineClip } from "@/hooks/use-timeline";`,
        "src/timeline/canvas/multi-select.ts",
        RULES,
    );
    assert.equal(out, `import type { TimelineClip } from "../../model/timeline";`);
});

test("rewrites @/lib/<name> to src/lib/<name>", () => {
    const out = rewriteImports(
        `import { x } from "@/lib/shot-utils";`,
        "src/timeline/canvas/hit-detector.ts",
        RULES,
    );
    assert.equal(out, `import { x } from "../../lib/shot-utils";`);
});

test("keeps same-directory prefix ./", () => {
    const out = rewriteImports(
        `import { y } from "@/lib/timeline-editing-properties";`,
        "src/lib/keyframe-interpolation.ts",
        RULES,
    );
    assert.equal(out, `import { y } from "./timeline-editing-properties";`);
});

test("applies file-local relative rules", () => {
    const out = rewriteImports(
        `import { getSceneStart } from "../nle-timeline-utils";`,
        "src/timeline/canvas/transition-markers.ts",
        RULES,
        { "../nle-timeline-utils": "src/timeline/scene-timing.ts" },
    );
    assert.equal(out, `import { getSceneStart } from "../scene-timing";`);
});

test("rewrites vi.mock and dynamic import specifiers", () => {
    const out = rewriteImports(
        `vi.mock("@/lib/shot-utils"); await import("@/lib/shot-utils");`,
        "src/lib/a.ts",
        RULES,
    );
    assert.equal(out, `vi.mock("./shot-utils"); await import("./shot-utils");`);
});

test("findUnresolvedAppImports reports leftover @/ specifiers", () => {
    assert.deepEqual(findUnresolvedAppImports(`import a from "@/lib/firebase";`), ["@/lib/firebase"]);
    assert.deepEqual(findUnresolvedAppImports(`import a from "./ok";`), []);
});
