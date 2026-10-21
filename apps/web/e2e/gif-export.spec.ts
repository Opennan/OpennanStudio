// Phase 10d: the Export dialog makes an animated GIF on the fast GPU path — the format picker, the GIF's size line,
// the download as .gif, and a file that is a looping 15 fps GIF at most 640 px wide.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { FIXTURE_VIDEO, createProject, serveFfmpegCoreLocally, snapshot, waitForSaves } from "./helpers";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

function nativeFfprobe(): string {
    const local = path.join(ROOT, "apps/desktop/resources/ffmpeg", `${process.platform}-${process.arch}`, "ffprobe");
    for (const candidate of [process.env.OPENNAN_PARITY_FFMPEG?.replace(/ffmpeg$/, "ffprobe"), local, "ffprobe"]) {
        if (candidate && spawnSync(candidate, ["-version"]).status === 0) return candidate;
    }
    throw new Error("an ffprobe binary is needed to read the exported GIF");
}

test("the Export dialog makes a looping GIF on the GPU path", async ({ page }) => {
    test.setTimeout(240_000);
    await serveFfmpegCoreLocally(page);
    await createProject(page, "GIF export");
    await page.getByTestId("media-import-input").setInputFiles(FIXTURE_VIDEO);
    const tile = page.getByTestId("media-item").filter({ hasText: "testsrc-6s.webm" });
    await expect(tile).toContainText("0:06");
    await tile.hover();
    await tile.getByRole("button", { name: "Add testsrc-6s.webm to timeline" }).click();
    await expect.poll(async () => (await snapshot(page)).scenes.length).toBe(1);
    await waitForSaves(page);

    await page.getByRole("button", { name: "Export", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Export video" });
    await dialog.getByRole("radiogroup", { name: "Format" }).getByText("GIF").click();
    await expect(dialog).toContainText("640 × 360 · GIF (no audio, loops) · 15 fps");
    await expect(dialog.locator(".export-engine")).toHaveText("Fast export (GPU)");

    const download = page.waitForEvent("download", { timeout: 200_000 });
    await dialog.getByRole("button", { name: "Export GIF" }).click();
    const failed = dialog.getByRole("alert").waitFor({ timeout: 200_000 }).then(async () => {
        throw new Error(`Export failed: ${await dialog.getByRole("alert").innerText()}`);
    });
    const file = await Promise.race([download, failed]);
    expect(file.suggestedFilename()).toBe("gif-export.gif");
    const out = test.info().outputPath("export.gif");
    await fs.copyFile(await file.path(), out);
    const bytes = await fs.readFile(out);
    expect(bytes.subarray(0, 6).toString("latin1")).toBe("GIF89a");
    expect(bytes.includes(Buffer.from("NETSCAPE2.0"))).toBe(true);
    const probe = JSON.parse(execFileSync(nativeFfprobe(), [
        "-v", "error", "-count_frames", "-show_entries", "stream=codec_name,width,height,nb_read_frames,r_frame_rate", "-of", "json", out,
    ], { encoding: "utf8" }));
    expect(probe.streams).toHaveLength(1);
    expect(probe.streams[0]).toMatchObject({ codec_name: "gif", width: 640, height: 360, r_frame_rate: "15/1" });
    expect(Number(probe.streams[0].nb_read_frames)).toBe(90);
});
