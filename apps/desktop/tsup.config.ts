import { defineConfig } from "tsup";

// Main and preload bundles. tsup keeps `dependencies` external (better-sqlite3, node-pty, electron-updater:
// packaged as node_modules) and bundles devDependencies, which is every workspace package. The preload must
// be one CommonJS file: sandboxed preloads cannot require siblings.
export default defineConfig([
    {
        entry: { index: "src/main/index.ts" },
        outDir: "dist/main",
        format: ["cjs"],
        outExtension: () => ({ js: ".cjs" }),
        platform: "node",
        target: "node22",
        external: ["electron"],
        sourcemap: true,
        clean: true,
        metafile: true,
    },
    {
        entry: { index: "src/preload/index.ts" },
        outDir: "dist/preload",
        format: ["cjs"],
        outExtension: () => ({ js: ".cjs" }),
        platform: "node",
        target: "node22",
        external: ["electron"],
        noExternal: [/^(?!electron$).*/],
        sourcemap: false,
        clean: true,
    },
]);
