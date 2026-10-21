import { defineConfig } from "tsup";

export default defineConfig({
    entry: ["src/index.ts", "src/node/index.ts", "src/web/index.ts", "src/web-gl/index.ts", "src/gpu-worker/index.ts"],
    format: ["esm", "cjs"],
    dts: true,
    sourcemap: true,
    clean: true,
    target: "es2020",
    tsconfig: "tsconfig.build.json",
    external: [/^@opennan\//, /^@ffmpeg\//, "regl", "mediabunny"],
});
