import { defineConfig } from "tsup";

export default defineConfig({
    entry: { index: "src/index.ts", server: "src/server-api.ts", cli: "src/bin.ts" },
    format: ["esm"],
    dts: { entry: { index: "src/index.ts", server: "src/server-api.ts" } },
    sourcemap: true,
    clean: true,
    target: "node20",
    tsconfig: "tsconfig.build.json",
});
