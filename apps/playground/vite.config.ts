import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
    plugins: [react()],
    // @ffmpeg/ffmpeg starts its worker from new URL("./worker.js", import.meta.url); pre-bundling breaks that.
    optimizeDeps: { exclude: ["@ffmpeg/ffmpeg", "@ffmpeg/util"] },
    server: { port: 4317 },
    preview: { port: 4317 },
});
