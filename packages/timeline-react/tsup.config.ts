import { defineConfig } from "tsup";

export default defineConfig({
    entry: ["src/index.ts"],
    format: ["esm", "cjs"],
    dts: true,
    sourcemap: true,
    clean: false,
    target: "es2020",
    tsconfig: "tsconfig.build.json",
    // Next.js hosts import the package from client components.
    banner: { js: '"use client";' },
});
