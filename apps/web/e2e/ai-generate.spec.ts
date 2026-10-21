// The AI generators against the fake OpenNan server (phase 11): text to speech with the voice picker and its price
// on the button, and image-to-video from the frame under the playhead (the still is saved to Media, uploaded, and sent
// as the start image). Results land in Media and on the timeline at the playhead.
import { expect, test } from "@playwright/test";
import { fakeState } from "./fixtures/fake-opennan";
import { addToTimeline, importFixtures, signInOpenNan } from "./ai-helpers";
import { createProject, execute, snapshot } from "./helpers";

test("text to speech: the voice picker lists the voices, the button shows the price, the voice lands at the playhead", async ({ page }) => {
    await createProject(page, "Voice");
    await signInOpenNan(page);
    await page.getByRole("button", { name: "Generate" }).first().click();
    const dialog = page.getByRole("dialog", { name: "Generate" });
    await dialog.getByRole("radio", { name: "Voice" }).click();
    const voices = dialog.getByLabel("Voice", { exact: true });
    await expect(voices.locator("option")).toHaveText(["Heart · en-US · female", "Adam · en-US · male", "Emma · en-GB · female"]);
    await voices.selectOption("adam");
    await dialog.getByLabel("Text to speak").fill("Welcome back to the lighthouse.");
    // 31 characters → 1 started block of 1,000 × $0.026.
    const run = dialog.getByTestId("generate-run");
    await expect(run).toHaveText("≈ $0.026 · Generate");
    await run.click();
    await expect(dialog.getByRole("status")).toHaveText("Added to Media and the timeline.", { timeout: 30_000 });
    const speech = (await fakeState()).requests.find((r) => r.method === "POST" && r.path === "/v1/audio/speech")!;
    expect(speech.body).toMatchObject({ input: "Welcome back to the lighthouse.", voice: "adam" });
    expect((await snapshot(page)).clips.filter((c) => c.trackType === "audio")).toHaveLength(1);
});

test("image to video from this frame: the frame goes to Media and up as the start image", async ({ page }) => {
    await createProject(page, "From this frame");
    await signInOpenNan(page);
    await importFixtures(page, ["clip-360p.webm"]);
    await addToTimeline(page, "clip-360p.webm", "scene");
    await execute(page, { type: "playhead.seek", seconds: 1.5 });
    const before = (await fakeState()).uploads.length;
    await page.getByRole("button", { name: "Generate" }).first().click();
    const dialog = page.getByRole("dialog", { name: "Generate" });
    await dialog.getByRole("radio", { name: "Video" }).click();
    await dialog.getByLabel("Start from the frame at the playhead").check();
    await dialog.getByLabel("Describe the video").fill("The test card slowly zooms in");
    const run = dialog.getByTestId("generate-run");
    await expect(run).toContainText("· Generate");
    await run.click();
    await expect(dialog.getByRole("status")).toHaveText("Added to Media and the timeline.", { timeout: 60_000 });
    const state = await fakeState();
    expect(state.uploads.slice(before).map((u) => u.contentType)).toEqual(["image/png"]);
    const generation = state.requests.find((r) => r.method === "POST" && r.path === "/v1/videos/generations")!;
    expect((generation.body as { image: string }).image).toContain("/files/uploads/");
    // The still, the generated video: both in Media.
    await expect(page.getByTestId("media-item").filter({ hasText: "frame-" })).toHaveCount(1);
});
