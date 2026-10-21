// Captures preview snapshots for the export golden tests (packages/export/golden/golden.test.ts).
// Opt-in: GOLDEN_SNAPSHOTS=1 (pnpm golden:snapshots). Writes packages/export/golden/snapshots/<fixture>@<t>.png.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { GOLDEN_FIXTURES } from "../../../packages/export/golden/fixtures";

const SNAPSHOTS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/export/golden/snapshots");

test.skip(!process.env.GOLDEN_SNAPSHOTS, "set GOLDEN_SNAPSHOTS=1 to capture export golden snapshots");
test.use({ viewport: { width: 1000, height: 700 }, deviceScaleFactor: 1 });

type Rect = { x: number; y: number; w: number; h: number };

async function settle(page: Page): Promise<void> {
    await page.waitForFunction(() => {
        const pool = (window as unknown as { __opennanOverlayVids?: Map<string, HTMLVideoElement> }).__opennanOverlayVids;
        const videos = [...document.querySelectorAll("video"), ...(pool ? [...pool.values()] : [])].filter((v) => v.currentSrc || v.src);
        return videos.every((v) => !v.seeking && v.readyState >= 2);
    }, undefined, { timeout: 15_000 });
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.waitForTimeout(300);
}

for (const fixture of GOLDEN_FIXTURES.filter((f) => f.samples.length > 0)) {
    test(`snapshot ${fixture.name}`, async ({ page }) => {
        test.setTimeout(60_000);
        await page.goto(`/?golden=${fixture.name}`);
        await page.waitForFunction(() => "__golden" in window);
        await page.evaluate(() => document.fonts.ready.then(() => undefined));
        for (const seconds of fixture.samples) {
            await page.evaluate(async (t) => {
                const { controller } = (window as unknown as { __golden: { controller: { execute(c: unknown): Promise<unknown> } } }).__golden;
                await controller.execute({ type: "playhead.seek", seconds: t });
            }, seconds);
            await settle(page);
            const rect = await page.evaluate(() => (window as unknown as { __opennanPreviewFrameRect: () => Rect | null }).__opennanPreviewFrameRect());
            expect(rect, JSON.stringify(rect)).not.toBeNull();
            expect(rect!.w > 100 && rect!.h > 100, JSON.stringify(rect)).toBe(true);
            await page.screenshot({
                path: path.join(SNAPSHOTS, `${fixture.name}@${seconds}.png`),
                clip: { x: Math.round(rect!.x), y: Math.round(rect!.y), width: Math.floor(rect!.w), height: Math.floor(rect!.h) },
            });
        }
    });
}
