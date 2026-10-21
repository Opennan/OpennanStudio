import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        environment: "jsdom",
        globals: true,
        setupFiles: ["./vitest.setup.ts"],
        // The full workspace run shares the CPU across every package; property sweeps need headroom.
        testTimeout: 20_000,
    },
});
