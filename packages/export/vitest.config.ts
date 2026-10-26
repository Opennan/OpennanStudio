import { defineConfig } from "vitest/config";
import { workspaceAliases } from "../../tooling/workspace-aliases.mjs";

export default defineConfig({
    resolve: { alias: workspaceAliases() },
    test: {
        environment: "node",
        globals: true,
        include: ["src/**/*.test.ts", "parity/**/*.test.ts"],
        testTimeout: 60_000,
        // Native media fixtures compete with the export parity/benchmark workers.
        hookTimeout: 60_000,
    },
});
