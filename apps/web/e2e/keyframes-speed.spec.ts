// Phase 10b end to end on a main-track scene: a Scale keyframe from the inspector diamond, a second one by
// moving the slider at another time, ease in-out on the first, diamonds on the timeline, prev/next keyframe
// navigation, a Zoom in clip animation, the Speed tab (2×, then the Hero curve), undo, and an exported MP4
// whose length matches the timeline and whose frames match the preview mid-zoom and mid-keyframe.
import fs from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import {
    FIXTURE_VIDEO, createProject, execute, readMp4Info, sceneRects, serveFfmpegCoreLocally, snapshot, timelineCanvasBox, timelineZoom, waitForSaves,
} from "./helpers";
import { deselect, exportMp4, exportedFrame, meanDiff, previewAt, type Frame } from "./motion-helpers";

interface MotionScene { id: string; keyframesJson?: string | null; animationJson?: string | null; playbackSpeed?: number | null; speedCurveJson?: string | null }
interface Point { time: number; scale?: number; easing?: number }

async function scene(page: Page): Promise<MotionScene> {
    return (await snapshot(page)).scenes[0] as unknown as MotionScene;
}
/** Points of keyframesJson (an array, or { keyframes: [...] } as parseTimelineKeyframes accepts). */
const points = async (page: Page): Promise<Point[]> => {
    const raw = JSON.parse((await scene(page)).keyframesJson ?? "[]") as Point[] | { keyframes?: Point[] };
    return (Array.isArray(raw) ? raw : raw.keyframes ?? []).slice().sort((a, b) => a.time - b.time);
};
const sceneLength = async (page: Page): Promise<number> => (await sceneRects(page))[0]?.duration ?? 0;
const playhead = async (page: Page): Promise<number> => (await snapshot(page)).currentTime;
const round2 = (n: number) => Math.round(n * 100) / 100;

/** Timeline canvas pixels of a column band [x-2, x+2] over the scene row, as a flat array. */
async function timelineColumn(page: Page, x: number, y: number, h: number): Promise<number[]> {
    return page.evaluate(([cx, top, height]) => {
        const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="timeline-tracks-scroll"] canvas')!;
        const ratio = canvas.width / canvas.getBoundingClientRect().width;
        const ctx = canvas.getContext("2d")!;
        return Array.from(ctx.getImageData(Math.round((cx - 2) * ratio), Math.round(top * ratio), Math.max(1, Math.round(5 * ratio)), Math.round(height * ratio)).data);
    }, [x, y, h] as const);
}

function sumDiff(a: number[], b: number[]): number {
    let sum = 0;
    for (let i = 0; i < a.length; i += 1) if (i % 4 !== 3) sum += Math.abs(a[i] - b[i]);
    return sum;
}

