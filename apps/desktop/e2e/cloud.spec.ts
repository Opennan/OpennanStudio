// OpenNan cloud projects on desktop (phase 9a) against the fake OpenNan server: a signed-in person's local project
// with an imported video is saved to OpenNan (the file hashed and uploaded from main, a PUT without credentials, the
// project imported), opens as cloud-<id> playing the same media-store file, its state lands in userData/cloud,
// a cloud file is cached into the media store through main (answered at the download's headers, adopted shortly after,
// and played through opennan-media://), and Download a local copy makes an independent local project. Phase 9a.1: the
// cloud state is filed under the account id the fake sends. The renderer never sees the key or an upload address. Driven through the e2e build's window.__studioCloud.
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { FAKE_ACCOUNT_ID, startFakeOpenNan } from "@opennan/provider-opennan/testing";
import { FIXTURE_VIDEO, launchStudio, snapshot, waitForSaves, type Studio } from "./helpers";

async function recordOpenExternal(app: ElectronApplication): Promise<void> {
    await app.evaluate(({ shell }) => {
        shell.openExternal = async () => undefined;
    });
}

async function rendererHasNoKey(page: Page): Promise<void> {
    const seen = await page.evaluate(async () => {
        const bridge = (window as unknown as { opennan: { account: { status(): Promise<unknown> } } }).opennan;
        const storage = (s: Storage) => JSON.stringify(Object.fromEntries(Object.keys(s).map((k) => [k, s.getItem(k)])));
        const studio = (window as unknown as { __studio: { controller: { snapshot(): unknown } } }).__studio;
        return [JSON.stringify(await bridge.account.status()), JSON.stringify(studio.controller.snapshot()), document.documentElement.outerHTML, storage(localStorage), storage(sessionStorage)].join("\n");
    });
    expect(seen).not.toMatch(/sk-[A-Za-z0-9_-]{8,}/);
    expect(seen).not.toMatch(/\/u\/[A-Za-z0-9_-]+\./);
}

/** Every opennan-local media URL in a project state (scenes, clips, library). */
const localUrls = (state: unknown) => [...new Set(JSON.stringify(state).match(/opennan-local:\/\/media\/[0-9a-f-]{36}/g) ?? [])];

type CloudWindow = {
    __studioCloud: {
        backend(): {
            saveLocalProject(local: unknown, projectId: string): Promise<{ id: string; name: string }>;
            downloadLocalCopy(projectId: string, target: unknown): Promise<{ id: string; name: string }>;
        } | null;
        local: { snapshot(projectId: string): Promise<unknown> };
    };
    opennan: { cloud: { cache(url: string, sizeBytes: number | null): Promise<{ ok: boolean; value?: { url: string }; error?: { code: string } }> } };
};

