// Screenshots of the phase 10c editor for docs/theme/phase-10c/ (dark, the only theme, 1440×900): masks, multi-select,
// keyframe diamonds and the graph editor, paste attributes, and the fast GPU export.
// SCREENSHOTS=1 pnpm --filter @opennan/web exec playwright test e2e/screenshots-10c.spec.ts. Skipped otherwise.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { blurFocus, createProject, execute, serveFfmpegCoreLocally, snapshot, timelineCanvasBox, waitForSaves } from "./helpers";
import { ROOT, deselect, openLibraryTab } from "./motion-helpers";

const OUT = path.join(ROOT, "docs", "theme", "phase-10c");
test.skip(!process.env.SCREENSHOTS, "set SCREENSHOTS=1 to write docs/theme/phase-10c");
test.use({ colorScheme: "dark" });

const shot = async (page: Page, name: string, clip?: { x: number; y: number; width: number; height: number }) => {
    await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(OUT, `${name}.png`), ...(clip ? { clip } : {}) });
};

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const SAMPLES = [path.join(FIXTURES, "sample-gradients.webm"), path.join(FIXTURES, "sample-mandelbrot.webm")];

type StudioWindow = { __studio: { store: { getState(): { timelineData: { tracks: unknown[] } } } } };
interface Box { cx: number; cy: number; w: number; h: number; rotation: number }
interface KeyframeDiamonds { clipId: string | null; diamonds: Array<{ time: number; x: number; y: number }> }

const previewBoxes = (page: Page) => page.evaluate(() => (
    (window as unknown as { __opennanPreviewBoxes?: () => { items: Record<string, Box>; group: Box | null } | null }).__opennanPreviewBoxes?.() ?? null
));

async function dismissToasts(page: Page): Promise<void> {
    for (const button of await page.getByRole("button", { name: "Dismiss" }).all()) await button.click({ timeout: 1000 }).catch(() => undefined);
}

/** The two sample clips (gradients, then the Mandelbrot zoom) on the main track: 12 s. */
async function twoScenes(page: Page, name: string): Promise<[string, string]> {
    await createProject(page, name);
    await page.getByTestId("media-import-input").setInputFiles(SAMPLES);
    await expect(page.getByTestId("media-item")).toHaveCount(2);
    for (let i = 0; i < 2; i += 1) {
        const tile = page.getByTestId("media-item").nth(i);
        await expect(tile).toContainText("0:06");
        await tile.hover();
        await tile.getByRole("button", { name: /to timeline$/ }).click();
        await expect.poll(async () => (await snapshot(page)).scenes.length).toBe(i + 1);
    }
    await expect.poll(async () => (await snapshot(page)).scenes.every((s) => !/^(temp-|optimistic-)/.test(s.id))).toBe(true);
    const [a, b] = (await snapshot(page)).scenes.map((s) => s.id);
    return [a, b];
}

/** Text clips on a new text track (one command), returning their ids. */
async function textClips(page: Page, spans: Array<[number, number, string]>): Promise<string[]> {
    const tracks = await page.evaluate(() => (window as unknown as StudioWindow).__studio.store.getState().timelineData.tracks);
    const withText = [...tracks, { type: "text", index: 1, label: "T1", muted: false, locked: false, visible: true, volume: 1 }];
    const before = new Set((await snapshot(page)).clips.map((c) => c.id));
    expect((await execute(page, {
        type: "clip.create",
        tracks: withText,
        input: spans.map(([startTime, endTime, textContent]) => ({ trackType: "text", trackIndex: 1, startTime, endTime, mediaType: "text", textContent })),
    })).ok).toBe(true);
    await expect.poll(async () => (await snapshot(page)).clips.filter((c) => !before.has(c.id) && !c.id.startsWith("temp-")).length).toBe(spans.length);
    return (await snapshot(page)).clips.filter((c) => !before.has(c.id)).map((c) => c.id);
}

test.beforeAll(() => fs.mkdirSync(OUT, { recursive: true }));

