// AI tools on desktop (phase 11) against the fake OpenNan server: "Isolate voice" on a clip prepares the clip's range
// with main's ffmpeg, uploads it from main (POST /v1/uploads, a PUT without credentials, /complete), runs the tool,
// and places the imported result on a new audio track, while the renderer never sees the key or an upload address.
// Then "Stabilize" runs on this device (deshake in main) and stacks the result above the scene with no request to
// the server. Commands come from timeline-core's planAiTool, as the editor's AI tab and the MCP tools build them.
import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { startFakeOpenNan } from "@opennan/provider-opennan/testing";
import { planAiTool, type ControllerSnapshot } from "@opennan/timeline-core";
import { FIXTURE_SPEECH, FIXTURE_VIDEO, launchStudio, snapshot, waitForSaves, type Studio } from "./helpers";

interface RunResult {
    ok: boolean;
    error?: string;
    createdClipIds?: string[];
    output?: { media?: Array<{ url: string; kind: string }>; costUsd?: number };
}

type SnapshotClip = { id: string; trackType: string; trackIndex: number; mediaUrl?: string | null; mediaType?: string | null; startTime: number; endTime: number; volume?: number | null };

async function recordOpenExternal(app: ElectronApplication): Promise<void> {
    await app.evaluate(({ shell }) => {
        const opened: string[] = [];
        (globalThis as { __opened?: string[] }).__opened = opened;
        shell.openExternal = async (url: string) => {
            opened.push(url);
        };
    });
}

/** Everything the renderer can read: no key-shaped string anywhere. */
async function rendererHasNoKey(page: Page): Promise<void> {
    const seen = await page.evaluate(async () => {
        const bridge = (window as unknown as { opennan: { account: { status(): Promise<unknown> } } }).opennan;
        const storage = (s: Storage) => JSON.stringify(Object.fromEntries(Object.keys(s).map((k) => [k, s.getItem(k)])));
        const studio = (window as unknown as { __studio: { controller: { snapshot(): unknown } } }).__studio;
        return [JSON.stringify(await bridge.account.status()), JSON.stringify(studio.controller.snapshot()), document.documentElement.outerHTML, storage(localStorage), storage(sessionStorage)].join("\n");
    });
    expect(seen).not.toMatch(/sk-[A-Za-z0-9_-]{8,}/);
    expect(seen).not.toMatch(/__uploads|files\/uploads|\/u\/[A-Za-z0-9_-]+\./);
}

/** Runs one planned tool through the editor's controller (window.__studio, e2e debug hooks). */
async function runTool(page: Page, command: Record<string, unknown>): Promise<RunResult> {
    return page.evaluate(async (c) => {
        const studio = (window as unknown as { __studio: { controller: { execute(command: unknown): Promise<unknown> } } }).__studio;
        return JSON.parse(JSON.stringify(await studio.controller.execute(c)));
    }, command);
}

async function plan(page: Page, toolId: "voice-isolation" | "stabilize", params: { clipId?: string; sceneId?: string }) {
    const snap = (await page.evaluate(() => JSON.parse(JSON.stringify((window as unknown as { __studio: { controller: { snapshot(): unknown } } }).__studio.controller.snapshot())))) as ControllerSnapshot;
    const planned = planAiTool(snap, toolId, params);
    if (!planned.ok) throw new Error(planned.error);
    return { type: "ai.run", capability: planned.plan.capability, input: planned.plan.input, ...(planned.plan.placeAt ? { placeAt: planned.plan.placeAt } : {}) };
}

const clipsOf = async (page: Page) => (await snapshot(page)).clips as unknown as SnapshotClip[];

