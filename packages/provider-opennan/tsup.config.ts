import { defineConfig } from "tsup";

// The main entry is browser-safe (fetch only); ./testing is the Node-only fake OpenNan server for tests.
export default defineConfig([
    {
        entry: ["src/index.ts"],
        format: ["esm", "cjs"],
        dts: true,
        sourcemap: true,
        clean: true,
        target: "es2020",
    },
    {
        entry: { testing: "src/testing.ts" },
        format: ["esm"],
        dts: true,
        sourcemap: true,
        target: "node20",
        platform: "node",
    },
]);