test("the Mask tab, a multi-selection on the timeline, and the Paste attributes picker", async ({ page }) => {
    test.setTimeout(180_000);
    const [a, b] = await twoScenes(page, "Launch teaser");

    // A heart mask on the first scene; the Mask tab open draws its outline and handles over the preview.
    expect((await execute(page, { type: "mask.set", sceneId: a, mask: { shape: "heart", width: 0.62, height: 0.62, feather: 0.08 } })).ok).toBe(true);
    await execute(page, { type: "playhead.seek", seconds: 2.5 });
    await execute(page, { type: "selection.set", sceneId: a });
    await waitForSaves(page);
    await dismissToasts(page);
    await page.getByTestId("inspector").getByRole("tab", { name: "Mask", exact: true }).click();
    await expect(page.getByTestId("mask-shape-heart")).toHaveAttribute("aria-pressed", "true");
    await shot(page, "mask-tab");
    const grid = (await page.getByTestId("mask-tab").locator(".on-anim-grid").boundingBox())!;
    await shot(page, "mask-shapes", { x: grid.x - 14, y: grid.y - 14, width: grid.width + 28, height: grid.height + 28 });

    // Two text clips and a scene selected: selection rings on the timeline, the inspector's group header.
    const [t0, t1] = await textClips(page, [[0.5, 2.5, "Launch day"], [3, 5.5, "Now in Studio"]]);
    await execute(page, { type: "selection.set", clipIds: [t0, t1], sceneIds: [b] });
    await expect(page.getByTestId("inspector-group-title")).toHaveText("3 items");
    await execute(page, { type: "playhead.seek", seconds: 4 });
    await execute(page, { type: "selection.set", clipIds: [t0, t1], sceneIds: [b] });
    await expect(page.getByTestId("inspector-group-title")).toHaveText("3 items");
    await waitForSaves(page);
    await shot(page, "multi-select-timeline");

    // A styled scene's attributes copied (⌥⌘C) and the picker opened on the other scene (⌥⌘V).
    expect((await execute(page, { type: "look.set", sceneId: b, filter: "warm", intensity: 0.7, adjustments: { exposure: 0.2, vignette: 0.4 } })).ok).toBe(true);
    expect((await execute(page, { type: "clip.effect.add", sceneId: b, effectId: "fx_rgb_split", params: { amount: 0.6 } })).ok).toBe(true);
    expect((await execute(page, { type: "animation.set", sceneId: b, slot: "in", animationId: "zoom_in", duration: 1 })).ok).toBe(true);
    expect((await execute(page, { type: "speed.set", sceneId: b, speed: 1.5 })).ok).toBe(true);
    await waitForSaves(page);
    await execute(page, { type: "selection.set", clipIds: [] });
    await execute(page, { type: "selection.set", sceneId: b });
    await blurFocus(page);
    await page.keyboard.press("Alt+ControlOrMeta+KeyC");
    await expect(page.getByText(/^Copied attributes:/)).toBeVisible();
    await dismissToasts(page);
    await execute(page, { type: "playhead.seek", seconds: 2.5 });
    await execute(page, { type: "selection.set", sceneId: a });
    await blurFocus(page);
    await page.keyboard.press("Alt+ControlOrMeta+KeyV");
    const picker = page.getByRole("dialog", { name: "Paste attributes" });
    await expect(picker).toBeVisible();
    await expect(picker.getByRole("checkbox", { name: "Filter" })).toBeChecked();
    await shot(page, "paste-attributes");
});

test("two stickers selected in the preview show the group box", async ({ page }) => {
    test.setTimeout(120_000);
    await twoScenes(page, "Launch teaser");
    await execute(page, { type: "playhead.seek", seconds: 1 });
    await openLibraryTab(page, "Stickers");
    await page.getByTestId("sticker-card-twemoji:1f525").click();
    await expect.poll(async () => (await snapshot(page)).clips.filter((c) => c.trackType === "sticker" && !c.id.startsWith("temp-")).length).toBe(1);
    await page.getByTestId("sticker-card-twemoji:1f60d").click();
    await expect.poll(async () => (await snapshot(page)).clips.filter((c) => c.trackType === "sticker" && !c.id.startsWith("temp-")).length).toBe(2);
    const [s1, s2] = (await snapshot(page)).clips.filter((c) => c.trackType === "sticker");
    await execute(page, { type: "clip.update", clipIds: [s1.id], patch: { positionX: 0.3, positionY: 0.38, scale: 1.1 } });
    await execute(page, { type: "clip.update", clipIds: [s2.id], patch: { positionX: 0.68, positionY: 0.6, scale: 1.1 } });
    await execute(page, { type: "playhead.seek", seconds: 2.5 });
    await waitForSaves(page);
    await deselect(page);
    await dismissToasts(page);
    await execute(page, { type: "selection.set", clipIds: [s1.id, s2.id] });
    await expect.poll(async () => Boolean((await previewBoxes(page))?.group)).toBe(true);
    await page.mouse.move(5, 5);
    await shot(page, "multi-select-preview", (await page.locator(".editor-preview").boundingBox())!);
});

