// Screenshots of the phase 10d editor for docs/theme/phase-10d/ (dark, the only theme, 1440×900): the Graphics
// library and a rotated graphic in the preview, masks on text, the group Mask tab, keyboard-focused keyframes,
// motion tracking, and the GIF export.
// SCREENSHOTS=1 pnpm --filter @opennan/web exec playwright test e2e/screenshots-10d.spec.ts. Skipped otherwise.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { createProject, execute, serveFfmpegCoreLocally, snapshot, waitForSaves } from "./helpers";
import { ROOT, openLibraryTab, previewFrameRect } from "./motion-helpers";

const OUT = path.join(ROOT, "docs", "theme", "phase-10d");
test.skip(!process.env.SCREENSHOTS, "set SCREENSHOTS=1 to write docs/theme/phase-10d");
test.use({ colorScheme: "dark" });

const shot = async (page: Page, name: string) => {
    await page.waitForTimeout(700);
    await page.screenshot({ path: path.join(OUT, `${name}.png`) });
};

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const SAMPLES = [path.join(FIXTURES, "sample-gradients.webm"), path.join(FIXTURES, "sample-mandelbrot.webm")];

async function dismissToasts(page: Page): Promise<void> {
    for (const button of await page.getByRole("button", { name: "Dismiss" }).all()) await button.click({ timeout: 1000 }).catch(() => undefined);
}

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

type StudioWindow = { __studio: { store: { getState(): { timelineData: { tracks: Array<{ type: string; index: number }> } } } } };

/** A clip on its track, adding the track first when the project has none of that type (one command). */
async function createClip(page: Page, input: Record<string, unknown>): Promise<string> {
    const tracks = await page.evaluate(() => (window as unknown as StudioWindow).__studio.store.getState().timelineData.tracks);
    const type = String(input.trackType);
    const index = Number(input.trackIndex ?? 1);
    const missing = !tracks.some((t) => t.type === type && t.index === index);
    const withTrack = missing ? [...tracks, { type, index, label: `${type[0].toUpperCase()}${index}`, muted: false, locked: false, visible: true, volume: 1 }] : null;
    const created = await execute(page, { type: "clip.create", input, ...(withTrack ? { tracks: withTrack } : {}) }) as { ok: boolean; createdClipIds?: string[] };
    expect(created.ok).toBe(true);
    return created.createdClipIds![0];
}

test.beforeAll(() => fs.mkdirSync(OUT, { recursive: true }));

test("the Graphics library and a rotated graphic with its handles", async ({ page }) => {
    test.setTimeout(180_000);
    await twoScenes(page, "Launch teaser");
    await execute(page, { type: "playhead.seek", seconds: 2.5 });
    await openLibraryTab(page, "Graphics");
    await page.getByTestId("graphic-card-lower-third").click();
    await expect.poll(async () => (await snapshot(page)).clips.filter((c) => c.trackType === "remotion").length).toBe(1);
    const graphic = (await snapshot(page)).clips.find((c) => c.trackType === "remotion")!;
    expect((await execute(page, {
        type: "clip.update", clipIds: [graphic.id], patch: { remotionPropsJson: JSON.stringify({ name: "Maya Chen", role: "Director, OpenNan Studio", barColor: "#f5f5f5", textColor: "#0a0a0b" }) },
    })).ok).toBe(true);
    await waitForSaves(page);
    // Past the entrance (the graphic slides in from the left over its first second).
    await execute(page, { type: "playhead.seek", seconds: 4 });
    await dismissToasts(page);
    await expect(page.getByTestId("library-graphics")).toBeVisible();
    await shot(page, "graphics-library");

    // Rotated and moved: the selection box frames what the graphic paints.
    expect((await execute(page, { type: "clip.update", clipIds: [graphic.id], patch: { rotationDegrees: -6, positionX: 0.56, positionY: 0.46 } })).ok).toBe(true);
    await execute(page, { type: "selection.set", clipIds: [graphic.id] });
    await waitForSaves(page);
    await page.mouse.move(10, 10);
    await shot(page, "graphics-rotation");
});

