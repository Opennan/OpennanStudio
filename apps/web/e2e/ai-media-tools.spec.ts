// The paid media tools on a clip or scene against the fake OpenNan server (phase 11), through the editor's AI host (the
// same runs the inspector AI tab and the context menu start): each shows "≈ $x" from the server's price block, uploads
// the used range, and lands as one undo step — upscale and background removal stacked above a hidden source, lip sync
// over the speech, stems on new tracks, captions translated into a new track above the source.
import { expect, test, type Page } from "@playwright/test";
import { fakeControl, fakeState } from "./fixtures/fake-opennan";
import { addToTimeline, aiJobs, aiRun, aiTool, importFixtures, signInOpenNan } from "./ai-helpers";
import { createProject, execute, snapshot } from "./helpers";

type Item = { id: string; trackType: string; trackIndex: number; mediaUrl: string | null; opacity?: number; volume?: number; textContent?: string | null; startTime: number; endTime: number };
const items = async (page: Page) => (await snapshot(page)).clips as unknown as Item[];
const lastJob = async (page: Page) => (await aiJobs(page)).at(-1);
const posts = async (path: string) => (await fakeState()).requests.filter((r) => r.method === "POST" && r.path === path);

async function videoScene(page: Page, name: string): Promise<string> {
    await createProject(page, name);
    await signInOpenNan(page);
    await importFixtures(page, ["clip-360p.webm"]);
    return addToTimeline(page, "clip-360p.webm", "scene");
}

test("upscale: the tier sets the price; the result is stacked over the hidden scene; undo; a video already that large is refused and refunded", async ({ page }) => {
    const sceneId = await videoScene(page, "Upscale");
    await expect.poll(async () => (await aiTool(page, "video-upscale", { sceneId, resolution: "1080p" })).price.label).toBe("≈ $0.038");
    await expect.poll(async () => (await aiTool(page, "video-upscale", { sceneId, resolution: "4k" })).price.label).toBe("≈ $0.150");
    await aiRun(page, "video-upscale", { sceneId, resolution: "1080p" });
    await expect.poll(async () => (await lastJob(page))?.status, { timeout: 60_000 }).toBe("succeeded");
    expect((await posts("/v1/videos/upscales"))[0]!.body).toMatchObject({ resolution: "1080p" });
    const upload = (await fakeState()).uploads.at(-1)!;
    expect(["video/mp4", "video/webm"]).toContain(upload.contentType);
    const stacked = (await items(page)).filter((c) => c.trackType === "video");
    expect(stacked).toHaveLength(1);
    expect(stacked[0]!.volume).toBe(0);
    const scene = (await snapshot(page)).scenes.find((s) => s.id === sceneId) as unknown as { opacity?: number };
    expect(scene.opacity).toBe(0);
    await execute(page, { type: "history.undo" });
    await expect.poll(async () => (await items(page)).filter((c) => c.trackType === "video").length).toBe(0);
    expect(((await snapshot(page)).scenes.find((s) => s.id === sceneId) as unknown as { opacity?: number | null }).opacity ?? 1).toBe(1);

    await fakeControl("fail-next?tool=video-upscale&kind=input_already_large");
    await aiRun(page, "video-upscale", { sceneId, resolution: "2k" });
    await expect.poll(async () => (await lastJob(page))?.status, { timeout: 60_000 }).toBe("failed");
    expect(await lastJob(page)).toMatchObject({ refunded: true, error: expect.stringMatching(/already at or above.*not charged/i) });
});

test("remove background: a transparent result stacked above, the source hidden", async ({ page }) => {
    const sceneId = await videoScene(page, "Matting");
    await expect.poll(async () => (await aiTool(page, "remove-background", { sceneId })).price.label).toBe("≈ $0.011");
    await aiRun(page, "remove-background", { sceneId, background: "transparent" });
    await expect.poll(async () => (await lastJob(page))?.status, { timeout: 60_000 }).toBe("succeeded");
    expect((await posts("/v1/videos/background-removals"))[0]!.body).toMatchObject({ background: "transparent" });
    expect((await items(page)).filter((c) => c.trackType === "video")).toHaveLength(1);
});

