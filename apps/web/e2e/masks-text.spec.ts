// Phase 10d end to end: a text clip takes a mask from its inspector Mask tab; the preview cuts the text where the mask
// ends, and the exported file (the Export dialog's GPU export) shows the same cut; the group Mask tab masks two text
// clips in one undo step.
import { expect, test, type Page } from "@playwright/test";
import { createProject, execute, serveFfmpegCoreLocally, snapshot, waitForSaves } from "./helpers";
import { centroid, countPixels, deselect, exportMp4, exportedFrame, isWhite, previewAt, type Frame, type Rect } from "./motion-helpers";

interface Clip { id: string; trackType: string; maskJson?: string | null }
type StudioWindow = { __studio: { store: { getState(): { timelineData: { tracks: unknown[] } } } } };

const W = 320;
const H = 180;
const STYLE = JSON.stringify({ fontSize: 110, fontWeight: "900", color: "#FFFFFF", strokeWidth: 0, shadowBlur: 0 });

const clips = async (page: Page) => (await snapshot(page)).clips as unknown as Clip[];
const maskOf = async (page: Page, id: string) => JSON.parse((await clips(page)).find((c) => c.id === id)?.maskJson ?? "null") as { shape: string; rotation: number } | null;

async function addText(page: Page, text: string, positionY: number): Promise<string> {
    const tracks = await page.evaluate(() => (window as unknown as StudioWindow).__studio.store.getState().timelineData.tracks) as Array<{ type: string }>;
    const withText = tracks.some((t) => t.type === "text") ? tracks : [...tracks, { type: "text", index: 1, label: "T1", muted: false, locked: false, visible: true, volume: 1 }];
    const before = new Set((await clips(page)).map((c) => c.id));
    expect((await execute(page, {
        type: "clip.create", tracks: withText,
        input: { trackType: "text", trackIndex: 1, startTime: 0, endTime: 3, mediaType: "text", textContent: text, textStyle: STYLE, positionY },
    })).ok).toBe(true);
    await expect.poll(async () => (await clips(page)).filter((c) => !before.has(c.id) && !c.id.startsWith("temp-")).length).toBe(1);
    return (await clips(page)).find((c) => !before.has(c.id))!.id;
}

/** White text pixels left and right of a vertical line at x (a 3 px gap on each side). */
function halves(frame: Frame, x: number): { left: number; right: number } {
    const left: Rect = { x: 0, y: 0, w: Math.max(0, Math.floor(x) - 3), h: frame.h };
    const right: Rect = { x: Math.ceil(x) + 3, y: 0, w: Math.max(0, frame.w - Math.ceil(x) - 3), h: frame.h };
    return { left: countPixels(frame, isWhite, left), right: countPixels(frame, isWhite, right) };
}

test("a text mask from the Mask tab cuts the text in the preview and the exported frames; the group Mask tab masks both texts", async ({ page }) => {
    test.setTimeout(420_000);
    await serveFfmpegCoreLocally(page);
    await createProject(page, "Text masks");
    const first = await addText(page, "MASKED", 0.5);
    await waitForSaves(page);

    // Unmasked: white text on both sides of its centre.
    const plain = await previewAt(page, 1.5, W, H);
    const centre = centroid(plain, isWhite);
    expect(centre, "the text is drawn").not.toBeNull();
    const before = halves(plain, centre!.x);
    expect(before.left).toBeGreaterThan(80);
    expect(before.right).toBeGreaterThan(80);

    // The inspector's Mask tab on the text clip: Linear, turned -90° (the left half of the text box stays).
    await execute(page, { type: "selection.set", clipIds: [first] });
    await page.getByTestId("inspector-tab-mask").click();
    await page.getByTestId("mask-shape-linear").click();
    await expect.poll(async () => (await maskOf(page, first))?.shape).toBe("linear");
    await page.getByTestId("mask-rotation").getByRole("slider").fill("-90");
    await expect.poll(async () => (await maskOf(page, first))?.rotation).toBe(-90);
    await waitForSaves(page);

    const masked = await previewAt(page, 1.5, W, H);
    const cut = halves(masked, centre!.x);
    expect(cut.left, `preview left half (${JSON.stringify({ before, cut })})`).toBeGreaterThan(before.left * 0.75);
    expect(cut.right, `preview right half (${JSON.stringify({ before, cut })})`).toBeLessThan(before.right * 0.05);

    // The exported file shows the same cut (the dialog's export runs the GPU path in Chromium).
    await deselect(page);
    const file = await exportMp4(page, "text-mask.mp4");
    const exported = halves(exportedFrame(file, 1.5, W, H), centre!.x);
    expect(exported.right, `export right half (${JSON.stringify({ cut, exported })})`).toBeLessThan(before.right * 0.05);
    expect(exported.left, `export left half (${JSON.stringify({ cut, exported })})`).toBeGreaterThan(cut.left * 0.65);
    expect(exported.left, `export left half (${JSON.stringify({ cut, exported })})`).toBeLessThan(cut.left * 1.5);

    // Group mode: two texts selected, the group Mask tab's Star masks both in one step; one undo takes it back.
    const second = await addText(page, "SECOND", 0.15);
    await waitForSaves(page);
    await execute(page, { type: "selection.set", clipIds: [first, second] });
    await expect(page.getByTestId("inspector-group")).toBeVisible();
    await page.getByTestId("inspector-tab-mask").click();
    await expect(page.getByTestId("group-mask-mixed")).toBeVisible();
    await page.getByTestId("mask-shape-star").click();
    await expect.poll(async () => [(await maskOf(page, first))?.shape, (await maskOf(page, second))?.shape]).toEqual(["star", "star"]);
    await waitForSaves(page);
    await execute(page, { type: "history.undo" });
    await expect.poll(async () => [(await maskOf(page, first))?.shape, (await maskOf(page, second))?.shape ?? null]).toEqual(["linear", null]);
});
