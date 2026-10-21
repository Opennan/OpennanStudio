// Sign in with OpenNan in the web app against the fake OpenNan server (phase 8 design, "Playwright e2e for the web
// modal", cases 1-15). Each test has a fresh browser context, so it starts signed out. Codes are approved by the
// code each test sees (no global reset: other spec files use the same fake server in parallel).
import { expect, test, type Page } from "@playwright/test";
import { FAKE_OPENNAN, fakeControl, fakeState } from "./fixtures/fake-opennan";
import { createProject } from "./helpers";

const modal = (page: Page) => page.locator(".signin");
const chip = (page: Page) => page.locator(".account-chip");
const codeOf = async (page: Page) => (await page.locator(".signin-code-text").textContent())!.trim();

async function openFromChip(page: Page) {
    await page.goto("/#/");
    await chip(page).click();
    await expect(modal(page)).toHaveAttribute("data-state", "start");
}

/** Clicks the primary and returns the approval popup once it shows the device page. */
async function startFlow(page: Page, name = "Sign in with OpenNan") {
    const popup = page.waitForEvent("popup");
    await modal(page).getByRole("button", { name }).click();
    const opened = await popup;
    await opened.waitForURL(/\/console\/device\?code=/);
    await expect(modal(page)).toHaveAttribute("data-state", "waiting");
    return opened;
}

async function signIn(page: Page) {
    await openFromChip(page);
    const popup = await startFlow(page);
    await fakeControl(`approve/${await codeOf(page)}`);
    await popup.close();
    await expect(chip(page)).toContainText("$12.40", { timeout: 10_000 });
}

test("1 · start state: focus on the primary, Esc closes and focus returns to the chip", async ({ page }) => {
    await openFromChip(page);
    const dialog = page.getByRole("dialog", { name: "Sign in to OpenNan" });
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute("aria-modal", "true");
    await expect(dialog.getByRole("button", { name: "Sign in with OpenNan" })).toBeFocused();
    await expect(dialog).toContainText("Use OpenNan AI tools in Studio.");
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(chip(page)).toBeFocused();
});

test("2 · happy path: popup on the approval page, matching code, approve, success, closes, chip shows the balance", async ({ page }) => {
    await openFromChip(page);
    const popup = await startFlow(page);
    const code = await codeOf(page);
    expect(popup.url()).toBe(`${FAKE_OPENNAN}/console/device?code=${code}`);
    await expect(popup.locator("#code")).toHaveText(code);
    await popup.getByRole("button", { name: "Approve" }).click();
    await expect(modal(page)).toHaveAttribute("data-state", "success", { timeout: 10_000 });
    const shownAt = Date.now();
    await expect(modal(page)).toContainText("You're signed in");
    await expect(modal(page)).toContainText("ada@example.com");
    await expect(modal(page)).toContainText("Credits $12.40");
    await expect(modal(page)).toHaveCount(0, { timeout: 2500 });
    expect(Date.now() - shownAt).toBeLessThan(2500);
    await expect(chip(page)).toContainText("$12.40");
    const device = (await fakeState()).devices.find((d) => d.userCode === code)!;
    expect(device).toMatchObject({ client: "web", status: "consumed", deviceName: expect.stringMatching(/^Web · Chrome/) });
});

test("3 · Copy puts the code on the clipboard", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: "http://localhost:4318" });
    await openFromChip(page);
    await startFlow(page);
    const code = await codeOf(page);
    await modal(page).getByRole("button", { name: "Copy code" }).click();
    await expect(modal(page).getByRole("button", { name: "Copied" })).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(code);
    await expect(modal(page).getByRole("button", { name: "Copy code" })).toBeVisible({ timeout: 3000 });
});

test("4 · Open browser again opens a second popup with the same URL", async ({ page }) => {
    await openFromChip(page);
    const first = await startFlow(page);
    const second = page.waitForEvent("popup");
    await modal(page).getByRole("button", { name: "Open browser again" }).click();
    const again = await second;
    await again.waitForURL(/\/console\/device\?code=/);
    expect(again.url()).toBe(first.url());
    expect(again).not.toBe(first);
});

