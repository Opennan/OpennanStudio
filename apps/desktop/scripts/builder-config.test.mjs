import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const CONFIG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "electron-builder.config.cjs");

function load(env) {
    const saved = { ...process.env };
    Object.assign(process.env, env);
    for (const key of ["CSC_LINK", "CSC_NAME", "OPENNAN_RELEASE_UPDATES"]) if (!(key in env)) delete process.env[key];
    delete require.cache[CONFIG];
    try {
        return require(CONFIG);
    } finally {
        process.env = saved;
    }
}

test("auto-update is on only for signed release builds", () => {
    assert.equal(load({ OPENNAN_RELEASE_UPDATES: "true" }).extraMetadata.opennanUpdates, false);
    assert.equal(load({ OPENNAN_RELEASE_UPDATES: "true", CSC_LINK: "cert.p12" }).extraMetadata.opennanUpdates, true);
    assert.equal(load({ CSC_LINK: "cert.p12" }).extraMetadata.opennanUpdates, false);
});

test("fuses and unsigned macOS signing", () => {
    const config = load({});
    assert.equal(config.electronFuses.runAsNode, false);
    assert.equal(config.electronFuses.enableNodeCliInspectArguments, false);
    assert.equal(config.mac.identity, "-");
    assert.equal(config.mac.hardenedRuntime, false);
    assert.equal(load({ CSC_LINK: "cert.p12" }).mac.hardenedRuntime, true);
});

test("every platform bundles ffmpeg and whisper.cpp with their notices", () => {
    const config = load({});
    for (const [os, section] of [["darwin", config.mac], ["win32", config.win], ["linux", config.linux]]) {
        const targets = section.extraResources.map((entry) => [entry.from, entry.to]);
        assert.deepEqual(targets, [[`resources/ffmpeg/${os}-\${arch}`, "ffmpeg"], [`resources/whisper/${os}-\${arch}`, "whisper"]], os);
        const whisper = section.extraResources[1];
        for (const file of ["LICENSE.txt", "MODELS-LICENSE.txt", "SOURCE.txt", "checksums.json"]) assert.ok(whisper.filter.includes(file), `${os} ${file}`);
    }
});
