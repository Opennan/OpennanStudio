import { defineConfig } from "tsup";

export default defineConfig({
    // Every module is an entry so dependents can deep-import single files
    // ("@opennan/timeline-core/lib/shot-utils"). ESM shares code via chunks.
    entry: ["src/**/*.ts", "!src/**/*.test.ts", "!src/**/__fixtures__/**"],
    format: ["esm", "cjs"],
    dts: true,
    sourcemap: true,
    clean: true,
    target: "es2020",
    external: ["vitest"],
});
