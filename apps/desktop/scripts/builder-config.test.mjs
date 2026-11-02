import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const CONFIG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "electron-builder.config.cjs");

const AZURE_KEYS = ["AZURE_TENANT_ID", "AZURE_CLIENT_ID", "AZURE_CLIENT_SECRET", "AZURE_SIGNING_ENDPOINT", "AZURE_SIGNING_ACCOUNT", "AZURE_SIGNING_PROFILE", "AZURE_SIGNING_PUBLISHER"];

function load(env, platform = process.platform) {
    const saved = { ...process.env };
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: platform });
    Object.assign(process.env, env);
    for (const key of ["CSC_LINK", "CSC_NAME", "WIN_CSC_LINK", "OPENNAN_RELEASE_UPDATES", "APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID", "OPENNAN_WINDOWS_SIGNING", ...AZURE_KEYS]) if (!(key in env)) delete process.env[key];
    delete require.cache[CONFIG];
    try {
        return require(CONFIG);
    } finally {
        process.env = saved;
        Object.defineProperty(process, "platform", platformDescriptor);
    }
}

test("release builds fail closed without signing and notarization", () => {
    assert.throws(() => load({ OPENNAN_RELEASE_UPDATES: "true" }), /signing credentials/);
    const env = { OPENNAN_RELEASE_UPDATES: "true", CSC_LINK: "cert.p12", APPLE_ID: "test@example.com", APPLE_APP_SPECIFIC_PASSWORD: "test", APPLE_TEAM_ID: "TEST" };
    if (process.platform === "linux") assert.throws(() => load(env), /signing credentials/);
    else assert.equal(load(env).extraMetadata.opennanUpdates, true);
    if (process.platform === "darwin") assert.throws(() => load({ OPENNAN_RELEASE_UPDATES: "true", CSC_LINK: "cert.p12" }), /notarization/);
    assert.equal(load({ CSC_LINK: "cert.p12" }).extraMetadata.opennanUpdates, false);
});

const azureEnv = {
    OPENNAN_RELEASE_UPDATES: "true", OPENNAN_WINDOWS_SIGNING: "azure",
    AZURE_TENANT_ID: "test-tenant", AZURE_CLIENT_ID: "test-client", AZURE_CLIENT_SECRET: "test-secret",
    AZURE_SIGNING_ENDPOINT: "https://eus.codesigning.azure.net/", AZURE_SIGNING_ACCOUNT: "test-studio",
    AZURE_SIGNING_PROFILE: "public-release", AZURE_SIGNING_PUBLISHER: "Example Company, Inc.",
};

test("Azure signs Windows without a certificate file and pins the verified publisher for updates", () => {
    const config = load(azureEnv, "win32");
    assert.equal(config.forceCodeSigning, true);
    assert.equal(config.extraMetadata.opennanUpdates, true);
    assert.equal(config.win.verifyUpdateCodeSignature, true);
    assert.equal(config.win.azureSignOptions.publisherName, azureEnv.AZURE_SIGNING_PUBLISHER);
    assert.equal(config.win.azureSignOptions.codeSigningAccountName, azureEnv.AZURE_SIGNING_ACCOUNT);
    assert.equal(config.win.azureSignOptions.certificateProfileName, azureEnv.AZURE_SIGNING_PROFILE);
    assert.ok(!JSON.stringify(config).includes(azureEnv.AZURE_CLIENT_SECRET));
});

test("incomplete Azure setup cannot fall back to another signer or unsigned output", () => {
    for (const key of AZURE_KEYS) {
        assert.throws(() => load({ ...azureEnv, [key]: "", CSC_LINK: "another.p12" }, "win32"), new RegExp(key));
    }
    assert.throws(() => load({ ...azureEnv, AZURE_SIGNING_ENDPOINT: "https://example.com" }, "win32"), /Microsoft signing endpoint/);
    assert.throws(() => load({ ...azureEnv, OPENNAN_WINDOWS_SIGNING: "typo" }, "win32"), /Unknown Windows/);
});

test("Azure credentials do not count as an Apple signing identity", () => {
    assert.throws(() => load(azureEnv, "darwin"), /signing credentials/);
    assert.equal(load({ ...azureEnv, CSC_LINK: "apple.p12", APPLE_ID: "test@example.com", APPLE_APP_SPECIFIC_PASSWORD: "test", APPLE_TEAM_ID: "TEST" }, "darwin").win.azureSignOptions, undefined);
});

test("updates use an architecture-specific R2 feed and keep signature verification", () => {
    const config = load({});
    assert.equal(config.publish[0].url, `https://cdn.opennan.com/programs/studio/${process.platform}-${process.arch}/`);
    assert.equal(config.win.verifyUpdateCodeSignature, true);
    assert.match(config.mac.artifactName, /darwin/);
    assert.match(config.win.artifactName, /win32/);
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
