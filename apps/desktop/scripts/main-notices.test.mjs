import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { bundledModules, runtimeClosure, separateComponentsNotice } from "./main-notices.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("resolves metafile inputs against the build folder", () => {
    assert.deepEqual(bundledModules({ inputs: { "../../node_modules/.pnpm/zod@4/node_modules/zod/index.js": {}, "src/main/index.ts": {} } }, "/r/apps/desktop"),
        [path.resolve("/r/node_modules/.pnpm/zod@4/node_modules/zod/index.js"), path.resolve("/r/apps/desktop/src/main/index.ts")]);
});

test("follows the runtime dependency closure", () => {
    const files = runtimeClosure(["better-sqlite3"], ROOT).map((file) => path.basename(path.dirname(file)));
    assert.ok(files.includes("better-sqlite3"));
    assert.ok(files.includes("bindings"));
});

test("lists ffmpeg, whisper.cpp, and the whisper models with their licenses", () => {
    const text = separateComponentsNotice({ ffmpegVersion: "7.1.5", whisperVersion: "1.9.5" });
    assert.match(text, /FFmpeg 7\.1\.5 {2}LGPL/);
    assert.match(text, /whisper\.cpp 1\.9\.5 {2}MIT/);
    assert.match(text, /Whisper models \(tiny, base, small\) {2}MIT/);
    assert.match(text, /not shipped/);
    assert.doesNotMatch(text, /\bGPL\b(?! or non-free)/);
});
