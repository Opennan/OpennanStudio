// Settings → AI providers against the fake OpenNan server: sign in from the OpenNan card, per-capability routing,
// the OpenNan-default switch (persisted), and the locked OpenNan-only rows.
import { expect, test } from "@playwright/test";
import { fakeControl } from "./fixtures/fake-opennan";
import { createProject } from "./helpers";

test("Providers screen: sign in from the card, routing, the default switch, locked story rows", async ({ page }) => {
    await page.goto("/#/settings/providers");
    const card = page.locator(".opennan-card");
    await expect(card).toContainText("Default for all AI tools");
    const popup = page.waitForEvent("popup");
    await card.getByRole("button", { name: "Sign in with OpenNan" }).click();
    await page.locator(".signin").getByRole("button", { name: "Sign in with OpenNan" }).click();
    await (await popup).waitForURL(/\/console\/device/);
    await fakeControl(`approve/${(await page.locator(".signin-code-text").textContent())!.trim()}`);
    await expect(card).toContainText("ada@example.com", { timeout: 10_000 });

    const image = page.getByRole("combobox", { name: "Provider for Image generation" });
    await expect(image.locator("option")).toHaveText(["Automatic · OpenNan", "OpenNan"]);
    const storyboard = page.locator('[data-capability="opennan.story.storyboard"]');
    await expect(storyboard).toContainText("OpenNan only");
    await expect(storyboard.getByRole("combobox")).toHaveCount(0);

    const toggle = page.getByRole("switch", { name: "Use OpenNan by default" });
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await expect(image.locator("option").first()).toHaveText("Automatic · none");
    await page.reload();
    await expect(page.getByRole("switch", { name: "Use OpenNan by default" })).toHaveAttribute("aria-checked", "false");

    // With OpenNan off and no other image provider, Generate explains what it needs.
    await createProject(page, "Routing");
    await page.getByRole("button", { name: "Generate", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Generate" }).getByRole("note")).toContainText("requires a provider with the image.generate capability");
});

test("phase 11 rows: the AI editor tools are routable, OpenNan cloud makes captions on the web, and a pick persists", async ({ page }) => {
    await page.goto("/#/settings/providers");
    for (const label of ["Translate captions", "Isolate voice", "Upscale video", "Remove background (video)", "Split vocals and stems", "Transcription and auto captions"]) {
        await expect(page.getByRole("combobox", { name: `Provider for ${label}` })).toBeVisible();
    }
    // Stabilize runs on the device only: it is not a routing row.
    await expect(page.getByRole("combobox", { name: "Provider for Stabilize video" })).toHaveCount(0);
    const captions = page.getByRole("combobox", { name: "Provider for Transcription and auto captions" });
    await expect(captions.locator("option")).toHaveText(["Automatic · OpenNan", "OpenNan"]);
    const isolate = page.getByRole("combobox", { name: "Provider for Isolate voice" });
    await isolate.selectOption("opennan");
    await page.reload();
    await expect(page.getByRole("combobox", { name: "Provider for Isolate voice" })).toHaveValue("opennan");
});
