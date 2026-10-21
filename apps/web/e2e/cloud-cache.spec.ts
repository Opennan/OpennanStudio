// Downloaded cloud media (phase 9a.1): a cloud project opened in a fresh browser downloads its media into that
// browser's cache; Settings → Cloud media on this device shows it; Clear cache keeps what a project open in another
// tab uses and frees it once the project is closed; a cleared file downloads again (under a new name) when the
// project opens again.
import { expect, test, type Page } from "@playwright/test";
import { addToTimeline, importFixtures, signInOpenNan } from "./ai-helpers";
import { openEditor, saveToCloud } from "./cloud-helpers";
import { createProject, snapshot } from "./helpers";

const sourceUrl = async (page: Page) => (await snapshot(page)).scenes[0]?.sourceVideoUrl ?? null;

test("Settings shows downloaded cloud media; Clear cache keeps an open project's files and frees a closed one's", async ({ page, browser }) => {
    await createProject(page, "Cache trip");
    await signInOpenNan(page);
    await importFixtures(page, ["testsrc-6s.webm"]);
    await addToTimeline(page, "testsrc-6s.webm", "scene");
    const projectId = await saveToCloud(page);

    const context = await browser.newContext();
    try {
        const other = await context.newPage();
        await other.goto("/#/");
        await signInOpenNan(other);
        await openEditor(other, projectId);
        await expect.poll(() => sourceUrl(other), { timeout: 30_000 }).toMatch(/^opennan-local:\/\/media\/c-/);
        const first = await sourceUrl(other);

        const settings = await context.newPage();
        await settings.goto("/#/settings/providers");
        const section = settings.getByTestId("media-cache-section");
        await expect(section).toContainText("Cloud media on this device");
        await expect(section.getByRole("meter", { name: "Downloaded cloud media" })).not.toHaveAttribute("aria-valuetext", /^0 B/);
        // The project is open in the other tab: its file stays.
        await expect(async () => {
            await section.getByRole("button", { name: "Clear cache" }).click();
            await expect(section.getByRole("status")).toContainText("stayed because open projects use it", { timeout: 2_000 });
        }).toPass({ timeout: 20_000 });

        // Closed: Clear cache frees it.
        await other.goto("/#/");
        await expect(async () => {
            await settings.reload();
            const button = settings.getByTestId("media-cache-section").getByRole("button", { name: "Clear cache" });
            await expect(button).toBeEnabled({ timeout: 2_000 });
            await button.click();
            await expect(settings.getByTestId("media-cache-section").getByRole("status")).toHaveText(/^Freed [^.]+\.$/, { timeout: 2_000 });
        }).toPass({ timeout: 20_000 });
        await expect(settings.getByTestId("media-cache-section").getByRole("meter")).toHaveAttribute("aria-valuetext", /^0 B of /);

        // Opened again: downloaded again under a new name, and it plays from there.
        await openEditor(other, projectId);
        await expect.poll(async () => {
            const url = await sourceUrl(other);
            return url !== first && /^opennan-local:\/\/media\/c-/.test(url ?? "");
        }, { timeout: 30_000 }).toBe(true);
    } finally {
        await context.close();
    }
});

test("Settings changes the cache size", async ({ page }) => {
    await page.goto("/#/settings/providers");
    const section = page.getByTestId("media-cache-section");
    const select = section.getByLabel("Cache size");
    await expect(select).toBeEnabled();
    await expect(select.locator("option").first()).toHaveText(/^Default \(/);
    await select.selectOption({ label: "1 GB" });
    await expect(section.getByRole("meter")).toHaveAttribute("aria-valuetext", / of 1 GB$/);
    await page.reload();
    await expect(page.getByTestId("media-cache-section").getByLabel("Cache size")).toHaveValue(String(1024 ** 3));
    await page.getByTestId("media-cache-section").getByLabel("Cache size").selectOption("default");
    await expect(page.getByTestId("media-cache-section").getByLabel("Cache size")).toHaveValue("default");
});
