import { defineConfig } from "vitest/config";
import { workspaceAliases } from "../../tooling/workspace-aliases.mjs";

export default defineConfig({
    resolve: { alias: workspaceAliases() },
    test: {
        environment: "jsdom",
        globals: true,
        setupFiles: ["./vitest.setup.ts"],
    },
});