test("a mask on text, and the group Mask tab", async ({ page }) => {
    test.setTimeout(180_000);
    await twoScenes(page, "Title card");
    const title = await createClip(page, {
        trackType: "text", trackIndex: 1, startTime: 0, endTime: 6, textContent: "MIDNIGHT RUN", positionX: 0.5, positionY: 0.5,
        textStyle: JSON.stringify({ fontSize: 150, color: "#ffffff", fontWeight: 900, fontFamily: "Montserrat" }),
    });
    const sticker = await createClip(page, { trackType: "sticker", trackIndex: 1, startTime: 0, endTime: 6, stickerId: "twemoji:2b50", positionX: 0.15, positionY: 0.2, scale: 0.8 });
    expect((await execute(page, { type: "mask.set", clipId: title, mask: { shape: "linear", rotation: 20, feather: 0.35 } })).ok).toBe(true);
    await execute(page, { type: "playhead.seek", seconds: 2 });
    await execute(page, { type: "selection.set", clipIds: [title] });
    await waitForSaves(page);
    await dismissToasts(page);
    await page.getByTestId("inspector").getByRole("tab", { name: "Mask", exact: true }).click();
    await shot(page, "text-mask");

    await execute(page, { type: "selection.set", clipIds: [title, sticker] });
    await page.getByTestId("inspector").getByRole("tab", { name: "Mask", exact: true }).click();
    await shot(page, "group-mask");
});

test("keyframe diamonds focused from the keyboard", async ({ page }) => {
    test.setTimeout(180_000);
    const [a] = await twoScenes(page, "Keyframes");
    const media = (await snapshot(page)).scenes.find((s) => s.id === a)!.sourceVideoUrl;
    const overlay = await createClip(page, { trackType: "video", trackIndex: 2, startTime: 1, endTime: 5, mediaUrl: media, mediaType: "video", label: "Picture in picture", scale: 0.4 });
    await execute(page, { type: "selection.set", clipIds: [overlay] });
    for (const [time, scale] of [[0.4, 0.4], [1.6, 0.6], [3.2, 0.45]] as const) {
        expect((await execute(page, { type: "keyframe.set", clipId: overlay, time, values: { scale } })).ok).toBe(true);
    }
    await waitForSaves(page);
    await page.getByRole("button", { name: "Add track" }).focus();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Alt+ArrowRight");
    await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? "")).toContain("1.60 s");
    await dismissToasts(page);
    await page.getByRole("listbox", { name: /^Keyframes of/ }).getByRole("option").nth(1).focus();
    await shot(page, "keyframes-keyboard");
});

test("motion tracking: the Track tab with a tracked path", async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    const ffmpeg = [process.env.OPENNAN_PARITY_FFMPEG, "ffmpeg"].find((c) => c && spawnSync(c, ["-version"]).status === 0);
    test.skip(!ffmpeg, "needs a native ffmpeg to generate the moving clip");
    const dir = testInfo.outputPath("fixture");
    fs.mkdirSync(dir, { recursive: true });
    const clip = path.join(dir, "skater.webm");
    execFileSync(ffmpeg!, [
        "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "gradients=s=1280x720:speed=0.004:r=30", "-f", "lavfi", "-i", "mandelbrot=size=160x160:rate=30",
        "-filter_complex", "[0][1]overlay=x='200+260*t':y='300-60*t',format=yuv420p", "-t", "3", "-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "30", "-deadline", "realtime", "-cpu-used", "8", clip,
    ]);
    await createProject(page, "Tracking");
    await page.getByTestId("media-import-input").setInputFiles(clip);
    const tile = page.getByTestId("media-item").filter({ hasText: "skater.webm" });
    await expect(tile).toContainText("0:03");
    await tile.hover();
    await tile.getByRole("button", { name: "Add skater.webm to timeline" }).click();
    await expect.poll(async () => (await snapshot(page)).scenes.length).toBe(1);
    const sceneId = (await snapshot(page)).scenes[0].id;
    await createClip(page, { trackType: "text", trackIndex: 1, startTime: 0, endTime: 3, textContent: "Nina, 14", positionX: 0.3, positionY: 0.3 });
    await execute(page, { type: "playhead.seek", seconds: 0.02 });
    await execute(page, { type: "selection.set", sceneId });
    await page.getByTestId("inspector-tab-track").click();
    const frame = await previewFrameRect(page);
    const at = (px: number, py: number) => ({ x: frame.x + (px / 1280) * frame.w, y: frame.y + (py / 720) * frame.h });
    const from = at(192, 292);
    const to = at(368, 468);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 6 });
    await page.mouse.up();
    await page.getByTestId("track-run").click();
    await expect(page.getByTestId("track-status")).toContainText(/Tracked \d+ frames/, { timeout: 120_000 });
    await execute(page, { type: "playhead.seek", seconds: 1.5 });
    await dismissToasts(page);
    await shot(page, "motion-tracking");
});

test("the Export dialog making a GIF", async ({ page }) => {
    test.setTimeout(180_000);
    await serveFfmpegCoreLocally(page);
    await twoScenes(page, "Loop");
    await dismissToasts(page);
    await page.getByRole("button", { name: "Export", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Export video" });
    await dialog.getByRole("radiogroup", { name: "Format" }).getByText("GIF").click();
    await expect(dialog).toContainText("GIF (no audio, loops)");
    await shot(page, "export-gif");
});
