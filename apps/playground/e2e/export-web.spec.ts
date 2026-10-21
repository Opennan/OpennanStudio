// @opennan/export in a real browser: canvas rasterizer, WebGL processor, ffmpeg.wasm export.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

// Served locally so the test needs no network; hosts serve the core next to the app (never bundled), and
// the runner checks its SHA-256 before running it.
const CORE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../node_modules/@ffmpeg/core/dist/esm");
const FFPROBE = process.env.OPENNAN_FFPROBE ?? "/opt/homebrew/bin/ffprobe";

type Harness = {
    rasterizeText(): Promise<{ width: number; height: number; boxHeight: number; opaque: number }>;
    glInvert(): Promise<number[]>;
    wasmExport(): Promise<{ container: string; encoder: string; warnings: unknown[]; base64: string }>;
};

test.beforeEach(async ({ page }) => {
    await page.route("**/ffmpeg-core/*", (route) => route.fulfill({ path: path.join(CORE_DIR, path.basename(new URL(route.request().url()).pathname)) }));
    await page.goto("/?harness=export");
    await page.waitForFunction(() => "__exportHarness" in window);
});

test("rasterizes text with the browser canvas", async ({ page }) => {
    const result = await page.evaluate(() => (window as unknown as { __exportHarness: Harness }).__exportHarness.rasterizeText());
    expect(result.boxHeight).toBeCloseTo(48 * 1.3);
    expect(result.opaque).toBeGreaterThan(100);
});

test("runs a GL effect on WebGL", async ({ page }) => {
    const pixel = await page.evaluate(() => (window as unknown as { __exportHarness: Harness }).__exportHarness.glInvert());
    expect(pixel[0]).toBeLessThan(10);
    expect(pixel[1]).toBeGreaterThan(245);
    expect(pixel[2]).toBeGreaterThan(245);
});

test("exports a 2 s timeline with ffmpeg.wasm", async ({ page }) => {
    test.setTimeout(240_000);
    const result = await page.evaluate(() => (window as unknown as { __exportHarness: Harness }).__exportHarness.wasmExport());
    expect(["mp4", "webm"]).toContain(result.container);
    expect(result.encoder).not.toBe("libx264");
    // Without GPL the wasm core has no H.264 encoder: MPEG-4 Part 2, reported as a fallback.
    expect(result.warnings.map((w) => (w as { code: string }).code)).toEqual(["encoder-fallback"]);
    const bytes = Buffer.from(result.base64, "base64");
    expect(bytes.length).toBeGreaterThan(10_000);
    if (existsSync(FFPROBE)) {
        const file = path.join(mkdtempSync(path.join(tmpdir(), "wasm-export-")), `out.${result.container}`);
        writeFileSync(file, bytes);
        const duration = Number(execFileSync(FFPROBE, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file], { encoding: "utf8" }));
        expect(duration).toBeGreaterThan(1.9);
        expect(duration).toBeLessThan(2.15);
    }
});
