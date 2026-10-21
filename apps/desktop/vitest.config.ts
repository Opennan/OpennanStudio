import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { workspaceAliases } from "../../tooling/workspace-aliases.mjs";

// Run inside Electron's Node (scripts/electron-node.mjs): main-process tests load the native modules the app
// ships. Package sources come through the workspace aliases, as in the package tests.
export default defineConfig({
    plugins: [react()],
    // @opennan/mcp/server is built from src/server-api.ts (packages/mcp/tsup.config.ts), not src/server.ts.
    resolve: {
        alias: [
            { find: /^@opennan\/mcp\/server$/, replacement: fileURLToPath(new URL("../../packages/mcp/src/server-api.ts", import.meta.url)) },
            ...workspaceAliases(),
        ],
    },
    test: {
        globals: true,
        pool: "forks",
        projects: [
            {
                extends: true,
                test: {
                    name: "main",
                    environment: "node",
                    include: ["src/main/**/*.test.ts", "src/shared/**/*.test.ts", "src/preload/**/*.test.ts"],
                },
            },
            {
                extends: true,
                test: { name: "renderer", environment: "jsdom", include: ["src/renderer/**/*.test.{ts,tsx}"] },
            },
        ],
    },
});
