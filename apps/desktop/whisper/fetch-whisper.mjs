// pnpm --filter @opennan/desktop fetch:whisper [--platform p] [--arch a] [--out dir] [--no-check]
// Puts whisper.cpp for one platform into resources/whisper/<platform>-<arch>/ (spec §5.9): Linux from the pinned
// upstream archive (refused unless its SHA-256 matches), macOS and Windows built from the pinned source
// (build-whisper.mjs). Writes LICENSE.txt (MIT), MODELS-LICENSE.txt, SOURCE.txt, and checksums.json, then runs
// check-whisper. Downloads only the manifest's HTTPS URLs; extraction uses tar with an argument list.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { MANIFEST, buildWhisper, sha256 } from "./build-whisper.mjs";
import { NOTICE_FILES, runHelp, whisperProblems } from "./check-whisper.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export { MANIFEST, sha256 };

export function platformKey(platform = process.platform, arch = process.arch) {
    return `${platform}-${arch}`;
}

export function verifySha256(buffer, expected) {
    const actual = sha256(buffer);
    if (actual !== expected) throw new Error(`SHA-256 mismatch: expected ${expected}, got ${actual}`);
}

/** Files to ship from an extracted Linux archive: whisper-cli and the libraries it loads (sonames). */
export function linuxFiles(names) {
    const wanted = new Set(["whisper-cli", "libwhisper.so.1", "libggml.so.0", "libggml-base.so.0"]);
    return names.filter((name) => wanted.has(name) || /^libggml-cpu(-[a-z0-9]+)?\.so$/.test(name)).sort();
}

async function download(url) {
    if (!url.startsWith("https://")) throw new Error(`refusing a non-https download: ${url}`);
    const response = await fetch(url, { redirect: "follow" });
    if (!response.ok) throw new Error(`download failed (${response.status}): ${url}`);
    return Buffer.from(await response.arrayBuffer());
}

export function writeNotices(out, sourceLines) {
    fs.copyFileSync(path.join(HERE, "LICENSE-whisper.cpp.txt"), path.join(out, "LICENSE.txt"));
    fs.copyFileSync(path.join(HERE, "MODELS-LICENSE.txt"), path.join(out, "MODELS-LICENSE.txt"));
    fs.writeFileSync(path.join(out, "SOURCE.txt"), [
        `whisper.cpp ${MANIFEST.version} (MIT License, see LICENSE.txt), commit ${MANIFEST.source.commit}.`,
        `Source: ${MANIFEST.source.url}`,
        `Source SHA-256: ${MANIFEST.source.sha256}`,
        ...sourceLines,
        "whisper-cli includes miniaudio (public domain or MIT No Attribution) and stb_vorbis (public domain or MIT) from the whisper.cpp source.",
        "Models: downloaded on first use, not shipped (see MODELS-LICENSE.txt).",
        "",
    ].join("\n"));
    const files = {};
    for (const name of fs.readdirSync(out).sort()) {
        if (NOTICE_FILES.includes(name)) continue;
        files[name] = sha256(fs.readFileSync(path.join(out, name)));
    }
    fs.writeFileSync(path.join(out, "checksums.json"), `${JSON.stringify({ version: MANIFEST.version, files }, null, 4)}\n`);
}

async function main() {
    const { values } = parseArgs({ options: { platform: { type: "string" }, arch: { type: "string" }, out: { type: "string" }, "no-check": { type: "boolean" } } });
    const key = platformKey(values.platform ?? process.platform, values.arch ?? process.arch);
    const entry = MANIFEST.builds[key];
    if (!entry) throw new Error(`no whisper.cpp build for ${key}`);
    const out = path.resolve(values.out ?? path.join(HERE, "..", "resources", "whisper", key));
    fs.rmSync(out, { recursive: true, force: true });
    fs.mkdirSync(out, { recursive: true });
    let sourceLines;
    if (entry.build === "cmake") {
        const configure = await buildWhisper(key, out);
        const script = sha256(fs.readFileSync(path.join(HERE, "build-whisper.mjs")));
        sourceLines = [`Built from source for ${key} by apps/desktop/whisper/build-whisper.mjs (SHA-256 ${script}).`, `CMake: ${configure.join(" ")}`];
    } else {
        const downloads = fs.mkdtempSync(path.join(os.tmpdir(), "opennan-whisper-dl-"));
        const unpacked = fs.mkdtempSync(path.join(os.tmpdir(), "opennan-whisper-x-"));
        try {
            const bytes = await download(entry.url);
            verifySha256(bytes, entry.sha256);
            const archive = path.join(downloads, "archive.tar.gz");
            fs.writeFileSync(archive, bytes);
            execFileSync("tar", ["-xzf", archive, "-C", unpacked]);
            const from = path.join(unpacked, entry.dir);
            for (const name of linuxFiles(fs.readdirSync(from))) {
                // copyFileSync follows the archive's symlinks: each soname becomes a real file.
                fs.copyFileSync(path.join(from, name), path.join(out, name));
                fs.chmodSync(path.join(out, name), 0o755);
            }
            sourceLines = [`Archive: ${entry.url}`, `Archive SHA-256: ${entry.sha256}`, "Built by the whisper.cpp project's release workflow (nightly b5454 = the v1.9.5 commit)."];
        } finally {
            fs.rmSync(downloads, { recursive: true, force: true });
            fs.rmSync(unpacked, { recursive: true, force: true });
        }
    }
    writeNotices(out, sourceLines);
    const host = key === platformKey();
    const problems = whisperProblems(out, { run: host && !values["no-check"] ? runHelp : null });
    if (problems.length > 0) throw new Error(`the whisper.cpp folder ${out} failed its check:\n${problems.join("\n")}`);
    console.log(`fetch-whisper: ${out} (whisper.cpp ${MANIFEST.version}, MIT${host ? ", whisper-cli runs" : ", not run: foreign platform"})`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
    main().catch((error) => {
        console.error(`fetch-whisper: ${error.message}`);
        process.exit(1);
    });
}
