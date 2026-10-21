// Generates the bench media (projects.mjs MEDIA) into .cache/bench-media/ once, with an ffmpeg that has
// libvpx-vp9 and libopus (Homebrew's, a dev tool that never ships; override with OPENNAN_BENCH_FFMPEG). VP9 +
// Opus WebM decodes in every Chromium build (Playwright's has no H.264), stills are PNG.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MEDIA, MEDIA_PREFIX } from "./projects.mjs";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const MEDIA_DIR = path.join(ROOT, ".cache/bench-media");

function ffmpegBinary() {
    const candidates = [process.env.OPENNAN_BENCH_FFMPEG, "/opt/homebrew/bin/ffmpeg", "ffmpeg"].filter(Boolean);
    for (const bin of candidates) {
        const probe = spawnSync(bin, ["-hide_banner", "-encoders"], { encoding: "utf8" });
        if (probe.status === 0 && probe.stdout.includes("libvpx-vp9")) return bin;
    }
    throw new Error("bench media needs an ffmpeg with libvpx-vp9 (set OPENNAN_BENCH_FFMPEG)");
}

/** Local path of a bench media URL. */
export function mediaPath(url) {
    return path.join(MEDIA_DIR, url.slice(MEDIA_PREFIX.length + 1));
}

/** Makes every missing file of `projectKey`'s media; returns the URL → path map. */
export function ensureMedia(projectKey) {
    mkdirSync(MEDIA_DIR, { recursive: true });
    const out = {};
    let bin = null;
    for (const [url, spec] of Object.entries(MEDIA[projectKey])) {
        const file = mediaPath(url);
        out[url] = file;
        if (existsSync(file) && statSync(file).size > 0) continue;
        bin ??= ffmpegBinary();
        const args = ["-hide_banner", "-loglevel", "error", "-y"];
        if (spec.kind === "image") {
            args.push("-f", "lavfi", "-i", spec.source, "-frames:v", "1", file);
        } else {
            args.push("-f", "lavfi", "-i", `${spec.source},format=yuv420p`, "-t", String(spec.seconds));
            if (spec.tone) args.push("-f", "lavfi", "-i", `sine=frequency=${spec.tone}:sample_rate=48000`, "-t", String(spec.seconds));
            args.push("-c:v", "libvpx-vp9", "-b:v", "6M", "-deadline", "realtime", "-cpu-used", "8", "-row-mt", "1", "-g", "60");
            if (spec.tone) args.push("-c:a", "libopus", "-b:a", "96k");
            args.push("-shortest", file);
        }
        process.stderr.write(`[bench] making ${path.basename(file)}\n`);
        const result = spawnSync(bin, args, { encoding: "utf8" });
        if (result.status !== 0) throw new Error(`ffmpeg failed for ${url}: ${result.stderr}`);
    }
    return out;
}
