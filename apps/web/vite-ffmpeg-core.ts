// Serves the ffmpeg.wasm core at ./ffmpeg-core/ in dev and preview, straight from node_modules (never
// copied into dist/). Deploys serve dist-ffmpeg-core/ffmpeg-core/ (scripts/copy-ffmpeg-core.mjs) next to the app.
import { createReadStream } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { Connect, Plugin } from "vite";

const require = createRequire(import.meta.url);
const CORE_DIR = path.join(path.dirname(require.resolve("@ffmpeg/core")), "..", "esm");
const TYPES: Record<string, string> = { "ffmpeg-core.js": "text/javascript", "ffmpeg-core.wasm": "application/wasm" };

const serveCore: Connect.NextHandleFunction = (req, res, next) => {
    const match = req.url?.match(/\/ffmpeg-core\/(ffmpeg-core\.(?:js|wasm))(?:[?#]|$)/);
    if (!match) return next();
    res.setHeader("Content-Type", TYPES[match[1]]);
    createReadStream(path.join(CORE_DIR, match[1])).pipe(res);
};

export function serveFfmpegCore(): Plugin {
    return {
        name: "opennan-ffmpeg-core",
        configureServer(server) {
            server.middlewares.use(serveCore);
        },
        configurePreviewServer(server) {
            server.middlewares.use(serveCore);
        },
    };
}
