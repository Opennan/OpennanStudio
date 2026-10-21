// Phase 3 end to end: import media, place it, edit, reload, export a downloadable MP4, then
// export again from the already loaded encoder with the core files unreachable.
import fs from "node:fs/promises";
import { expect, test, type Download, type Locator, type Page } from "@playwright/test";
import {
    FFMPEG_CORE_ROUTE, FIXTURE_VIDEO, blurFocus, createProject, execute, readMp4Info, serveFfmpegCoreLocally, snapshot, waitForSaves,
} from "./helpers";

/** Clicks the dialog's export button and waits for the download, failing fast with the dialog's error text if the export fails. */
async function exportDownload(page: Page, dialog: Locator, button: string): Promise<Download> {
    const download = page.waitForEvent("download", { timeout: 200_000 });
    await dialog.getByRole("button", { name: button }).click();
    const alert = dialog.getByRole("alert");
    const failed = alert.waitFor({ timeout: 200_000 }).then(async () => {
        throw new Error(`Export failed: ${await alert.innerText()}`);
    });
    return Promise.race([download, failed]);
}

test("import, place, split, reload, and export an MP4; a second export uses the cached encoder", async ({ page }) => {
    test.setTimeout(300_000);
    const core = await serveFfmpegCoreLocally(page);
    await createProject(page, "Export test");

    await page.getByTestId("media-import-input").setInputFiles(FIXTURE_VIDEO);
    const tile = page.getByTestId("media-item").first();
    await expect(tile).toContainText("0:06");
    await tile.hover();
    await tile.getByRole("button", { name: "Add testsrc-6s.webm to timeline" }).click();
    await expect.poll(async () => (await snapshot(page)).scenes.length).toBe(1);

    const [scene] = (await snapshot(page)).scenes;
    await execute(page, { type: "selection.set", sceneId: scene.id });
    await execute(page, { type: "playhead.seek", seconds: 2 });
    await blurFocus(page);
    await page.keyboard.press("ControlOrMeta+b");
    await expect.poll(async () => (await snapshot(page)).scenes.length).toBe(2);
    await waitForSaves(page);

    await page.reload();
    await expect.poll(async () => (await snapshot(page)).scenes.map((s) => Math.round(s.duration * 10) / 10).sort()).toEqual([2, 4]);
    await expect(page.getByTestId("media-item")).toHaveCount(1);

    await page.getByRole("button", { name: "Export", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Export video" });
    await expect(dialog).toContainText("1280 × 720");
    // Shortcuts are off while the dialog is open, the timeline's own window listeners included:
    // with a scene selected and focus on a dialog button, Backspace and Delete remove nothing.
    await execute(page, { type: "selection.set", sceneId: (await snapshot(page)).scenes[0].id });
    await dialog.getByRole("button", { name: "Export MP4" }).focus();
    await page.keyboard.press("Backspace");
    await page.keyboard.press("Delete");
    expect((await snapshot(page)).scenes).toHaveLength(2);
    const download = await exportDownload(page, dialog, "Export MP4");
    expect(download.suggestedFilename()).toBe("export-test.mp4");
    const info = readMp4Info(await fs.readFile(await download.path()));
    expect(info.durationSeconds).toBeGreaterThan(5.9);
    expect(info.durationSeconds).toBeLessThan(6.1);
    expect(info.tracks.map((track) => track.handler).sort()).toEqual(["soun", "vide"]);
    expect(info.tracks.find((track) => track.handler === "vide")).toMatchObject({ width: 1280, height: 720 });
    await expect(dialog.getByRole("status")).toContainText("Exported export-test.mp4");
    expect(core.requests()).toBe(2);

    // The verified core is loaded now: make the core files unreachable and export again.
    await page.unroute(FFMPEG_CORE_ROUTE);
    await page.route(FFMPEG_CORE_ROUTE, (route) => route.abort());
    const again = readMp4Info(await fs.readFile(await (await exportDownload(page, dialog, "Export again")).path()));
    expect(again.durationSeconds).toBeCloseTo(info.durationSeconds, 2);
    expect(again.tracks).toHaveLength(2);
});