test("lip sync: the face video and the speech go up separately; the result follows the speech", async ({ page }) => {
    const sceneId = await videoScene(page, "Lip sync");
    await importFixtures(page, ["speech-with-gaps.wav"]);
    const audioClipId = await addToTimeline(page, "speech-with-gaps.wav", "clip");
    // Priced on the speech: 3.2 s → 4 started seconds × $0.013.
    await expect.poll(async () => (await aiTool(page, "lipsync", { sceneId, audioClipId })).price.label).toBe("≈ $0.052");
    await aiRun(page, "lipsync", { sceneId, audioClipId });
    await expect.poll(async () => (await lastJob(page))?.status, { timeout: 60_000 }).toBe("succeeded");
    const body = (await posts("/v1/videos/lipsync"))[0]!.body as { video_url: string; audio_url: string };
    expect(body.video_url).not.toBe(body.audio_url);
    expect((await items(page)).filter((c) => c.trackType === "video")).toHaveLength(1);
});

test("split vocals: four stems on four new audio tracks, one undo", async ({ page }) => {
    await createProject(page, "Stems");
    await signInOpenNan(page);
    await importFixtures(page, ["speech-with-gaps.wav"]);
    const clipId = await addToTimeline(page, "speech-with-gaps.wav", "clip");
    await expect.poll(async () => (await aiTool(page, "stems", { clipId, stems: "all" })).price.kind).toBe("estimate");
    await aiRun(page, "stems", { clipId, stems: "all" });
    await expect.poll(async () => (await lastJob(page))?.status, { timeout: 60_000 }).not.toMatch(/queued|preparing|running/);
    expect(await lastJob(page)).toMatchObject({ status: "succeeded" });
    expect((await posts("/v1/audio/separations"))[0]!.body).toMatchObject({ model: "demucs", stems: "all" });
    expect((await items(page)).filter((c) => c.trackType === "audio")).toHaveLength(5);
    await execute(page, { type: "history.undo" });
    await expect.poll(async () => (await items(page)).filter((c) => c.trackType === "audio").length).toBe(1);
});

test("translate captions: priced on characters, a new track above with the same timings; untranslated lines keep their text; keep-source off replaces", async ({ page }) => {
    await createProject(page, "Translate");
    await signInOpenNan(page);
    const lines = [["Hello there.", 0.1, 1.0], ["How are you?", 1.2, 2.3]] as const;
    for (const [text, start, end] of lines) {
        await execute(page, { type: "clip.create", input: { trackType: "text", trackIndex: 1, startTime: start, endTime: end, textContent: text, mediaType: "text" } });
    }
    await expect.poll(async () => (await items(page)).filter((c) => c.trackType === "text" && !c.id.startsWith("temp")).length).toBe(2);
    // (12 + 10) + (12 + 10) = 44 billed characters → 1 started thousand × $0.00591.
    await expect.poll(async () => (await aiTool(page, "caption-translate", { trackIndex: 1, language: "th" })).price.label).toBe("≈ $0.006");
    await aiRun(page, "caption-translate", { trackIndex: 1, language: "th" });
    await expect.poll(async () => (await lastJob(page))?.status, { timeout: 60_000 }).toBe("succeeded");
    const texts = (await items(page)).filter((c) => c.trackType === "text");
    const translated = texts.filter((c) => c.textContent?.startsWith("[th] "));
    expect(translated.map((c) => [c.textContent, c.startTime, c.endTime])).toEqual([["[th] Hello there.", 0.1, 1.0], ["[th] How are you?", 1.2, 2.3]]);
    expect(translated[0]!.trackIndex).not.toBe(1);
    await execute(page, { type: "history.undo" });
    await expect.poll(async () => (await items(page)).filter((c) => c.trackType === "text").length).toBe(2);

    await fakeControl("drop-translated-line");
    await aiRun(page, "caption-translate", { trackIndex: 1, language: "ja", keepSource: false });
    await expect.poll(async () => (await lastJob(page))?.status, { timeout: 60_000 }).toBe("succeeded");
    const replaced = (await items(page)).filter((c) => c.trackType === "text").map((c) => c.textContent);
    expect(replaced).toHaveLength(2);
    // The fake drops line 2 from its answer: it keeps its source text (untranslated), line 1 is translated.
    expect(replaced).toContain("[ja] Hello there.");
    expect(replaced).toContain("How are you?");
});
