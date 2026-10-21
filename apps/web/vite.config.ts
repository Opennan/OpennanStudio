import { defineConfig, loadEnv, type Plugin } from "vite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { serveFfmpegCore } from "./vite-ffmpeg-core";
import { thirdPartyNotices } from "../../scripts/third-party-notices.mjs";
import { cspMetaTag, studioCsp } from "./src/platform/csp";

/** The Twemoji graphics vendored in @opennan/timeline-core (src/stickers/twemoji-svgs.ts) are CC-BY 4.0, not an npm module. */
const TWEMOJI_NOTICE = {
    name: "twemoji (graphics)",
    version: "15.1.0",
    license: "CC-BY-4.0",
    licenseText: `Emoji graphics: Twemoji by Twitter, Inc. and contributors, licensed CC-BY 4.0\nhttps://github.com/jdecked/twemoji (v15.1.0)\n\n${readFileSync(fileURLToPath(new URL("../../LICENSES/CC-BY-4.0.txt", import.meta.url)), "utf8")}`,
};

const PRODUCTION_API = "https://api.opennan.com";
/** The fake OpenNan server of the e2e suite (e2e/global-setup.ts). */
const E2E_FAKE_OPENNAN = "http://127.0.0.1:4320";

/** OpenNan API and console bases: production, except in the e2e build (the fake server, or VITE_OPENNAN_*). */
function openNanBases(mode: string): { apiBase: string; consoleBase: string; env: Record<string, string> } {
    const env = loadEnv(mode, fileURLToPath(new URL(".", import.meta.url)), "VITE_");
    if (mode !== "e2e") return { apiBase: PRODUCTION_API, consoleBase: "https://opennan.com", env };
    const apiBase = env.VITE_OPENNAN_API_BASE || E2E_FAKE_OPENNAN;
    return { apiBase, consoleBase: env.VITE_OPENNAN_CONSOLE_BASE || apiBase, env };
}

/** Writes the strict CSP into index.html. */
function contentSecurityPolicy(mode: string): Plugin {
    const { apiBase, env } = openNanBases(mode);
    const policy = studioCsp({ apiBase, ffmpegCoreBase: env.VITE_FFMPEG_CORE_BASE });
    return {
        name: "opennan-csp",
        transformIndexHtml: (html) => html.replace("<!-- csp -->", cspMetaTag(policy)),
    };
}

// base "./": the static build opens from any path (a domain root or a sub-folder).
// @ffmpeg/ffmpeg stays out of dependency pre-bundling: FFmpeg starts its worker with
// new URL("./worker.js", import.meta.url) (@ffmpeg/ffmpeg dist/esm/classes.js:103-112),
// and that ES-module worker imports the ffmpeg core at runtime (@opennan/export/web wasm-runner.ts).
// serveFfmpegCore answers ./ffmpeg-core/ in dev and preview (vite-ffmpeg-core.ts).
export default defineConfig(({ mode }) => ({
    base: "./",
    // Only the e2e build gets other OpenNan addresses; studio-runtime.ts ignores them in every other mode.
    define: mode === "e2e"
        ? { "import.meta.env.VITE_OPENNAN_API_BASE": JSON.stringify(openNanBases(mode).apiBase), "import.meta.env.VITE_OPENNAN_CONSOLE_BASE": JSON.stringify(openNanBases(mode).consoleBase) }
        : {},
    plugins: [react(), contentSecurityPolicy(mode), serveFfmpegCore(), thirdPartyNotices({ appName: "OpenNan Studio (apps/web)", licenseFile: fileURLToPath(new URL("./LICENSE", import.meta.url)), extraEntries: [TWEMOJI_NOTICE] })],
    optimizeDeps: { exclude: ["@ffmpeg/ffmpeg"] },
    worker: { format: "es" },
    server: { port: 4318 },
    preview: { port: 4318 },
}));
