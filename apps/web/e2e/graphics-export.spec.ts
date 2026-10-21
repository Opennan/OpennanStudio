// Phase 10d end to end: a graphics clip added from the Graphics library draws in the preview and lands in the
// exported file on exactly its frames, through the fast GPU export and through the compatible ffmpeg.wasm export
// (graphics used to be left out of every export, and drew nothing outside OpenNan's own web app).
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { FIXTURE_VIDEO, createProject, execute, serveFfmpegCoreLocally, snapshot, waitForSaves } from "./helpers";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
// Amber: a colour the testsrc fixture never produces, not even on its blended edges (checked frame by frame).
const AMBER = "#c87828";

function nativeFfmpeg(): string {
    const local = path.join(ROOT, "apps/desktop/resources/ffmpeg", `${process.platform}-${process.arch}`, "ffmpeg");
    for (const candidate of [process.env.OPENNAN_PARITY_FFMPEG, local, "ffmpeg"]) {
        if (candidate && spawnSync(candidate, ["-version"]).status === 0) return candidate;
    }
    throw new Error("an ffmpeg binary is needed to decode the exported file");
}

const W = 160;
const H = 90;

/** RGBA of the exported frame shown at `seconds`, downscaled to W×H. */
function exportedFrame(file: string, seconds: number): number[] {
    return Array.from(execFileSync(nativeFfmpeg(), [
        "-hide_banner", "-loglevel", "error", "-ss", Math.max(0, seconds - 1 / 60).toFixed(4), "-i", file, "-frames:v", "1",
        "-vf", `scale=${W}:${H}:flags=area`, "-f", "rawvideo", "-pix_fmt", "rgba", "-",
    ]));
}

const isAmber = (r: number, g: number, b: number) => Math.abs(r - 200) < 22 && Math.abs(g - 120) < 22 && Math.abs(b - 40) < 22;

/** Bounding box (in W×H cells) of the amber bar, or null. */
function amberBox(pixels: number[]): { x0: number; y0: number; x1: number; y1: number; count: number } | null {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    let count = 0;
    for (let i = 0; i < pixels.length; i += 4) {
        if (!isAmber(pixels[i], pixels[i + 1], pixels[i + 2])) continue;
        const x = (i / 4) % W;
        const y = Math.floor(i / 4 / W);
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        x1 = Math.max(x1, x);
        y1 = Math.max(y1, y);
        count += 1;
    }
    return count > 0 ? { x0, y0, x1, y1, count } : null;
}

/** The graphics layer's canvas, downscaled to W×H (transparent outside the graphic); null while hidden. */
async function previewGraphic(page: Page): Promise<number[] | null> {
    return page.evaluate(([width, height]) => {
        const layer = document.querySelector<HTMLElement>("[data-graphics-clip]");
        const canvas = layer?.querySelector("canvas");
        if (!layer || !canvas || layer.style.visibility !== "visible") return null;
        const small = document.createElement("canvas");
        small.width = width;
        small.height = height;
        const ctx = small.getContext("2d")!;
        ctx.fillStyle = "#000";
        ctx.fillRect(0, 0, width, height);
        ctx.drawImage(canvas, 0, 0, width, height);
        return Array.from(ctx.getImageData(0, 0, width, height).data);
    }, [W, H] as const);
}

async function exportDownload(page: Page, dialog: Locator, button: string) {
    const download = page.waitForEvent("download", { timeout: 280_000 });
    await dialog.getByRole("button", { name: button }).click();
    const failed = dialog.getByRole("alert").waitFor({ timeout: 280_000 }).then(async () => {
        throw new Error(`Export failed: ${await dialog.getByRole("alert").innerText()}`);
    });
    return Promise.race([download, failed]);
}

