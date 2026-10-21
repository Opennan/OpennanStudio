// The AI director on desktop (phase 9b) against the fake OpenNan server: a signed-in person's cloud project, a turn
// sent from the AI tab streams through main (the key added there; the bytes reach the window over IPC events), the
// reply shows as it arrives, the edit lands on the timeline through sync, the turn shows its charge, and the renderer
// never sees the key. Run alone (desktop e2e): `pnpm --filter @opennan/desktop exec playwright test e2e/director.spec.ts`
// after building the app.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { startFakeOpenNan } from "@opennan/provider-opennan/testing";
import { launchStudio, snapshot, waitForSaves, type Studio } from "./helpers";

const SCENE = "6b1f3c2a-9d4e-4f50-8a1b-2c3d4e5f6a7b";

type DirectorWindow = {
    __studioCloud: {
        backend(): { saveLocalProject(local: unknown, projectId: string): Promise<{ id: string; name: string }> } | null;
        local: unknown;
    };
};

async function rendererHasNoKey(page: Page): Promise<void> {
    const seen = await page.evaluate(async () => {
        const bridge = (window as unknown as { opennan: { account: { status(): Promise<unknown> } } }).opennan;
        const storage = (s: Storage) => JSON.stringify(Object.fromEntries(Object.keys(s).map((k) => [k, s.getItem(k)])));
        const studio = (window as unknown as { __studio: { controller: { snapshot(): unknown } } }).__studio;
        return [JSON.stringify(await bridge.account.status()), JSON.stringify(studio.controller.snapshot()), document.documentElement.outerHTML, storage(localStorage), storage(sessionStorage)].join("\n");
    });
    expect(seen).not.toMatch(/sk-[A-Za-z0-9_-]{8,}/);
}

/** The fake's director script knob over HTTP (the same as FakeOpenNan.director.script). */
async function script(base: string, steps: unknown[]): Promise<void> {
    const res = await fetch(`${base}/__test/director/script`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ steps }) });
    expect(res.status).toBe(200);
}

test("AI director: a turn streams through main into the AI tab, its edit lands, the charge shows, and the renderer never sees the key", async () => {
    const fake = await startFakeOpenNan({ intervalSeconds: 1 });
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), "opennan-e2e-director-"));
    let studio: Studio | null = null;
    try {
        studio = await launchStudio({ userData, env: { OPENNAN_STUDIO_API_BASE: fake.url } });
        await studio.app.evaluate(({ shell }) => {
            shell.openExternal = async () => undefined;
        });
        const page = studio.page;
        let cloudId = "";

        await test.step("sign in", async () => {
            await page.locator(".account-chip").click();
            const modal = page.locator(".signin");
            await modal.getByRole("button", { name: "Sign in with OpenNan" }).click();
            await expect(modal).toHaveAttribute("data-state", "waiting");
            const code = (await modal.locator(".signin-code-text").textContent())!.trim();
            expect(fake.approve(code)).toBe(true);
            await expect(page.locator(".account-chip")).toContainText("$12.40", { timeout: 15_000 });
        });

        await test.step("a cloud project", async () => {
            await page.getByRole("button", { name: "New project" }).first().click();
            const dialog = page.getByRole("dialog", { name: "New project" });
            await dialog.getByLabel("Project name").fill("Directed");
            await dialog.getByRole("button", { name: "Create project" }).click();
            await expect.poll(async () => (await snapshot(page)).project?.name).toBe("Directed");
            await waitForSaves(page);
            const localId = ((await snapshot(page)) as unknown as { projectId: string }).projectId;
            cloudId = await page.evaluate(async (id) => {
                const cloud = (window as unknown as DirectorWindow).__studioCloud;
                return (await cloud.backend()!.saveLocalProject(cloud.local, id)).id;
            }, localId);
            expect(cloudId).toMatch(/^cloud-[A-Za-z0-9_-]{1,36}$/);
            await page.evaluate((id) => {
                window.location.hash = `#/p/${encodeURIComponent(id)}`;
            }, cloudId);
            await expect.poll(async () => ((await snapshot(page)) as unknown as { projectId: string }).projectId, { timeout: 15_000 }).toBe(cloudId);
        });

        await test.step("open the AI tab", async () => {
            const topBar = page.getByRole("button", { name: "AI director" });
            await expect(topBar).toHaveAttribute("title", "AI director (⌘J)");
            await topBar.click();
            await expect(page.getByRole("tab", { name: "AI director" })).toHaveAttribute("aria-selected", "true");
            await expect(page.getByRole("textbox", { name: "Message to the AI director" })).toBeVisible();
        });

        await test.step("send a message: the reply streams in, the edit lands, the charge shows", async () => {
            await script(fake.url, [
                { text: "Looking at your project." },
                { delay: 400 },
                { edit: { label: "Add an opening", changes: { scenes: { create: [{ id: SCENE, caption: "Opening", duration: 5 }] } } } },
                { text: "Done: the film opens with a 5 second scene." },
            ]);
            const before = fake.state().requests.length;
            await page.getByRole("textbox", { name: "Message to the AI director" }).fill("Add an opening scene");
            await page.getByRole("button", { name: "Send" }).click();
            const messages = page.getByTestId("director-messages");
            // The first round shows while the turn still runs (streamed, not one answer at the end).
            await expect(messages).toContainText("Looking at your project.");
            await expect(messages).toContainText("Done: the film opens with a 5 second scene.", { timeout: 15_000 });
            await expect(messages.getByText(/Charged \$/).last()).toBeVisible({ timeout: 15_000 });
            await expect.poll(async () => (await snapshot(page)).scenes.map((s) => s.id), { timeout: 15_000 }).toContain(SCENE);
            const serverId = cloudId.slice("cloud-".length);
            const turns = fake.state().requests.slice(before).filter((r) => r.method === "POST" && r.path === `/v1/projects/${serverId}/director/turns`);
            expect(turns).toEqual([expect.objectContaining({ authorized: true })]);
        });

        await test.step("the renderer never saw the key", async () => {
            await rendererHasNoKey(page);
            expect(await page.getByTestId("director-messages").innerHTML()).not.toMatch(/sk-[A-Za-z0-9_-]{8,}/);
        });
    } finally {
        await studio?.close();
        await fake.close();
        fs.rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
});
