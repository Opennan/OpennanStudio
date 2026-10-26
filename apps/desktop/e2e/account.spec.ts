// Sign in with OpenNan on desktop (phase 8) against the fake OpenNan server: main opens the browser (openExternal,
// stubbed here to record the URL), the key stays in main (safeStorage), the renderer never sees it, the account
// survives a restart, a Generate job runs in main and lands in Media, and sign-out revokes the key.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { startFakeOpenNan } from "@opennan/provider-opennan/testing";
import { launchStudio, snapshot, type Studio } from "./helpers";

async function recordOpenExternal(app: ElectronApplication): Promise<void> {
    await app.evaluate(({ shell }) => {
        const opened: string[] = [];
        (globalThis as { __opened?: string[] }).__opened = opened;
        shell.openExternal = async (url: string) => {
            opened.push(url);
        };
    });
}

const opened = (app: ElectronApplication) => app.evaluate(() => (globalThis as { __opened?: string[] }).__opened ?? []);

async function rendererHasNoKey(page: Page): Promise<void> {
    const seen = await page.evaluate(async () => {
        const bridge = (window as unknown as { opennan: { account: { status(): Promise<unknown> } } }).opennan;
        const storage = (s: Storage) => JSON.stringify(Object.fromEntries(Object.keys(s).map((k) => [k, s.getItem(k)])));
        return [JSON.stringify(await bridge.account.status()), document.documentElement.outerHTML, storage(localStorage), storage(sessionStorage)].join("\n");
    });
    expect(seen).not.toMatch(/sk-[A-Za-z0-9_-]{8,}/);
}

test("Sign in with OpenNan: browser opened by main, key only in main, restart, Generate, sign out", async () => {
    const fake = await startFakeOpenNan({ intervalSeconds: 1 });
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), "opennan-e2e-account-"));
    const env = { OPENNAN_STUDIO_API_BASE: fake.url };
    let studio: Studio | null = null;
    try {
        studio = await launchStudio({ userData, env, keepUserData: true });
        await recordOpenExternal(studio.app);
        let page = studio.page;

        await test.step("sign in from the project list's chip", async () => {
            await page.locator(".account-chip").click();
            const modal = page.locator(".signin");
            await modal.getByRole("button", { name: "Sign in with OpenNan" }).click();
            await expect(modal).toHaveAttribute("data-state", "waiting");
            const code = (await modal.locator(".signin-code-text").textContent())!.trim();
            expect(await opened(studio!.app)).toEqual([`${fake.url}/console/device?code=${code}`]);
            await rendererHasNoKey(page);
            expect(fake.approve(code)).toBe(true);
            await expect(page.locator(".account-chip")).toContainText("$12.40", { timeout: 15_000 });
            expect(fake.state().devices[0]).toMatchObject({ client: "desktop", status: "consumed" });
            await rendererHasNoKey(page);
        });

        const persistent = await studio.app.evaluate(({ safeStorage }) => safeStorage.isEncryptionAvailable()
            && (process.platform !== "linux" || safeStorage.getSelectedStorageBackend() !== "basic_text"));
        await test.step("restart respects the system key storage", async () => {
            await studio!.close();
            studio = await launchStudio({ userData, env, keepUserData: true });
            page = studio.page;
            if (!persistent) {
                await expect(page.locator(".account-chip")).toHaveText("Sign in");
                await recordOpenExternal(studio.app);
                await page.locator(".account-chip").click();
                const modal = page.locator(".signin");
                await modal.getByRole("button", { name: "Sign in with OpenNan" }).click();
                await expect(modal).toHaveAttribute("data-state", "waiting");
                expect(fake.approve((await modal.locator(".signin-code-text").textContent())!.trim())).toBe(true);
            }
            await expect(page.locator(".account-chip")).toContainText("$12.40", { timeout: 15_000 });
            await rendererHasNoKey(page);
        });

        await test.step("Generate runs in main and lands in Media", async () => {
            await page.getByRole("button", { name: "New project" }).first().click();
            const dialog = page.getByRole("dialog", { name: "New project" });
            await dialog.getByLabel("Project name").fill("Cloud");
            await dialog.getByRole("button", { name: "Create project" }).click();
            await expect.poll(async () => (await snapshot(page)).project?.name).toBe("Cloud");
            await page.getByRole("button", { name: "Generate", exact: true }).click();
            const generate = page.getByRole("dialog", { name: "Generate" });
            await generate.getByLabel("Describe the image").fill("A lighthouse at dawn");
            await generate.getByRole("button", { name: "Generate", exact: true }).click();
            await expect(generate.getByRole("status")).toHaveText("Added to Media and the timeline.", { timeout: 20_000 });
            await generate.getByRole("button", { name: "Close" }).click();
            await expect(page.getByTestId("media-item")).toHaveCount(1);
            expect(fake.state().requests.some((r) => r.method === "POST" && r.path === "/v1/images/generations")).toBe(true);
            await rendererHasNoKey(page);
        });

        await test.step("sign out revokes the key", async () => {
            await page.locator(".account-chip").click();
            await page.getByRole("menuitem", { name: "Sign out" }).click();
            await expect(page.locator(".account-chip")).toHaveText("Sign in");
            expect(fake.state().revokedKeyIds).toHaveLength(1);
        });
    } finally {
        await studio?.close();
        fs.rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
        await fake.close();
    }
});
