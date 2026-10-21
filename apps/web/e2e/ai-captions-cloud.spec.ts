// Cloud captions on the web (phase 11): OpenNan cloud is the web's transcription engine. The dialog shows the price of
// the timeline's audio (1 started minute), uploads the mixed audio as WAV, and places captions with word timings from
// the server's `words` — one undo step.
import { expect, test } from "@playwright/test";
import { fakeState } from "./fixtures/fake-opennan";
import { addToTimeline, importFixtures, signInOpenNan } from "./ai-helpers";
import { createProject, execute, snapshot } from "./helpers";

test("auto captions in the cloud: price, upload, captions with words, undo", async ({ page }) => {
    await createProject(page, "Cloud captions");
    await signInOpenNan(page);
    await importFixtures(page, ["speech-with-gaps.wav"]);
    await addToTimeline(page, "speech-with-gaps.wav", "clip");
    const before = await fakeState();

    await page.locator(".topbar-gated").click();
    const dialog = page.getByRole("dialog", { name: "Auto captions" });
    await expect(dialog).toContainText("Sends the timeline audio to OpenNan cloud");
    const run = dialog.getByRole("button", { name: "≈ $0.005 · Run" });
    await expect(run).toBeVisible();
    await run.click();
    await expect(dialog.getByRole("status")).toContainText("Added 2 captions", { timeout: 30_000 });

    const after = await fakeState();
    expect(after.uploads.slice(before.uploads.length).map((u) => u.contentType)).toEqual(["audio/wav"]);
    const post = after.requests.find((r) => r.method === "POST" && r.path === "/v1/audio/transcriptions")!;
    expect((post.body as { audio_url: string }).audio_url).toContain("/files/uploads/");
    const captions = (await snapshot(page)).clips.filter((c) => c.trackType === "text") as unknown as Array<{ textContent: string; captionWordsJson: string | null }>;
    expect(captions.map((c) => c.textContent)).toEqual(["Hello there.", "How are you?"]);
    expect(JSON.parse(captions[0]!.captionWordsJson!).map((w: { text: string }) => w.text)).toEqual(["Hello", "there."]);

    await dialog.getByRole("button", { name: "Close" }).click();
    await execute(page, { type: "history.undo" });
    await expect.poll(async () => (await snapshot(page)).clips.filter((c) => c.trackType === "text").length).toBe(0);
});
