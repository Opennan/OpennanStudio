// pnpm --filter @opennan/desktop fetch:ffmpeg [--platform p] [--arch a] [--out dir] [--no-check]
// Puts the LGPL ffmpeg/ffprobe for one platform into resources/ffmpeg/<platform>-<arch>/: downloads the pinned
// archive (manifest.json), refuses it unless its SHA-256 matches, extracts only the two binaries, writes
// LICENSE.txt and SOURCE.txt, and runs check-ffmpeg-lgpl. macOS has no upstream LGPL build: build-macos.sh.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { checkFfmpegDir } from "./check-ffmpeg-lgpl.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const MANIFEST = JSON.parse(fs.readFileSync(path.join(HERE, "manifest.json"), "utf8"));

export function platformKey(platform = process.platform, arch = process.arch) {
    return `${platform}-${arch}`;
}

export function sha256(buffer) {
    return createHash("sha256").update(buffer).digest("hex");
}

export function verifySha256(buffer, expected) {
    const actual = sha256(buffer);
    if (actual !== expected) throw new Error(`SHA-256 mismatch: expected ${expected}, got ${actual}`);
}

async function download(url) {
    const response = await fetch(url, { redirect: "follow" });
    if (!response.ok) throw new Error(`download failed (${response.status}): ${url}`);
    return Buffer.from(await response.arrayBuffer());
}

function extract(archive, kind, into) {
    if (kind === "zip" && process.platform === "linux") execFileSync("unzip", ["-q", archive, "-d", into]);
    else execFileSync(process.platform === "win32" ? path.join(process.env.SystemRoot || "C:\Windows", "System32", "tar.exe") : "tar", [kind === "tar.xz" ? "-xJf" : "-xf", archive, "-C", into]);
}

async function main() {
    const { values } = parseArgs({ options: { platform: { type: "string" }, arch: { type: "string" }, out: { type: "string" }, "no-check": { type: "boolean" } } });
    const key = platformKey(values.platform ?? process.platform, values.arch ?? process.arch);
    const entry = MANIFEST.builds[key];
    if (!entry) throw new Error(`no ffmpeg build for ${key}`);
    const out = path.resolve(values.out ?? path.join(HERE, "..", "resources", "ffmpeg", key));
    fs.mkdirSync(out, { recursive: true });
    if (entry.build) {
        execFileSync(path.join(HERE, entry.build), [entry.arch, out], { stdio: "inherit" });
    } else {
        const downloads = fs.mkdtempSync(path.join(os.tmpdir(), "opennan-ffmpeg-dl-"));
        const unpacked = fs.mkdtempSync(path.join(os.tmpdir(), "opennan-ffmpeg-x-"));
        try {
            const archive = path.join(downloads, `archive.${entry.archive}`);
            const bytes = await download(entry.url);
            verifySha256(bytes, entry.sha256);
            fs.writeFileSync(archive, bytes);
            extract(archive, entry.archive, unpacked);
            const exe = key.startsWith("win32") ? ".exe" : "";
            for (const name of ["ffmpeg", "ffprobe"]) {
                fs.copyFileSync(path.join(unpacked, entry.bin, `${name}${exe}`), path.join(out, `${name}${exe}`));
                fs.chmodSync(path.join(out, `${name}${exe}`), 0o755);
            }
            const archiveLicense = path.join(unpacked, path.dirname(entry.bin), "LICENSE.txt");
            fs.copyFileSync(fs.existsSync(archiveLicense) ? archiveLicense : path.join(HERE, "LGPL-2.1.txt"), path.join(out, "LICENSE.txt"));
            fs.writeFileSync(path.join(out, "SOURCE.txt"), [
                `FFmpeg ${MANIFEST.version} LGPL build for ${key} (BtbN FFmpeg-Builds).`,
                "License: GNU Lesser General Public License (see LICENSE.txt); no GPL or non-free components.",
                `Archive: ${entry.url}`,
                `Archive SHA-256: ${entry.sha256}`,
                `FFmpeg source: ${MANIFEST.source.url}`,
                `FFmpeg source SHA-256: ${MANIFEST.source.sha256}`,
                "Build scripts: https://github.com/BtbN/FFmpeg-Builds",
                "",
            ].join("\n"));
        } finally {
            fs.rmSync(downloads, { recursive: true, force: true });
            fs.rmSync(unpacked, { recursive: true, force: true });
        }
    }
    if (values["no-check"] || key !== platformKey()) {
        console.log(`fetch-ffmpeg: ${out} (not checked: ${values["no-check"] ? "--no-check" : "foreign platform"})`);
        return;
    }
    const { problems, encoder } = checkFfmpegDir(out);
    if (problems.length > 0) throw new Error(`the ffmpeg in ${out} is not an LGPL build:\n${problems.join("\n")}`);
    console.log(`fetch-ffmpeg: ${out} (LGPL, H.264 via ${encoder ?? "none"})`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
    main().catch((error) => {
        console.error(`fetch-ffmpeg: ${error.message}`);
        process.exit(1);
    });
}