test("AI tools: isolate voice uploads from main to the fake OpenNan; stabilize runs on this device", async () => {
    const fake = await startFakeOpenNan({ intervalSeconds: 1 });
    let studio: Studio | null = null;
    try {
        studio = await launchStudio({ env: { OPENNAN_STUDIO_API_BASE: fake.url } });
        await recordOpenExternal(studio.app);
        const { page } = studio;

        await test.step("sign in through the fake", async () => {
            await page.locator(".account-chip").click();
            const modal = page.locator(".signin");
            await modal.getByRole("button", { name: "Sign in with OpenNan" }).click();
            await expect(modal).toHaveAttribute("data-state", "waiting");
            const code = (await modal.locator(".signin-code-text").textContent())!.trim();
            expect(fake.approve(code)).toBe(true);
            await expect(page.locator(".account-chip")).toContainText("$12.40", { timeout: 15_000 });
        });

        await test.step("create a project with a video scene and a speech clip", async () => {
            await page.getByRole("button", { name: "New project" }).first().click();
            const dialog = page.getByRole("dialog", { name: "New project" });
            await dialog.getByLabel("Project name").fill("AI");
            await dialog.getByRole("button", { name: "Create project" }).click();
            await expect.poll(async () => (await snapshot(page)).project?.name).toBe("AI");
            await page.getByTestId("media-import-input").setInputFiles(FIXTURE_VIDEO);
            await expect(page.getByTestId("media-item")).toHaveCount(1);
            await page.getByTestId("media-import-input").setInputFiles(FIXTURE_SPEECH);
            await expect(page.getByTestId("media-item")).toHaveCount(2);
            for (const name of ["testsrc-6s.webm", "jfk.wav"]) {
                const tile = page.getByTestId("media-item").filter({ hasText: name });
                await tile.hover();
                await tile.getByRole("button", { name: `Add ${name} to timeline` }).click();
            }
            await expect.poll(async () => (await snapshot(page)).scenes.length).toBe(1);
            await expect.poll(async () => (await clipsOf(page)).filter((c) => c.trackType === "audio").length).toBe(1);
            await waitForSaves(page);
        });

        await test.step("isolate voice: prepared and uploaded in main, placed on a new audio track", async () => {
            const speech = (await clipsOf(page)).find((c) => c.trackType === "audio")!;
            const audioTracksBefore = new Set((await clipsOf(page)).filter((c) => c.trackType === "audio").map((c) => c.trackIndex));
            const command = await plan(page, "voice-isolation", { clipId: speech.id });
            expect(command).toMatchObject({ capability: "audio.isolate-voice", input: { source: { mediaUrl: speech.mediaUrl } }, placeAt: { kind: "replace-audio" } });
            const result = await runTool(page, command);
            expect(result.error).toBeUndefined();
            expect(result.ok).toBe(true);
            expect(result.output?.costUsd).toBeGreaterThan(0);
            expect(result.createdClipIds).toHaveLength(1);

            const state = fake.state();
            expect(state.uploads).toEqual([expect.objectContaining({ contentType: "audio/wav", put: true, completed: true })]);
            expect(state.requests.some((r) => r.method === "POST" && r.path === "/v1/uploads" && r.authorized)).toBe(true);
            // A tool input is a temporary upload: one PUT to a single-use gateway link (no key), a temp media URL.
            expect(state.requests.filter((r) => r.method === "PUT")).toEqual([expect.objectContaining({ path: expect.stringMatching(/^\/u\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/), authorized: false })]);
            const isolation = state.requests.find((r) => r.method === "POST" && r.path === "/v1/audio/isolations");
            expect((isolation?.body as { audio_url?: string } | undefined)?.audio_url).toMatch(new RegExp(`^${fake.url.replace(/[.]/g, "\\.")}/files/uploads/temp/[0-9a-f]{24}/[a-z0-9]+\\.wav$`));

            await expect.poll(async () => (await clipsOf(page)).some((c) => c.id === result.createdClipIds![0])).toBe(true);
            const placed = (await clipsOf(page)).find((c) => c.id === result.createdClipIds![0])!;
            expect(placed).toMatchObject({ trackType: "audio", mediaUrl: expect.stringMatching(/^opennan-local:\/\/media\//) });
            expect(audioTracksBefore.has(placed.trackIndex)).toBe(false);
            expect(placed.startTime).toBeCloseTo(speech.startTime, 3);
            await waitForSaves(page);
            await rendererHasNoKey(page);
        });

        await test.step("stabilize on this device: a stacked video clip, no request to the server", async () => {
            const requestsBefore = fake.state().requests.length;
            const [scene] = (await snapshot(page)).scenes;
            const command = await plan(page, "stabilize", { sceneId: scene.id });
            expect(command).toMatchObject({ capability: "media.stabilize", placeAt: { kind: "stack-video" } });
            const result = await runTool(page, command);
            expect(result.error).toBeUndefined();
            expect(result.ok).toBe(true);
            expect(result.createdClipIds).toHaveLength(1);
            await expect.poll(async () => (await clipsOf(page)).some((c) => c.id === result.createdClipIds![0])).toBe(true);
            const stacked = (await clipsOf(page)).find((c) => c.id === result.createdClipIds![0])!;
            expect(stacked).toMatchObject({ trackType: "video", mediaUrl: expect.stringMatching(/^opennan-local:\/\/media\//) });
            expect(stacked.trackIndex).toBeGreaterThan(1);
            expect(stacked.endTime - stacked.startTime).toBeCloseTo(scene.duration, 1);
            expect(fake.state().requests.length).toBe(requestsBefore);
            await waitForSaves(page);
            await rendererHasNoKey(page);
        });
    } finally {
        await studio?.close();
        await fake.close();
    }
});
