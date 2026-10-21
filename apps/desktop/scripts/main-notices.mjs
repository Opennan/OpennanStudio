// THIRD_PARTY_NOTICES.txt and third-party-licenses.json for the main-process bundle (spec §3): every package
// esbuild bundled into dist/main/index.cjs (from tsup's metafile) plus the runtime dependencies packaged as
// node_modules (better-sqlite3, node-pty, electron-updater, and what they depend on). The preload bundles only
// this repo's code. `pnpm check:licenses` reads the JSON (scripts/check-licenses.mjs).
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { LICENSE_MANIFEST, collectNotices, formatNotices } from "../../../scripts/third-party-notices.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Absolute module paths from an esbuild metafile (inputs are relative to the build's working directory). */
export function bundledModules(metafile, cwd) {
    return Object.keys(metafile.inputs ?? {}).map((input) => path.resolve(cwd, input.replace(/^[a-z-]+:/, "")));
}

/** A package's production dependency closure as file paths inside each package (one per package). */
export function runtimeClosure(names, fromDir) {
    const seen = new Map();
    const visit = (name, from) => {
        let manifest;
        try {
            manifest = createRequire(path.join(from, "package.json")).resolve(`${name}/package.json`);
        } catch {
            return; // optional dependency not installed for this platform
        }
        const dir = fs.realpathSync(path.dirname(manifest));
        if (seen.has(dir)) return;
        seen.set(dir, path.join(dir, "package.json"));
        const json = JSON.parse(fs.readFileSync(manifest, "utf8"));
        for (const dep of Object.keys({ ...json.dependencies, ...json.optionalDependencies })) visit(dep, dir);
    };
    for (const name of names) visit(name, fromDir);
    return [...seen.values()];
}

/** Programs and data shipped next to the app (or downloaded by it), not bundled into the main process. */
export function separateComponentsNotice({ ffmpegVersion, whisperVersion }) {
    return [
        "",
        "Components shipped next to the app, not bundled into this file",
        "",
        `FFmpeg ${ffmpegVersion}  LGPL (no GPL or non-free components)  https://ffmpeg.org`,
        "  Resources/ffmpeg: LICENSE.txt, SOURCE.txt (source URL, SHA-256, configure line). Run as a separate process.",
        `whisper.cpp ${whisperVersion}  MIT  https://github.com/ggml-org/whisper.cpp`,
        "  Resources/whisper: LICENSE.txt, SOURCE.txt, checksums.json. Run as a separate process for auto captions.",
        "  whisper-cli includes miniaudio (public domain or MIT No Attribution) and stb_vorbis (public domain or MIT).",
        "Whisper models (tiny, base, small)  MIT (OpenAI; ggml conversion by the whisper.cpp project)",
        "  Downloaded on first use from https://huggingface.co/ggerganov/whisper.cpp at a pinned revision, checked by SHA-256;",
        "  not shipped. Resources/whisper/MODELS-LICENSE.txt has the license text.",
        "",
    ].join("\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
    const out = path.join(ROOT, "dist", "main");
    const metafile = JSON.parse(fs.readFileSync(path.join(out, "metafile-cjs.json"), "utf8"));
    const runtime = Object.keys(JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).dependencies ?? {});
    const packages = collectNotices([...bundledModules(metafile, ROOT), ...runtimeClosure(runtime, ROOT)]);
    const versions = {
        ffmpegVersion: JSON.parse(fs.readFileSync(path.join(ROOT, "ffmpeg", "manifest.json"), "utf8")).version,
        whisperVersion: JSON.parse(fs.readFileSync(path.join(ROOT, "whisper", "manifest.json"), "utf8")).version,
    };
    fs.writeFileSync(path.join(out, "THIRD_PARTY_NOTICES.txt"), formatNotices("OpenNan Studio (apps/desktop main process)", packages) + separateComponentsNotice(versions));
    fs.writeFileSync(path.join(out, LICENSE_MANIFEST), `${JSON.stringify(packages.map(({ name, version, license }) => ({ name, version, license })), null, 2)}\n`);
    fs.copyFileSync(path.join(ROOT, "LICENSE"), path.join(out, "LICENSE"));
    console.log(`main-notices: ${packages.length} packages`);
}
