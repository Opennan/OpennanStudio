// Copies the ffmpeg.wasm core next to the built app as its own artifact (never inside dist/), checks it
// against the SHA-256 the runner pins, and writes the GPL notice. Deploy dist-ffmpeg-core/ffmpeg-core/ at
// <app>/ffmpeg-core/. Self-hosting distributes a GPL-2.0-or-later binary: NOTICE.txt must ship with it.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FFMPEG_CORE_SHA256, FFMPEG_CORE_VERSION } from "@opennan/export/web";

const require = createRequire(import.meta.url);
const source = path.join(path.dirname(require.resolve("@ffmpeg/core")), "..", "esm");
const out = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist-ffmpeg-core", "ffmpeg-core");
mkdirSync(out, { recursive: true });
for (const [file, expected] of Object.entries(FFMPEG_CORE_SHA256)) {
    const bytes = readFileSync(path.join(source, file));
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== expected) throw new Error(`${file}: SHA-256 ${actual} does not match the pinned ${expected}`);
    writeFileSync(path.join(out, file), bytes);
}
writeFileSync(path.join(out, "NOTICE.txt"), [
    `@ffmpeg/core ${FFMPEG_CORE_VERSION} (ffmpeg.wasm), GPL-2.0-or-later.`,
    `Corresponding source: https://github.com/ffmpegwasm/ffmpeg.wasm/tree/v${FFMPEG_CORE_VERSION} and the FFmpeg, x264 and other library sources it builds.`,
    "Loaded at export time only; OpenNan Studio's own code is not linked into it.",
    "",
].join("\n"));
console.log(`ffmpeg core ready in ${path.relative(process.cwd(), out)}`);
