import { defineConfig } from "vite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { thirdPartyNotices } from "../../scripts/third-party-notices.mjs";

/** The Twemoji graphics vendored in @opennan/timeline-core (src/stickers/twemoji-svgs.ts) are CC-BY 4.0, not an npm module. */
const TWEMOJI_NOTICE = {
    name: "twemoji (graphics)",
    version: "15.1.0",
    license: "CC-BY-4.0",
    licenseText: `Emoji graphics: Twemoji by Twitter, Inc. and contributors, licensed CC-BY 4.0\nhttps://github.com/jdecked/twemoji (v15.1.0)\n\n${readFileSync(fileURLToPath(new URL("../../LICENSES/CC-BY-4.0.txt", import.meta.url)), "utf8")}`,
};

// The renderer: the @opennan/web editor shell (its TypeScript sources through @opennan/web/studio) plus the
// desktop runtime. Built packages are used as in apps/web; workspace aliases are for Vitest only.
export default defineConfig({
    root: fileURLToPath(new URL("./src/renderer", import.meta.url)),
    base: "./",
    plugins: [react(), thirdPartyNotices({ appName: "OpenNan Studio (apps/desktop renderer)", licenseFile: fileURLToPath(new URL("./LICENSE", import.meta.url)), extraEntries: [TWEMOJI_NOTICE] })],
    resolve: { dedupe: ["react", "react-dom"] },
    worker: { format: "es" },
    build: { outDir: fileURLToPath(new URL("./dist/renderer", import.meta.url)), emptyOutDir: true, target: "chrome140" },
});
