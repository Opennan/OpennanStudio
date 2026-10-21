// Phase 10b end to end: direct manipulation in the preview on a sticker clip. Drag to move, drag back near the
// frame centre (snap guides drawn across the frame while the pointer is down, and the position snaps to the
// centre), scale from a corner handle, turn with the rotate knob; every gesture is one undo step.
import { expect, test, type Page } from "@playwright/test";
import { createProject, execute, snapshot, waitForSaves } from "./helpers";
import { deselect, openLibraryTab, previewFrameRect, type Rect } from "./motion-helpers";

interface Clip { id: string; trackType: string; positionX: number; positionY: number; scale: number; rotationDegrees: number }

async function sticker(page: Page): Promise<Clip> {
    return ((await snapshot(page)).clips as unknown as Clip[]).find((c) => c.trackType === "sticker")!;
}

/** Bounding box (viewport px) of what the preview's overlay canvas draws: alpha above `minAlpha`. */
async function drawnBox(page: Page, minAlpha = 40): Promise<Rect | null> {
    return page.evaluate((min) => {
        const canvas = document.querySelector<HTMLCanvasElement>("canvas[data-preview-canvas]")!;
        const rect = canvas.getBoundingClientRect();
        const ratio = canvas.width / rect.width;
        const data = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data;
        let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
        for (let y = 0; y < canvas.height; y += 1) {
            for (let x = 0; x < canvas.width; x += 1) {
                if (data[(y * canvas.width + x) * 4 + 3] > min) {
                    if (x < x0) x0 = x;
                    if (x > x1) x1 = x;
                    if (y < y0) y0 = y;
                    if (y > y1) y1 = y;
                }
            }
        }
        if (x1 < 0) return null;
        return { x: rect.left + x0 / ratio, y: rect.top + y0 / ratio, w: (x1 - x0 + 1) / ratio, h: (y1 - y0 + 1) / ratio };
    }, minAlpha);
}

/** Alpha of the overlay canvas at a viewport point (the max over a 3 px square). */
async function alphaAt(page: Page, x: number, y: number): Promise<number> {
    return page.evaluate(([px, py]) => {
        const canvas = document.querySelector<HTMLCanvasElement>("canvas[data-preview-canvas]")!;
        const rect = canvas.getBoundingClientRect();
        const ratio = canvas.width / rect.width;
        const data = canvas.getContext("2d")!.getImageData(Math.round((px - rect.left) * ratio) - 1, Math.round((py - rect.top) * ratio) - 1, 3, 3).data;
        let max = 0;
        for (let i = 3; i < data.length; i += 4) max = Math.max(max, data[i]);
        return max;
    }, [x, y] as const);
}

/** Waits until the drawn box stops changing (a draw follows each store write). */
async function settledBox(page: Page, minAlpha = 40): Promise<Rect> {
    let prev = await drawnBox(page, minAlpha);
    for (let i = 0; i < 20; i += 1) {
        await page.waitForTimeout(100);
        const next = await drawnBox(page, minAlpha);
        if (prev && next && Math.abs(prev.x - next.x) < 0.5 && Math.abs(prev.y - next.y) < 0.5 && Math.abs(prev.w - next.w) < 0.5 && Math.abs(prev.h - next.h) < 0.5) return next;
        prev = next;
    }
    if (!prev) throw new Error("the preview draws nothing");
    return prev;
}

const centre = (r: Rect) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });

async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }, release = true): Promise<void> {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 6 });
    await page.mouse.move(to.x, to.y, { steps: 8 });
    if (release) await page.mouse.up();
}

