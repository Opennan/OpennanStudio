// Builds better-sqlite3 for Electron's ABI when Electron or better-sqlite3 changed since the last build.
// One ABI everywhere: the tests (run inside Electron's Node, scripts/electron-node.mjs), dev runs, and packages.
// node-pty 1.1.0 is N-API (prebuilds on macOS/Windows, a source build on Linux); only its spawn-helper needs
// its execute bit restored.
// The build runs in a temporary copy of the package: node-gyp's make files break on paths with spaces.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "package.json"));
const packageDir = (name) => fs.realpathSync(path.dirname(require.resolve(`${name}/package.json`)));
const versionOf = (name) => JSON.parse(fs.readFileSync(path.join(packageDir(name), "package.json"), "utf8")).version;

const electronVersion = versionOf("electron");
const sqliteDir = packageDir("better-sqlite3");
const sqliteVersion = versionOf("better-sqlite3");
const arch = process.env.npm_config_arch || process.arch;
const addon = path.join(sqliteDir, "build", "Release", "better_sqlite3.node");
const stampFile = path.join(sqliteDir, "build", "opennan-native-stamp.json");
const wanted = JSON.stringify({ electron: electronVersion, "better-sqlite3": sqliteVersion, platform: process.platform, arch });

function stampMatches() {
    try {
        return fs.existsSync(addon) && fs.readFileSync(stampFile, "utf8") === wanted;
    } catch {
        return false;
    }
}

/** Extra compiler flags for macOS installs whose stale CommandLineTools/usr/include/c++/v1 hides the SDK's libc++. */
function macCxxFlags() {
    if (process.platform !== "darwin") return "";
    const probe = path.join(os.tmpdir(), `opennan-cxx-probe-${process.pid}.cpp`);
    fs.writeFileSync(probe, "#include <climits>\nint main() { return 0; }\n");
    try {
        execFileSync("clang++", ["-fsyntax-only", probe], { stdio: "ignore" });
        return "";
    } catch {
        const sdk = execFileSync("xcrun", ["--show-sdk-path"], { encoding: "utf8" }).trim();
        console.log("ensure-native: using the SDK's libc++ headers (the CommandLineTools copy is incomplete)");
        return `-nostdinc++ -isystem ${sdk}/usr/include/c++/v1`;
    } finally {
        fs.rmSync(probe, { force: true });
    }
}

function build() {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), "opennan-native-"));
    const copy = path.join(work, "better-sqlite3");
    try {
        fs.cpSync(sqliteDir, copy, { recursive: true, filter: (src) => !src.includes(`${path.sep}build${path.sep}`) && !src.endsWith(`${path.sep}build`) });
        const env = { ...process.env };
        const flags = macCxxFlags();
        if (flags) env.CXXFLAGS = `${env.CXXFLAGS ?? ""} ${flags}`.trim();
        const prebuild = path.join(path.dirname(require.resolve("prebuild-install/package.json", { paths: [sqliteDir] })), "bin.js");
        try {
            execFileSync(process.execPath, [prebuild, "--runtime=electron", `--target=${electronVersion}`, `--arch=${arch}`], { cwd: copy, env, stdio: "inherit" });
            console.log("ensure-native: downloaded a prebuilt better-sqlite3 for Electron");
        } catch {
            const gyp = require.resolve("node-gyp/bin/node-gyp.js");
            execFileSync(process.execPath, [gyp, "rebuild", "--release", `--target=${electronVersion}`, `--arch=${arch}`, "--dist-url=https://electronjs.org/headers"], { cwd: copy, env, stdio: "inherit" });
        }
        fs.mkdirSync(path.dirname(addon), { recursive: true });
        fs.copyFileSync(path.join(copy, "build", "Release", "better_sqlite3.node"), addon);
        fs.writeFileSync(stampFile, wanted);
    } finally {
        fs.rmSync(work, { recursive: true, force: true });
    }
}

/** node-pty's macOS/Linux spawn-helper ships without its execute bit in the npm tarball (posix_spawnp fails). */
function fixSpawnHelper() {
    if (process.platform === "win32") return;
    const ptyDir = packageDir("node-pty");
    const candidates = [path.join(ptyDir, "build", "Release", "spawn-helper")];
    const prebuilds = path.join(ptyDir, "prebuilds");
    if (fs.existsSync(prebuilds)) for (const dir of fs.readdirSync(prebuilds)) candidates.push(path.join(prebuilds, dir, "spawn-helper"));
    for (const file of candidates) {
        if (fs.existsSync(file) && (fs.statSync(file).mode & 0o111) === 0) {
            fs.chmodSync(file, 0o755);
            console.log(`ensure-native: made ${path.relative(ptyDir, file)} executable`);
        }
    }
}

fixSpawnHelper();
if (!stampMatches()) {
    console.log(`ensure-native: building better-sqlite3 ${sqliteVersion} for Electron ${electronVersion} (${process.platform}-${arch})`);
    build();
}
console.log(`ensure-native: better-sqlite3 ${sqliteVersion} ready for Electron ${electronVersion}`);
