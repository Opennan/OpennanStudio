// Phase 11 end to end: an effect layer applies over everything below it — the footage, a built-in graphic and a text
// clip — in the preview exactly as in the exported file (phase 10d left the preview's effects under graphics and
// text while both exports ran them over the full composite). A black & white effect span covers a recoloured lower
// third and green text: both turn gray in the preview and in the exported frame at the same time, and the two
// frames agree where the graphic and the text are.
import { expect, test, type Page } from "@playwright/test";
import { FIXTURE_VIDEO, createProject, execute, serveFfmpegCoreLocally, snapshot, waitForSaves } from "./helpers";
import { exportMp4, exportedFrame, meanDiff, previewAt, type Frame } from "./motion-helpers";

const W = 160;
const H = 90;
// Colours the testsrc fixture never produces (graphics-export.spec.ts): the bar amber, the text green.
const AMBER = "#c87828";
const GREEN = "#22dd44";
const isAmber = (r: number, g: number, b: number) => Math.abs(r - 200) < 22 && Math.abs(g - 120) < 22 && Math.abs(b - 40) < 22;
const isGreen = (r: number, g: number, b: number) => g > 150 && g - r > 90 && g - b > 70;

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
    await expect.poll(async () => (await snapshot(page)).clips.some((c) => c.trackType === type && !/^(temp-|optimistic-)/.test(c.id))).toBe(true);
    return (await snapshot(page)).clips.find((c) => c.trackType === type)!.id;
}

/** Indices (pixel offsets) of the cells matching `test` whose four neighbours match too (no blended edges). */
function interiorCells(frame: Frame, test: (r: number, g: number, b: number) => boolean): number[] {
    const at = (x: number, y: number) => {
        if (x < 0 || y < 0 || x >= frame.w || y >= frame.h) return false;
        const i = (y * frame.w + x) * 4;
        return test(frame.data[i], frame.data[i + 1], frame.data[i + 2]);
    };
    const cells: number[] = [];
    for (let y = 0; y < frame.h; y += 1) {
        for (let x = 0; x < frame.w; x += 1) {
            if (at(x, y) && at(x - 1, y) && at(x + 1, y) && at(x, y - 1) && at(x, y + 1)) cells.push((y * frame.w + x) * 4);
        }
    }
    return cells;
}

/** Mean channel spread (|r−g| + |g−b|) over `cells`: 0 for gray. */
function grayness(frame: Frame, cells: number[]): number {
    let sum = 0;
    for (const i of cells) sum += Math.abs(frame.data[i] - frame.data[i + 1]) + Math.abs(frame.data[i + 1] - frame.data[i + 2]);
    return sum / Math.max(1, cells.length);
}

/** Mean luma over `cells`. */
function luma(frame: Frame, cells: number[]): number {
    let sum = 0;
    for (const i of cells) sum += 0.299 * frame.data[i] + 0.587 * frame.data[i + 1] + 0.114 * frame.data[i + 2];
    return sum / Math.max(1, cells.length);
}

/** Mean absolute RGB difference of two frames over `cells`. */
function cellDiff(a: Frame, b: Frame, cells: number[]): number {
    let sum = 0;
    for (const i of cells) sum += Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2]);
    return sum / Math.max(1, cells.length * 3);
}

/** Every cell's channel spread over the whole frame. */
const allCells = (frame: Frame) => Array.from({ length: frame.w * frame.h }, (_, k) => k * 4);

test("an effect span covers a graphic and a text clip in the preview as in the exported frame", async ({ page }) => {
    test.setTimeout(480_000);
    await serveFfmpegCoreLocally(page);
    await createProject(page, "Effect order");
    await page.getByTestId("media-import-input").setInputFiles(FIXTURE_VIDEO);
    const tile = page.getByTestId("media-item").filter({ hasText: "testsrc-6s.webm" });
    await expect(tile).toContainText("0:06");
    await tile.hover();
    await tile.getByRole("button", { name: "Add testsrc-6s.webm to timeline" }).click();
    await expect.poll(async () => (await snapshot(page)).scenes.length).toBe(1);

    // A recoloured lower third (1–5 s) from the Graphics library and green text near the top (0–6 s).
    await execute(page, { type: "playhead.seek", seconds: 1 });
    await page.getByRole("tab", { name: "Graphics" }).click();
    await page.getByTestId("graphic-card-lower-third").click();
    await expect.poll(async () => (await snapshot(page)).clips.filter((c) => c.trackType === "remotion").length).toBe(1);
    const graphic = (await snapshot(page)).clips.find((c) => c.trackType === "remotion")!;
    expect((await execute(page, {
        type: "clip.update", clipIds: [graphic.id], patch: { remotionPropsJson: JSON.stringify({ name: "Effect order", role: "Phase 11", barColor: AMBER }) },
    })).ok).toBe(true);
    await createClip(page, {
        trackType: "text", trackIndex: 1, startTime: 0, endTime: 6, mediaType: "text", textContent: "GREEN", positionX: 0.5, positionY: 0.22,
        textStyle: JSON.stringify({ fontSize: 150, fontWeight: "900", color: GREEN, strokeWidth: 0, shadowBlur: 0 }),
    });
    await waitForSaves(page);

    // Without an effect: the graphic and the text in colour, where they are.
    const before = await previewAt(page, 3, W, H);
    const barCells = interiorCells(before, isAmber);
    const textCells = interiorCells(before, isGreen);
    expect(barCells.length, "amber bar cells in the preview").toBeGreaterThan(20);
    expect(textCells.length, "green text cells in the preview").toBeGreaterThan(10);

    // A black & white effect layer over the whole clip.
    const fx = await createClip(page, { trackType: "effect", trackIndex: 1, startTime: 0, endTime: 6, mediaType: "effect", label: "Black & white" });
    expect((await execute(page, { type: "clip.effect.add", clipId: fx, effectId: "fx_black_white" })).ok).toBe(true);
    await waitForSaves(page);

    // The preview: the graphic and the text are effected (gray, still drawn where they were), the footage too.
    const preview = await previewAt(page, 3, W, H);
    expect(grayness(preview, allCells(preview)), "preview: the whole frame is black and white").toBeLessThan(6);
    expect(grayness(preview, barCells), "preview: the bar is gray").toBeLessThan(6);
    expect(grayness(preview, textCells), "preview: the text is gray").toBeLessThan(6);
    expect(luma(preview, textCells), "preview: the text is still drawn").toBeGreaterThan(80);

    // The exported frame at the same time agrees.
    const file = await exportMp4(page, "effect-order.mp4");
    const frame = exportedFrame(file, 3, W, H);
    expect(grayness(frame, allCells(frame)), "export: the whole frame is black and white").toBeLessThan(6);
    expect(grayness(frame, barCells), "export: the bar is gray").toBeLessThan(6);
    expect(grayness(frame, textCells), "export: the text is gray").toBeLessThan(6);
    expect(cellDiff(preview, frame, barCells), "preview vs export on the graphic").toBeLessThan(16);
    expect(cellDiff(preview, frame, textCells), "preview vs export on the text").toBeLessThan(16);
    expect(meanDiff(preview, frame), "preview vs export, whole frame").toBeLessThan(14);
    // The bar is drawn (a flat gray, unlike the moving pattern under it) in both.
    expect(Math.abs(luma(preview, barCells) - luma(frame, barCells)), "bar luma").toBeLessThan(14);
});
