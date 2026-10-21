// Screenshots of the phase 10a editor for docs/theme/phase-10a/ (dark, the only theme):
// SCREENSHOTS=1 pnpm --filter @opennan/web exec playwright test e2e/screenshots-10a.spec.ts. Skipped otherwise.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { FIXTURE_VIDEO, createProject, execute, sceneRects, serveFfmpegCoreLocally, snapshot, timelineCanvasBox, timelineZoom, waitForSaves } from "./helpers";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const OUT = path.join(ROOT, "docs", "theme", "phase-10a");
test.skip(!process.env.SCREENSHOTS, "set SCREENSHOTS=1 to write docs/theme/phase-10a");

const shot = async (page: Page, name: string, clip?: { x: number; y: number; width: number; height: number }) => {
    await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(OUT, `${name}.png`), ...(clip ? { clip } : {}) });
};

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const SAMPLES = [path.join(FIXTURES, "sample-gradients.webm"), path.join(FIXTURES, "sample-mandelbrot.webm")];

/** Two main-track clips from the sample fixtures (gradients, then a Mandelbrot zoom), or the test card twice. */
async function setup(page: Page, files: string[] = SAMPLES): Promise<[string, string]> {
    await createProject(page, "Launch teaser");
    await page.getByTestId("media-import-input").setInputFiles(files.length > 1 ? files : files[0]);
    await expect(page.getByTestId("media-item")).toHaveCount(files.length);
    for (let i = 0; i < 2; i += 1) {
        const tile = page.getByTestId("media-item").nth(files.length > 1 ? i : 0);
        await expect(tile).toContainText("0:06");
        await tile.hover();
        await tile.getByRole("button", { name: /to timeline$/ }).click();
        await expect.poll(async () => (await snapshot(page)).scenes.length).toBe(i + 1);
    }
    const [a, b] = (await snapshot(page)).scenes;
    // Dismiss the import toasts so they do not cover the timeline.
    for (const button of await page.getByRole("button", { name: "Dismiss" }).all()) await button.click();
    return [a.id, b.id];
}

function nativeFfmpeg(): string {
    const local = path.join(ROOT, "apps/desktop/resources/ffmpeg", `${process.platform}-${process.arch}`, "ffmpeg");
    for (const candidate of [process.env.OPENNAN_PARITY_FFMPEG, local, "ffmpeg"]) {
        if (candidate && spawnSync(candidate, ["-version"]).status === 0) return candidate;
    }
    throw new Error("an ffmpeg binary is needed to extract exported frames");
}

test.beforeAll(() => fs.mkdirSync(OUT, { recursive: true }));

test("editor overview, every library tab, and the inspector", async ({ page }) => {
    const [a, b] = await setup(page);
    await execute(page, { type: "transition.set", sceneId: a, transition: "wipe_left", duration: 1 });
    await execute(page, { type: "look.set", sceneId: b, filter: "teal_orange", intensity: 0.85 });
    await execute(page, { type: "selection.set", sceneId: b });
    await execute(page, { type: "playhead.seek", seconds: 8.5 });
    await page.getByTestId("editor-library").getByRole("tab", { name: "Transitions", exact: true }).click();
    await shot(page, "editor-overview");

    for (const [tab, name] of [["Media", "media"], ["Audio", "audio"], ["Text", "text"], ["Effects", "effects"], ["Transitions", "transitions"], ["Filters", "filters"], ["Adjust", "adjust"]]) {
        await page.getByTestId("editor-library").getByRole("tab", { name: tab, exact: true }).click();
        await shot(page, `library-${name}`);
    }

    // Inspector tabs on a main-track clip, then on a layer video clip (speed and audio), then a transition.
    await page.getByTestId("editor-library").getByRole("tab", { name: "Filters", exact: true }).click();
    for (const tab of ["video", "adjust", "filter", "effects"]) {
        await page.getByTestId(`inspector-tab-${tab}`).click();
        await shot(page, `inspector-scene-${tab}`);
    }
    const created = await execute(page, { type: "clip.create", input: { trackType: "video", trackIndex: 2, startTime: 1, endTime: 4, mediaUrl: (await snapshot(page)).scenes[0].sourceVideoUrl, mediaType: "video", label: "Overlay" } }) as { createdClipIds?: string[] };
    await execute(page, { type: "selection.set", clipIds: created.createdClipIds ?? [] });
    for (const tab of ["video", "speed", "audio"]) {
        await page.getByTestId(`inspector-tab-${tab}`).click();
        await shot(page, `inspector-clip-${tab}`);
    }
    await execute(page, { type: "selection.set", transition: { kind: "scene", id: a } });
    await shot(page, "inspector-transition");
    await execute(page, { type: "selection.set", clipIds: [] });
    await execute(page, { type: "selection.set", sceneId: null });
    await shot(page, "inspector-project");
});

