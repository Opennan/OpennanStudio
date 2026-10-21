import { defineConfig } from "vitest/config";
import { workspaceAliases } from "../../tooling/workspace-aliases.mjs";

export default defineConfig({
    resolve: { alias: workspaceAliases() },
    test: { environment: "node", globals: true, testTimeout: 30_000 },
});