test("cloud projects: save a local project to OpenNan, reopen it as cloud-<id>, cache a cloud file, download a local copy", async () => {
    const fake = await startFakeOpenNan({ intervalSeconds: 1 });
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), "opennan-e2e-cloud-"));
    let studio: Studio | null = null;
    try {
        studio = await launchStudio({ userData, env: { OPENNAN_STUDIO_API_BASE: fake.url } });
        await recordOpenExternal(studio.app);
        const page = studio.page;
        const fixture = fs.readFileSync(FIXTURE_VIDEO);
        let localId = "";
        let cloudId = "";
        let localMediaUrl = "";

        await test.step("sign in", async () => {
            await page.locator(".account-chip").click();
            const modal = page.locator(".signin");
            await modal.getByRole("button", { name: "Sign in with OpenNan" }).click();
            await expect(modal).toHaveAttribute("data-state", "waiting");
            const code = (await modal.locator(".signin-code-text").textContent())!.trim();
            expect(fake.approve(code)).toBe(true);
            await expect(page.locator(".account-chip")).toContainText("$12.40", { timeout: 15_000 });
        });

        await test.step("a local project with an imported video", async () => {
            await page.getByRole("button", { name: "New project" }).first().click();
            const dialog = page.getByRole("dialog", { name: "New project" });
            await dialog.getByLabel("Project name").fill("Cloud trip");
            await dialog.getByRole("button", { name: "Create project" }).click();
            await expect.poll(async () => (await snapshot(page)).project?.name).toBe("Cloud trip");
            await page.getByTestId("media-import-input").setInputFiles(FIXTURE_VIDEO);
            const tile = page.getByTestId("media-item").filter({ hasText: "testsrc-6s.webm" });
            await tile.hover();
            await tile.getByRole("button", { name: "Add testsrc-6s.webm to timeline" }).click();
            await expect.poll(async () => (await snapshot(page)).scenes.length).toBe(1);
            await waitForSaves(page);
            const snap = await snapshot(page) as unknown as { projectId: string };
            localId = snap.projectId;
            expect(localUrls(snap)).toHaveLength(1);
            localMediaUrl = localUrls(snap)[0]!;
        });

        await test.step("Save to OpenNan: hashed and uploaded from main, imported, the local document detached", async () => {
            cloudId = await page.evaluate(async (id) => {
                const cloud = (window as unknown as CloudWindow).__studioCloud;
                const saved = await cloud.backend()!.saveLocalProject(cloud.local, id);
                return saved.id;
            }, localId);
            expect(cloudId).toMatch(/^cloud-[A-Za-z0-9_-]{1,36}$/);
            const state = fake.state();
            expect(state.requests.some((r) => r.method === "POST" && r.path === "/v1/uploads" && r.authorized)).toBe(true);
            expect(state.requests.filter((r) => r.method === "PUT")).toEqual([expect.objectContaining({ path: expect.stringMatching(/^\/u\//), authorized: false })]);
            expect(state.requests.some((r) => r.method === "POST" && r.path === "/v1/projects/import" && r.authorized)).toBe(true);
            const asset = fake.cloud.state().assets[0]!;
            expect(asset).toMatchObject({ sha256: createHash("sha256").update(fixture).digest("hex"), scope: "account", size_bytes: fixture.byteLength });
            expect(fake.cloud.state().projects.map((p) => p.name)).toEqual(["Cloud trip"]);
            const account = createHash("sha256").update(`id:${FAKE_ACCOUNT_ID}`).digest("hex").slice(0, 24);
            const cloudDir = path.join(userData, "cloud", account);
            expect(fs.readdirSync(path.join(cloudDir, "sync"))).toEqual([`${cloudId.replace(/[A-Z]/g, (c) => `^${c.toLowerCase()}`)}.json`]);
            expect(fs.readdirSync(path.join(cloudDir, "mirror"))).toHaveLength(1);
            await rendererHasNoKey(page);
        });

        await test.step("the cloud project opens as cloud-<id> and plays the same media-store file", async () => {
            await page.evaluate((id) => {
                window.location.hash = `#/p/${encodeURIComponent(id)}`;
            }, cloudId);
            await expect.poll(async () => ((await snapshot(page)) as unknown as { projectId: string }).projectId, { timeout: 15_000 }).toBe(cloudId);
            await expect.poll(async () => localUrls(await snapshot(page))).toEqual([localMediaUrl]);
            await expect(page.getByTestId("media-item")).toHaveCount(1);
        });

        await test.step("a cloud file is cached into the media store through main (once) and plays through the media protocol", async () => {
            const mediaUrl = fake.cloud.state().assets[0]!.media_url;
            const fileGets = () => fake.state().requests.filter((r) => r.method === "GET" && r.path.startsWith("/files/"));
            // Answered as soon as the download's headers arrived; the file is adopted shortly after.
            const first = await page.evaluate(async ([url, size]) => (window as unknown as CloudWindow).opennan.cloud.cache(url, size), [mediaUrl, fixture.byteLength] as const);
            expect(first).toMatchObject({ ok: true, value: { url: expect.stringMatching(/^opennan-local:\/\/media\//) } });
            const again = await page.evaluate(async (url) => (window as unknown as CloudWindow).opennan.cloud.cache(url, null), mediaUrl);
            expect(again).toEqual(first);
            const refused = await page.evaluate(async () => (window as unknown as CloudWindow).opennan.cloud.cache("https://evil.example/a.mp4", null));
            expect(refused).toMatchObject({ ok: false, error: { code: "download_refused" } });
            const id = first.value!.url.slice("opennan-local://media/".length);
            await expect.poll(() => fs.readdirSync(path.join(userData, "media")).filter((name) => name.startsWith(id)).length, { timeout: 15_000 }).toBe(1);
            const readIndex = () => JSON.parse(fs.readFileSync(path.join(userData, "cloud", "media-cache.json"), "utf8")) as { version: number; entries: Array<{ id: string; state: string; sizeBytes: number }> };
            await expect.poll(() => readIndex().entries.find((e) => e.id === id), { timeout: 15_000 }).toMatchObject({ state: "ready", sizeBytes: fixture.byteLength });
            expect(readIndex().version).toBe(2);
            // The page reads it like any imported file: a Range request answered 206 with the right bytes, from disk.
            const read = await page.evaluate(async (mediaId) => {
                const res = await fetch(`opennan-media://blob/${mediaId}`, { headers: { Range: "bytes=0-99" } });
                return { status: res.status, contentRange: res.headers.get("content-range"), bytes: [...new Uint8Array(await res.arrayBuffer())] };
            }, id);
            expect(read).toEqual({ status: 206, contentRange: `bytes 0-99/${fixture.byteLength}`, bytes: [...fixture.subarray(0, 100)] });
            expect(fileGets()).toHaveLength(1);
        });

        await test.step("Download a local copy: an independent local project with its own copy of the media", async () => {
            const copy = await page.evaluate(async (id) => {
                const cloud = (window as unknown as CloudWindow).__studioCloud;
                const made = await cloud.backend()!.downloadLocalCopy(id, cloud.local);
                const state = await cloud.local.snapshot(made.id);
                return { id: made.id, name: made.name, state: JSON.parse(JSON.stringify(state)) as unknown };
            }, cloudId);
            const urls = localUrls(copy.state);
            expect(copy.name).toBe("Cloud trip (local copy)");
            expect(urls).toHaveLength(1);
            expect(urls[0]).not.toBe(localMediaUrl);
            await rendererHasNoKey(page);
        });
    } finally {
        await studio?.close();
        await fake.close();
        fs.rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
});
