// Screenshots of phase 9a (OpenNan cloud projects) for docs/theme/phase-9a/ (dark, the only theme, 1440×900): the
// Projects screen's Local and Cloud tabs (signed out and in), the trash, the project menu, Save to OpenNan, the sync
// chip (saved, offline, conflict), and the storage meter (full); plus a check that the new components use theme
// greys only. SCREENSHOTS=1 pnpm --filter @opennan/web exec playwright test e2e/screenshots-9a.spec.ts. Skipped otherwise.
import fs from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { importFixtures, signInOpenNan } from "./ai-helpers";
import { cloudControl, saveToCloud, serverIdOf, syncKind } from "./cloud-helpers";
import { createProject, execute, snapshot } from "./helpers";
import { ROOT } from "./motion-helpers";

const OUT = path.join(ROOT, "docs", "theme", "phase-9a");
test.skip(!process.env.SCREENSHOTS, "set SCREENSHOTS=1 to write docs/theme/phase-9a");
test.use({ colorScheme: "dark" });
test.describe.configure({ mode: "serial" });
test.beforeAll(() => fs.mkdirSync(OUT, { recursive: true }));
test.afterEach(async () => {
    await cloudControl("offline", { mode: "off" });
    await cloudControl("storage", { media_limit_bytes: 2 * 1024 ** 3, media_used_extra_bytes: 0 });
});

const shot = async (page: Page, name: string) => {
    await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(OUT, `${name}.png`) });
};

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

/** Greys, plus the destructive red the full storage bar and refusals use and the link/focus accent. */
const allowed = (rgb: string) => {
    const [r, g, b] = rgb.split(",").map(Number) as [number, number, number];
    const isGrey = Math.max(r, g, b) - Math.min(r, g, b) <= 24;
    return isGrey || r > g + 40 || b > r;
};

test("projects: the Cloud tab signed out", async ({ page }) => {
    await page.goto("/#/");
    await page.getByRole("tab", { name: "OpenNan cloud" }).click();
    await expect(page.getByTestId("cloud-signin")).toBeVisible();
    await shot(page, "projects-cloud-signed-out");
});

test("projects, project menu, Save to OpenNan, sync chip, trash, storage", async ({ page }) => {
    await createProject(page, "Product launch");
    await signInOpenNan(page);
    await importFixtures(page, ["testsrc-6s.webm"]);
    await execute(page, { type: "clip.create", input: { trackType: "text", trackIndex: 1, startTime: 0, endTime: 3, mediaType: "text", textContent: "Launch day" } });
    await expect.poll(async () => (await snapshot(page)).clips.length).toBe(1);
    await page.getByRole("button", { name: "Project menu" }).click();
    await shot(page, "project-menu");
    await page.getByRole("menuitem", { name: "Save to OpenNan…" }).click();
    await expect(page.getByTestId("save-plan")).toBeVisible({ timeout: 20_000 });
    await shot(page, "save-to-opennan");
    await page.getByRole("dialog", { name: /Save ".*" to OpenNan/ }).getByRole("button", { name: "Save to OpenNan" }).click();
    await expect.poll(async () => (await page.evaluate(() => location.hash)).includes("cloud-"), { timeout: 60_000 }).toBe(true);
    const projectId = decodeURIComponent((await page.evaluate(() => location.hash)).replace(/^#\/p\//, ""));
    await expect.poll(() => syncKind(page, projectId), { timeout: 30_000 }).toBe("saved");
    await page.getByTestId("sync-chip").click();
    await shot(page, "sync-saved");
    expect((await colours(page, ".sync-chip, .sync-popover")).filter((c) => !allowed(c))).toEqual([]);
    await page.keyboard.press("Escape");

    // Offline: edits wait on this device.
    await cloudControl("offline", { mode: "drop" });
    const clipId = (await snapshot(page)).clips[0]!.id;
    await execute(page, { type: "clip.update", clipIds: [clipId], patch: { textContent: "Launch day!" } });
    await expect.poll(() => syncKind(page, projectId), { timeout: 20_000 }).toBe("offline");
    await page.getByTestId("sync-chip").click();
    await shot(page, "sync-offline");
    await page.keyboard.press("Escape");
    await cloudControl("offline", { mode: "off" });
    await expect.poll(() => syncKind(page, projectId), { timeout: 30_000 }).toBe("saved");

    // A conflict: the clip deleted on another device while this one edits it.
    await cloudControl("delete-entity", { project_id: serverIdOf(projectId), kind: "clip", id: clipId });
    await execute(page, { type: "clip.update", clipIds: [clipId], patch: { opacity: 0.5 } });
    await expect.poll(() => syncKind(page, projectId), { timeout: 20_000 }).toBe("conflict");
    await page.getByTestId("sync-chip").click();
    await shot(page, "sync-conflict");
    await page.getByRole("dialog", { name: "Sync status" }).getByRole("button", { name: "OK" }).click();

    // A second cloud project, then the Cloud tab and the trash.
    await createProject(page, "Lyric video");
    await saveToCloud(page);
    await createProject(page, "Trip edit (draft)");
    await page.goto("/#/");
    await shot(page, "projects-local");
    await page.getByRole("tab", { name: "OpenNan cloud" }).click();
    await expect(page.getByTestId("cloud-list").getByTestId("cloud-card")).toHaveCount(2, { timeout: 20_000 });
    await shot(page, "projects-cloud");
    expect((await colours(page, ".projects-tabs, .cloud-projects")).filter((c) => !allowed(c))).toEqual([]);
    await page.getByRole("button", { name: "Move Lyric video to trash" }).click({ force: true });
    await page.getByRole("dialog", { name: "Move to trash?" }).getByRole("button", { name: "Move to trash" }).click();
    await page.getByRole("tab", { name: "Trash" }).click();
    await expect(page.getByTestId("cloud-trash").getByText("Lyric video")).toBeVisible();
    await shot(page, "projects-cloud-trash");

    // Storage full: the account menu's meter.
    await cloudControl("storage", { media_limit_bytes: 2 * 1024 ** 3, media_used_extra_bytes: 2 * 1024 ** 3 });
    await page.getByRole("tab", { name: "Projects" }).click();
    await page.locator(".account-chip").click();
    await expect(page.getByRole("menu", { name: "Account" }).getByTestId("storage-meter")).toHaveAttribute("data-full", "true");
    await shot(page, "account-storage-full");
});
