// pnpm check:licenses (spec §11 "license check (deny GPL in shipped bundles)").
// 1. No GPL or AGPL package in the production dependency tree of anything we ship: every
//    packages/* and apps/* package. `pnpm licenses list` does not follow workspace links,
//    so each workspace package is filtered in. Dev dependencies (such as @ffmpeg/core,
//    which the web e2e serves locally) are not shipped and not listed.
// 2. No GPL or AGPL package in what each build actually bundled: the tree check misses
//    packages that reach the bundle as optional peers (mediabunny, regl, emoji-mart are
//    timeline-react/timeline-media peers), so the build's third-party-licenses.json,
//    written by scripts/third-party-notices.mjs, is checked too.
// 3. The web build contains no ffmpeg.wasm core: the core is GPL-2.0-or-later and is
//    served next to the app at export time (apps/web/scripts/copy-ffmpeg-core.mjs, outside dist/).
// 4. The desktop app's bundles (renderer and main process) are checked like apps/web/dist, and the ffmpeg it
//    bundles (apps/desktop/resources/ffmpeg/<platform>-<arch>, when fetched) must be an LGPL build with its
//    LICENSE.txt and SOURCE.txt: the host's binary is run, other platforms' are read for their configure line.
// 5. The whisper.cpp folders the desktop app bundles (apps/desktop/resources/whisper/<platform>-<arch>, when
//    fetched) carry whisper.cpp's MIT license, the models' MIT notice, SOURCE.txt, and checksums.json matching
//    every file (nothing GPL, nothing unlisted).
// The check fails closed: an unreadable or empty report or manifest is a failure.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { LICENSE_MANIFEST } from "./third-party-notices.mjs";
import { checkFfmpegDir, checkForeignFfmpegDir } from "../apps/desktop/ffmpeg/check-ffmpeg-lgpl.mjs";
import { whisperProblems } from "../apps/desktop/whisper/check-whisper.mjs";

const SHIPPED_FILTERS = ["./packages/*", "./apps/*"];
const SHIPPED_BUILDS = ["apps/web/dist", "apps/desktop/dist/renderer", "apps/desktop/dist/main"];
const FFMPEG_RESOURCES = "apps/desktop/resources/ffmpeg";
const WHISPER_RESOURCES = "apps/desktop/resources/whisper";
/** Strings only the core contains: its Emscripten factory, and the x264 banner inside the wasm. */
const CORE_MARKERS = ["var createFFmpegCore = (() =>", "x264 - core "];

/** Denied when every OR alternative is GPL or AGPL (LGPL is allowed). */
export function isDeniedLicense(expression) {
    const alternatives = String(expression).replace(/[()]/g, " ").split(/\s+OR\s+/).map((a) => a.trim()).filter(Boolean);
    return alternatives.length > 0 && alternatives.every((alternative) => /(^|[^L])A?GPL/.test(alternative));
}

/** `pnpm licenses list --prod --json` output -> "name@version (license)" for each denied package. */
export function deniedPackages(report) {
    return Object.entries(report).flatMap(([license, packages]) => (
        isDeniedLicense(license) ? packages.map((p) => `${p.name}@${p.versions.join(",")} (${license})`) : []
    ));
}

/** third-party-licenses.json entries -> "name@version (license)" for each denied package. */
export function deniedBundled(entries) {
    return entries.filter((entry) => isDeniedLicense(entry.license)).map((entry) => `${entry.name}@${entry.version} (${entry.license})`);
}

/** `pnpm licenses list --json` output -> report; throws when it is not JSON or lists no packages. */
export function parseLicenseReport(output) {
    let report;
    try {
        report = JSON.parse(output);
    } catch {
        throw new Error(`pnpm licenses list output is not JSON:\n${output}`);
    }
    const count = report && typeof report === "object" ? Object.values(report).reduce((sum, packages) => sum + packages.length, 0) : 0;
    if (count === 0) throw new Error(`pnpm licenses list found no packages:\n${output}`);
    return report;
}

