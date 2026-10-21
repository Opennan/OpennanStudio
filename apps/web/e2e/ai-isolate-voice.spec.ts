// Voice isolation end to end against the fake OpenNan server (phase 11): the clip's used range is prepared in the page
// (mediabunny, WAV), uploaded with POST /v1/uploads → PUT (no Authorization) → complete, sent to
// POST /v1/audio/isolations, and the result lands as a new audio track with the source muted — one undo step.
import { expect, test, type Page } from "@playwright/test";
import { fakeState } from "./fixtures/fake-opennan";
import { importFixtures, signInOpenNan } from "./ai-helpers";
import { createProject, execute, snapshot } from "./helpers";

type AiWindow = { __studio: { ai: { run(tool: string, params: Record<string, unknown>): void; tool(tool: string, params: Record<string, unknown>): { state: string; price: { kind: string; label?: string } }; jobs(): Array<{ status: string; error?: string; costUsd?: number }> } } };

async function addAudioToTimeline(page: Page, name: string): Promise<string> {
    const tile = page.getByTestId("media-item").filter({ hasText: name });
    await tile.hover();
    await tile.getByRole("button", { name: `Add ${name} to timeline` }).click();
    await expect.poll(async () => (await snapshot(page)).clips.filter((c) => c.trackType === "audio").length).toBeGreaterThan(0);
    // The optimistic clip has a temporary id until the backend answers (slow on a loaded machine).
    await expect.poll(async () => (await snapshot(page)).clips.some((c) => c.id.startsWith("temp"))).toBe(false);
    return (await snapshot(page)).clips.find((c) => c.trackType === "audio")!.id;
}

test("isolate voice: prepared range uploaded without the key, task, new audio track, source muted, one undo", async ({ page }) => {
    await createProject(page, "Isolate voice");
    await signInOpenNan(page);
    await importFixtures(page, ["speech-with-gaps.wav"]);
    const clipId = await addAudioToTimeline(page, "speech-with-gaps.wav");
    const before = await fakeState();

    // The price the button shows: 1 started minute × the fake's $0.13.
    await expect.poll(() => page.evaluate((id) => (window as unknown as AiWindow).__studio.ai.tool("voice-isolation", { clipId: id }).price.label, clipId)).toBe("≈ $0.130");
    await page.evaluate((id) => (window as unknown as AiWindow).__studio.ai.run("voice-isolation", { clipId: id }), clipId);
    await expect.poll(() => page.evaluate(() => (window as unknown as AiWindow).__studio.ai.jobs()[0]?.status), { timeout: 30_000 }).toBe("succeeded");

    const after = await fakeState();
    const upload = after.uploads.slice(before.uploads.length)[0]!;
    expect(upload).toMatchObject({ contentType: "audio/wav" });
    const puts = after.requests.filter((r) => r.method === "PUT" && r.path.startsWith("/u/"));
    expect(puts.length).toBeGreaterThan(0);
    expect(puts.every((r) => !r.authorized)).toBe(true);
    const isolation = after.requests.find((r) => r.method === "POST" && r.path === "/v1/audio/isolations")!;
    expect((isolation.body as { audio_url: string }).audio_url).toContain("/files/uploads/");

    const placed = await snapshot(page);
    const audio = placed.clips.filter((c) => c.trackType === "audio");
    expect(audio).toHaveLength(2);
    const source = audio.find((c) => c.id === clipId) as unknown as { volume: number };
    expect(source.volume).toBe(0);
    const result = audio.find((c) => c.id !== clipId)!;
    expect(result.mediaUrl).toMatch(/^opennan-local:\/\//);
    expect(result.trackIndex).not.toBe(audio.find((c) => c.id === clipId)!.trackIndex);

    await execute(page, { type: "history.undo" });
    await expect.poll(async () => (await snapshot(page)).clips.filter((c) => c.trackType === "audio").length).toBe(1);
    const restored = (await snapshot(page)).clips.find((c) => c.id === clipId) as unknown as { volume: number };
    expect(restored.volume).toBe(1);
});
