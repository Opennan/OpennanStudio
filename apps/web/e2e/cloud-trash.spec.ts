// The Cloud tab's trash: Move to trash (removed from every device), the trash shows "Deleted in 7 days", Restore
// brings it back, Delete permanently removes it for good.
import { expect, test } from "@playwright/test";
import { signInOpenNan } from "./ai-helpers";
import { cloudState, saveToCloud, serverIdOf } from "./cloud-helpers";
import { createProject, execute, snapshot } from "./helpers";

test("trash and restore a cloud project, then delete it permanently", async ({ page }) => {
    await createProject(page, "Trash me");
    await signInOpenNan(page);
    await execute(page, { type: "clip.create", input: { trackType: "text", trackIndex: 1, startTime: 0, endTime: 2, mediaType: "text", textContent: "x" } });
    await expect.poll(async () => (await snapshot(page)).clips.length).toBe(1);
    const projectId = await saveToCloud(page);
    await page.goto("/#/");
    await page.getByRole("tab", { name: "OpenNan cloud" }).click();
    const list = page.getByTestId("cloud-list");
    await expect(list.getByText("Trash me")).toBeVisible();
    await page.getByRole("button", { name: "Move Trash me to trash" }).click({ force: true });
    await page.getByRole("dialog", { name: "Move to trash?" }).getByRole("button", { name: "Move to trash" }).click();
    await expect(list.getByText("Trash me")).toHaveCount(0);
    expect((await cloudState()).projects.find((p) => p.id === serverIdOf(projectId))!.deleted_at).not.toBeNull();

    await page.getByRole("tab", { name: "Trash" }).click();
    const trash = page.getByTestId("cloud-trash");
    await expect(trash.getByText("Trash me")).toBeVisible();
    await expect(trash).toContainText("Deleted in 7 days");
    await page.getByRole("button", { name: "Restore Trash me" }).click({ force: true });
    await expect(trash.getByText("Trash me")).toHaveCount(0);
    await page.getByRole("tab", { name: "Projects" }).click();
    await expect(page.getByTestId("cloud-list").getByText("Trash me")).toBeVisible();

    await page.getByRole("button", { name: "Move Trash me to trash" }).click({ force: true });
    await page.getByRole("dialog", { name: "Move to trash?" }).getByRole("button", { name: "Move to trash" }).click();
    await page.getByRole("tab", { name: "Trash" }).click();
    await page.getByRole("button", { name: "Delete Trash me permanently" }).click({ force: true });
    await page.getByRole("dialog", { name: "Delete permanently?" }).getByRole("button", { name: "Delete permanently" }).click();
    await expect(page.getByTestId("cloud-trash").getByText("Trash me")).toHaveCount(0);
    expect((await cloudState()).projects.find((p) => p.id === serverIdOf(projectId))).toBeUndefined();
});
