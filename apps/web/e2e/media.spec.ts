// Media bin: import (picker and drop), add to the timeline, drag to the timeline, trim, persistence.
import { expect, test } from "@playwright/test";
import {
    BLACK_PNG_BASE64, FIXTURE_VIDEO, createProject, dragBy, execute, sceneRects, silentWav, snapshot, timelineCanvasBox,
    timelineZoom, waitForSaves,
} from "./helpers";

test.beforeEach(async ({ page }) => {
    await createProject(page, "Media test");
});

test("imports a video, appends it to V1, and both survive a reload", async ({ page }) => {
    await page.getByTestId("media-import-input").setInputFiles(FIXTURE_VIDEO);
    const tile = page.getByTestId("media-item").filter({ hasText: "testsrc-6s.webm" });
    await expect(tile).toContainText("0:06");
    await tile.hover();
    await tile.getByRole("button", { name: "Add testsrc-6s.webm to timeline" }).click();
    await expect.poll(async () => (await snapshot(page)).scenes.length).toBe(1);
    const [scene] = (await snapshot(page)).scenes;
    expect(scene.trackIndex).toBe(1);
    expect(scene.duration).toBeCloseTo(6, 0);
    await waitForSaves(page);

    await page.reload();
    await expect(page.getByTestId("media-item")).toHaveCount(1);
    await expect.poll(async () => (await snapshot(page)).scenes.length).toBe(1);
    await expect(page.locator(".editor-preview video").first()).toBeAttached();
    // The preview fills its grid cell: the video is on screen, not a 0×0 box.
    await expect.poll(async () => (await page.locator(".editor-preview video").first().boundingBox())?.height ?? 0).toBeGreaterThan(200);
});

test("dropping files on the bin imports them; an image goes to the timeline as a sticker", async ({ page }) => {
    const dataTransfer = await page.evaluateHandle((base64) => {
        const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
        const transfer = new DataTransfer();
        transfer.items.add(new File([bytes], "black.png", { type: "image/png" }));
        return transfer;
    }, BLACK_PNG_BASE64);
    await page.getByTestId("media-drop-zone").dispatchEvent("dragover", { dataTransfer });
    await page.getByTestId("media-drop-zone").dispatchEvent("drop", { dataTransfer });
    const tile = page.getByTestId("media-item").filter({ hasText: "black.png" });
    await expect(tile).toBeVisible();
    await tile.hover();
    await tile.getByRole("button", { name: "Add black.png to timeline" }).click();
    await expect.poll(async () => (await snapshot(page)).clips.filter((c) => c.trackType === "sticker").length).toBe(1);
});

test("audio goes onto an audio track at the playhead", async ({ page }) => {
    await page.getByTestId("media-import-input").setInputFiles({ name: "tone.wav", mimeType: "audio/wav", buffer: silentWav(2) });
    const tile = page.getByTestId("media-item").filter({ hasText: "tone.wav" });
    await expect(tile).toContainText("0:02");
    await tile.hover();
    await tile.getByRole("button", { name: "Add tone.wav to timeline" }).click();
    await expect.poll(async () => (await snapshot(page)).clips.filter((c) => c.trackType === "audio").length).toBe(1);
    const [clip] = (await snapshot(page)).clips.filter((c) => c.trackType === "audio");
    expect(clip.endTime - clip.startTime).toBeCloseTo(2, 1);
});

test("dragging a video tile onto the main track adds a main-track clip; below the tracks, an overlay clip", async ({ page }) => {
    await page.getByTestId("media-import-input").setInputFiles(FIXTURE_VIDEO);
    const tile = page.getByTestId("media-item").first();
    await expect(tile).toContainText("0:06");
    const canvas = page.locator('[data-testid="timeline-tracks-scroll"] canvas');
    await tile.dragTo(canvas, { targetPosition: { x: 200, y: 30 } });
    await expect.poll(async () => (await snapshot(page)).scenes.length).toBe(1);
    expect((await snapshot(page)).scenes[0]).toMatchObject({ trackIndex: 1 });
    expect((await snapshot(page)).scenes[0].duration).toBeCloseTo(6, 0);
    const box = await timelineCanvasBox(page);
    await tile.dragTo(canvas, { targetPosition: { x: 200, y: box.height - 12 } });
    await expect.poll(async () => (await snapshot(page)).clips.filter((c) => c.trackType === "video").length).toBe(1);
    const [clip] = (await snapshot(page)).clips.filter((c) => c.trackType === "video");
    expect(clip.trackIndex).toBeGreaterThanOrEqual(2);
    expect(clip.endTime - clip.startTime).toBeCloseTo(6, 0);
});

test("dragging the right edge of a V1 scene trims it, and the trim survives a reload", async ({ page }) => {
    await page.getByTestId("media-import-input").setInputFiles(FIXTURE_VIDEO);
    const tile = page.getByTestId("media-item").filter({ hasText: "testsrc-6s.webm" });
    await expect(tile).toContainText("0:06");
    await tile.hover();
    await tile.getByRole("button", { name: "Add testsrc-6s.webm to timeline" }).click();
    await expect.poll(async () => (await snapshot(page)).scenes.length).toBe(1);
    const [scene] = (await snapshot(page)).scenes;
    // Edges resize only a selected scene (packages/timeline-core/src/timeline/canvas/hit-detector.ts:209-215).
    await execute(page, { type: "selection.set", sceneId: scene.id });
    await expect.poll(async () => (await sceneRects(page)).length).toBe(1);
    const box = await timelineCanvasBox(page);
    const px = await timelineZoom(page);
    const [before] = await sceneRects(page);
    await dragBy(page, { x: box.x + before.x + before.duration * px - 3, y: box.y + before.y + 10 }, -2 * px);
    await expect.poll(async () => (await snapshot(page)).scenes[0].duration).toBeLessThan(5);
    const trimmed = (await snapshot(page)).scenes[0].duration;
    await waitForSaves(page);

    await page.reload();
    await expect.poll(async () => (await snapshot(page)).scenes[0]?.duration).toBeCloseTo(trimmed, 2);
});
