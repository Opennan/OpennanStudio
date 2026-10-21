import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { cmakeArgs } from "./build-whisper.mjs";
import { MANIFEST, linuxFiles, platformKey, sha256, verifySha256, writeNotices } from "./fetch-whisper.mjs";
import { whisperProblems } from "./check-whisper.mjs";

test("manifest pins the source and every archive by SHA-256 over HTTPS", () => {
    assert.equal(MANIFEST.version, "1.9.5");
    assert.equal(MANIFEST.license, "MIT");
    assert.match(MANIFEST.source.url, /^https:\/\/github\.com\/ggml-org\/whisper\.cpp\/archive\/refs\/tags\/v1\.9\.5\.tar\.gz$/);
    assert.match(MANIFEST.source.sha256, /^[0-9a-f]{64}$/);
    assert.match(MANIFEST.source.commit, /^[0-9a-f]{40}$/);
    assert.deepEqual(Object.keys(MANIFEST.builds).sort(), ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "win32-x64"]);
    for (const [key, entry] of Object.entries(MANIFEST.builds)) {
        if (entry.build) {
            assert.equal(entry.build, "cmake", key);
            continue;
        }
        assert.match(entry.url, /^https:\/\/github\.com\/ggml-org\/whisper\.cpp\/releases\/download\/b5454\/whisper-bin-ubuntu-(x64|arm64)\.tar\.gz$/, key);
        assert.match(entry.sha256, /^[0-9a-f]{64}$/, key);
    }
});

test("SHA-256 verification refuses tampered bytes", () => {
    const bytes = Buffer.from("whisper");
    verifySha256(bytes, sha256(bytes));
    assert.throws(() => verifySha256(Buffer.from("whisper!"), sha256(bytes)), /SHA-256 mismatch/);
    assert.equal(platformKey("win32", "x64"), "win32-x64");
});

test("CMake arguments: one flag per element, static, Metal on macOS, static CRT on Windows", () => {
    const mac = cmakeArgs("darwin-arm64", { sourceDir: "/s", buildDir: "/b", sdkIncludes: "/SDK/usr/include/c++/v1" });
    assert.deepEqual(mac.slice(0, 4), ["-S", "/s", "-B", "/b"]);
    for (const flag of ["-DBUILD_SHARED_LIBS=OFF", "-DGGML_NATIVE=OFF", "-DGGML_OPENMP=OFF", "-DWHISPER_BUILD_IS_DEV=OFF", "-DGGML_METAL=ON", "-DGGML_METAL_EMBED_LIBRARY=ON", "-DCMAKE_OSX_ARCHITECTURES=arm64", "-DCMAKE_OSX_DEPLOYMENT_TARGET=11.0"]) {
        assert.ok(mac.includes(flag), flag);
    }
    assert.ok(mac.includes("-DCMAKE_CXX_FLAGS=-nostdinc++ -isystem /SDK/usr/include/c++/v1"));
    assert.ok(!cmakeArgs("darwin-x64", { sourceDir: "/s", buildDir: "/b" }).some((a) => a.startsWith("-DCMAKE_CXX_FLAGS")));
    assert.ok(cmakeArgs("darwin-x64", { sourceDir: "/s", buildDir: "/b" }).includes("-DCMAKE_OSX_ARCHITECTURES=x86_64"));
    const win = cmakeArgs("win32-x64", { sourceDir: "/s", buildDir: "/b" });
    assert.ok(win.includes("-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded"));
    assert.deepEqual(win.slice(win.indexOf("-A"), win.indexOf("-A") + 2), ["-A", "x64"]);
    assert.ok(!win.some((a) => /METAL/.test(a)));
    assert.throws(() => cmakeArgs("linux-x64", { sourceDir: "/s", buildDir: "/b" }), /no source build/);
});

test("Linux archives ship whisper-cli and the libraries it loads", () => {
    assert.deepEqual(linuxFiles([
        "whisper-cli", "libwhisper.so", "libwhisper.so.1", "libwhisper.so.1.9.5", "libggml.so", "libggml.so.0", "libggml.so.0.26.0",
        "libggml-base.so.0", "libggml-cpu-haswell.so", "libggml-cpu.so", "libparakeet.so.1", "whisper-server", "main", "LICENSE",
    ]), ["libggml-base.so.0", "libggml-cpu-haswell.so", "libggml-cpu.so", "libggml.so.0", "libwhisper.so.1", "whisper-cli"]);
});

test("check-whisper accepts a complete folder and flags what is wrong", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opennan-wcheck-"));
    try {
        const folder = path.join(dir, "linux-x64");
        fs.mkdirSync(folder);
        fs.writeFileSync(path.join(folder, "whisper-cli"), "binary");
        fs.writeFileSync(path.join(folder, "libggml.so.0"), "lib");
        writeNotices(folder, ["Archive: test"]);
        assert.deepEqual(whisperProblems(folder), []);
        assert.deepEqual(whisperProblems(folder, { run: () => "usage: --output-json" }), []);
        assert.match(whisperProblems(folder, { run: () => { throw new Error("exit 1"); } })[0], /does not run/);

        fs.writeFileSync(path.join(folder, "libggml.so.0"), "evil");
        assert.ok(whisperProblems(folder).includes("libggml.so.0 does not match checksums.json"));
        fs.writeFileSync(path.join(folder, "libggml.so.0"), "lib");
        fs.writeFileSync(path.join(folder, "extra-tool"), "x");
        assert.ok(whisperProblems(folder).includes("extra-tool is not listed in checksums.json"));
        fs.rmSync(path.join(folder, "extra-tool"));
        fs.writeFileSync(path.join(folder, "LICENSE.txt"), "GNU General Public License version 3");
        assert.ok(whisperProblems(folder).some((p) => /MIT license/.test(p)));
        assert.ok(whisperProblems(folder).some((p) => /GPL/.test(p)));
        fs.rmSync(path.join(folder, "checksums.json"));
        assert.ok(whisperProblems(folder).includes("checksums.json is missing or lists no files"));

        const win = path.join(dir, "win32-x64");
        fs.mkdirSync(win);
        fs.writeFileSync(path.join(win, "whisper-cli"), "binary");
        writeNotices(win, ["x"]);
        assert.ok(whisperProblems(win).includes("checksums.json does not list whisper-cli.exe"));
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
