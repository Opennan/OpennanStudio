// Phase 2 smoke: the packaged editor on LocalBackend supports drag, trim, split, undo.
import { expect, test, type Page } from "@playwright/test";

type Rect = { id: string; x: number; y: number; startSeconds: number; duration: number };

async function rects(page: Page): Promise<Rect[]> {
    return page.evaluate(() => (window as unknown as { __timelineDebugRects?: () => Rect[] }).__timelineDebugRects?.() ?? []);
}

async function rect(page: Page, id: string): Promise<Rect> {
    const found = (await rects(page)).find((r) => r.id === id);
    if (!found) throw new Error(`scene ${id} not rendered`);
    return found;
}

async function zoom(page: Page): Promise<number> {
    return page.evaluate(() => (window as unknown as { __timelineDebugMarkers: () => { zoom: number } }).__timelineDebugMarkers().zoom);
}

async function canvasBox(page: Page) {
    const canvas = page.locator('[data-testid="timeline-tracks-scroll"] canvas');
    await expect(canvas).toBeVisible();
    const box = await canvas.boundingBox();
    if (!box) throw new Error("timeline canvas not visible");
    return box;
}

async function clipCount(page: Page): Promise<number> {
    return page.evaluate(() => (window as unknown as { __playground: { controller: { snapshot(): { clips: unknown[] } } } }).__playground.controller.snapshot().clips.length);
}

async function drag(page: Page, from: { x: number; y: number }, dx: number) {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + dx / 2, from.y, { steps: 5 });
    await page.mouse.move(from.x + dx, from.y, { steps: 10 });
    await page.mouse.up();
}

test.beforeEach(async ({ page }) => {
    await page.goto("/?e2e=1");
    // The sample project as the playground renders it (Task 38): 3 scenes, the title clip,
    // a preview video, and an empty inspector (ClipProperties renders nothing without a selection).
    await expect.poll(async () => (await rects(page)).length).toBe(3);
    expect(await clipCount(page)).toBe(1);
    await expect(page.locator(".preview video").first()).toBeAttached();
    await expect(page.locator(".inspector")).toBeEmpty();
});

test("drag moves a scene later on the timeline", async ({ page }) => {
    const box = await canvasBox(page);
    const before = await rect(page, "scene-c");
    await drag(page, { x: box.x + before.x + 40, y: box.y + before.y + 10 }, 120);
    await expect.poll(async () => (await rect(page, "scene-c")).startSeconds).toBeGreaterThan(before.startSeconds + 1);
});

test("trimming the right edge shortens a scene", async ({ page }) => {
    // Edges resize only a selected scene (hit-detector.ts:209-215); unselected, the press moves it.
    await page.evaluate(async () => {
        const { controller } = (window as unknown as { __playground: { controller: { execute(c: unknown): Promise<unknown> } } }).__playground;
        await controller.execute({ type: "selection.set", sceneId: "scene-c" });
    });
    const box = await canvasBox(page);
    const px = await zoom(page);
    const before = await rect(page, "scene-c");
    const edgeX = box.x + before.x + before.duration * px - 3;
    await drag(page, { x: edgeX, y: box.y + before.y + 10 }, -px);
    await expect.poll(async () => (await rect(page, "scene-c")).duration).toBeLessThan(before.duration - 0.5);
});

test("split at playhead cuts the selected clip in two", async ({ page }) => {
    await page.evaluate(async () => {
        const { controller } = (window as unknown as { __playground: { controller: { execute(c: unknown): Promise<unknown> } } }).__playground;
        await controller.execute({ type: "selection.set", clipIds: ["title-clip"] });
        await controller.execute({ type: "playhead.seek", seconds: 3 });
    });
    await page.getByRole("button", { name: "Split at playhead (⌘B)" }).click();
    await expect.poll(() => clipCount(page)).toBe(2);
});

test("undo restores the clip after a split", async ({ page }) => {
    await page.evaluate(async () => {
        const { controller } = (window as unknown as { __playground: { controller: { execute(c: unknown): Promise<unknown> } } }).__playground;
        await controller.execute({ type: "selection.set", clipIds: ["title-clip"] });
        await controller.execute({ type: "playhead.seek", seconds: 3 });
    });
    await page.getByRole("button", { name: "Split at playhead (⌘B)" }).click();
    await expect.poll(() => clipCount(page)).toBe(2);
    const undo = page.getByRole("button", { name: "Undo (⌘Z)" });
    await expect(undo).toBeEnabled();
    await undo.click();
    await expect.poll(() => clipCount(page)).toBe(1);
});
