// Phase 10b end to end: the Stickers tab finds "fire", a click adds a bundled sticker clip (stickerId, no
// media URL), a drag lands another on the timeline, the inspector sets an in-animation, and the exported MP4
// shows the sticker (and matches the preview) while the empty stretch stays black.
import { expect, test, type Page } from "@playwright/test";
import { createProject, execute, serveFfmpegCoreLocally, snapshot, timelineCanvasBox, timelineZoom, waitForSaves } from "./helpers";
import { countPixels, deselect, exportMp4, exportedFrame, isColorful, meanDiff, openLibraryTab, previewAt } from "./motion-helpers";

interface StickerClip { id: string; trackType: string; startTime: number; endTime: number; stickerId?: string | null; mediaUrl?: string | null; animationJson?: string | null }

async function stickers(page: Page): Promise<StickerClip[]> {
    return ((await snapshot(page)).clips as unknown as StickerClip[]).filter((c) => c.trackType === "sticker").sort((a, b) => a.startTime - b.startTime);
}

const FIRE = "twemoji:1f525";

test("search, click, and drag stickers; an in-animation; the export shows the sticker", async ({ page }) => {
    test.setTimeout(420_000);
    await serveFfmpegCoreLocally(page);
    await createProject(page, "Stickers");

    await openLibraryTab(page, "Stickers");
    const panel = page.getByTestId("library-stickers");
    await expect(panel.getByTestId(/^sticker-card-/)).toHaveCount(96);
    await panel.getByRole("searchbox").fill("fire");
    await expect(panel.getByTestId(`sticker-card-${FIRE}`)).toBeVisible();
    expect(await panel.getByTestId(/^sticker-card-/).count()).toBeLessThan(96);
    await expect(panel).toContainText(/Twemoji/);

    // Click: a 3 s sticker clip at the playhead, selected.
    await panel.getByTestId(`sticker-card-${FIRE}`).click();
    await expect.poll(async () => (await stickers(page)).length).toBe(1);
    const [fire] = await stickers(page);
    expect(fire).toMatchObject({ stickerId: FIRE, startTime: 0, endTime: 3 });
    expect(fire.mediaUrl ?? null).toBeNull();
    await expect.poll(async () => (await snapshot(page) as unknown as { selection: { clipIds: string[] } }).selection.clipIds).toEqual([fire.id]);

    // Drag a second sticker onto the timeline at 4 s.
    await panel.getByRole("searchbox").fill("");
    const second = panel.getByTestId(/^sticker-card-opennan:/).first();
    const secondId = (await second.getAttribute("data-testid"))!.replace("sticker-card-", "");
    const canvas = page.locator('[data-testid="timeline-tracks-scroll"] canvas');
    const box = await timelineCanvasBox(page);
    const zoom = await timelineZoom(page);
    await second.dragTo(canvas, { targetPosition: { x: 4 * zoom, y: Math.min(box.height - 10, 60) } });
    await expect.poll(async () => (await stickers(page)).length).toBe(2);
    const dropped = (await stickers(page)).find((c) => c.stickerId === secondId)!;
    expect(dropped, `a ${secondId} clip`).toBeTruthy();
    expect(dropped.startTime).toBeGreaterThan(3);
    expect(dropped.startTime).toBeLessThan(5);

    // Inspector → Animation → In → Zoom in, then Out → Fade out.
    await execute(page, { type: "selection.set", clipIds: [fire.id] });
    await page.getByTestId("inspector-tab-animation").click();
    await expect(page.getByTestId("anim-slot-loop")).toBeVisible();
    await page.getByTestId("anim-slot-in").click();
    await page.getByTestId("anim-card-in-zoom_in").click();
    const anim = async () => JSON.parse((await stickers(page)).find((c) => c.id === fire.id)?.animationJson ?? "{}");
    await expect.poll(async () => (await anim()).in?.id).toBe("zoom_in");
    await page.getByTestId("anim-slot-out").click();
    await page.getByTestId("anim-card-out-fade_out").click();
    await expect.poll(async () => (await anim()).out?.id).toBe("fade_out");
    await waitForSaves(page);
    await execute(page, { type: "history.undo" });
    await expect.poll(async () => (await anim()).out).toBeUndefined();
    expect((await anim()).in?.id).toBe("zoom_in");
    await waitForSaves(page);

    // The in-animation grows the sticker: fewer lit pixels early in the window than at rest.
    await deselect(page);
    const early = countPixels(await previewAt(page, 0.15), isColorful);
    const rest = await previewAt(page, 1.5);
    const empty = await previewAt(page, 3.5);
    // Between the stickers the frame is empty (the preview shows its gray "Select a scene" hint, no colour).
    expect(early, "zoom in starts smaller").toBeLessThan(countPixels(rest, isColorful) * 0.9);
    expect(countPixels(rest, isColorful), "the sticker in the preview").toBeGreaterThan(40);
    expect(countPixels(empty, isColorful), "nothing between the stickers").toBeLessThan(5);

    const file = await exportMp4(page, "stickers.mp4");
    const exportRest = exportedFrame(file, 1.5);
    const exportEmpty = exportedFrame(file, 3.5);
    const exportEarly = exportedFrame(file, 0.15);
    expect(countPixels(exportRest, isColorful), "the sticker in the export").toBeGreaterThan(40);
    expect(countPixels(exportEmpty, isColorful), "black between the stickers").toBeLessThan(5);
    expect(countPixels(exportEarly, isColorful), "zoom in in the export").toBeLessThan(countPixels(exportRest, isColorful) * 0.9);
    expect(countPixels(exportedFrame(file, 5), isColorful), "the dropped sticker in the export").toBeGreaterThan(20);
    expect(meanDiff(exportRest, rest), "export vs preview at 1.5 s").toBeLessThan(6);
});
