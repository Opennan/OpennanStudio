// One tab at a time edits a cloud project (Web Locks): a second tab of the same browser says it is open elsewhere and
// can take it over; the first tab then says it was opened in another tab.
import { expect, test } from "@playwright/test";
import { signInOpenNan } from "./ai-helpers";
import { openEditor, saveToCloud } from "./cloud-helpers";
import { createProject, execute, snapshot } from "./helpers";

test("a cloud project open in another tab can be taken over", async ({ page, context }) => {
    await createProject(page, "Two tabs");
    await signInOpenNan(page);
    await execute(page, { type: "clip.create", input: { trackType: "text", trackIndex: 1, startTime: 0, endTime: 2, mediaType: "text", textContent: "tab" } });
    await expect.poll(async () => (await snapshot(page)).clips.length).toBe(1);
    const projectId = await saveToCloud(page);

    const second = await context.newPage();
    await second.goto(`/#/p/${projectId}`);
    const locked = second.getByTestId("cloud-editor-locked");
    await expect(locked).toContainText("open in another tab");
    await locked.getByRole("button", { name: "Open it here" }).click();
    await expect.poll(() => second.evaluate(() => Boolean((window as unknown as { __studio?: unknown }).__studio)), { timeout: 30_000 }).toBe(true);
    await expect(page.getByTestId("cloud-editor-locked")).toContainText("opened in another tab");
    await openEditor(second, projectId);
    await expect.poll(async () => (await snapshot(second)).clips.length).toBe(1);
});
