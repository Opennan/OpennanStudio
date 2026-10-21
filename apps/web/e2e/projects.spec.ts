// Project list: create with a canvas preset, rename, reload, delete; unknown routes; provider settings.
import { expect, test } from "@playwright/test";

test("creates, renames, and deletes a project, and the list survives a reload", async ({ page }) => {
    await page.goto("/#/");
    await expect(page.getByRole("heading", { name: "No projects yet" })).toBeVisible();
    await page.getByRole("button", { name: "New project" }).first().click();
    const dialog = page.getByRole("dialog", { name: "New project" });
    await dialog.getByLabel("Project name").fill("Trip");
    await dialog.getByRole("radio", { name: "9:16 Vertical" }).check();
    await dialog.getByRole("button", { name: "Create project" }).click();
    await expect(page).toHaveURL(/#\/p\/[^/]+$/);

    await page.goto("/#/");
    await expect(page.getByTestId("storage-usage")).toContainText(/Using .+ of .+ available to this browser/);
    const card = page.getByRole("listitem").filter({ hasText: "Trip" });
    await expect(card).toContainText("9:16");
    await card.getByRole("button", { name: "Rename Trip" }).click();
    const input = page.getByRole("textbox", { name: "Project name" });
    await input.fill("Beach trip");
    await input.press("Enter");
    await expect(page.getByRole("link", { name: /^Beach trip/ })).toBeVisible();

    await page.reload();
    await expect(page.getByRole("link", { name: /^Beach trip/ })).toBeVisible();
    await page.getByRole("button", { name: "Delete Beach trip" }).click();
    await page.getByRole("dialog", { name: "Delete project?" }).getByRole("button", { name: "Delete", exact: true }).click();
    await expect(page.getByRole("heading", { name: "No projects yet" })).toBeVisible();
});

test("unknown links and missing projects lead back to the list", async ({ page }) => {
    await page.goto("/#/nope");
    await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
    await page.goto("/#/p/does-not-exist");
    await expect(page.getByRole("heading", { name: "Project not found" })).toBeVisible();
    await page.getByRole("link", { name: "Back to projects" }).click();
    await expect(page.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();
});

test("the provider settings screen opens from the project list", async ({ page }) => {
    await page.goto("/#/");
    await page.getByRole("link", { name: "AI providers" }).click();
    await expect(page.getByRole("heading", { name: "AI providers", exact: true })).toBeVisible();
    await expect(page.locator(".opennan-card").getByRole("button", { name: "Sign in with OpenNan" })).toBeEnabled();
});
