import { test } from "node:test";
import assert from "node:assert/strict";
import { stripSourceTextTests } from "./strip-source-text-tests.mjs";

const input = [
    'import { readFileSync } from "node:fs";',
    'import { resolve } from "node:path";',
    "function source() {",
    '  return readFileSync(resolve(__dirname, "x.tsx"), "utf8");',
    "}",
    "",
    'describe("a", () => {',
    '  it("pure", () => {',
    "    expect(1).toBe(1);",
    "  });",
    "",
    '  it("source", () => {',
    '    expect(source()).toContain("x");',
    "  });",
    "});",
    "",
    'describe("only source", () => {',
    '  it("s", () => {',
    "    expect(source()).toContain(\"y\");",
    "  });",
    "});",
].join("\n");

test("removes reader-based tests, their helpers, empty suites, and unused fs imports", () => {
    const { code, removed, kept } = stripSourceTextTests(input, { readers: ["source("], helpers: ["source"] });
    assert.equal(removed, 2);
    assert.equal(kept, 1);
    assert.equal(code, ['describe("a", () => {', '  it("pure", () => {', "    expect(1).toBe(1);", "  });", "", "});", ""].join("\n"));
});
