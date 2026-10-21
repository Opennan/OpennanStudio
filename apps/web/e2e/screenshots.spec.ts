// Screenshots of Sign in with OpenNan, the account chip, the Providers screen, and Generate for docs/theme/phase-8/
// (SCREENSHOTS=1 pnpm --filter @opennan/web exec playwright test e2e/screenshots.spec.ts). Skipped otherwise.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { FAKE_OPENNAN, fakeControl } from "./fixtures/fake-opennan";
import { createProject } from "./helpers";

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "docs", "theme", "phase-8");
test.skip(!process.env.SCREENSHOTS, "set SCREENSHOTS=1 to write docs/theme/phase-8");

const modal = (page: Page) => page.locator(".signin");
const shot = async (page: Page, name: string) => {
    await page.waitForTimeout(450);
    await page.screenshot({ path: path.join(OUT, `${name}.png`) });
};
const codeOf = async (page: Page) => (await page.locator(".signin-code-text").textContent())!.trim();

async function openModal(page: Page) {
    await page.goto("/#/");
    await page.locator(".account-chip").click();
    await expect(modal(page)).toHaveAttribute("data-state", "start");
}

async function startFlow(page: Page) {
    const popup = page.waitForEvent("popup");
    await modal(page).getByRole("button", { name: "Sign in with OpenNan" }).click();
    const opened = await popup;
    await expect(modal(page)).toHaveAttribute("data-state", "waiting");
    return opened;
}

async function signIn(page: Page) {
    await openModal(page);
    const popup = await startFlow(page);
    await fakeControl(`approve/${await codeOf(page)}`);
    await popup.close();
    await expect(page.locator(".account-chip")).toContainText("$12.40", { timeout: 10_000 });
}

test("modal states", async ({ page }) => {
    await openModal(page);
    await shot(page, "modal-start");
    const popup = await startFlow(page);
    await page.bringToFront();
    await shot(page, "modal-waiting");
    await fakeControl(`approve/${await codeOf(page)}`);
    await expect(modal(page)).toHaveAttribute("data-state", "success", { timeout: 10_000 });
    await page.waitForTimeout(250);
    await page.screenshot({ path: path.join(OUT, "modal-success.png") });
    await popup.close();
});

test("approval page in the browser (fake opennan.com)", async ({ page }) => {
    await openModal(page);
    const popup = await startFlow(page);
    await popup.setViewportSize({ width: 720, height: 560 });
    await popup.screenshot({ path: path.join(OUT, "browser-approval-fake.png") });
});

test("gated action context line and onboarding variant", async ({ page }) => {
    await createProject(page, "Screens");
    await page.getByRole("button", { name: "Generate", exact: true }).click();
    const generate = page.getByRole("dialog", { name: "Generate" });
    await expect(generate.locator("select option").first()).toHaveText("Nano Banana 2");
    await generate.getByLabel("Describe the image").fill("A lighthouse on a cliff at dawn, soft fog");
    await shot(page, "generate-dialog");
    await generate.getByRole("button", { name: "Generate", exact: true }).click();
    await expect(modal(page)).toContainText("needs an OpenNan account");
    await shot(page, "modal-start-gated");
});

test("onboarding variant", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("opennan-studio:e2e-onboarding", "1"));
    await page.goto("/#/");
    await expect(modal(page).getByRole("button", { name: "Not now" })).toBeVisible();
    await shot(page, "modal-start-onboarding");
});

test("popup blocked", async ({ page }) => {
    await page.addInitScript(() => {
        window.open = () => null;
    });
    await openModal(page);
    await modal(page).getByRole("button", { name: "Sign in with OpenNan" }).click();
    await expect(modal(page).getByRole("link", { name: "Open opennan.com" })).toBeVisible();
    await shot(page, "modal-waiting-popup-blocked");
});

test("zero balance success", async ({ page }) => {
    await fakeControl("balance?usd=0");
    try {
        await openModal(page);
        await startFlow(page);
        await fakeControl(`approve/${await codeOf(page)}`);
        await expect(modal(page)).toContainText("Add credits to start generating.", { timeout: 10_000 });
        await page.bringToFront();
        await shot(page, "modal-success-zero-balance");
    } finally {
        await fakeControl("balance?usd=12.4");
    }
});

test("error states", async ({ page }) => {
    await openModal(page);
    await startFlow(page);
    await page.bringToFront();
    await fakeControl(`expire/${await codeOf(page)}`);
    await expect(modal(page)).toHaveAttribute("data-state", "error-expired", { timeout: 10_000 });
    await shot(page, "modal-error-expired");
});

test("error denied", async ({ page }) => {
    await openModal(page);
    await startFlow(page);
    await page.bringToFront();
    await fakeControl(`deny/${await codeOf(page)}`);
    await expect(modal(page)).toHaveAttribute("data-state", "error-denied", { timeout: 10_000 });
    await shot(page, "modal-error-denied");
});

test("error network", async ({ page }) => {
    await openModal(page);
    await page.route(`${FAKE_OPENNAN}/**`, (route) => route.abort("internetdisconnected"));
    await modal(page).getByRole("button", { name: "Sign in with OpenNan" }).click();
    await expect(modal(page)).toHaveAttribute("data-state", "error-network");
    await page.bringToFront();
    await shot(page, "modal-error-network");
});

test("error rate limited", async ({ page }) => {
    await openModal(page);
    await fakeControl("start-429?retry=30");
    await modal(page).getByRole("button", { name: "Sign in with OpenNan" }).click();
    await expect(modal(page)).toHaveAttribute("data-state", "error-rate-limited");
    await page.bringToFront();
    await shot(page, "modal-error-rate-limited");
});

test("error origin", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("opennan-studio:e2e-origin", "blocked"));
    await openModal(page);
    await modal(page).getByRole("button", { name: "Sign in with OpenNan" }).click();
    await expect(modal(page)).toHaveAttribute("data-state", "error-origin");
    await shot(page, "modal-error-origin");
});

test("account chip and menu, Providers screen", async ({ page }) => {
    await page.goto("/#/settings/providers");
    await expect(page.locator(".opennan-card")).toBeVisible();
    await shot(page, "providers-signed-out");
    await page.goto("/#/");
    await page.locator(".projects-header").screenshot({ path: path.join(OUT, "chip-signed-out.png") });
    await signIn(page);
    await page.locator(".projects-header").screenshot({ path: path.join(OUT, "chip-signed-in.png") });
    await page.locator(".account-chip").click();
    await expect(page.getByRole("menu", { name: "Account" })).toBeVisible();
    await shot(page, "chip-menu");
    await page.keyboard.press("Escape");
    await page.goto("/#/settings/providers");
    await expect(page.locator(".opennan-card")).toContainText("ada@example.com");
    await shot(page, "providers-signed-in");
    await page.screenshot({ path: path.join(OUT, "providers-signed-in-full.png"), fullPage: true });
    await page.getByRole("button", { name: "Add provider" }).click();
    await shot(page, "providers-add-menu");
});
