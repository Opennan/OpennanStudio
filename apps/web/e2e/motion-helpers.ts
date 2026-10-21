// Shared helpers for the phase 10b specs (text, captions, stickers, keyframes, speed, handles): the preview
// frame as the user sees it (a screenshot of the project frame, box-downscaled), the web export through the
// dialog with the local ffmpeg core, and frames decoded from the exported file with a native ffmpeg.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { execute, waitForSaves } from "./helpers";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

export interface Frame { w: number; h: number; data: number[] }
export interface Rect { x: number; y: number; w: number; h: number }

export async function openLibraryTab(page: Page, name: string): Promise<void> {
    await page.getByTestId("editor-library").getByRole("tab", { name, exact: true }).click();
}

/** Clears the clip and scene selection, so no transform chrome is drawn over the preview. */
export async function deselect(page: Page): Promise<void> {
    await execute(page, { type: "selection.set", clipIds: [] });
    await execute(page, { type: "selection.set", sceneId: null });
}

/** The project frame inside the preview, in viewport pixels (preview-panel's debug hook). */
export async function previewFrameRect(page: Page): Promise<Rect> {
    await expect.poll(() => page.evaluate(() => {
        const fn = (window as unknown as { __opennanPreviewFrameRect?: () => Rect | null }).__opennanPreviewFrameRect;
        const r = fn?.();
        return Boolean(r && r.w > 10 && r.h > 10);
    })).toBe(true);
    return page.evaluate(() => (window as unknown as { __opennanPreviewFrameRect: () => Rect }).__opennanPreviewFrameRect());
}

/** A screenshot of the project frame (everything the preview composites), box-averaged to w×h RGBA. */
export async function previewFrame(page: Page, w = 160, h = 90): Promise<Frame> {
    const r = await previewFrameRect(page);
    const png = await page.screenshot({ clip: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.w), height: Math.round(r.h) }, animations: "disabled", caret: "hide" });
    const data = await page.evaluate(async ([b64, width, height]) => {
        const img = new Image();
        img.src = `data:image/png;base64,${b64}`;
        await img.decode();
        const W = img.naturalWidth;
        const H = img.naturalHeight;
        const canvas = document.createElement("canvas");
        canvas.width = W;
        canvas.height = H;
        const ctx = canvas.getContext("2d")!;
        ctx.drawImage(img, 0, 0);
        const src = ctx.getImageData(0, 0, W, H).data;
        const out = new Array<number>(width * height * 4).fill(0);
        for (let y = 0; y < height; y += 1) {
            const y0 = Math.floor((y * H) / height);
            const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * H) / height));
            for (let x = 0; x < width; x += 1) {
                const x0 = Math.floor((x * W) / width);
                const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * W) / width));
                let r = 0, g = 0, b = 0, n = 0;
                for (let yy = y0; yy < y1; yy += 1) {
                    for (let xx = x0; xx < x1; xx += 1) {
                        const i = (yy * W + xx) * 4;
                        r += src[i]; g += src[i + 1]; b += src[i + 2]; n += 1;
                    }
                }
                const o = (y * width + x) * 4;
                out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = 255;
            }
        }
        return out;
    }, [png.toString("base64"), w, h] as const);
    return { w, h, data };
}

/** The preview frame once two reads 150 ms apart agree (decoders and font loads settle after a seek). */
export async function stablePreviewFrame(page: Page, w = 160, h = 90): Promise<Frame> {
    let prev = await previewFrame(page, w, h);
    for (let i = 0; i < 30; i += 1) {
        await page.waitForTimeout(150);
        const next = await previewFrame(page, w, h);
        if (meanDiff(prev, next) < 0.25) return next;
        prev = next;
    }
    return prev;
}

/**
 * Seeks (paused) and returns the settled preview frame. A seek selects the scene under the playhead (ScenePreview
 * onSceneChange), whose transform chrome the preview then draws: the selection is cleared after the seek.
 */
export async function previewAt(page: Page, seconds: number, w = 160, h = 90): Promise<Frame> {
    await execute(page, { type: "playhead.seek", seconds });
    await page.waitForTimeout(150);
    await deselect(page);
    await page.waitForTimeout(100);
    return stablePreviewFrame(page, w, h);
}