test("5 · expired code, then Try again gives a different code", async ({ page }) => {
    await openFromChip(page);
    await startFlow(page);
    const code = await codeOf(page);
    await fakeControl(`expire/${code}`);
    await expect(modal(page)).toHaveAttribute("data-state", "error-expired", { timeout: 10_000 });
    await expect(page.getByRole("alert")).toContainText("Code expired");
    await expect(page.getByRole("alert")).toContainText("Codes work for 10 minutes. Get a new one to continue.");
    await startFlow(page, "Try again");
    expect(await codeOf(page)).not.toBe(code);
});

test("6 · denied, then Try again", async ({ page }) => {
    await openFromChip(page);
    await startFlow(page);
    await fakeControl(`deny/${await codeOf(page)}`);
    await expect(modal(page)).toHaveAttribute("data-state", "error-denied", { timeout: 10_000 });
    await expect(page.getByRole("alert")).toContainText("Sign-in was denied");
    await startFlow(page, "Try again");
});

test("7 · offline: Can't reach OpenNan, then retry once the network is back", async ({ page }) => {
    await openFromChip(page);
    await page.route(`${FAKE_OPENNAN}/**`, (route) => route.abort("internetdisconnected"));
    await modal(page).getByRole("button", { name: "Sign in with OpenNan" }).click();
    await expect(modal(page)).toHaveAttribute("data-state", "error-network");
    await expect(page.getByRole("alert")).toContainText("Can't reach OpenNan");
    await expect(page.getByRole("alert")).toContainText("Editing keeps working offline.");
    await page.unroute(`${FAKE_OPENNAN}/**`);
    await startFlow(page, "Try again");
});

test("8 · 429: Try again stays disabled until Retry-After has passed", async ({ page }) => {
    await openFromChip(page);
    await fakeControl("start-429?retry=3");
    await modal(page).getByRole("button", { name: "Sign in with OpenNan" }).click();
    await expect(modal(page)).toHaveAttribute("data-state", "error-rate-limited");
    await expect(page.getByRole("alert")).toContainText("Too many sign-in attempts");
    const retry = modal(page).locator(".signin-primary");
    await expect(retry).toBeDisabled();
    await expect(retry).toHaveText(/Try again in [123] s/);
    await expect(retry).toBeEnabled({ timeout: 5000 });
    await expect(retry).toHaveText("Try again");
});

test("9 · polls are never closer than the server allows, even with focus changes", async ({ page }) => {
    await openFromChip(page);
    await startFlow(page);
    const code = await codeOf(page);
    for (let i = 0; i < 6; i++) {
        await page.evaluate(() => window.dispatchEvent(new Event("focus")));
        await page.waitForTimeout(700);
    }
    await page.waitForTimeout(5000);
    const device = (await fakeState()).devices.find((d) => d.userCode === code)!;
    expect(device.pollSpacingsMs.length).toBeGreaterThanOrEqual(2);
    // Interval 3 s: polls, scheduled or on focus, are never closer than the interval (RFC 8628).
    for (const spacing of device.pollSpacingsMs) expect(spacing).toBeGreaterThanOrEqual(2950);
});

test("10 · a gated AI action opens the modal with its context and continues after approval", async ({ page }) => {
    await createProject(page, "Gate");
    await page.getByRole("button", { name: "Generate", exact: true }).click();
    const generate = page.getByRole("dialog", { name: "Generate" });
    await generate.getByLabel("Describe the image").fill("A lighthouse at dawn");
    // The run button carries its price once it loads ("≈ $0.040 · Generate").
    await generate.getByTestId("generate-run").click();
    await expect(modal(page)).toContainText("Generate image needs an OpenNan account.");
    const popup = await startFlow(page);
    await popup.getByRole("button", { name: "Approve" }).click();
    await expect(generate.getByRole("status")).toHaveText("Added to Media and the timeline.", { timeout: 20_000 });
    const requests = (await fakeState()).requests.filter((r) => r.path === "/v1/images/generations" && r.method === "POST");
    expect(requests.some((r) => (r.body as { prompt?: string }).prompt === "A lighthouse at dawn")).toBe(true);
    await generate.getByRole("button", { name: "Close" }).click();
    await expect(page.getByTestId("media-item")).toHaveCount(1);
});

