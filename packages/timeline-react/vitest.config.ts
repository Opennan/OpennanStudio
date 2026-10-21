import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { workspaceAliases } from "../../tooling/workspace-aliases.mjs";

export default defineConfig({
    plugins: [react()],
    resolve: { alias: workspaceAliases() },
    test: {
        environment: "jsdom",
        globals: true,
        setupFiles: ["./vitest.setup.ts"],
        // The NleTimeline interaction tests take 1-2 s alone and over 5 s when every package's tests (whisper and
        // ffmpeg runs included) share the machine.
        testTimeout: 20_000,
    },
});
