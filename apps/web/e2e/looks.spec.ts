// Phase 10a end to end: the library and inspector drive transitions, filters, adjustments, and effects
// (drag and click), every edit undoes, the preview shows the look, and an exported MP4's frames match
// the preview's frames at the same times.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Locator, type Page } from "@playwright/test";
import {
    FIXTURE_VIDEO, createProject, execute, sceneRects, serveFfmpegCoreLocally, snapshot, timelineCanvasBox, timelineZoom, waitForSaves,
} from "./helpers";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

interface LookScene { id: string; visualTransition?: string | null; visualTransitionDuration?: number | null; visualFilter?: string | null; filterIntensity?: number | null; adjustmentsJson?: string | null; effects?: Array<{ effectId: string; order: number }> | null }

async function scenes(page: Page): Promise<LookScene[]> {
    return (await snapshot(page)).scenes as unknown as LookScene[];
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

async function openTab(page: Page, name: string): Promise<void> {
    await page.getByTestId("editor-library").getByRole("tab", { name, exact: true }).click();
}

/** The main-track cut between the first two scenes, in page coordinates. */
async function cutPoint(page: Page): Promise<{ x: number; y: number }> {
    await expect.poll(async () => (await sceneRects(page)).length).toBe(2);
    const box = await timelineCanvasBox(page);
    const zoom = await timelineZoom(page);
    const [first] = await sceneRects(page);
    return { x: box.x + first.x + first.duration * zoom, y: box.y + first.y + 20 };
}

async function dragCard(page: Page, card: Locator, target: { x: number; y: number }): Promise<void> {
    const canvas = page.locator('[data-testid="timeline-tracks-scroll"] canvas');
    const box = await timelineCanvasBox(page);
    await card.dragTo(canvas, { targetPosition: { x: target.x - box.x, y: target.y - box.y } });
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

function nativeFfmpeg(): string {
    const local = path.join(ROOT, "apps/desktop/resources/ffmpeg", `${process.platform}-${process.arch}`, "ffmpeg");
    for (const candidate of [process.env.OPENNAN_PARITY_FFMPEG, local, "ffmpeg"]) {
        if (candidate && spawnSync(candidate, ["-version"]).status === 0) return candidate;
    }
    throw new Error("an ffmpeg binary is needed to decode the exported file");
}

function exportedFrame(file: string, seconds: number, w = 160, h = 90): number[] {
    const raw = execFileSync(nativeFfmpeg(), [
        "-hide_banner", "-loglevel", "error", "-ss", seconds.toFixed(3), "-i", file, "-frames:v", "1",
        "-vf", `scale=${w}:${h}:flags=area`, "-f", "rawvideo", "-pix_fmt", "rgba", "-",
    ]);
    return Array.from(raw);
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

function grayness(pixels: number[]): number {
    let sum = 0;
    for (let i = 0; i < pixels.length; i += 4) sum += Math.abs(pixels[i] - pixels[i + 1]) + Math.abs(pixels[i + 1] - pixels[i + 2]);
    return sum / (pixels.length / 4);
}

test.beforeEach(async ({ page }) => {
    await createProject(page, "Looks test");
});

test("drags a transition onto the cut, edits its duration in the inspector, and undoes", async ({ page }) => {
    const [a] = await twoScenes(page);
    await openTab(page, "Transitions");
    await expect(page.getByTestId(/^transition-card-/)).toHaveCount(25);
    await dragCard(page, page.getByTestId("transition-card-wipe_left"), await cutPoint(page));
    await expect.poll(async () => (await scenes(page)).find((s) => s.id === a)?.visualTransition).toBe("wipe_left");
    expect((await scenes(page))[0].visualTransitionDuration).toBe(0.5);

    await execute(page, { type: "selection.set", transition: { kind: "scene", id: a } });
    const slider = page.getByTestId("transition-duration").getByRole("slider");
    await slider.fill("1.2");
    await expect.poll(async () => (await scenes(page))[0].visualTransitionDuration).toBe(1.2);

    // The preview draws the centered window: 0.25 s before the cut is inside it.
    await execute(page, { type: "playhead.seek", seconds: 5.75 });
    await expect.poll(() => overlayPixels(page).then((p) => p !== null)).toBe(true);

    await execute(page, { type: "history.undo" });
    await expect.poll(async () => (await scenes(page))[0].visualTransitionDuration).toBe(0.5);
    await execute(page, { type: "history.undo" });
    await expect.poll(async () => (await scenes(page))[0].visualTransition ?? "none").toBe("none");
});

test("applies a filter by click, sets its intensity, and the preview turns black and white", async ({ page }) => {
    const [, b] = await twoScenes(page);
    await execute(page, { type: "selection.set", sceneId: b });
    await openTab(page, "Filters");
    await page.getByTestId("filter-card-mono").click();
    await expect.poll(async () => (await scenes(page))[1]).toMatchObject({ visualFilter: "mono", filterIntensity: 0.8 });
    await page.getByTestId("filter-intensity").getByRole("slider").fill("100");
    await expect.poll(async () => (await scenes(page))[1].filterIntensity).toBe(1);
    await execute(page, { type: "playhead.seek", seconds: 8 });
    await expect.poll(async () => {
        const pixels = await overlayPixels(page);
        return pixels ? grayness(pixels) : 999;
    }).toBeLessThan(3);
    await execute(page, { type: "history.undo" });
    await expect.poll(async () => (await scenes(page))[1].filterIntensity).toBe(0.8);
});

test("adjusts exposure and vignette from the inspector, resets all, and undoes the reset", async ({ page }) => {
    const [a] = await twoScenes(page);
    await execute(page, { type: "selection.set", sceneId: a });
    await page.getByTestId("inspector-tab-adjust").click();
    await page.getByTestId("adjust-exposure").getByRole("slider").fill("40");
    await page.getByTestId("adjust-vignette").getByRole("slider").fill("60");
    await expect.poll(async () => JSON.parse((await scenes(page))[0].adjustmentsJson ?? "{}")).toEqual({ exposure: 0.4, vignette: 0.6 });
    await page.getByTestId("adjust-controls").getByRole("button", { name: "Reset all" }).click();
    await expect.poll(async () => (await scenes(page))[0].adjustmentsJson ?? null).toBeNull();
    // The reset is recorded in history when its save settles; undo after that.
    await waitForSaves(page);
    await execute(page, { type: "history.undo" });
    await expect.poll(async () => JSON.parse((await scenes(page))[0].adjustmentsJson ?? "{}")).toEqual({ exposure: 0.4, vignette: 0.6 });
    await waitForSaves(page);
    await page.reload();
    await expect.poll(async () => JSON.parse((await scenes(page))[0]?.adjustmentsJson ?? "{}")).toEqual({ exposure: 0.4, vignette: 0.6 });
});

test("drags an effect onto a clip and onto the timeline; the stack reorders and removes in the inspector", async ({ page }) => {
    const [a] = await twoScenes(page);
    await openTab(page, "Effects");
    const box = await timelineCanvasBox(page);
    const [first] = await sceneRects(page);
    // Onto scene a: its own stack.
    await dragCard(page, page.getByTestId("effect-card-fx_rgb_split"), { x: box.x + first.x + 60, y: box.y + first.y + 20 });
    await expect.poll(async () => (await scenes(page))[0].effects?.map((e) => e.effectId)).toEqual(["fx_rgb_split"]);
    // Below the tracks: an effect layer.
    await dragCard(page, page.getByTestId("effect-card-fx_vhs"), { x: box.x + first.x + 60, y: box.y + box.height - 12 });
    await expect.poll(async () => (await snapshot(page)).clips.filter((c) => c.trackType === "effect").length).toBe(1);
    // Click with the scene selected: appends to its stack.
    await execute(page, { type: "selection.set", sceneId: a });
    await page.getByTestId("effect-card-fx_sepia").click();
    await expect.poll(async () => (await scenes(page))[0].effects?.length).toBe(2);
    await page.getByTestId("inspector-tab-effects").click();
    await expect(page.getByTestId("effects-stack-item")).toHaveCount(2);
    await page.getByRole("button", { name: /^Move Sepia up$/ }).click();
    await expect.poll(async () => (await scenes(page))[0].effects!.slice().sort((x, y) => x.order - y.order).map((e) => e.effectId)).toEqual(["fx_sepia", "fx_rgb_split"]);
    await page.getByRole("button", { name: /^Remove RGB split$/ }).click();
    await expect.poll(async () => (await scenes(page))[0].effects?.map((e) => e.effectId)).toEqual(["fx_sepia"]);
});

test("exports a short clip with a transition, a filter, an adjustment, and an effect; frames match the preview", async ({ page }) => {
    test.setTimeout(420_000);
    await serveFfmpegCoreLocally(page);
    const [a, b] = await twoScenes(page);
    expect((await execute(page, { type: "transition.set", sceneId: a, transition: "wipe_left", duration: 1 })).ok).toBe(true);
    expect((await execute(page, { type: "look.set", sceneId: b, filter: "noir", intensity: 1 })).ok).toBe(true);
    expect((await execute(page, { type: "look.set", sceneId: a, adjustments: { exposure: 0.4 } })).ok).toBe(true);
    expect((await execute(page, { type: "clip.effect.add", sceneId: a, effectId: "fx_rgb_split", params: { amount: 0.8 } })).ok).toBe(true);
    await waitForSaves(page);

    const times = [1.5, 5.75, 6.25, 9];
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
    const downloadPromise = page.waitForEvent("download", { timeout: 400_000 });
    await dialog.getByRole("button", { name: "Export MP4" }).click();
    const failed = dialog.getByRole("alert").waitFor({ timeout: 400_000 }).then(async () => {
        throw new Error(`Export failed: ${await dialog.getByRole("alert").innerText()}`);
    });
    const download = await Promise.race([downloadPromise, failed]);
    const file = test.info().outputPath("looks.mp4");
    await fs.copyFile(await download.path(), file);

    times.forEach((t, i) => {
        const frame = exportedFrame(file, t);
        const diff = meanDiff(frame, preview[i]);
        expect(diff, `export vs preview at ${t}s`).toBeLessThan(14);
    });
    expect(grayness(exportedFrame(file, 9)), "noir in the export").toBeLessThan(4);
    expect(grayness(exportedFrame(file, 1.5)), "color before the cut").toBeGreaterThan(20);
});
