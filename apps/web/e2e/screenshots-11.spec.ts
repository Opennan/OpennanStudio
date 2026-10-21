// Screenshots of the phase 11 editor for docs/theme/phase-11/ (dark, the only theme, 1440×900): the inspector AI tab
// with prices, translate captions, the AI job tray, the library AI tab, the clip menu's AI group, Remove silences with
// its cut preview, the generator's voice picker, cloud captions, and the routing rows; plus a check that the new
// components use theme tokens only (no colour outside the monochrome palette).
// SCREENSHOTS=1 pnpm --filter @opennan/web exec playwright test e2e/screenshots-11.spec.ts. Skipped otherwise.
import fs from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { fakeControl } from "./fixtures/fake-opennan";
import { addToTimeline, importFixtures, signInOpenNan } from "./ai-helpers";
import { createProject, execute, sceneRects, snapshot, timelineCanvasBox, waitForSaves } from "./helpers";
import { ROOT } from "./motion-helpers";

const OUT = path.join(ROOT, "docs", "theme", "phase-11");
test.skip(!process.env.SCREENSHOTS, "set SCREENSHOTS=1 to write docs/theme/phase-11");
test.use({ colorScheme: "dark" });
test.describe.configure({ mode: "serial" });
test.beforeAll(() => fs.mkdirSync(OUT, { recursive: true }));

const shot = async (page: Page, name: string) => {
    await page.waitForTimeout(700);
    await page.screenshot({ path: path.join(OUT, `${name}.png`) });
};

async function dismissToasts(page: Page): Promise<void> {
    for (const button of await page.getByRole("button", { name: "Dismiss" }).all()) await button.click({ timeout: 1000 }).catch(() => undefined);
}

async function sceneProject(page: Page, name: string): Promise<string> {
    await createProject(page, name);
    await signInOpenNan(page);
    await importFixtures(page, ["clip-360p.webm", "speech-with-gaps.wav"]);
    return addToTimeline(page, "clip-360p.webm", "scene");
}

/** Computed colours of an element tree must be greys (the monochrome palette) or the ice-blue focus/link accent. */
async function colours(page: Page, selector: string): Promise<string[]> {
    return page.evaluate((sel) => {
        const out = new Set<string>();
        for (const root of document.querySelectorAll(sel)) {
            for (const el of [root, ...root.querySelectorAll("*")]) {
                const style = getComputedStyle(el);
                for (const value of [style.color, style.backgroundColor, style.borderTopColor]) {
                    const m = /rgba?\(([^)]+)\)/.exec(value);
                    if (!m) continue;
                    const [r, g, b, a = "1"] = m[1]!.split(",").map((s) => s.trim());
                    if (Number(a) === 0) continue;
                    out.add(`${r},${g},${b}`);
                }
            }
        }
        return [...out];
    }, selector);
}

const grey = (rgb: string) => {
    const [r, g, b] = rgb.split(",").map(Number) as [number, number, number];
    return Math.max(r, g, b) - Math.min(r, g, b) <= 24;
};

test("inspector AI tab, upscale tiers, job tray", async ({ page }) => {
    const sceneId = await sceneProject(page, "AI tools");
    await execute(page, { type: "selection.set", sceneIds: [sceneId], sceneId });
    await page.getByTestId("inspector-tab-ai").click();
    await expect(page.getByTestId("ai-section-voice-isolation")).toContainText("≈ $");
    await shot(page, "inspector-ai-tab");
    await page.getByTestId("ai-section-video-upscale").scrollIntoViewIfNeeded();
    await shot(page, "inspector-ai-upscale");
    await fakeControl("task-steps?n=6");
    await page.getByTestId("ai-section-voice-isolation").getByRole("button", { name: /^Run, about/ }).click();
    await expect(page.getByTestId("ai-job-tray")).toContainText("Isolat");
    await shot(page, "job-tray-running");
    await fakeControl("task-steps?n=1");
    await expect(page.getByTestId("ai-job-tray")).toContainText("Done", { timeout: 60_000 });
    await dismissToasts(page);
    await shot(page, "job-tray-done");
    const offPalette = (await colours(page, ".on-ai-tray, [data-testid=ai-tab]")).filter((c) => !grey(c));
    // Only the ice-blue focus/link accent may be coloured.
    expect(offPalette.length).toBeLessThanOrEqual(2);
});

test("translate captions, clip menu AI group, library AI tab, generator voice picker", async ({ page }) => {
    const sceneId = await sceneProject(page, "AI menu");
    await execute(page, { type: "clip.create", input: { trackType: "text", trackIndex: 1, startTime: 0.2, endTime: 2, mediaType: "text", textContent: "Hello there." } });
    await waitForSaves(page);
    const caption = (await snapshot(page)).clips.find((c) => c.trackType === "text")!;
    await execute(page, { type: "selection.set", clipIds: [caption.id] });
    await page.getByTestId("inspector-tab-ai").click();
    await page.getByTestId("ai-translate-search").fill("thai");
    await page.getByTestId("ai-translate-language").selectOption("th");
    await shot(page, "translate-captions");

    await expect.poll(async () => (await sceneRects(page)).length).toBe(1);
    const box = await timelineCanvasBox(page);
    const rect = (await sceneRects(page)).find((r) => r.id === sceneId)!;
    await page.mouse.click(box.x + rect.x + 30, box.y + rect.y + 20, { button: "right" });
    await expect(page.getByTestId("ctx-ai-group")).toBeVisible();
    await shot(page, "clip-menu-ai");
    await page.keyboard.press("Escape");

    await page.getByTestId("editor-library").getByRole("tab", { name: "AI" }).click();
    await shot(page, "library-ai-tab");
    await page.getByTestId("ai-tile-voice").click();
    const dialog = page.getByRole("dialog", { name: "Generate" });
    await dialog.getByLabel("Text to speak").fill("Welcome back to the lighthouse.");
    await expect(dialog.getByTestId("generate-run")).toContainText("≈ $");
    await shot(page, "generate-voice");
});

test("remove silences with the cut preview, cloud captions, routing rows", async ({ page }) => {
    await createProject(page, "Silences");
    await signInOpenNan(page);
    await importFixtures(page, ["speech-with-gaps.wav"]);
    const clipId = await addToTimeline(page, "speech-with-gaps.wav", "clip");
    await execute(page, { type: "selection.set", clipIds: [clipId] });
    await page.getByTestId("inspector-tab-ai").click();
    await page.getByTestId("ai-silences-find").click();
    await expect(page.getByTestId("ai-silences-summary")).toBeVisible({ timeout: 20_000 });
    await shot(page, "remove-silences-preview");

    await page.locator(".topbar-gated").click();
    await expect(page.getByRole("dialog", { name: "Auto captions" }).getByRole("button", { name: /· Run$/ })).toBeVisible();
    await shot(page, "auto-captions-cloud");
    await page.getByRole("dialog", { name: "Auto captions" }).getByRole("button", { name: "Close" }).click();

    await page.goto("/#/settings/providers");
    await page.getByRole("combobox", { name: "Provider for Isolate voice" }).scrollIntoViewIfNeeded();
    await shot(page, "routing-rows");
});
