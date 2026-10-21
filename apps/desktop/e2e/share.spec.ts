// Share links on desktop (phase 9c) against the fake OpenNan server: a signed-in person's cloud project gets a
// view-only link through main (the key added there), shown on the account's share_base_url, then turned off; an agent's
// link (MCP through --mcp-bridge) waits for the person's yes: Deny makes nothing, Allow makes it (9c.1); the renderer
// never sees the key. Run alone (desktop e2e): `pnpm --filter @opennan/desktop exec playwright test e2e/share.spec.ts`
// after building the app.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { expect, test } from "@playwright/test";
import { startFakeOpenNan } from "@opennan/provider-opennan/testing";
import { APP_DIR, electronBinary, launchStudio, snapshot, waitForSaves, type Studio } from "./helpers";

const text = (result: unknown) => ((result as { content?: Array<{ text?: string }> }).content ?? []).map((c) => c.text ?? "").join("\n");

type ShareWindow = {
    __studioCloud: {
        backend(): { saveLocalProject(local: unknown, projectId: string): Promise<{ id: string; name: string }> } | null;
        local: unknown;
    };
};

test("Share: a cloud project's view-only link is made through main, shown on the share page, and turned off", async () => {
    const fake = await startFakeOpenNan({ intervalSeconds: 1 });
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), "opennan-e2e-share-"));
    let studio: Studio | null = null;
    try {
        studio = await launchStudio({ userData, env: { OPENNAN_STUDIO_API_BASE: fake.url } });
        await studio.app.evaluate(({ shell }) => {
            shell.openExternal = async () => undefined;
        });
        const page = studio.page;
        let cloudId = "";

        await test.step("sign in and make a cloud project with a picture", async () => {
            await page.locator(".account-chip").click();
            const modal = page.locator(".signin");
            await modal.getByRole("button", { name: "Sign in with OpenNan" }).click();
            await expect(modal).toHaveAttribute("data-state", "waiting");
            const code = (await modal.locator(".signin-code-text").textContent())!.trim();
            expect(fake.approve(code)).toBe(true);
            await expect(page.locator(".account-chip")).toContainText("$12.40", { timeout: 15_000 });
            await page.getByRole("button", { name: "New project" }).first().click();
            const dialog = page.getByRole("dialog", { name: "New project" });
            await dialog.getByLabel("Project name").fill("Shared");
            await dialog.getByRole("button", { name: "Create project" }).click();
            await expect.poll(async () => (await snapshot(page)).project?.name).toBe("Shared");
            await waitForSaves(page);
            const localId = ((await snapshot(page)) as unknown as { projectId: string }).projectId;
            cloudId = await page.evaluate(async (id) => {
                const cloud = (window as unknown as ShareWindow).__studioCloud;
                return (await cloud.backend()!.saveLocalProject(cloud.local, id)).id;
            }, localId);
            fake.cloud.remoteChange(cloudId.slice("cloud-".length), { scenes: { create: [{ id: crypto.randomUUID(), start_image_url: `${fake.url}/files/generated.png` }] } });
            await page.evaluate((id) => {
                window.location.hash = `#/p/${encodeURIComponent(id)}`;
            }, cloudId);
            await expect.poll(async () => ((await snapshot(page)) as unknown as { projectId: string }).projectId, { timeout: 15_000 }).toBe(cloudId);
        });

        await test.step("create the link through main", async () => {
            const before = fake.state().requests.length;
            await page.getByTestId("topbar-share").click();
            const dialog = page.getByRole("dialog", { name: "Share" });
            await expect(dialog.getByTestId("share-dialog")).toHaveAttribute("data-state", "none", { timeout: 15_000 });
            await dialog.getByRole("button", { name: "Create link" }).click();
            await expect(dialog.getByTestId("share-dialog")).toHaveAttribute("data-state", "active", { timeout: 15_000 });
            const serverId = cloudId.slice("cloud-".length);
            const posts = fake.state().requests.slice(before).filter((r) => r.method === "POST" && r.path === `/v1/projects/${serverId}/shares`);
            expect(posts).toEqual([expect.objectContaining({ authorized: true })]);
            const token = fake.cloud.state().shares.find((s) => s.project_id === serverId)!.token;
            // The link on the server's share_base_url (the fake's own site here), never another address.
            await expect(dialog.getByRole("textbox", { name: "View-only link" })).toHaveValue(`${fake.url}/s/${token}`);
        });

        await test.step("turn it off", async () => {
            const dialog = page.getByRole("dialog", { name: "Share" });
            await dialog.getByRole("button", { name: "Turn off", exact: true }).click();
            await dialog.getByRole("button", { name: "Turn off link" }).click();
            await expect(dialog.getByTestId("share-dialog")).toHaveAttribute("data-state", "none");
            expect(fake.cloud.state().shares.every((s) => s.revoked_at !== null)).toBe(true);
        });

        await test.step("an agent's link waits for the person's yes: Deny makes nothing, Allow makes it", async () => {
            await page.getByRole("dialog", { name: "Share" }).getByRole("button", { name: "Close" }).click();
            const info = await page.evaluate(() => (window as unknown as { opennan: { mcp: { info(): Promise<{ running: boolean; url: string; tokenFile: string }> } } }).opennan.mcp.info());
            expect(info.running).toBe(true);
            const transport = new StdioClientTransport({ command: electronBinary(), args: [APP_DIR, "--mcp-bridge", "--url", info.url, "--token-file", info.tokenFile], stderr: "pipe" });
            const client = new Client({ name: "desktop-share", version: "1.0.0" });
            await client.connect(transport);
            const serverId = cloudId.slice("cloud-".length);
            const active = () => fake.cloud.state().shares.filter((s) => s.project_id === serverId && s.revoked_at === null);
            try {
                const ask = page.getByRole("dialog", { name: "Allow a public link?" });
                const denied = client.callTool({ name: "create_share_link", arguments: {} });
                await expect(ask).toBeVisible({ timeout: 15_000 });
                await expect(ask).toContainText("Your agent wants to create a public view link for \u201cShared\u201d. Anyone with the link can watch it. Allow?");
                await expect(ask.getByRole("button", { name: "Deny" })).toBeFocused();
                await ask.getByRole("button", { name: "Deny" }).click();
                const no = await denied;
                expect(no.isError).toBe(true);
                expect(text(no)).toMatch(/declined.*no share link was made/i);
                await expect(ask).toHaveCount(0);
                expect(active()).toEqual([]);

                const allowed = client.callTool({ name: "create_share_link", arguments: { expires_in_days: 7 } });
                await expect(ask).toBeVisible({ timeout: 15_000 });
                await ask.getByRole("button", { name: "Allow", exact: true }).click();
                const yes = await allowed;
                expect(yes.isError, text(yes)).toBeFalsy();
                await expect.poll(() => active().length).toBe(1);
                expect(text(yes)).toContain(`${fake.url}/s/${active()[0]!.token}`);
                // The person is told in the editor (never the link itself).
                await expect(page.getByText(/agent made a view-only share link/i)).toBeVisible();

                // Turning it off never asks.
                const off = await client.callTool({ name: "revoke_share_link", arguments: {} });
                expect(off.isError, text(off)).toBeFalsy();
                expect(text(off)).toContain("Turned off the link shr_");
                await expect(ask).toHaveCount(0);
                expect(active()).toEqual([]);
            } finally {
                await client.close();
            }
        });

        await test.step("the renderer never saw the key", async () => {
            const seen = await page.evaluate(() => [document.documentElement.outerHTML, JSON.stringify({ ...localStorage })].join("\n"));
            expect(seen).not.toMatch(/sk-[A-Za-z0-9_-]{8,}/);
        });
    } finally {
        await studio?.close();
        await fake.close();
        fs.rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
});