test("scale keyframes with easing, timeline diamonds, prev/next, zoom in, speed 2× and a curve; the export matches", async ({ page }) => {
    test.setTimeout(420_000);
    await serveFfmpegCoreLocally(page);
    await createProject(page, "Keyframes and speed");
    await page.getByTestId("media-import-input").setInputFiles(FIXTURE_VIDEO);
    const tile = page.getByTestId("media-item").filter({ hasText: "testsrc-6s.webm" });
    await expect(tile).toContainText("0:06");
    await tile.hover();
    await tile.getByRole("button", { name: "Add testsrc-6s.webm to timeline" }).click();
    await expect.poll(async () => (await snapshot(page)).scenes.length).toBe(1);
    const { id } = await scene(page);
    await expect.poll(() => sceneLength(page)).toBeCloseTo(6, 1);

    // Diamond at 0.5 s (current scale), then the slider at 2.5 s writes the second keyframe.
    await execute(page, { type: "selection.set", sceneId: id });
    await execute(page, { type: "playhead.seek", seconds: 0.5 });
    await expect(page.getByTestId("inspector-tab-video")).toHaveAttribute("aria-selected", "true");
    const scaleDiamond = page.getByTestId("kf-toggle-scale");
    await expect(scaleDiamond).toBeEnabled();
    await expect(scaleDiamond).toHaveAttribute("data-state", "off");
    await scaleDiamond.click();
    await expect.poll(async () => (await points(page)).map((p) => [round2(p.time), p.scale])).toEqual([[0.5, 1]]);
    await expect(scaleDiamond).toHaveAttribute("data-state", "on");
    await execute(page, { type: "playhead.seek", seconds: 2.5 });
    await expect(scaleDiamond).toHaveAttribute("data-state", "keyed");
    await page.getByTestId("scene-scale").getByRole("slider").fill("150");
    await expect.poll(async () => (await points(page)).map((p) => [round2(p.time), p.scale])).toEqual([[0.5, 1], [2.5, 1.5]]);

    // Prev/next move the playhead between the keyframes; ease in-out on the first one.
    await page.getByTestId("kf-prev").click();
    await expect.poll(() => playhead(page)).toBeCloseTo(0.5, 2);
    await page.getByTestId("kf-next").click();
    await expect.poll(() => playhead(page)).toBeCloseTo(2.5, 2);
    await page.getByTestId("kf-prev").click();
    await expect.poll(() => playhead(page)).toBeCloseTo(0.5, 2);
    await expect(page.getByTestId("kf-easing")).toBeVisible();
    // The easing bar remounts when the playhead settles on the keyframe (keyed by its time); retry the click until it lands.
    await expect(async () => {
        await page.getByTestId("ease-ease_in_out").click();
        await expect.poll(async () => (await points(page)).find((p) => round2(p.time) === 0.5)?.easing, { timeout: 1500 }).toBe(3);
    }).toPass({ timeout: 10_000 });
    await expect(page.getByTestId("ease-ease_in_out")).toHaveAttribute("aria-pressed", "true");

    // The timeline draws diamonds on the selected scene: the keyframe columns change with the selection,
    // a column between them only by the selection ring.
    await execute(page, { type: "playhead.seek", seconds: 4 });
    const box = await timelineCanvasBox(page);
    const zoom = await timelineZoom(page);
    const [rect] = await sceneRects(page);
    const columns = [0.5, 2.5, 1.5].map((t) => rect.x + t * zoom);
    const read = () => Promise.all(columns.map((x) => timelineColumn(page, x, rect.y, Math.min(90, box.height - rect.y))));
    await page.waitForTimeout(300);
    const selected = await read();
    await deselect(page);
    await page.waitForTimeout(300);
    const unselected = await read();
    const [k1, k2, control] = selected.map((col, i) => sumDiff(col, unselected[i]));
    expect(k1, `diamond at 0.5 s (control ${control})`).toBeGreaterThan(control + 1500);
    expect(k2, `diamond at 2.5 s (control ${control})`).toBeGreaterThan(control + 1500);

    // Animation → In → Zoom in, 1 s.
    await execute(page, { type: "selection.set", sceneId: id });
    await page.getByTestId("inspector-tab-animation").click();
    await page.getByTestId("anim-card-in-zoom_in").click();
    await expect.poll(async () => JSON.parse((await scene(page)).animationJson ?? "{}").in?.id).toBe("zoom_in");
    await page.getByTestId("anim-duration").getByRole("slider").fill("1");
    await expect.poll(async () => JSON.parse((await scene(page)).animationJson ?? "{}").in?.duration).toBe(1);

    // Speed: 2× halves the scene, the Hero curve changes its length, undo walks back.
    await page.getByTestId("inspector-tab-speed").click();
    const input = page.getByTestId("speed-input");
    await input.fill("2");
    await input.press("Enter");
    await expect.poll(() => sceneLength(page)).toBeCloseTo(3, 1);
    await expect(page.getByTestId("speed-length")).toContainText("6.0");
    await expect(page.getByTestId("speed-length")).toContainText("3.0");
    await page.getByTestId("speed-tab").getByRole("button", { name: "Curve", exact: true }).click();
    await page.getByTestId("speed-preset-hero").click();
    await expect.poll(async () => JSON.parse((await scene(page)).speedCurveJson ?? "null")?.id ?? null).toBe("hero");
    const heroLength = await sceneLength(page);
    expect(Math.abs(heroLength - 3), `hero length ${heroLength}`).toBeGreaterThan(0.2);
    expect(Math.abs(heroLength - 6), `hero length ${heroLength}`).toBeGreaterThan(0.2);
    await expect(page.getByTestId("curve-editor")).toBeVisible();
    await waitForSaves(page);
    await execute(page, { type: "history.undo" });
    await expect.poll(() => sceneLength(page)).toBeCloseTo(3, 1);
    await execute(page, { type: "history.undo" });
    await expect.poll(() => sceneLength(page)).toBeCloseTo(6, 1);
    expect((await points(page)).map((p) => round2(p.time))).toEqual([0.5, 2.5]);
    await execute(page, { type: "history.redo" });
    await expect.poll(() => sceneLength(page)).toBeCloseTo(3, 1);
    // Keyframes follow the source moment they were set on (animations keep their length in seconds).
    await expect.poll(async () => (await points(page)).map((p) => round2(p.time))).toEqual([0.25, 1.25]);
    await waitForSaves(page);

    // Preview frames mid-zoom, mid-keyframe ramp, and at rest; then the export.
    const anim = JSON.parse((await scene(page)).animationJson ?? "{}") as { in?: { duration: number } };
    const [k0, kEnd] = (await points(page)).map((p) => p.time);
    const times = [round2((anim.in?.duration ?? 0.5) / 2), round2((k0 + kEnd) / 2 + 0.1), 2.4];
    await deselect(page);
    const preview: Frame[] = [];
    for (const t of times) preview.push(await previewAt(page, t));

    const file = await exportMp4(page, "keyframes-speed.mp4");
    const info = readMp4Info(await fs.readFile(file));
    expect(info.durationSeconds, "exported length = timeline length").toBeGreaterThan(2.9);
    expect(info.durationSeconds, "exported length = timeline length").toBeLessThan(3.1);
    times.forEach((t, i) => {
        expect(meanDiff(exportedFrame(file, t), preview[i]), `export vs preview at ${t} s`).toBeLessThan(14);
    });
    // The zoom is visible: mid-zoom and at rest differ in both.
    expect(meanDiff(preview[0], preview[2])).toBeGreaterThan(3);
});
