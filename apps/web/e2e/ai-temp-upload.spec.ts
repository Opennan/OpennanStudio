// AI tool inputs stay temporary (phase 9a, server §10.1 item 17): an upload for a tool names no project, so the
// server keeps it as scope "temp" and deletes it after the task; Studio drops its hash-cache entry when the task ends
// and uploads again for the next task instead of reusing a link the server may already have deleted.
import { expect, test, type Page } from "@playwright/test";
import { importFixtures, signInOpenNan } from "./ai-helpers";
import { cloudControl, cloudState } from "./cloud-helpers";
import { fakeState } from "./fixtures/fake-opennan";
import { createProject, snapshot } from "./helpers";

type AiWindow = { __studio: { ai: { run(tool: string, params: Record<string, unknown>): void; jobs(): Array<{ status: string }> } } };

async function addAudio(page: Page, name: string): Promise<string> {
    const tile = page.getByTestId("media-item").filter({ hasText: name });
    await tile.hover();
    await tile.getByRole("button", { name: `Add ${name} to timeline` }).click();
    await expect.poll(async () => (await snapshot(page)).clips.filter((c) => c.trackType === "audio").length).toBeGreaterThan(0);
    // The optimistic clip has a temporary id until the backend answers (slow on a loaded machine).
    await expect.poll(async () => (await snapshot(page)).clips.some((c) => c.id.startsWith("temp"))).toBe(false);
    return (await snapshot(page)).clips.find((c) => c.trackType === "audio")!.id;
}

test("an AI tool's upload is temporary and not reused by the next task", async ({ page }) => {
    await createProject(page, "Temp uploads");
    await signInOpenNan(page);
    await importFixtures(page, ["speech-with-gaps.wav"]);
    const clipId = await addAudio(page, "speech-with-gaps.wav");
    const before = await fakeState();
    const cloudBefore = await cloudState();
    for (let run = 1; run <= 2; run++) {
        await page.evaluate((id) => (window as unknown as AiWindow).__studio.ai.run("voice-isolation", { clipId: id }), clipId);
        await expect.poll(() => page.evaluate(() => (window as unknown as AiWindow).__studio.ai.jobs().filter((j) => j.status === "succeeded").length), { timeout: 30_000 }).toBe(run);
    }
    const after = await fakeState();
    const starts = after.requests.slice(before.requests.length).filter((r) => r.method === "POST" && r.path === "/v1/uploads");
    expect(starts).toHaveLength(2);
    for (const start of starts) {
        const body = start.body as Record<string, unknown>;
        expect(body.project_id).toBeUndefined();
        expect(body.scope === undefined || body.scope === "temp").toBe(true);
    }
    const uploads = (await cloudState()).uploads.slice(cloudBefore.uploads.length);
    expect(uploads.map((u) => u.scope)).toEqual(["temp", "temp"]);
    const puts = after.requests.slice(before.requests.length).filter((r) => r.method === "PUT" && r.path.startsWith("/u/"));
    expect(puts).toHaveLength(2);
    const isolations = after.requests.slice(before.requests.length).filter((r) => r.path === "/v1/audio/isolations");
    const urls = isolations.map((r) => (r.body as { audio_url: string }).audio_url);
    expect(urls).toHaveLength(2);
    expect(urls[0]).not.toBe(urls[1]);
    expect(urls.every((u) => u.includes("/uploads/temp/"))).toBe(true);
});

test("a tool input over the server's single-PUT limit goes up in parts (9a.1)", async ({ page }) => {
    // The fake's single-PUT limit lowered to 64 KB (the server's is 95 MB): the clip's audio needs parts.
    await cloudControl("upload-limits", { single_put_max_bytes: 64 * 1024, part_size: 32 * 1024 });
    try {
        await createProject(page, "Big tool input");
        await signInOpenNan(page);
        await importFixtures(page, ["speech-with-gaps.wav"]);
        const clipId = await addAudio(page, "speech-with-gaps.wav");
        const before = await fakeState();
        const cloudBefore = await cloudState();
        await page.evaluate((id) => (window as unknown as AiWindow).__studio.ai.run("voice-isolation", { clipId: id }), clipId);
        await expect.poll(() => page.evaluate(() => (window as unknown as AiWindow).__studio.ai.jobs().filter((j) => j.status === "succeeded").length), { timeout: 30_000 }).toBe(1);
        const after = await fakeState();
        const starts = after.requests.slice(before.requests.length).filter((r) => r.method === "POST" && r.path === "/v1/uploads").map((r) => r.body as Record<string, unknown>);
        // Asked once whole, told to use parts, asked again with parts.
        expect(starts.map((b) => b.multipart ?? null)).toEqual([null, true]);
        const uploads = (await cloudState()).uploads.slice(cloudBefore.uploads.length) as Array<{ scope: string; completed: boolean; transport?: string; puts: number }>;
        expect(uploads.at(-1)).toMatchObject({ scope: "temp", completed: true, transport: "multipart" });
        expect(uploads.at(-1)!.puts).toBeGreaterThan(1);
        const puts = after.requests.slice(before.requests.length).filter((r) => r.method === "PUT" && r.path.startsWith("/u/"));
        expect(puts.length).toBe(uploads.at(-1)!.puts);
        expect(puts.every((r) => !r.authorized)).toBe(true);
    } finally {
        await cloudControl("upload-limits", { single_put_max_bytes: 95 * 1024 ** 2, part_size: 32 * 1024 ** 2 });
    }
});
