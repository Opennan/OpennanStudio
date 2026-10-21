// Local projects stay 100% local (phase 9a): creating, editing, importing media, undoing and reopening a local project
// makes no request to OpenNan at all, and no cloud work starts until someone opens the Cloud tab or a cloud project.
import { expect, test } from "@playwright/test";
import { importFixtures } from "./ai-helpers";
import { FAKE_OPENNAN } from "./fixtures/fake-opennan";
import { createProject, execute, snapshot } from "./helpers";

test("a local project makes zero network calls to OpenNan", async ({ page }) => {
    const outside: string[] = [];
    page.on("request", (request) => {
        const url = request.url();
        if (url.startsWith(FAKE_OPENNAN) || /opennan\.com/.test(url)) outside.push(`${request.method()} ${url}`);
    });
    await createProject(page, "Stays here");
    await importFixtures(page, ["testsrc-6s.webm"]);
    await execute(page, { type: "clip.create", input: { trackType: "text", trackIndex: 1, startTime: 0, endTime: 2, mediaType: "text", textContent: "Local" } });
    await expect.poll(async () => (await snapshot(page)).clips.length).toBe(1);
    await execute(page, { type: "history.undo" });
    await expect.poll(async () => (await snapshot(page)).clips.length).toBe(0);
    await page.reload();
    await expect.poll(() => page.evaluate(() => Boolean((window as unknown as { __studio?: unknown }).__studio)), { timeout: 30_000 }).toBe(true);
    await page.goto("/#/");
    await expect(page.getByRole("list", { name: "Projects" }).getByText("Stays here")).toBeVisible();
    expect(outside).toEqual([]);
    // Nothing about the cloud was even built.
    expect(await page.evaluate(() => (window as unknown as { __studioCloud: { peek(): unknown } }).__studioCloud.peek() === null)).toBe(true);
});