test("move, snap to the centre with guides, corner-scale, and rotate a sticker in the preview; each undoes", async ({ page }) => {
    await createProject(page, "Handles");
    await openLibraryTab(page, "Stickers");
    await page.getByTestId("sticker-card-twemoji:1f525").click();
    await expect.poll(async () => (await sticker(page))?.positionX).toBe(0.5);
    const start = await sticker(page);
    await execute(page, { type: "playhead.seek", seconds: 1 });
    const frame = await previewFrameRect(page);
    const frameCentre = centre(frame);

    // The sticker starts centred; move it right and down.
    await deselect(page);
    const box0 = await settledBox(page);
    expect(Math.abs(centre(box0).x - frameCentre.x)).toBeLessThan(4);
    await drag(page, centre(box0), { x: centre(box0).x + 140, y: centre(box0).y + 70 });
    await expect.poll(async () => (await sticker(page)).positionX).toBeGreaterThan(0.6);
    const moved = await sticker(page);
    expect(moved.positionY).toBeGreaterThan(0.55);
    await waitForSaves(page);

    // Drag it back to 3 px off the centre: guides cross the frame while the pointer is down, and it snaps.
    await deselect(page);
    const box1 = await settledBox(page);
    const c1 = centre(box1);
    await drag(page, c1, { x: frameCentre.x + 3, y: frameCentre.y - 2 }, false);
    await expect.poll(() => alphaAt(page, frameCentre.x, frame.y + 6), { message: "vertical guide near the top of the frame" }).toBeGreaterThan(100);
    await expect.poll(() => alphaAt(page, frame.x + 6, frameCentre.y), { message: "horizontal guide near the left of the frame" }).toBeGreaterThan(100);
    expect(await alphaAt(page, frame.x + frame.w * 0.25, frame.y + 6), "no guide off the centre line").toBeLessThan(20);
    await page.mouse.up();
    await expect.poll(async () => (await sticker(page)).positionX).toBeCloseTo(0.5, 3);
    expect((await sticker(page)).positionY).toBeCloseTo(0.5, 3);
    // The guides go away with the gesture.
    await expect.poll(() => alphaAt(page, frameCentre.x, frame.y + 6)).toBeLessThan(20);
    await waitForSaves(page);

    // Corner scale: with the clip selected, its chrome extends the drawn box by the handle radius (5 px).
    await execute(page, { type: "selection.set", clipIds: [start.id] });
    const chrome = await settledBox(page, 10);
    const corner = { x: chrome.x + chrome.w - 5, y: chrome.y + chrome.h - 5 };
    await drag(page, corner, { x: corner.x + 60, y: corner.y + 60 });
    await expect.poll(async () => (await sticker(page)).scale).toBeGreaterThan(1.2);
    const scaled = await sticker(page);
    await waitForSaves(page);

    // Rotate: the knob (radius 7) sits on top of the chrome; a quarter turn around the centre.
    const chrome2 = await settledBox(page, 10);
    const knob = { x: chrome2.x + chrome2.w / 2, y: chrome2.y + 7 };
    await deselect(page);
    const body = centre(await settledBox(page));
    await execute(page, { type: "selection.set", clipIds: [start.id] });
    await settledBox(page, 10);
    const radius = body.y - knob.y;
    await page.mouse.move(knob.x, knob.y);
    await page.mouse.down();
    for (let i = 1; i <= 12; i += 1) {
        const a = -Math.PI / 2 + (i / 12) * (Math.PI / 2);
        await page.mouse.move(body.x + Math.cos(a) * radius, body.y + Math.sin(a) * radius, { steps: 2 });
    }
    await page.mouse.up();
    await expect.poll(async () => (await sticker(page)).rotationDegrees).toBeCloseTo(90, 0);
    await waitForSaves(page);

    // One undo per gesture, newest first.
    await execute(page, { type: "history.undo" });
    await expect.poll(async () => (await sticker(page)).rotationDegrees).toBe(0);
    expect((await sticker(page)).scale).toBeCloseTo(scaled.scale, 4);
    await execute(page, { type: "history.undo" });
    await expect.poll(async () => (await sticker(page)).scale).toBe(1);
    await execute(page, { type: "history.undo" });
    await expect.poll(async () => (await sticker(page)).positionX).toBeCloseTo(moved.positionX, 4);
    await execute(page, { type: "history.undo" });
    await expect.poll(async () => (await sticker(page)).positionX).toBe(0.5);
    expect((await sticker(page)).positionY).toBe(0.5);
    expect(await sticker(page)).toMatchObject({ scale: 1, rotationDegrees: 0 });
});
