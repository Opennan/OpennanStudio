// Phase 10c end to end: the Export dialog takes the fast GPU path (WebGL2 compositor + WebCodecs), shows the
// engine, progress, and time left, can be cancelled, and the exported file's frames match the preview — with a
// transition, a filter, a mask, and an effect on the main track.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { FIXTURE_VIDEO, createProject, execute, readMp4Info, serveFfmpegCoreLocally, snapshot, waitForSaves } from "./helpers";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

function nativeFfmpeg(): string {
    const local = path.join(ROOT, "apps/desktop/resources/ffmpeg", `${process.platform}-${process.arch}`, "ffmpeg");
    for (const candidate of [process.env.OPENNAN_PARITY_FFMPEG, local, "ffmpeg"]) {
        if (candidate && spawnSync(candidate, ["-version"]).status === 0) return candidate;
    }
    throw new Error("an ffmpeg binary is needed to decode the exported file");
}

/** The frame shown at `seconds` (the input seek keeps the first frame at or after the point: half a frame early). */
function exportedFrame(file: string, seconds: number, w = 160, h = 90): number[] {
    return Array.from(execFileSync(nativeFfmpeg(), [
        "-hide_banner", "-loglevel", "error", "-ss", Math.max(0, seconds - 1 / 60).toFixed(4), "-i", file, "-frames:v", "1",
        "-vf", `scale=${w}:${h}:flags=area`, "-f", "rawvideo", "-pix_fmt", "rgba", "-",
    ]));
}

function meanDiff(a: number[], b: number[]): number {
    let sum = 0;
    let count = 0;
    for (let i = 0; i < a.length; i += 1) {
        if (i % 4 === 3) continue;
        sum += Math.abs(a[i] - b[i]);
        count += 1;
    }
    return sum / count;
}

/** RGBA of the main-track look overlay, downscaled to w×h; null while it shows nothing. */
async function overlayPixels(page: Page, w = 160, h = 90): Promise<number[] | null> {
    return page.evaluate(([width, height]) => {
        const overlay = document.querySelector<HTMLCanvasElement>('[data-testid="lane-look-overlay"]');
        if (!overlay || overlay.style.opacity !== "1" || overlay.width < 2) return null;
        const small = document.createElement("canvas");
        small.width = width;
        small.height = height;
        const ctx = small.getContext("2d")!;
        ctx.drawImage(overlay, 0, 0, width, height);
        return Array.from(ctx.getImageData(0, 0, width, height).data);
    }, [w, h] as const);
}

async function twoScenes(page: Page): Promise<[string, string]> {
    await page.getByTestId("media-import-input").setInputFiles(FIXTURE_VIDEO);
    const tile = page.getByTestId("media-item").filter({ hasText: "testsrc-6s.webm" });
    await expect(tile).toContainText("0:06");
    for (let i = 0; i < 2; i += 1) {
        await tile.hover();
        await tile.getByRole("button", { name: "Add testsrc-6s.webm to timeline" }).click();
        await expect.poll(async () => (await snapshot(page)).scenes.length).toBe(i + 1);
    }
    const [a, b] = (await snapshot(page)).scenes;
    return [a.id, b.id];
}

async function exportDownload(page: Page, dialog: Locator, button: string) {
    const download = page.waitForEvent("download", { timeout: 200_000 });
    await dialog.getByRole("button", { name: button }).click();
    const failed = dialog.getByRole("alert").waitFor({ timeout: 200_000 }).then(async () => {
        throw new Error(`Export failed: ${await dialog.getByRole("alert").innerText()}`);
    });
    return Promise.race([download, failed]);
}

test("the Export dialog runs the fast GPU export, can cancel it, and the frames match the preview", async ({ page }) => {
    test.setTimeout(300_000);
    await serveFfmpegCoreLocally(page);
    await createProject(page, "GPU export");
    const [a, b] = await twoScenes(page);
    expect((await execute(page, { type: "transition.set", sceneId: a, transition: "spin", duration: 1 })).ok).toBe(true);
    expect((await execute(page, { type: "look.set", sceneId: a, filter: "teal_orange", intensity: 1 })).ok).toBe(true);
    expect((await execute(page, { type: "mask.set", sceneId: b, mask: { shape: "circle", width: 0.8, height: 0.8, feather: 0.2 } })).ok).toBe(true);
    expect((await execute(page, { type: "clip.effect.add", sceneId: b, effectId: "fx_vhs" })).ok).toBe(true);
    await waitForSaves(page);

    // On the 30 fps frame grid: a spin turns fast, so the preview and the file must show the same frame.
    const times = [45, 173, 187, 270].map((frame) => frame / 30);
    const preview: number[][] = [];
    for (const t of times) {
        await execute(page, { type: "playhead.seek", seconds: t });
        await page.waitForTimeout(900);
        const pixels = await overlayPixels(page);
        expect(pixels, `preview at ${t}`).not.toBeNull();
        preview.push(pixels!);
    }

    await page.getByRole("button", { name: "Export", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Export video" });
    await expect(dialog.locator(".export-engine")).toHaveText("Fast export (GPU)");
    await expect(dialog).toContainText("MP4 (H.264, AAC)");

    // Cancel mid-render: the dialog says so, and the next export runs.
    await dialog.getByRole("button", { name: "Export MP4" }).click();
    await expect(dialog.getByText(/Rendering \d+%/)).toBeVisible({ timeout: 60_000 });
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await page.getByRole("button", { name: "Export", exact: true }).click();
    await expect(dialog).toContainText("Export cancelled.");

    const download = await exportDownload(page, dialog, "Export MP4");
    expect(download.suggestedFilename()).toBe("gpu-export.mp4");
    // Phase 10d: the file was streamed to disk (the origin private file system), not built in memory; the encoded
    // intermediate is gone, the export stays until the dialog lets go of it.
    const stored = await page.evaluate(async () => {
        const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle("opennan-exports");
        const names: string[] = [];
        for await (const name of (dir as unknown as { keys(): AsyncIterable<string> }).keys()) names.push(name);
        return names;
    });
    expect(stored.filter((name) => name.startsWith("video-"))).toEqual([]);
    expect(stored.filter((name) => /^export-.*\.mp4$/.test(name))).toHaveLength(1);
    const file = test.info().outputPath("gpu.mp4");
    await fs.copyFile(await download.path(), file);
    const info = readMp4Info(await fs.readFile(file));
    expect(info.durationSeconds).toBeCloseTo(12, 1);
    expect(info.tracks.map((track) => track.handler).sort()).toEqual(["soun", "vide"]);
    times.forEach((t, i) => {
        const diff = meanDiff(exportedFrame(file, t), preview[i]);
        // The 10a looks spec's export-vs-preview limit (the GPU path measured 5–7 there, ffmpeg 6–8). Inside the spin
        // (frame 173) the transition samples the turning frame nearest-neighbour at the canvas's own resolution, and the
        // preview canvas is smaller than the 720p file: measured 15.0 there, 2–5 elsewhere.
        expect(diff, `GPU export vs preview at ${t.toFixed(3)}s`).toBeLessThan(i === 1 ? 20 : 14);
    });
});
