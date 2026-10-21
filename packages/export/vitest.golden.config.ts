import { defineConfig } from "vitest/config";
import { workspaceAliases } from "../../tooling/workspace-aliases.mjs";

// Renders fixtures with the local ffmpeg (GPL Homebrew build is fine for tests) and compares frames
// with committed preview snapshots. Run: pnpm --filter @opennan/export test:golden
export default defineConfig({
    resolve: { alias: workspaceAliases() },
    test: {
        environment: "node",
        globals: true,
        include: ["golden/**/*.test.ts"],
        testTimeout: 300_000,
        fileParallelism: false,
    },
});
