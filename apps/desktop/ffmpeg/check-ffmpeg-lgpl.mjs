// pnpm --filter @opennan/desktop check:ffmpeg [dir]: the bundled ffmpeg must be an LGPL build (spec §3).
// Fails on --enable-gpl, --enable-nonfree, any GPL or non-free library, a license line that is not the LGPL,
// a missing LICENSE.txt/SOURCE.txt, or no H.264/AAC/PNG encoder for the export.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const GPL_OR_NONFREE = ["libx264", "libx265", "libxvid", "libfdk", "libvidstab", "librubberband", "frei0r", "libcdio", "libdavs2", "libxavs2", "avisynth", "libsmbclient", "decklink", "libnpp", "cuda-nvcc"];
export const LGPL_H264_ENCODERS = ["h264_videotoolbox", "h264_mf", "h264_vaapi", "libopenh264"];

/** Problems with one ffmpeg's -buildconf, -L, -encoders output and its notice files. */
export function lgplProblems({ buildconf, license, encoders, licenseText = "LGPL", sourceText = "x", platform = process.platform }) {
    const problems = [];
    const flags = buildconf.split(/\s+/).filter((part) => part.startsWith("--"));
    if (flags.includes("--enable-gpl")) problems.push("built with --enable-gpl");
    if (flags.includes("--enable-nonfree")) problems.push("built with --enable-nonfree");
    for (const lib of GPL_OR_NONFREE) if (flags.some((flag) => flag.startsWith("--enable-") && flag.includes(lib))) problems.push(`built with a GPL or non-free library: ${lib}`);
    if (!/GNU Lesser General Public/i.test(license)) problems.push("ffmpeg -L does not show the GNU Lesser General Public License");
    if (/GNU General Public License/i.test(license.replace(/GNU Lesser General Public License/gi, ""))) problems.push("ffmpeg -L mentions the GNU General Public License");
    if (flags.includes("--enable-version3") && !/version 3/i.test(licenseText)) problems.push("--enable-version3 needs the LGPL 3.0 text in LICENSE.txt");
    if (!licenseText.trim()) problems.push("LICENSE.txt is missing");
    if (!sourceText.trim()) problems.push("SOURCE.txt is missing");
    const names = new Set(encoders.split("\n").map((line) => line.trim().split(/\s+/)[1]).filter(Boolean));
    if (!names.has("aac")) problems.push("no aac encoder");
    if (!names.has("png")) problems.push("no png encoder (preview frames)");
    if (!names.has("gif")) problems.push("no gif encoder (GIF export)");
    if (!LGPL_H264_ENCODERS.some((name) => names.has(name)) && platform !== "linux") problems.push(`no LGPL H.264 encoder (${LGPL_H264_ENCODERS.join(", ")})`);
    return problems;
}

/** The configure line ffmpeg embeds in its binary (FFMPEG_CONFIGURATION), for binaries of another platform. */
export function embeddedConfiguration(bytes) {
    const text = bytes.toString("latin1");
    const at = text.indexOf("--prefix=");
    if (at < 0) return null;
    let start = at;
    while (start > 0 && text.charCodeAt(start - 1) >= 32 && text.charCodeAt(start - 1) < 127) start -= 1;
    let end = at;
    while (end < text.length && text.charCodeAt(end) >= 32 && text.charCodeAt(end) < 127) end += 1;
    return text.slice(start, end);
}

/** Checks a binary that cannot run here by its embedded configure line and its notice files. */
export function checkForeignFfmpegDir(dir) {
    const file = ["ffmpeg", "ffmpeg.exe"].map((name) => path.join(dir, name)).find((f) => fs.existsSync(f));
    if (!file) return [`${dir}: ffmpeg is missing`];
    const configuration = embeddedConfiguration(fs.readFileSync(file));
    if (!configuration) return [`${file}: no embedded configure line`];
    return lgplProblems({
        buildconf: configuration, license: "GNU Lesser General Public License", encoders: " A aac\n V png\n V gif\n V libopenh264\n",
        licenseText: read(path.join(dir, "LICENSE.txt")), sourceText: read(path.join(dir, "SOURCE.txt")),
    });
}

const read = (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "");

export function checkFfmpegDir(dir) {
    const exe = process.platform === "win32" ? ".exe" : "";
    const ffmpeg = path.join(dir, `ffmpeg${exe}`);
    if (!fs.existsSync(ffmpeg)) return { problems: [`${ffmpeg} is missing`], encoder: null };
    const run = (...args) => execFileSync(ffmpeg, ["-hide_banner", ...args], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
    const encoders = run("-encoders");
    const problems = lgplProblems({
        buildconf: run("-buildconf"), license: run("-L"), encoders,
        licenseText: read(path.join(dir, "LICENSE.txt")), sourceText: read(path.join(dir, "SOURCE.txt")),
    });
    const encoder = LGPL_H264_ENCODERS.find((name) => new RegExp(`\\s${name}\\s`).test(encoders)) ?? null;
    return { problems, encoder };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const dir = path.resolve(process.argv[2] ?? path.join(root, "resources", "ffmpeg", `${process.platform}-${process.arch}`));
    const { problems, encoder } = checkFfmpegDir(dir);
    if (problems.length > 0) {
        console.error(`check-ffmpeg-lgpl: ${dir}\n${problems.map((p) => `  - ${p}`).join("\n")}`);
        process.exit(1);
    }
    console.log(`check-ffmpeg-lgpl: LGPL build, H.264 via ${encoder ?? "none (MPEG-4 Part 2 fallback)"} (${dir})`);
}
