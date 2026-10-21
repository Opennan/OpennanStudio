// Phase 10c end to end: keyframes on a layer video clip through the controller, then the timeline diamonds
// (click seeks, drag retimes with one undo step, right-click → Ease in) and the graph editor (drag a point's
// value), each checked in the stored keyframesJson.
import { expect, test, type Page } from "@playwright/test";
import { FIXTURE_VIDEO, createProject, execute, snapshot, timelineCanvasBox, timelineZoom, waitForSaves } from "./helpers";

interface Point { time: number; scale?: number; easing?: number }
interface KeyframeDiamonds { clipId: string | null; start: number; duration: number; diamonds: Array<{ time: number; x: number; y: number }> }

const round2 = (n: number) => Math.round(n * 100) / 100;

async function clipPoints(page: Page, id: string): Promise<Point[]> {
    const clip = (await snapshot(page)).clips.find((c) => c.id === id) as unknown as { keyframesJson?: string | null } | undefined;
    const raw = JSON.parse(clip?.keyframesJson ?? "[]") as Point[] | { keyframes?: Point[] };
    return (Array.isArray(raw) ? raw : raw.keyframes ?? []).slice().sort((a, b) => a.time - b.time);
}

async function diamonds(page: Page): Promise<KeyframeDiamonds> {
    const found = await page.evaluate(() => (window as unknown as { __timelineDebugKeyframes?: () => KeyframeDiamonds | null }).__timelineDebugKeyframes?.() ?? null);
    if (!found) throw new Error("no keyframe diamonds on the timeline");
    return found;
}

/** Page coordinates of the diamond at item time `time`. */
async function diamondAt(page: Page, time: number): Promise<{ x: number; y: number }> {
    const box = await timelineCanvasBox(page);
    const diamond = (await diamonds(page)).diamonds.find((d) => Math.abs(d.time - time) < 0.002);
    if (!diamond) throw new Error(`no diamond at ${time} s`);
    return { x: box.x + diamond.x, y: box.y + diamond.y };
}

const selectedKeyframe = (page: Page) => page.evaluate(() => (window as unknown as { __studio: { store: { getState(): { selectedKeyframe: unknown } } } }).__studio.store.getState().selectedKeyframe);

test("timeline diamonds select, retime, and ease keyframes; the graph editor drags a value", async ({ page }) => {
    test.setTimeout(180_000);
    await createProject(page, "Keyframe graph");
    await page.getByTestId("media-import-input").setInputFiles(FIXTURE_VIDEO);
    const tile = page.getByTestId("media-item").filter({ hasText: "testsrc-6s.webm" });
    await expect(tile).toContainText("0:06");
    await tile.hover();
    await tile.getByRole("button", { name: "Add testsrc-6s.webm to timeline" }).click();
    await expect.poll(async () => (await snapshot(page)).scenes.length).toBe(1);

    // A layer clip 1..5 s with Scale keyframes at 0.5 s and 2.5 s (item time), all through the controller.
    const created = await execute(page, {
        type: "clip.create",
        input: { trackType: "video", trackIndex: 2, startTime: 1, endTime: 5, mediaUrl: (await snapshot(page)).scenes[0].sourceVideoUrl, mediaType: "video", label: "Overlay" },
    }) as { createdClipIds?: string[] };
    const id = created.createdClipIds?.[0];
    expect(id).toBeTruthy();
    await execute(page, { type: "selection.set", clipIds: [id] });
    expect((await execute(page, { type: "keyframe.set", clipId: id, time: 0.5, values: { scale: 1 } })).ok).toBe(true);
    expect((await execute(page, { type: "keyframe.set", clipId: id, time: 2.5, values: { scale: 1.5 } })).ok).toBe(true);
    await execute(page, { type: "playhead.seek", seconds: 0 });
    await expect.poll(async () => (await diamonds(page)).diamonds.map((d) => d.time)).toEqual([0.5, 2.5]);

    // Click the 2.5 s diamond: it is selected and the playhead jumps to it (1 + 2.5 s).
    const second = await diamondAt(page, 2.5);
    await page.mouse.click(second.x, second.y);
    await expect.poll(() => selectedKeyframe(page)).toEqual({ clipId: id, time: 2.5 });
    await expect.poll(async () => (await snapshot(page)).currentTime).toBeCloseTo(3.5, 2);

    // Drag it half a second later: one keyframe.retime, and one undo brings it back.
    await execute(page, { type: "playhead.seek", seconds: 0 });
    const zoom = await timelineZoom(page);
    await page.mouse.move(second.x, second.y);
    await page.mouse.down();
    await page.mouse.move(second.x + zoom * 0.25, second.y, { steps: 5 });
    await page.mouse.move(second.x + zoom * 0.5, second.y, { steps: 5 });
    await page.mouse.up();
    await expect.poll(async () => (await clipPoints(page, id!)).map((p) => round2(p.time))).toEqual([0.5, 3]);
    expect((await clipPoints(page, id!))[1].scale).toBe(1.5);
    await waitForSaves(page);
    await execute(page, { type: "history.undo" });
    await expect.poll(async () => (await clipPoints(page, id!)).map((p) => round2(p.time))).toEqual([0.5, 2.5]);

    // Right-click the 0.5 s diamond → Ease in.
    const first = await diamondAt(page, 0.5);
    await page.mouse.click(first.x, first.y, { button: "right" });
    const menu = page.getByTestId("keyframe-menu");
    await expect(menu).toBeVisible();
    await menu.getByRole("menuitemradio", { name: "Ease in", exact: true }).click();
    await expect.poll(async () => (await clipPoints(page, id!))[0].easing).toBe(1);
    await expect(menu).toBeHidden();

    // Open the graph editor from the diamond's menu and drag the first point up.
    await page.mouse.click(first.x, first.y, { button: "right" });
    await page.getByTestId("keyframe-menu-graph").click();
    const graph = page.getByTestId("kf-graph");
    await expect(graph).toBeVisible();
    await expect(page.getByTestId("kf-graph-channel")).toHaveValue("scale");
    const point = page.getByTestId("kf-graph-point-0");
    const box = await point.boundingBox();
    if (!box) throw new Error("graph point not visible");
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx, cy - 10, { steps: 4 });
    await page.mouse.move(cx, cy - 24, { steps: 4 });
    await page.mouse.up();
    await expect.poll(async () => (await clipPoints(page, id!))[0].scale ?? 1).toBeGreaterThan(1.02);
    const [moved] = await clipPoints(page, id!);
    expect(round2(moved.time)).toBe(0.5);
    expect(moved.easing).toBe(1);
    await waitForSaves(page);
});
