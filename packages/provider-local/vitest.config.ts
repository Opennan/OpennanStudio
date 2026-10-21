import { defineConfig } from "vitest/config";
import { workspaceAliases } from "../../tooling/workspace-aliases.mjs";

export default defineConfig({
    resolve: { alias: workspaceAliases() },
    test: {
        environment: "node",
        globals: true,
        // The whisper integration test runs a real model.
        testTimeout: 60_000,
    },
});
