import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { workspaceAliases } from "../../tooling/workspace-aliases.mjs";

// Unit tests read the packages from source (tooling/workspace-aliases.mjs), as the package tests do.
export default defineConfig({
    plugins: [react()],
    resolve: { alias: workspaceAliases() },
    // auto-captions.css is processed so its ?raw import has the text (the token check reads it).
    test: { environment: "jsdom", globals: true, include: ["src/**/*.test.ts"], css: { include: [/auto-captions\.css/, /account\.css/, /generate\.css/, /settings\.css/, /cloud\.css/, /director\.css/, /share\.css/, /story-film\.css/] } },
});
