// Phase 10d end to end: motion tracking. A generated clip (a textured square moving at a known speed over a noisy
// background, made with a native ffmpeg) is imported as the main-track clip; the Track tab's box is drawn on the
// preview around the square, Track runs the browser tracker (mediabunny + worker), the track is checked against
// the known path, and Apply makes a text clip follow it through position keyframes (one undo step).
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { createProject, execute, snapshot, waitForSaves } from "./helpers";
import { previewFrameRect } from "./motion-helpers";

const W = 640;
const H = 360;
const SIDE = 96;
const SECONDS = 3;
/** The square's top-left at t seconds (the overlay expression below). */
const square = (t: number) => ({ x: 100 + 120 * t, y: 120 + 40 * t });

function ffmpegBinary(): string | null {
    for (const candidate of [process.env.OPENNAN_PARITY_FFMPEG, "ffmpeg"]) {
        if (candidate && spawnSync(candidate, ["-version"]).status === 0) return candidate;
    }
    return null;
}

async function makeFixture(dir: string, ffmpeg: string): Promise<string> {
    await fs.mkdir(dir, { recursive: true });
    const bg = path.join(dir, "bg.png");
    const tex = path.join(dir, "tex.png");
    const out = path.join(dir, "moving-square.webm");
    const run = (args: string[]) => execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", ...args]);
    run(["-f", "lavfi", "-i", `nullsrc=s=${W}x${H},format=gray,geq=lum='60+70*random(1)'`, "-frames:v", "1", bg]);
    run(["-f", "lavfi", "-i", `mandelbrot=size=${SIDE}x${SIDE}`, "-frames:v", "1", tex]);
    run([
        "-framerate", "30", "-loop", "1", "-i", bg, "-framerate", "30", "-loop", "1", "-i", tex,
        "-filter_complex", "[0][1]overlay=x='100+120*t':y='120+40*t',format=yuv420p", "-t", String(SECONDS), "-r", "30",
        "-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "20", "-deadline", "realtime", "-cpu-used", "8", out,
    ]);
    return out;
}

interface Sample { time: number; x: number; y: number; confidence: number; lost: boolean }
interface Point { time: number; position_x?: number; position_y?: number }

const trackingResult = (page: Page) => page.evaluate(() => {
    const state = (window as unknown as { __studio: { store: { getState(): { trackingResult: { samples: Sample[] } | null } } } }).__studio.store.getState();
    return state.trackingResult ? JSON.parse(JSON.stringify(state.trackingResult.samples)) as Sample[] : null;
});

async function clipPoints(page: Page, id: string): Promise<Point[]> {
    const clip = (await snapshot(page)).clips.find((c) => c.id === id) as unknown as { keyframesJson?: string | null } | undefined;
    const raw = JSON.parse(clip?.keyframesJson ?? "[]") as Point[] | { keyframes?: Point[] };
    return (Array.isArray(raw) ? raw : raw.keyframes ?? []).slice().sort((a, b) => a.time - b.time);
}

test("draws a box on the preview, tracks a moving square, and makes a text clip follow it", async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    const ffmpeg = ffmpegBinary();
    test.skip(!ffmpeg, "needs a native ffmpeg to generate the moving-square clip");
    const fixture = await makeFixture(testInfo.outputPath("fixture"), ffmpeg!);

    await createProject(page, "Motion tracking");
    await page.getByTestId("media-import-input").setInputFiles(fixture);
    const tile = page.getByTestId("media-item").filter({ hasText: "moving-square.webm" });
    await expect(tile).toContainText("0:03");
    await tile.hover();
    await tile.getByRole("button", { name: "Add moving-square.webm to timeline" }).click();
    await expect.poll(async () => (await snapshot(page)).scenes.length).toBe(1);
    const sceneId = (await snapshot(page)).scenes[0].id;
    const created = await execute(page, {
        type: "clip.create", input: { trackType: "text", trackIndex: 1, startTime: 0, endTime: SECONDS, textContent: "Follow", positionX: 0.5, positionY: 0.2 },
    }) as { createdClipIds?: string[] };
    const textId = created.createdClipIds![0];
    // Just past the scene's start (imported scenes sit at 0.001 s): still the first frame.
    await execute(page, { type: "playhead.seek", seconds: 0.02 });
    await execute(page, { type: "selection.set", sceneId });

    // The Track tab puts a box on the preview; drag a new one around the square on the first frame.
    await page.getByTestId("inspector-tab-track").click();
    await expect(page.getByTestId("track-tab")).toBeVisible();
    const frame = await previewFrameRect(page);
    const at = (px: number, py: number) => ({ x: frame.x + (px / W) * frame.w, y: frame.y + (py / H) * frame.h });
    const from = at(square(0).x - 4, square(0).y - 4);
    const to = at(square(0).x + SIDE + 4, square(0).y + SIDE + 4);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 4 });
    await page.mouse.move(to.x, to.y, { steps: 4 });
    await page.mouse.up();
    const region = await page.evaluate(() => (window as unknown as { __studio: { store: { getState(): { trackingRegion: { region: { x: number; y: number; width: number; height: number } } | null } } } }).__studio.store.getState().trackingRegion?.region ?? null);
    expect(region!.x).toBeCloseTo((square(0).x - 4) / W, 2);
    expect(region!.width).toBeCloseTo((SIDE + 8) / W, 2);

    // Track: the browser tracker follows the square within a few pixels.
    await page.getByTestId("track-run").click();
    await expect(page.getByTestId("track-status")).toContainText(/Tracked \d+ frames/, { timeout: 120_000 });
    const samples = (await trackingResult(page))!;
    expect(samples.length).toBeGreaterThan(80);
    let worst = 0;
    // A sample at item time t shows the frame with the latest timestamp at or before t (30 fps, the scene starts at 0.001 s).
    for (const sample of samples) {
        const s = square(Math.floor((sample.time + 1e-6) * 30) / 30);
        worst = Math.max(worst, Math.hypot(sample.x * W - (s.x + SIDE / 2), sample.y * H - (s.y + SIDE / 2)));
        expect(sample.lost).toBe(false);
    }
    console.log(`worst tracking error ${worst.toFixed(2)} px at ${W}x${H} over ${samples.length} frames`);
    testInfo.annotations.push({ type: "worst tracking error (px at 640x360)", description: worst.toFixed(2) });
    expect(worst).toBeLessThan(3);

    // Apply to the text clip: position keyframes that move it right and down with the square.
    await page.getByTestId(`track-follower-${textId}`).check();
    await page.getByTestId("track-apply").click();
    await expect(page.getByTestId("track-status")).toContainText("now follows");
    const points = await clipPoints(page, textId);
    expect(points.length).toBeGreaterThanOrEqual(2);
    const first = points[0];
    const last = points[points.length - 1];
    expect(first.time).toBeCloseTo(0, 2);
    expect(first.position_x).toBeCloseTo(0.5, 3);
    expect(first.position_y).toBeCloseTo(0.2, 3);
    // The square moves 120·3/640 of the width and 40·3/360 of the height; positions move at least that much
    // (a clip's position spans the frame minus its own box).
    const span = last.time - first.time;
    expect(last.position_x! - first.position_x!).toBeGreaterThan(((120 * span) / W) * 0.95);
    expect(last.position_y! - first.position_y!).toBeGreaterThan(((40 * span) / H) * 0.95);

    // One undo step takes the keyframes back.
    await waitForSaves(page);
    await execute(page, { type: "history.undo" });
    await expect.poll(async () => (await clipPoints(page, textId)).length).toBe(0);
});
