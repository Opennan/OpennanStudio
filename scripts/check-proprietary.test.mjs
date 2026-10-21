import { test } from "node:test";
import assert from "node:assert/strict";
import { checkFile } from "./check-proprietary.mjs";

test("flags denylisted path segments", () => {
    assert.ok(checkFile("packages/x/src/ai/agents/cinematographer.ts", "").length > 0);
    assert.ok(checkFile("packages/x/src/storyboard_prompt.ts", "").length > 0);
    assert.ok(checkFile("RESEARCH_KB.md", "").length > 0);
});

test("flags long LLM-instruction strings", () => {
    const text = `const p = "You are an expert cinematographer. ${"Describe each shot carefully. ".repeat(10)}";`;
    assert.ok(checkFile("packages/x/src/a.ts", text).length > 0);
});

test("passes normal timeline code", () => {
    assert.deepEqual(checkFile("packages/timeline-core/src/lib/shot-utils.ts", "export const a = 1;"), []);
});

test("flags private source citations in shipped code only", () => {
    assert.ok(checkFile("packages/export/src/filters/video.ts", "/** assembler.py:1336-1343 */").length > 0);
    assert.ok(checkFile("apps/web/src/a.ts", "// see backend/app/ai/media").length > 0);
    assert.deepEqual(checkFile("docs/plans/phase-4.md", "ASM = backend/app/ai/media/assembler.py"), []);
});

test("flags private server module names in shipped code only", () => {
    assert.ok(checkFile("packages/provider-opennan/src/tasks.ts", "/** stage lists (director_catalog) */").length > 0);
    assert.ok(checkFile("packages/timeline-core/src/ai/tools.ts", "/** Server limits (backend public_api contracts). */").length > 0);
    assert.ok(checkFile("packages/provider-opennan/src/testing.ts", "// the server's device_auth.STUDIO_SCOPES").length > 0);
    assert.ok(checkFile("packages/provider-opennan/src/testing.ts", "// the server's tasks.PUBLIC_ERRORS").length > 0);
    assert.deepEqual(checkFile("docs/plans/phase-11.md", "director_catalog stages, public_api routes"), []);
    assert.ok(checkFile("packages/director-client/src/a.ts", "// mirrors director_turns.turn_view").length > 0);
});

test("the AI director's public contract names are not private (phase 9b)", () => {
    assert.deepEqual(checkFile("packages/director-client/src/a.ts", `{ object: "director_turn" } // 503 director_unavailable`), []);
    assert.ok(checkFile("packages/director-client/src/a.ts", "// director_turns.py").length > 0);
});