test("the editor as docs/theme/after-editor-dark.png shows it (test card, two clips)", async ({ page }) => {
    await setup(page, [FIXTURE_VIDEO]);
    await execute(page, { type: "playhead.seek", seconds: 3.2 });
    await page.waitForTimeout(800);
    await page.screenshot({ path: path.join(ROOT, "docs", "theme", "after-editor-dark.png") });
});

test("the drop target on a cut while a transition card is dragged", async ({ page }) => {
    await setup(page);
    await page.getByTestId("editor-library").getByRole("tab", { name: "Transitions", exact: true }).click();
    await expect.poll(async () => (await sceneRects(page)).length).toBe(2);
    const box = await timelineCanvasBox(page);
    const zoom = await timelineZoom(page);
    const [first] = await sceneRects(page);
    const point = { x: box.x + first.x + first.duration * zoom, y: box.y + first.y + 24 };
    const transfer = await page.evaluateHandle(() => {
        const dt = new DataTransfer();
        dt.setData("application/x-transition-id", "cross_dissolve");
        dt.setData("application/json", JSON.stringify({ kind: "transition", transitionId: "cross_dissolve", name: "Dissolve" }));
        return dt;
    });
    const canvas = page.locator('[data-testid="timeline-tracks-scroll"] canvas');
    await canvas.dispatchEvent("dragover", { dataTransfer: transfer, clientX: point.x, clientY: point.y });
    await page.waitForTimeout(300);
    await canvas.dispatchEvent("dragover", { dataTransfer: transfer, clientX: point.x, clientY: point.y });
    await shot(page, "transition-drop-target");
    await shot(page, "transition-drop-target-timeline", { x: box.x - 112, y: box.y - 40, width: Math.min(900, box.width + 112), height: 160 });
});

test("before and after a filter, and an exported frame per category", async ({ page }) => {
    test.setTimeout(420_000);
    await serveFfmpegCoreLocally(page);
    const [a, b] = await setup(page);
    const preview = page.locator(".editor-preview");
    await execute(page, { type: "playhead.seek", seconds: 9 });
    await shot(page, "filter-before", (await preview.boundingBox())!);
    await execute(page, { type: "look.set", sceneId: b, filter: "golden_hour", intensity: 1 });
    await shot(page, "filter-after", (await preview.boundingBox())!);

    await execute(page, { type: "transition.set", sceneId: a, transition: "circle_open", duration: 1.5 });
    await execute(page, { type: "look.set", sceneId: a, adjustments: { exposure: 0.35, vignette: 0.7, temperature: 0.5 } });
    await execute(page, { type: "clip.effect.add", sceneId: a, effectId: "fx_rgb_split", params: { amount: 1 } });
    await waitForSaves(page);
    await page.getByRole("button", { name: "Export", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Export video" });
    const download = page.waitForEvent("download", { timeout: 400_000 });
    await dialog.getByRole("button", { name: "Export MP4" }).click();
    const file = path.join(test.info().outputDir, "phase-10a.mp4");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.copyFileSync(await (await download).path(), file);
    for (const [name, seconds] of [["export-adjust-effect", 2], ["export-transition", 6], ["export-filter", 9]] as const) {
        execFileSync(nativeFfmpeg(), ["-hide_banner", "-loglevel", "error", "-y", "-ss", String(seconds), "-i", file, "-frames:v", "1", path.join(OUT, `${name}.png`)]);
    }
});