/** A project with the fixture video and a recoloured lower third (1–5 s) added from the Graphics library; the preview's box of its bar. */
async function graphicProject(page: Page) {
    await serveFfmpegCoreLocally(page);
    await createProject(page, "Graphics export");
    await page.getByTestId("media-import-input").setInputFiles(FIXTURE_VIDEO);
    const tile = page.getByTestId("media-item").filter({ hasText: "testsrc-6s.webm" });
    await expect(tile).toContainText("0:06");
    await tile.hover();
    await tile.getByRole("button", { name: "Add testsrc-6s.webm to timeline" }).click();
    await expect.poll(async () => (await snapshot(page)).scenes.length).toBe(1);

    // Add a lower third from the Graphics library at 1 s, then recolour its bar.
    await execute(page, { type: "playhead.seek", seconds: 1 });
    await page.getByRole("tab", { name: "Graphics" }).click();
    await page.getByTestId("graphic-card-lower-third").click();
    await expect.poll(async () => (await snapshot(page)).clips.filter((c) => c.trackType === "remotion").length).toBe(1);
    const graphic = (await snapshot(page)).clips.find((c) => c.trackType === "remotion")!;
    expect(graphic).toMatchObject({ remotionTemplateId: "lower-third", startTime: 1, endTime: 5 });
    expect((await execute(page, {
        type: "clip.update", clipIds: [graphic.id], patch: { remotionPropsJson: JSON.stringify({ name: "Graphics export", role: "Phase 10d", barColor: AMBER }) },
    })).ok).toBe(true);
    await waitForSaves(page);

    // The preview draws it while the playhead is inside the clip, and nothing before it.
    await execute(page, { type: "playhead.seek", seconds: 0.5 });
    await expect.poll(() => previewGraphic(page)).toBeNull();
    await execute(page, { type: "playhead.seek", seconds: 3 });
    await expect.poll(async () => amberBox((await previewGraphic(page)) ?? [])?.count ?? 0, { timeout: 10_000 }).toBeGreaterThan(20);
    return amberBox((await previewGraphic(page))!)!;
}

async function exportAndCheck(page: Page, name: string, engineLabel: string, preview: NonNullable<ReturnType<typeof amberBox>>) {
    const dialog = page.getByRole("dialog", { name: "Export video" });
    const exportOnce = async (name: string, engineLabel: string) => {
        await page.getByRole("button", { name: "Export", exact: true }).click();
        await expect(dialog.locator(".export-engine")).toContainText(engineLabel, { timeout: 30_000 });
        const download = await exportDownload(page, dialog, "Export MP4");
        const file = test.info().outputPath(name);
        await fs.copyFile(await download.path(), file);
        await page.keyboard.press("Escape");
        await expect(dialog).toBeHidden();
        return file;
    };
    const check = (file: string, engine: string) => {
        expect(amberBox(exportedFrame(file, 0.5)), `${engine}: nothing before the clip`).toBeNull();
        expect(amberBox(exportedFrame(file, 5.5)), `${engine}: nothing after the clip`).toBeNull();
        const settled = amberBox(exportedFrame(file, 3));
        expect(settled, `${engine}: the graphic at 3 s`).not.toBeNull();
        // Same place as the preview draws it (the same Canvas 2D code), within two cells of the 160×90 grid.
        for (const key of ["x0", "y0", "x1", "y1"] as const) expect(Math.abs(settled![key] - preview[key]), `${engine} ${key}`).toBeLessThanOrEqual(2);
    };

    check(await exportOnce(name, engineLabel), engineLabel);
}

test("a graphic from the library draws in the preview and appears in the fast GPU export's frames", async ({ page }) => {
    test.setTimeout(300_000);
    const preview = await graphicProject(page);
    await exportAndCheck(page, "gpu.mp4", "Fast export (GPU)", preview);
});

test("the compatible ffmpeg.wasm export draws the same graphic on the same frames", async ({ page }) => {
    test.setTimeout(400_000);
    await page.addInitScript(() => window.localStorage.setItem("opennan-studio:export-engine", "ffmpeg"));
    const preview = await graphicProject(page);
    await exportAndCheck(page, "ffmpeg.mp4", "Compatible export", preview);
});