export function meanDiff(a: Frame, b: Frame): number {
    let sum = 0;
    let count = 0;
    for (let i = 0; i < a.data.length; i += 1) {
        if (i % 4 === 3) continue;
        sum += Math.abs(a.data[i] - b.data[i]);
        count += 1;
    }
    return sum / count;
}

/** How many pixels match `test` (r, g, b). */
export function countPixels(frame: Frame, test: (r: number, g: number, b: number) => boolean, region?: Rect): number {
    let n = 0;
    const x0 = region?.x ?? 0, y0 = region?.y ?? 0, x1 = region ? region.x + region.w : frame.w, y1 = region ? region.y + region.h : frame.h;
    for (let y = y0; y < y1; y += 1) {
        for (let x = x0; x < x1; x += 1) {
            const i = (y * frame.w + x) * 4;
            if (test(frame.data[i], frame.data[i + 1], frame.data[i + 2])) n += 1;
        }
    }
    return n;
}

/** Mean x and y of the pixels matching `test`, or null when none match. */
export function centroid(frame: Frame, test: (r: number, g: number, b: number) => boolean): { x: number; y: number; n: number } | null {
    let sx = 0, sy = 0, n = 0;
    for (let y = 0; y < frame.h; y += 1) {
        for (let x = 0; x < frame.w; x += 1) {
            const i = (y * frame.w + x) * 4;
            if (test(frame.data[i], frame.data[i + 1], frame.data[i + 2])) { sx += x; sy += y; n += 1; }
        }
    }
    return n === 0 ? null : { x: sx / n, y: sy / n, n };
}

export const isWhite = (r: number, g: number, b: number) => r > 170 && g > 170 && b > 170;
export const isLit = (r: number, g: number, b: number) => r + g + b > 90;

export function nativeFfmpeg(): string {
    const local = path.join(ROOT, "apps/desktop/resources/ffmpeg", `${process.platform}-${process.arch}`, "ffmpeg");
    for (const candidate of [process.env.OPENNAN_PARITY_FFMPEG, local, "ffmpeg"]) {
        if (candidate && spawnSync(candidate, ["-version"]).status === 0) return candidate;
    }
    throw new Error("an ffmpeg binary is needed to decode the exported file");
}

/** One frame of the exported file at `seconds`, area-scaled to w×h RGBA. */
export function exportedFrame(file: string, seconds: number, w = 160, h = 90): Frame {
    const raw = execFileSync(nativeFfmpeg(), [
        "-hide_banner", "-loglevel", "error", "-ss", seconds.toFixed(3), "-i", file, "-frames:v", "1",
        "-vf", `scale=${w}:${h}:flags=area`, "-f", "rawvideo", "-pix_fmt", "rgba", "-",
    ]);
    return { w, h, data: Array.from(raw) };
}

/** Writes one exported frame as a PNG (screenshots). */
export function exportedFramePng(file: string, seconds: number, out: string): void {
    execFileSync(nativeFfmpeg(), ["-hide_banner", "-loglevel", "error", "-y", "-ss", seconds.toFixed(3), "-i", file, "-frames:v", "1", out]);
}

/** Exports through the dialog (720p default) and copies the MP4 into the test's output folder. */
export async function exportMp4(page: Page, name: string, timeout = 400_000): Promise<string> {
    await waitForSaves(page);
    await page.getByRole("button", { name: "Export", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Export video" });
    await expect(dialog).toContainText("1280 × 720");
    const downloadPromise = page.waitForEvent("download", { timeout });
    await dialog.getByRole("button", { name: "Export MP4" }).click();
    const failed = dialog.getByRole("alert").waitFor({ timeout }).then(async () => {
        throw new Error(`Export failed: ${await dialog.getByRole("alert").innerText()}`);
    });
    const download = await Promise.race([downloadPromise, failed]);
    const file = test.info().outputPath(name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.copyFile(await download.path(), file);
    await dialog.getByRole("button", { name: "Close" }).first().click().catch(() => undefined);
    return file;
}

/** Saturated colour (stickers, highlights), not gray UI hints or black. */
export const isColorful = (r: number, g: number, b: number) => Math.max(r, g, b) - Math.min(r, g, b) > 60;
