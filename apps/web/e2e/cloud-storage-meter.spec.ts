// The account menu's storage meter (phase 9a.1) for every signed-in person, read from GET /v1/storage when the menu
// opens, without starting any cloud project work.
import { expect, test } from "@playwright/test";
import { signInOpenNan } from "./ai-helpers";
import { cloudControl } from "./cloud-helpers";
import { fakeState } from "./fixtures/fake-opennan";

test("a signed-in person who never used cloud projects sees their cloud storage in the account menu", async ({ page }) => {
    await cloudControl("storage", { media_limit_bytes: 2 * 1024 ** 3, media_used_extra_bytes: 300 * 1024 ** 2 });
    try {
        await page.goto("/#/");
        await signInOpenNan(page);
        const before = (await fakeState()).requests.filter((r) => r.path === "/v1/storage").length;
        await page.locator(".account-chip").click();
        const meter = page.getByRole("menu", { name: "Account" }).getByTestId("storage-meter");
        // Other specs' files count too (one fake server): about 300 MB of 2 GB.
        await expect(meter).toContainText(/Cloud media3\d\d\.\d MB of 2\.00 GB/);
        expect((await fakeState()).requests.filter((r) => r.path === "/v1/storage").length).toBe(before + 1);
        // Opening the menu again within 30 s reuses the answer.
        await page.keyboard.press("Escape");
        await page.locator(".account-chip").click();
        await expect(page.getByRole("menu", { name: "Account" }).getByTestId("storage-meter")).toBeVisible();
        expect((await fakeState()).requests.filter((r) => r.path === "/v1/storage").length).toBe(before + 1);
        // No cloud backend was built for it.
        expect(await page.evaluate(() => (window as unknown as { __studioCloud: { peek(): unknown } }).__studioCloud.peek() === null)).toBe(true);
    } finally {
        await cloudControl("storage", { media_used_extra_bytes: 0 });
    }
});
