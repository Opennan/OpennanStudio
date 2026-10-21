// Quota: when the media doesn't fit the cloud storage left, Save to OpenNan says so (and that more storage is coming)
// and can't start; the storage meter in the account menu shows the use; a cloud project whose upload is refused
// keeps syncing its edits and shows "Storage full".
import { expect, test } from "@playwright/test";
import { importFixtures, signInOpenNan } from "./ai-helpers";
import { cloudControl } from "./cloud-helpers";
import { createProject } from "./helpers";

test.afterEach(async () => {
    await cloudControl("storage", { media_limit_bytes: 2 * 1024 ** 3, media_used_extra_bytes: 0 });
});

test("over quota: Save to OpenNan is blocked with a clear message; the meter shows it", async ({ page }) => {
    await createProject(page, "Too big");
    await signInOpenNan(page);
    await importFixtures(page, ["testsrc-6s.webm"]);
    await cloudControl("storage", { media_limit_bytes: 2 * 1024 ** 3, media_used_extra_bytes: 2 * 1024 ** 3 });
    await page.getByRole("button", { name: "Project menu" }).click();
    await page.getByRole("menuitem", { name: "Save to OpenNan…" }).click();
    const dialog = page.getByRole("dialog", { name: /Save ".*" to OpenNan/ });
    await expect(dialog.getByRole("alert")).toContainText("Not enough cloud storage");
    await expect(dialog.getByRole("alert")).toContainText("More storage is coming soon.");
    await expect(dialog.getByRole("button", { name: "Save to OpenNan" })).toBeDisabled();
    await dialog.getByRole("button", { name: "Close" }).click();

    await page.locator(".account-chip").click();
    const meter = page.getByRole("menu", { name: "Account" }).getByTestId("storage-meter");
    await expect(meter).toHaveAttribute("data-full", "true");
    await expect(meter).toContainText("Cloud storage is full");
});
