// The free on-device AI tools in the browser (phase 11): Remove silences (find, preview, remove as one undo step),
// Remove filler words (from caption word timings), Detect beats (beat dots, snap to beats), and auto cut to beat. They
// decode the clip's range in a worker and never call OpenNan.
import { expect, test, type Page } from "@playwright/test";
import { fakeState } from "./fixtures/fake-opennan";
import { addToTimeline, importFixtures } from "./ai-helpers";
import { createProject, execute, snapshot, waitForSaves } from "./helpers";

type Clip = { id: string; trackType: string; trackIndex: number; startTime: number; endTime: number; beatsJson?: string | null; textContent?: string | null };
const clips = async (page: Page) => (await snapshot(page)).clips as unknown as Clip[];
const audioSeconds = async (page: Page) => (await clips(page)).filter((c) => c.trackType === "audio").reduce((sum, c) => sum + (c.endTime - c.startTime), 0);

async function openAiTab(page: Page, clipId: string) {
    await execute(page, { type: "selection.set", clipIds: [clipId] });
    await page.getByTestId("inspector-tab-ai").click();
    await expect(page.getByTestId("ai-tab")).toBeVisible();
}

test("remove silences: found in a worker, previewed, removed as one undo step, nothing sent to OpenNan", async ({ page }) => {
    await createProject(page, "Silences");
    await importFixtures(page, ["speech-with-gaps.wav"]);
    const clipId = await addToTimeline(page, "speech-with-gaps.wav", "clip");
    // Quotes (POST /v1/quotes, keyless) price the paid tools the AI tab lists; anything else would be a run.
    const posts = async () => (await fakeState()).requests.filter((r) => r.method !== "GET" && r.path !== "/v1/quotes").length;
    const before0 = await posts();
    await openAiTab(page, clipId);
    const panel = page.getByTestId("ai-silences");
    await panel.getByTestId("ai-silences-find").click();
    await expect(panel.getByTestId("ai-silences-summary")).toContainText("1 silence", { timeout: 20_000 });
    await expect.poll(() => page.evaluate(() => (window as unknown as { __studio: { store: { getState(): { aiCutPreview: unknown } } } }).__studio.store.getState().aiCutPreview)).not.toBeNull();
    const before = await audioSeconds(page);
    await panel.getByTestId("ai-silences-remove").click();
    await expect.poll(() => audioSeconds(page)).toBeLessThan(before - 0.8);
    // The 1.2 s gap minus the padding kept on both sides (0.08 s each), within a frame or two.
    expect(before - (await audioSeconds(page))).toBeGreaterThan(0.9);
    expect(before - (await audioSeconds(page))).toBeLessThan(1.2);
    await waitForSaves(page);
    await execute(page, { type: "history.undo" });
    await expect.poll(() => audioSeconds(page)).toBeCloseTo(before, 1);
    // The AI tab reads paid tools' prices (GET lists, keyless quotes); the local tool itself sends nothing.
    expect(await posts()).toBe(before0);
});

test("remove filler words: found in the caption words and cut with their caption words", async ({ page }) => {
    await createProject(page, "Fillers");
    await importFixtures(page, ["speech-with-gaps.wav"]);
    const clipId = await addToTimeline(page, "speech-with-gaps.wav", "clip");
    const words = [{ start: 0.05, end: 0.3, text: "So" }, { start: 0.4, end: 0.75, text: "um" }, { start: 0.85, end: 1.0, text: "we" }];
    await execute(page, { type: "clip.create", input: { trackType: "text", trackIndex: 1, startTime: 0, endTime: 1, mediaType: "text", textContent: "So um we", captionWordsJson: JSON.stringify(words) } });
    await waitForSaves(page);
    await openAiTab(page, clipId);
    const panel = page.getByTestId("ai-fillers");
    await panel.getByTestId("ai-fillers-find").click();
    await expect(panel.getByTestId("ai-fillers-list")).toContainText("um");
    const before = await audioSeconds(page);
    await panel.getByTestId("ai-fillers-remove").click();
    await expect.poll(() => audioSeconds(page)).toBeLessThan(before - 0.2);
    const caption = (await clips(page)).filter((c) => c.trackType === "text").map((c) => c.textContent).join(" ");
    expect(caption).not.toMatch(/\bum\b/);
});

test("detect beats: 120 BPM on a click track, snap to beats, and auto cut to beat", async ({ page }) => {
    await createProject(page, "Beats");
    await importFixtures(page, ["click-120bpm.wav", "clip-360p.webm"]);
    const audioId = await addToTimeline(page, "click-120bpm.wav", "clip");
    await openAiTab(page, audioId);
    const panel = page.getByTestId("ai-beats");
    await panel.getByTestId("ai-beats-detect").click();
    await expect(panel.getByTestId("ai-beats-summary")).toContainText(/1(19|20|21) BPM/, { timeout: 20_000 });
    const beats = JSON.parse((await clips(page)).find((c) => c.id === audioId)!.beatsJson!) as number[];
    expect(beats.length).toBeGreaterThanOrEqual(10);
    for (let i = 1; i < beats.length; i += 1) expect(Math.abs(beats[i]! - beats[i - 1]! - 0.5)).toBeLessThan(0.03);

    const snap = page.getByRole("button", { name: "Snap to beats" });
    await snap.click();
    await expect(snap).toHaveAttribute("aria-pressed", "true");
    expect(await page.evaluate(() => (window as unknown as { __studio: { store: { getState(): { snapToBeats: boolean } } } }).__studio.store.getState().snapToBeats)).toBe(true);

    // Two overlay clips that do not end on beats: auto cut to beat (group inspector) lands the cut on a beat.
    const sceneId = await addToTimeline(page, "clip-360p.webm", "scene");
    const scene = (await snapshot(page)).scenes.find((x) => x.id === sceneId) as unknown as { sourceVideoUrl?: string | null; videoUrl?: string | null };
    const url = scene.sourceVideoUrl ?? scene.videoUrl;
    for (const [start, end] of [[0, 1.3], [1.3, 2.9]] as const) {
        await execute(page, { type: "clip.create", input: { trackType: "video", trackIndex: 2, startTime: start, endTime: end, mediaType: "video", mediaUrl: url } });
    }
    await waitForSaves(page);
    const overlays = (await clips(page)).filter((c) => c.trackType === "video").sort((a, b) => a.startTime - b.startTime);
    await execute(page, { type: "selection.set", clipIds: overlays.map((c) => c.id) });
    await page.getByTestId("ai-auto-cut-run").click();
    await expect(page.getByTestId("ai-auto-cut-status")).toContainText("on the beat");
    const cut = (await clips(page)).filter((c) => c.trackType === "video").sort((a, b) => a.startTime - b.startTime);
    const onBeat = (t: number) => beats.some((b) => Math.abs(b - t) < 0.02);
    expect(onBeat(cut[0]!.endTime)).toBe(true);
    expect(cut[1]!.startTime).toBeCloseTo(cut[0]!.endTime, 3);
});
