import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { collectNotices, formatNotices, thirdPartyNotices } from "./third-party-notices.mjs";

test("collects the bundled packages with their license texts and skips workspace packages", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "notices-"));
    const nm = path.join(root, "node_modules", ".pnpm", "x@1.0.0", "node_modules");
    const pkg = (dir, manifest, files = {}) => {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(manifest));
        for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
    };
    pkg(path.join(nm, "react"), { name: "react", version: "19.2.3", license: "MIT" }, { LICENSE: "MIT License\nCopyright (c) Meta" });
    pkg(path.join(nm, "@base-ui", "react"), { name: "@base-ui/react", version: "1.2.0", license: "MIT" }, { "LICENSE.md": "MIT base-ui" });
    pkg(path.join(nm, "@opennan", "timeline-core"), { name: "@opennan/timeline-core", version: "0.3.0", license: "SEE LICENSE IN LICENSE" });
    const notices = collectNotices([
        path.join(nm, "react", "cjs", "react.production.js"),
        path.join(nm, "react", "index.js"),
        path.join(nm, "@base-ui", "react", "esm", "index.js"),
        path.join(nm, "@opennan", "timeline-core", "dist", "index.js"),
        "\0vite/preload-helper.js",
        path.join(root, "src", "main.tsx"),
    ]);
    assert.deepEqual(notices.map((p) => `${p.name}@${p.version} ${p.license}`), ["@base-ui/react@1.2.0 MIT", "react@19.2.3 MIT"]);
    const text = formatNotices("Test app", notices);
    assert.ok(text.includes("react 19.2.3 (MIT)\n" + "-".repeat(80) + "\nMIT License\nCopyright (c) Meta"));
    fs.rmSync(root, { recursive: true });
});

test("the plugin emits the notices, a machine-readable license manifest, and the app's own LICENSE", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "notices-"));
    const nm = path.join(root, "node_modules");
    fs.mkdirSync(path.join(nm, "mediabunny"), { recursive: true });
    fs.writeFileSync(path.join(nm, "mediabunny", "package.json"), JSON.stringify({ name: "mediabunny", version: "1.61.6", license: "MPL-2.0" }));
    fs.writeFileSync(path.join(root, "LICENSE"), "OpenNan Community License");
    const emitted = {};
    const plugin = thirdPartyNotices({ appName: "Test app", licenseFile: path.join(root, "LICENSE") });
    plugin.generateBundle.call(
        { emitFile: (file) => { emitted[file.fileName] = file.source; } },
        {},
        { "index.js": { type: "chunk", moduleIds: [path.join(nm, "mediabunny", "dist", "index.js")] }, "a.css": { type: "asset" } },
    );
    assert.deepEqual(Object.keys(emitted).sort(), ["LICENSE", "THIRD_PARTY_NOTICES.txt", "third-party-licenses.json"]);
    assert.deepEqual(JSON.parse(emitted["third-party-licenses.json"]), [{ name: "mediabunny", version: "1.61.6", license: "MPL-2.0" }]);
    assert.equal(emitted.LICENSE, "OpenNan Community License");
    assert.ok(emitted["THIRD_PARTY_NOTICES.txt"].includes("mediabunny 1.61.6 (MPL-2.0)"));
    fs.rmSync(root, { recursive: true });
});

test("extraEntries (vendored assets such as the Twemoji graphics) go into both outputs, sorted with the packages", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "notices-"));
    const nm = path.join(root, "node_modules");
    fs.mkdirSync(path.join(nm, "zustand"), { recursive: true });
    fs.writeFileSync(path.join(nm, "zustand", "package.json"), JSON.stringify({ name: "zustand", version: "5.0.15", license: "MIT" }));
    const emitted = {};
    const plugin = thirdPartyNotices({
        appName: "Test app",
        extraEntries: [{ name: "twemoji (graphics)", version: "15.1.0", license: "CC-BY-4.0", licenseText: "Attribution 4.0 International\n\n  " }],
    });
    plugin.generateBundle.call(
        { emitFile: (file) => { emitted[file.fileName] = file.source; } },
        {},
        { "index.js": { type: "chunk", moduleIds: [path.join(nm, "zustand", "index.js")] } },
    );
    assert.deepEqual(JSON.parse(emitted["third-party-licenses.json"]), [
        { name: "twemoji (graphics)", version: "15.1.0", license: "CC-BY-4.0" },
        { name: "zustand", version: "5.0.15", license: "MIT" },
    ]);
    const text = emitted["THIRD_PARTY_NOTICES.txt"];
    assert.ok(text.includes(`twemoji (graphics) 15.1.0 (CC-BY-4.0)\n${"-".repeat(80)}\nAttribution 4.0 International\n`));
    assert.ok(text.indexOf("twemoji (graphics)") < text.indexOf("zustand 5.0.15"));
    assert.ok(!("LICENSE" in emitted));
    // An entry without a text says so instead of printing an empty section.
    const bare = formatNotices("Test app", [{ name: "x", version: "1", license: "CC-BY-4.0", texts: [] }]);
    assert.match(bare, /declares: CC-BY-4\.0/);
    fs.rmSync(root, { recursive: true });
});

test("extraEntries are validated", () => {
    assert.throws(() => thirdPartyNotices({ appName: "a", extraEntries: [{ name: "x", version: "1", license: "" }] }), /extraEntries/);
});