/** Problems with one build directory: its bundled licenses and any ffmpeg core in it. */
export function checkBuild(dir) {
    if (!fs.existsSync(dir)) return ["the build is missing: run pnpm build first"];
    const problems = [];
    const manifestFile = path.join(dir, LICENSE_MANIFEST);
    if (!fs.existsSync(manifestFile)) {
        problems.push(`${LICENSE_MANIFEST} is missing: the build did not record its bundled licenses`);
    } else {
        let entries;
        try {
            entries = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
        } catch {
            entries = null;
        }
        if (!Array.isArray(entries)) problems.push(`${LICENSE_MANIFEST} is not a JSON array`);
        else if (entries.length === 0) problems.push(`${LICENSE_MANIFEST} lists no packages`);
        else problems.push(...deniedBundled(entries).map((p) => `GPL in the bundle: ${p}`));
    }
    problems.push(...findBundledCore(dir));
    return problems;
}

/** Problems with the bundled ffmpeg folders; `hostKey` is the folder whose binary can run here. */
export function checkFfmpegResources(dir, hostKey = `${process.platform}-${process.arch}`) {
    if (!fs.existsSync(dir)) return [];
    const problems = [];
    for (const key of fs.readdirSync(dir).filter((name) => fs.statSync(path.join(dir, name)).isDirectory())) {
        const folder = path.join(dir, key);
        const found = key === hostKey ? checkFfmpegDir(folder).problems : checkForeignFfmpegDir(folder);
        problems.push(...found.map((problem) => `${key}: ${problem}`));
    }
    return problems;
}

/** Problems with the bundled whisper.cpp folders (read only: no binary is run here). */
export function checkWhisperResources(dir) {
    if (!fs.existsSync(dir)) return [];
    const problems = [];
    for (const key of fs.readdirSync(dir).filter((name) => fs.statSync(path.join(dir, name)).isDirectory())) {
        problems.push(...whisperProblems(path.join(dir, key)).map((problem) => `${key}: ${problem}`));
    }
    return problems;
}

export function findBundledCore(dir) {
    const problems = [];
    const walk = (current) => {
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            const file = path.join(current, entry.name);
            if (entry.isDirectory()) {
                walk(file);
                continue;
            }
            const relative = path.relative(dir, file).split(path.sep).join("/");
            if (/ffmpeg-core/i.test(entry.name) || entry.name.endsWith(".wasm")) {
                problems.push(`${relative}: ffmpeg core file in the build`);
                continue;
            }
            const content = fs.readFileSync(file).toString("latin1");
            for (const marker of CORE_MARKERS) if (content.includes(marker)) problems.push(`${relative}: contains the ffmpeg core ("${marker}")`);
        }
    };
    if (fs.existsSync(dir)) walk(dir);
    return problems;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const output = execFileSync("pnpm", [...SHIPPED_FILTERS.flatMap((f) => ["--filter", f]), "licenses", "list", "--prod", "--json"], {
        cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
    });
    let report;
    try {
        report = parseLicenseReport(output);
    } catch (error) {
        console.error(error.message);
        process.exit(1);
    }
    const problems = deniedPackages(report).map((p) => `GPL in a shipped dependency tree: ${p}`);
    for (const build of SHIPPED_BUILDS) problems.push(...checkBuild(path.join(root, build)).map((p) => `${build}: ${p}`));
    problems.push(...checkFfmpegResources(path.join(root, FFMPEG_RESOURCES)).map((p) => `${FFMPEG_RESOURCES}/${p}`));
    problems.push(...checkWhisperResources(path.join(root, WHISPER_RESOURCES)).map((p) => `${WHISPER_RESOURCES}/${p}`));
    if (problems.length > 0) {
        console.error(problems.join("\n"));
        process.exit(1);
    }
    const count = Object.values(report).reduce((sum, packages) => sum + packages.length, 0);
    const bundled = SHIPPED_BUILDS.map((build) => `${build} bundles ${JSON.parse(fs.readFileSync(path.join(root, build, LICENSE_MANIFEST), "utf8")).length}`).join(", ");
    const ffmpeg = fs.existsSync(path.join(root, FFMPEG_RESOURCES)) ? `; ${FFMPEG_RESOURCES}: ${fs.readdirSync(path.join(root, FFMPEG_RESOURCES)).join(", ")} LGPL` : "";
    const whisper = fs.existsSync(path.join(root, WHISPER_RESOURCES)) ? `; ${WHISPER_RESOURCES}: ${fs.readdirSync(path.join(root, WHISPER_RESOURCES)).join(", ")} MIT` : "";
    console.log(`check-licenses: ${count} production packages, ${bundled}, none GPL; no ffmpeg.wasm core in ${SHIPPED_BUILDS.join(", ")}${ffmpeg}${whisper}`);
}