test("11 · zero balance: no auto-close, Buy credits opens billing", async ({ page }) => {
    await fakeControl("balance?usd=0");
    try {
        await openFromChip(page);
        await startFlow(page);
        await fakeControl(`approve/${await codeOf(page)}`);
        await expect(modal(page)).toContainText("Add credits to start generating.", { timeout: 10_000 });
        await page.waitForTimeout(2600);
        await expect(modal(page)).toHaveAttribute("data-state", "success");
        const billing = page.waitForEvent("popup");
        await modal(page).getByRole("button", { name: "Buy credits" }).click();
        await (await billing).waitForURL(`${FAKE_OPENNAN}/console/billing`);
        await modal(page).getByRole("button", { name: "Done" }).click();
        await expect(chip(page)).toContainText("Add credits");
    } finally {
        await fakeControl("balance?usd=12.4");
    }
});

test("12 · sign out revokes the key; switch account reopens the modal", async ({ page }) => {
    await signIn(page);
    const revokedBefore = (await fakeState()).revokedKeyIds.length;
    await chip(page).click();
    await page.getByRole("menuitem", { name: "Sign out" }).click();
    await expect(chip(page)).toHaveText("Sign in");
    await expect.poll(async () => (await fakeState()).revokedKeyIds.length).toBe(revokedBefore + 1);
    expect((await fakeState()).requests.some((r) => r.method === "DELETE" && r.path === "/v1/auth/key")).toBe(true);

    await chip(page).click();
    const popup = await startFlow(page);
    await fakeControl(`approve/${await codeOf(page)}`);
    await popup.close();
    await expect(chip(page)).toContainText("$12.40", { timeout: 10_000 });
    await chip(page).click();
    const switched = page.waitForEvent("popup");
    await page.getByRole("menuitem", { name: "Switch account" }).click();
    await (await switched).waitForURL(/\/console\/device\?code=/);
    await expect(modal(page)).toHaveAttribute("data-state", "waiting");
});

test("13 · focus stays in the modal, Enter runs the primary, the live region updates", async ({ page }) => {
    await openFromChip(page);
    for (let i = 0; i < 8; i++) {
        await page.keyboard.press("Tab");
        expect(await page.evaluate(() => Boolean(document.activeElement?.closest(".signin")))).toBe(true);
    }
    await page.keyboard.press("Shift+Tab");
    expect(await page.evaluate(() => Boolean(document.activeElement?.closest(".signin")))).toBe(true);
    await modal(page).getByRole("button", { name: "Sign in with OpenNan" }).focus();
    const popup = page.waitForEvent("popup");
    await page.keyboard.press("Enter");
    await popup;
    await expect(modal(page).locator("[aria-live=polite]").first()).toHaveText("Waiting for approval…");
    await expect(modal(page).getByRole("timer")).toHaveText(/Code expires in \d:\d\d/);
});

test("14 · a blocked popup shows the Open opennan.com link", async ({ page }) => {
    await page.addInitScript(() => {
        window.open = () => null;
    });
    await openFromChip(page);
    await modal(page).getByRole("button", { name: "Sign in with OpenNan" }).click();
    const link = modal(page).getByRole("link", { name: "Open opennan.com" });
    await expect(link).toBeVisible();
    const code = await codeOf(page);
    await expect(link).toHaveAttribute("href", `${FAKE_OPENNAN}/console/device?code=${code}`);
    await expect(link).toHaveAttribute("target", "_blank");
    await expect(link).toHaveAttribute("rel", "noopener noreferrer");
});

test("15 · the first-launch prompt shows once and Not now is remembered", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("opennan-studio:e2e-onboarding", "1"));
    await page.goto("/#/");
    await expect(modal(page)).toBeVisible();
    await modal(page).getByRole("button", { name: "Not now" }).click();
    await expect(modal(page)).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();
    await page.waitForTimeout(500);
    await expect(modal(page)).toHaveCount(0);
});