test("keyframe diamonds with the easing menu, and the graph editor", async ({ page }) => {
    test.setTimeout(180_000);
    const [a] = await twoScenes(page, "Launch teaser");

    // Scale keyframes on the first scene at 0.5, 2, and 3.5 s, the middle one eased in-out.
    await execute(page, { type: "selection.set", sceneId: a });
    expect((await execute(page, { type: "keyframe.set", sceneId: a, time: 0.5, values: { scale: 0.6 } })).ok).toBe(true);
    expect((await execute(page, { type: "keyframe.set", sceneId: a, time: 2, values: { scale: 0.9 }, easing: "ease_in_out" })).ok).toBe(true);
    expect((await execute(page, { type: "keyframe.set", sceneId: a, time: 3.5, values: { scale: 0.45 } })).ok).toBe(true);
    // Zoomed in, so the timeline scrolls sideways (below, the selected diamond comes out from under its menu).
    for (let i = 0; i < 2; i += 1) await page.getByRole("button", { name: "Zoom in (+)", exact: true }).click();
    await execute(page, { type: "playhead.seek", seconds: 0 });
    const diamonds = () => page.evaluate(() => (window as unknown as { __timelineDebugKeyframes?: () => KeyframeDiamonds | null }).__timelineDebugKeyframes?.() ?? null);
    await expect.poll(async () => (await diamonds())?.diamonds.map((d) => d.time)).toEqual([0.5, 2, 3.5]);
    await page.waitForTimeout(1000);
    await page.getByTestId("timeline-tracks-scroll").evaluate((el) => { el.scrollLeft = 0; });
    await expect.poll(async () => (await diamonds())!.diamonds[0].x).toBeGreaterThan(0);
    await page.mouse.move(5, 5);
    await waitForSaves(page);
    await dismissToasts(page);

    // Click the 2 s diamond (selects it, the playhead jumps to it), then right-click it for the easing menu.
    const box = await timelineCanvasBox(page);
    const d = (await diamonds())!.diamonds.find((x) => Math.abs(x.time - 2) < 0.002)!;
    const at = { x: box.x + d.x, y: box.y + d.y };
    await page.mouse.click(at.x, at.y);
    await expect.poll(async () => (await snapshot(page)).currentTime).toBeCloseTo(2, 2);
    await page.mouse.click(at.x, at.y, { button: "right" });
    const menu = page.getByTestId("keyframe-menu");
    await expect(menu).toBeVisible();
    // The menu opens at the pointer, over the diamond: scroll the timeline (not a wheel, which closes the menu) so
    // the selected diamond shows beside it.
    await page.getByTestId("timeline-tracks-scroll").evaluate((el) => { el.scrollLeft += 80; });
    await expect.poll(async () => (await diamonds())!.diamonds.find((x) => Math.abs(x.time - 2) < 0.002)!.x).toBeLessThan(d.x - 60);
    await expect(menu).toBeVisible();
    await page.waitForTimeout(2000);
    await shot(page, "keyframe-diamonds");

    // The graph editor from the same menu, on Scale.
    await page.getByTestId("keyframe-menu-graph").click();
    await expect(page.getByTestId("kf-graph")).toBeVisible();
    await expect(page.getByTestId("kf-graph-channel")).toHaveValue("scale");
    await expect(page.getByTestId("kf-graph-point-2")).toBeVisible();
    await page.mouse.move(5, 5);
    await shot(page, "keyframe-graph");
});

test("the Export dialog on the fast GPU path, and its progress", async ({ page }) => {
    test.setTimeout(300_000);
    await serveFfmpegCoreLocally(page);
    const [a, b] = await twoScenes(page, "Launch teaser");
    expect((await execute(page, { type: "transition.set", sceneId: a, transition: "cross_dissolve", duration: 1 })).ok).toBe(true);
    expect((await execute(page, { type: "look.set", sceneId: b, filter: "teal_orange", intensity: 0.8 })).ok).toBe(true);
    await execute(page, { type: "playhead.seek", seconds: 3 });
    await deselect(page);
    await waitForSaves(page);
    await dismissToasts(page);

    await page.getByRole("button", { name: "Export", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Export video" });
    await expect(dialog.locator(".export-engine")).toHaveText("Fast export (GPU)");
    await expect(dialog).toContainText("MP4 (H.264, AAC)");
    await shot(page, "export-gpu");

    await dialog.getByRole("button", { name: "Export MP4" }).click();
    await expect(dialog.getByText(/Rendering \d+% · .+ left/)).toBeVisible({ timeout: 60_000 });
    await expect.poll(() => dialog.getByRole("progressbar", { name: "Export progress" }).evaluate((el) => (el as HTMLProgressElement).value), { timeout: 60_000, intervals: [100] }).toBeGreaterThan(0.3);
    await expect(dialog.getByText(/Rendering \d+% · .+ left/)).toBeVisible();
    await page.screenshot({ path: path.join(OUT, "export-progress.png") });
    await dialog.getByRole("button", { name: "Cancel" }).click();
});
