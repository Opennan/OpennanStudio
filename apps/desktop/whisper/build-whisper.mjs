// node whisper/build-whisper.mjs <platform-arch> <out>: builds whisper-cli from the pinned whisper.cpp source
// (manifest.json) with CMake. macOS: static, Metal with its shader library embedded, Accelerate, only system
// frameworks. Windows: static MSVC runtime and no OpenMP, so no Visual C++ redistributable is needed. Every
// command runs with an argument list (no shell). CMake: OPENNAN_CMAKE or "cmake" on PATH.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const MANIFEST = JSON.parse(fs.readFileSync(path.join(HERE, "manifest.json"), "utf8"));

const COMMON = [
    "-DCMAKE_BUILD_TYPE=Release", "-DBUILD_SHARED_LIBS=OFF", "-DWHISPER_BUILD_IS_DEV=OFF",
    "-DWHISPER_BUILD_TESTS=OFF", "-DWHISPER_BUILD_SERVER=OFF", "-DWHISPER_BUILD_EXAMPLES=ON",
    "-DWHISPER_SDL2=OFF", "-DWHISPER_CURL=OFF", "-DGGML_NATIVE=OFF", "-DGGML_OPENMP=OFF", "-DGGML_BLAS=OFF",
];

/** CMake configure arguments for one platform (each flag one argv element). */
export function cmakeArgs(key, { sourceDir, buildDir, sdkIncludes = null }) {
    const entry = MANIFEST.builds[key];
    if (!entry || entry.build !== "cmake") throw new Error(`no source build for ${key}`);
    const args = ["-S", sourceDir, "-B", buildDir, ...COMMON];
    if (key.startsWith("darwin-")) {
        args.push("-DGGML_METAL=ON", "-DGGML_METAL_EMBED_LIBRARY=ON", `-DCMAKE_OSX_ARCHITECTURES=${entry.arch}`, "-DCMAKE_OSX_DEPLOYMENT_TARGET=11.0");
        if (sdkIncludes) args.push(`-DCMAKE_CXX_FLAGS=-nostdinc++ -isystem ${sdkIncludes}`);
    } else if (key.startsWith("win32-")) {
        args.push("-A", entry.arch === "arm64" ? "ARM64" : "x64", "-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded", "-DGGML_CPU_ALL_VARIANTS=OFF");
    }
    return args;
}

/** The SDK's libc++ headers when the system clang++ cannot find <climits> (a stale CommandLineTools copy). */
export function macSdkIncludes() {
    if (process.platform !== "darwin") return null;
    const probe = path.join(os.tmpdir(), `opennan-whisper-cxx-probe-${process.pid}.cpp`);
    fs.writeFileSync(probe, "#include <climits>\n#include <mutex>\nint main() { return 0; }\n");
    try {
        execFileSync("clang++", ["-fsyntax-only", probe], { stdio: "ignore" });
        return null;
    } catch {
        return `${execFileSync("xcrun", ["--show-sdk-path"], { encoding: "utf8" }).trim()}/usr/include/c++/v1`;
    } finally {
        fs.rmSync(probe, { force: true });
    }
}

export function sha256(buffer) {
    return createHash("sha256").update(buffer).digest("hex");
}

async function download(url) {
    const response = await fetch(url, { redirect: "follow" });
    if (!response.ok) throw new Error(`download failed (${response.status}): ${url}`);
    return Buffer.from(await response.arrayBuffer());
}

/** Builds whisper-cli into `out`; returns the configure arguments (recorded in SOURCE.txt). */
export async function buildWhisper(key, out) {
    const cmake = process.env.OPENNAN_CMAKE ?? "cmake";
    const work = fs.mkdtempSync(path.join(os.tmpdir(), "opennan-whisper-src-"));
    try {
        const bytes = await download(MANIFEST.source.url);
        const actual = sha256(bytes);
        if (actual !== MANIFEST.source.sha256) throw new Error(`SHA-256 mismatch for the whisper.cpp source: expected ${MANIFEST.source.sha256}, got ${actual}`);
        const tarball = path.join(work, "source.tar.gz");
        fs.writeFileSync(tarball, bytes);
        execFileSync(process.platform === "win32" ? path.join(process.env.SystemRoot || "C:\Windows", "System32", "tar.exe") : "tar", ["-xzf", tarball, "-C", work]);
        const sourceDir = path.join(work, MANIFEST.source.dir);
        const buildDir = path.join(work, "build");
        const configure = cmakeArgs(key, { sourceDir, buildDir, sdkIncludes: key.startsWith("darwin-") ? macSdkIncludes() : null });
        execFileSync(cmake, configure, { stdio: "inherit" });
        execFileSync(cmake, ["--build", buildDir, "--config", "Release", "--target", "whisper-cli", "-j", String(os.availableParallelism?.() ?? 4)], { stdio: "inherit" });
        const exe = key.startsWith("win32-") ? "whisper-cli.exe" : "whisper-cli";
        const built = [path.join(buildDir, "bin", exe), path.join(buildDir, "bin", "Release", exe)].find((file) => fs.existsSync(file));
        if (!built) throw new Error("the build produced no whisper-cli");
        fs.mkdirSync(out, { recursive: true });
        fs.copyFileSync(built, path.join(out, exe));
        fs.chmodSync(path.join(out, exe), 0o755);
        return configure.map((arg) => arg.split(work).join("<build>"));
    } finally {
        fs.rmSync(work, { recursive: true, force: true });
    }
}
