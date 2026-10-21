// The web export works with no network: the core is served by the app itself and checked by hash.
import { expect, test } from "@playwright/test";
import { FIXTURE_VIDEO, createProject, snapshot } from "./helpers";

test("exports with every non-local request aborted", async ({ page, baseURL }) => {
    test.setTimeout(240_000);
    const origin = new URL(baseURL ?? "http://localhost:4318").origin;
    const blocked: string[] = [];
    // No serveFfmpegCoreLocally: nothing but the app's own origin answers.
    await page.route("**/*", (route) => {
        const url = route.request().url();
        if (url.startsWith(origin) || url.startsWith("blob:") || url.startsWith("data:")) return route.continue();
        blocked.push(url);
        return route.abort("internetdisconnected");
    });
    await createProject(page, "Offline export");
    await page.getByTestId("media-import-input").setInputFiles(FIXTURE_VIDEO);
    const tile = page.getByTestId("media-item").first();
    await expect(tile).toContainText("0:06");
    await tile.hover();
    await tile.getByRole("button", { name: "Add testsrc-6s.webm to timeline" }).click();
    await expect.poll(async () => (await snapshot(page)).scenes.length).toBe(1);

    await page.getByRole("button", { name: "Export", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Export video" });
    // The fast GPU engine (WebCodecs H.264 here): ffmpeg.wasm, served by the app itself, only adds the audio.
    await expect(dialog.locator(".export-engine")).toHaveText("Fast export (GPU)");
    await expect(dialog).toContainText("MP4 (H.264, AAC)");
    const downloadPromise = page.waitForEvent("download", { timeout: 200_000 });
    await dialog.getByRole("button", { name: "Export MP4" }).click();
    expect((await downloadPromise).suggestedFilename()).toBe("offline-export.mp4");
    await expect(dialog.getByRole("status")).toContainText("Exported offline-export.mp4");
    expect(blocked).toEqual([]);
});
