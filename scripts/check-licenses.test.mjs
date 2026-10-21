import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkBuild, checkFfmpegResources, deniedBundled, deniedPackages, findBundledCore, isDeniedLicense, parseLicenseReport, checkWhisperResources } from "./check-licenses.mjs";
import { writeNotices } from "../apps/desktop/whisper/fetch-whisper.mjs";

test("denies GPL and AGPL; allows LGPL, permissive, and dual licenses with a permissive choice", () => {
    for (const denied of ["GPL-2.0-or-later", "AGPL-3.0-only", "GPL-3.0", "(MIT AND GPL-2.0)"]) assert.equal(isDeniedLicense(denied), true, denied);
    for (const allowed of ["MIT", "ISC", "MPL-2.0", "LGPL-2.1-or-later", "(MIT OR GPL-3.0)", "SEE LICENSE IN LICENSE"]) assert.equal(isDeniedLicense(allowed), false, allowed);
    assert.deepEqual(
        deniedPackages({ MIT: [{ name: "react", versions: ["19.2.3"] }], "GPL-2.0-or-later": [{ name: "@ffmpeg/core", versions: ["0.12.10"] }] }),
        ["@ffmpeg/core@0.12.10 (GPL-2.0-or-later)"],
    );
});

test("finds an ffmpeg core in a build by file name or content, not by a URL that names it", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "licenses-"));
    fs.mkdirSync(path.join(dir, "assets"));
    fs.writeFileSync(path.join(dir, "assets", "index-abc.js"), "const url = `${base}/ffmpeg-core.js`; self.createFFmpegCore = 1;");
    assert.deepEqual(findBundledCore(dir), []);
    fs.writeFileSync(path.join(dir, "assets", "chunk.js"), "var createFFmpegCore = (() => {");
    fs.writeFileSync(path.join(dir, "assets", "x.wasm"), "");
    assert.deepEqual(findBundledCore(dir).sort(), [
        "assets/chunk.js: contains the ffmpeg core (\"var createFFmpegCore = (() =>\")",
        "assets/x.wasm: ffmpeg core file in the build",
    ]);
    fs.rmSync(dir, { recursive: true });
});

test("finds the x264 banner of an inlined or renamed core in a file that is not .wasm", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "licenses-"));
    fs.writeFileSync(path.join(dir, "blob.bin"), "\0\0x264 - core 164 r3108\0");
    assert.deepEqual(findBundledCore(dir), ["blob.bin: contains the ffmpeg core (\"x264 - core \")"]);
    fs.rmSync(dir, { recursive: true });
});

test("denies a GPL package that reached the bundle, whatever the dependency tree says", () => {
    assert.deepEqual(
        deniedBundled([
            { name: "mediabunny", version: "1.61.6", license: "MPL-2.0" },
            { name: "gpl-peer", version: "2.0.0", license: "GPL-3.0-only" },
        ]),
        ["gpl-peer@2.0.0 (GPL-3.0-only)"],
    );
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "licenses-"));
    assert.deepEqual(checkBuild(dir), ["third-party-licenses.json is missing: the build did not record its bundled licenses"]);
    fs.writeFileSync(path.join(dir, "third-party-licenses.json"), JSON.stringify([{ name: "gpl-peer", version: "2.0.0", license: "GPL-3.0-only" }]));
    assert.deepEqual(checkBuild(dir), ["GPL in the bundle: gpl-peer@2.0.0 (GPL-3.0-only)"]);
    fs.writeFileSync(path.join(dir, "third-party-licenses.json"), "[]");
    assert.deepEqual(checkBuild(dir), ["third-party-licenses.json lists no packages"]);
    fs.writeFileSync(path.join(dir, "third-party-licenses.json"), JSON.stringify([{ name: "react", version: "19.2.3", license: "MIT" }]));
    assert.deepEqual(checkBuild(dir), []);
    fs.rmSync(dir, { recursive: true });
    assert.deepEqual(checkBuild(dir), ["the build is missing: run pnpm build first"]);
});

test("a license report that is not JSON or lists no packages fails instead of passing", () => {
    assert.throws(() => parseLicenseReport("WARN something\n{}"), /not JSON/);
    assert.throws(() => parseLicenseReport("{}"), /no packages/);
    assert.throws(() => parseLicenseReport("No licenses in packages found"), /not JSON/);
    assert.deepEqual(parseLicenseReport('{"MIT":[{"name":"react","versions":["19.2.3"]}]}'), { MIT: [{ name: "react", versions: ["19.2.3"] }] });
});

test("checks bundled ffmpeg folders by their embedded configure line and notices", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "licenses-ffmpeg-"));
    const folder = (key, configure, notices = true) => {
        fs.mkdirSync(path.join(dir, key));
        fs.writeFileSync(path.join(dir, key, "ffmpeg"), Buffer.concat([Buffer.from([0]), Buffer.from(configure), Buffer.from([0])]));
        if (notices) {
            fs.writeFileSync(path.join(dir, key, "LICENSE.txt"), "GNU LESSER GENERAL PUBLIC LICENSE Version 3");
            fs.writeFileSync(path.join(dir, key, "SOURCE.txt"), "source");
        }
    };
    folder("linux-x64", "--prefix=/ffbuild --enable-version3 --enable-libopenh264");
    assert.deepEqual(checkFfmpegResources(dir, "none"), []);
    folder("win32-x64", "--prefix=/ffbuild --enable-gpl --enable-libx264");
    folder("linux-arm64", "--prefix=/ffbuild", false);
    const problems = checkFfmpegResources(dir, "none");
    assert.ok(problems.includes("win32-x64: built with --enable-gpl"));
    assert.ok(problems.includes("linux-arm64: SOURCE.txt is missing"));
    assert.deepEqual(checkFfmpegResources(path.join(dir, "missing")), []);
    fs.rmSync(dir, { recursive: true });
});

test("checks bundled whisper.cpp folders: MIT notices and checksums for every file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "licenses-whisper-"));
    try {
        const linux = path.join(dir, "linux-x64");
        fs.mkdirSync(linux);
        fs.writeFileSync(path.join(linux, "whisper-cli"), "cli");
        fs.writeFileSync(path.join(linux, "libwhisper.so.1"), "lib");
        writeNotices(linux, ["Archive: test"]);
        assert.deepEqual(checkWhisperResources(dir), []);
        fs.writeFileSync(path.join(linux, "libwhisper.so.1"), "changed");
        fs.writeFileSync(path.join(linux, "LICENSE.txt"), "GNU GENERAL PUBLIC LICENSE");
        const problems = checkWhisperResources(dir);
        assert.ok(problems.includes("linux-x64: libwhisper.so.1 does not match checksums.json"));
        assert.ok(problems.some((p) => p.startsWith("linux-x64: LICENSE.txt")));
        assert.deepEqual(checkWhisperResources(path.join(dir, "missing")), []);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
