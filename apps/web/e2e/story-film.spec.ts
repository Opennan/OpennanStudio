// Story film end to end against the fake OpenNan server: AI library → Story film (its own window) → write a story (the story writer drafts
// it; the draft is edited and saved) → cast sheets → keyframes → clips → music → "Put on timeline" (9:16, the film on
// V1, the title, the music). The cast check looks at each keyframe: a miss is redrawn with the look restated, and a
// shot still off after its redraw says "Check this shot". A second pass pays for nothing; one keyframe is redrawn on its
// own. Copying a video from Media sends its frames on one contact sheet with an original cast. A copy that keeps the
// original motion cuts the video into its shots and remakes each one with its clip as the reference video.
import { expect, test, type Page } from "@playwright/test";
import { FAKE_OPENNAN, fakeState } from "./fixtures/fake-opennan";
import { importFixtures, signInOpenNan } from "./ai-helpers";
import { createProject, snapshot } from "./helpers";

test.describe.configure({ timeout: 240_000 });

const STORY = {
    title: "Rain Check",
    style: "classic 2D hand-drawn animated film still, ink linework, flat cel colour, soft overcast palette",
    characters: [
        { id: "theo", name: "Theo", look: "tall lanky young man, curly ginger hair, mustard cardigan" },
        { id: "mae", name: "Mae", look: "young woman, chestnut ponytail, teal swing coat" },
    ],
    shots: [
        { id: "s01", cast: ["theo", "mae"], frame: "A quiet London street. Mae walks past Theo.", motion: "Mae walks left to right; Theo's head turns to follow her.", seconds: 5 },
        { id: "s02", cast: ["mae"], frame: "Mae under a grey sky, palm out.", motion: "A raindrop lands on her palm; she looks up.", seconds: 5 },
    ],
    music: "gentle jazz waltz, no vocals",
};

async function queueReply(text: string): Promise<void> {
    const response = await fetch(`${FAKE_OPENNAN}/__test/chat-reply`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) });
    if (!response.ok) throw new Error(`chat-reply ${response.status}`);
}

async function openStoryFilm(page: Page): Promise<void> {
    await page.getByTestId("editor-library").getByRole("tab", { name: "AI" }).click();
    await page.getByTestId("ai-tile-story-film").click();
    await expect(page.getByRole("dialog", { name: "Story film" })).toBeVisible();
    await expect(page.getByTestId("story-film-wizard")).toBeVisible();
}

const posts = async (path: string) => (await fakeState()).requests.filter((r) => r.method === "POST" && r.path === path);

async function runStep(page: Page, testId: string, items: string[]): Promise<void> {
    const run = page.getByTestId(testId);
    await expect(run).toContainText("· ", { timeout: 20_000 });
    await expect(run).toBeEnabled();
    await run.click();
    for (const id of items) await expect(page.getByTestId(id)).toHaveAttribute("data-state", "done", { timeout: 120_000 });
    await expect(page.getByTestId("story-film-running")).toHaveCount(0, { timeout: 30_000 });
}

test("writes, draws, animates, scores and lays out a story film; a second pass pays for nothing", async ({ page }) => {
    await createProject(page, "Story film");
    await signInOpenNan(page);
    await openStoryFilm(page);

    await page.getByTestId("story-film-text").fill("A shy man courts a woman across a rainy London, and she ends up sheltering him.");
    const draft = page.getByTestId("story-film-draft");
    await expect(draft).toHaveText(/^≈ \$\d+\.\d+ · Write the shots$/, { timeout: 20_000 });
    await queueReply(`Here it is:\n\`\`\`json\n${JSON.stringify(STORY)}\n\`\`\``);
    await draft.click();
    const editor = page.getByTestId("story-film-editor");
    await expect(editor.getByTestId("story-film-title")).toHaveValue("Rain Check", { timeout: 30_000 });
    await expect(editor.getByTestId("story-film-shot-edit")).toHaveCount(2);
    // The draft is edited before anything is drawn.
    await editor.getByTestId("story-film-title").fill("Rain Check!");
    await editor.getByTestId("story-film-save").click();
    await expect(editor.getByText("Saved")).toBeVisible();
    expect((await snapshot(page)).project?.storyFilmJson).toContain("Rain Check!");

    await page.getByRole("button", { name: "Cast", exact: true }).click();
    await runStep(page, "story-film-run-cast", ["story-film-item-theo", "story-film-item-mae"]);
    const sheets = await posts("/v1/images/generations");
    expect(sheets).toHaveLength(2);
    expect(sheets[0]!.body).toMatchObject({ model: "nano-banana-pro", size: "2K", aspect_ratio: "16:9" });

    await page.getByRole("button", { name: "Shots", exact: true }).click();
    const check = page.getByTestId("story-film-cast-check");
    await expect(check).toBeChecked();
    await expect(page.getByText(/^Check characters match \(\+~\$\d+\.\d{3} per shot\)$/)).toBeVisible({ timeout: 20_000 });
    // Shot 1's first look finds Mae off her sheet: it is redrawn with her look restated, and the redraw matches.
    await queueReply(JSON.stringify({ characters: [{ id: "theo", match: true }, { id: "mae", match: false, reason: "no ponytail" }] }));
    await runStep(page, "story-film-run-frames", ["story-film-item-s01", "story-film-item-s02"]);
    const frames = (await posts("/v1/images/generations")).slice(2);
    expect(frames).toHaveLength(3);
    expect(String((frames[1]!.body as { prompt: string }).prompt)).toMatch(/Most important: Mae must look exactly like reference image 2: .*no ponytail$/);
    expect((frames[2]!.body as { images?: unknown[] }).images).toHaveLength(1);
    expect(await posts("/v1/chat/completions")).toHaveLength(1 + 3);
    await expect(page.getByTestId("story-film-item-s01")).toContainText("Made, characters match");
    await expect(page.getByTestId("story-film-flag-s01")).toHaveCount(0);

    await page.getByRole("button", { name: "Animate", exact: true }).click();
    await expect(page.getByTestId("story-film-model")).toHaveValue("seedance-2-5", { timeout: 20_000 });
    await runStep(page, "story-film-run-animate", ["story-film-clip-s01", "story-film-clip-s02"]);
    expect((await posts("/v1/videos/generations")).map((r) => r.body)).toEqual([
        expect.objectContaining({ model: "seedance-2-5", quality: "720p", duration: 5, generate_audio: false }),
        expect.objectContaining({ model: "seedance-2-5" }),
    ]);

    await page.getByRole("button", { name: "Music", exact: true }).click();
    const music = page.getByTestId("story-film-redo-music");
    await expect(music).toHaveText(/^≈ \$\d+\.\d+ · Make$/, { timeout: 20_000 });
    await music.click();
    await expect.poll(async () => (await posts("/v1/music/generations")).length, { timeout: 60_000 }).toBe(1);
    await expect(music).toHaveText(/· Make again$/, { timeout: 60_000 });

    await page.getByRole("button", { name: "Timeline", exact: true }).click();
    await page.getByTestId("story-film-assemble").click();
    await expect(page.getByTestId("story-film-wizard").getByText("On the timeline", { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect.poll(async () => (await snapshot(page)).scenes.length, { timeout: 10_000 }).toBe(2);
    const snap = await snapshot(page);
    expect(snap.project?.aspectRatio).toBe("9:16");
    expect(snap.scenes.map((s) => s.fitMode)).toEqual(["contain", "contain"]);
    expect(snap.clips.find((c) => c.trackType === "text")?.textContent).toBe("Rain Check!");
    expect(snap.clips.filter((c) => c.trackType === "audio")).toHaveLength(1);

    // A second pass: nothing is left to make, nothing is sent.
    const before = (await fakeState()).requests.filter((r) => r.method === "POST").length;
    await page.getByRole("button", { name: "Cast", exact: true }).click();
    await expect(page.getByTestId("story-film-run-cast")).toHaveText("Everything is made", { timeout: 20_000 });
    await expect(page.getByTestId("story-film-run-cast")).toBeDisabled();
    expect((await fakeState()).requests.filter((r) => r.method === "POST").length).toBe(before);

    // One keyframe redrawn on its own; Mae stays off her sheet after its redraw too: kept, and the shot says check it.
    await page.getByRole("button", { name: "Shots", exact: true }).click();
    const redo = page.getByTestId("story-film-redo-s02");
    await expect(redo).toHaveText(/^≈ \$\d+\.\d+ · Make again$/, { timeout: 20_000 });
    const miss = JSON.stringify({ characters: [{ id: "mae", match: false, reason: "short dark hair" }] });
    await queueReply(miss);
    await queueReply(miss);
    await redo.click();
    await expect.poll(async () => (await posts("/v1/images/generations")).length, { timeout: 60_000 }).toBe(7);
    await expect(page.getByTestId("story-film-flag-s02")).toContainText("Check this shot. Mae: short dark hair", { timeout: 30_000 });
    await expect(page.getByTestId("story-film-item-s02")).toHaveAttribute("data-flagged", "true");
    // With the check off, a redo is one image and no look.
    const chats = (await posts("/v1/chat/completions")).length;
    await check.uncheck();
    await expect(redo).toHaveText(/^≈ \$\d+\.\d+ · Make again$/, { timeout: 20_000 });
    await redo.click();
    await expect.poll(async () => (await posts("/v1/images/generations")).length, { timeout: 60_000 }).toBe(8);
    await expect(page.getByTestId("story-film-flag-s02")).toHaveCount(0, { timeout: 30_000 });
    expect(await posts("/v1/chat/completions")).toHaveLength(chats);
});

test("copies a video from Media: its frames on one contact sheet, an original cast by default", async ({ page }) => {
    await createProject(page, "Copy a video");
    await signInOpenNan(page);
    await importFixtures(page, ["clip-360p.webm"]);
    await openStoryFilm(page);
    await page.getByRole("radio", { name: "Copy a video" }).click();
    await expect(page.getByLabel("New cast and title (keeps the beats)")).toBeChecked();
    const copy = page.getByTestId("story-film-copy");
    await expect(copy).toHaveText(/^≈ \$\d+\.\d+ · Read the video$/, { timeout: 20_000 });
    await queueReply(JSON.stringify({ ...STORY, title: "Umbrella Day" }));
    const chatsBefore = (await posts("/v1/chat/completions")).length;
    await copy.click();
    await expect(page.getByTestId("story-film-title")).toHaveValue("Umbrella Day", { timeout: 60_000 });
    const chat = (await posts("/v1/chat/completions"))[chatsBefore]!;
    expect((chat.body as { model: string }).model).toBe("text-vision");
    expect(JSON.stringify(chat.body)).toMatch(/ORIGINAL cast/);
    expect(JSON.stringify(chat.body)).toMatch(/image_url/);
    // The contact sheet is in Media (behind the window: close it, open Media).
    await page.getByRole("dialog", { name: "Story film" }).getByRole("button", { name: "Close", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Story film" })).toHaveCount(0);
    await page.getByTestId("editor-library").getByRole("tab", { name: "Media" }).click();
    await expect(page.getByTestId("media-item").filter({ hasText: "story-frames" })).toHaveCount(1);
});

test("remakes a copied video shot by shot: its shots cut out, each sent as the reference video of its clip", async ({ page }) => {
    await createProject(page, "Remake a video");
    await signInOpenNan(page);
    // 4 s of a test card, then 4 s of gradients: one cut, two real shots.
    await importFixtures(page, ["two-shots.webm"]);
    await openStoryFilm(page);
    await page.getByRole("radio", { name: "Copy a video" }).click();
    const keepMotion = page.getByTestId("story-film-keep-motion");
    // On by default: the default video model takes reference videos.
    await expect(keepMotion).toBeChecked({ timeout: 20_000 });
    await expect(page.getByText("Only copy or remake a video you have the rights to.")).toBeVisible();
    const copy = page.getByTestId("story-film-copy");
    await expect(copy).toHaveText(/^≈ \$\d+\.\d+ · Read the video$/, { timeout: 20_000 });
    const chatsBefore = (await posts("/v1/chat/completions")).length;
    await queueReply(JSON.stringify({ ...STORY, title: "Second Take" }));
    await copy.click();
    await expect(page.getByTestId("story-film-title")).toHaveValue("Second Take", { timeout: 90_000 });
    // The story writer saw a sheet of each shot and was told the real shots.
    const chat = (await posts("/v1/chat/completions"))[chatsBefore]!;
    expect(JSON.stringify(chat.body)).toMatch(/exactly 2 shots \(cut to cut\)/);
    const stored = JSON.parse((await snapshot(page)).project!.storyFilmJson!) as {
        source: Record<string, unknown>; settings: Record<string, unknown>; shots: Array<{ seconds: number; source?: { start: number; end: number; clip?: string } }>;
    };
    expect(stored.source).toMatchObject({ kind: "copy", cast: "original", keepMotion: true, mediaUrl: expect.any(String) });
    expect(stored.settings).toMatchObject({ videoModel: "seedance-2-5", videoReference: { minSeconds: 2 } });
    expect(stored.shots).toHaveLength(2);
    for (const shot of stored.shots) {
        expect(shot.source?.clip).toEqual(expect.any(String));
        expect(shot.source!.end - shot.source!.start).toBeGreaterThan(3.5);
        expect(shot.source!.end - shot.source!.start).toBeLessThan(4.5);
    }

    await page.getByRole("button", { name: "Cast", exact: true }).click();
    await runStep(page, "story-film-run-cast", ["story-film-item-theo", "story-film-item-mae"]);
    await page.getByRole("button", { name: "Shots", exact: true }).click();
    await page.getByTestId("story-film-cast-check").uncheck();
    await runStep(page, "story-film-run-frames", ["story-film-item-s01", "story-film-item-s02"]);

    await page.getByRole("button", { name: "Animate", exact: true }).click();
    await expect(page.getByTestId("story-film-animate-intro")).toContainText("Each shot is remade from its original shot", { timeout: 20_000 });
    await expect(page.getByTestId("story-film-animate-keep-motion")).toBeChecked();
    await expect(page.getByTestId("story-film-clip-s01")).toHaveAttribute("data-remake", "true");
    // The original shot sits beside its clip, for the review.
    await expect(page.getByTestId("story-film-original-s01").locator("video")).toHaveCount(1);
    const videosBefore = (await posts("/v1/videos/generations")).length;
    const uploadsBefore = (await fakeState()).uploads.length;
    await runStep(page, "story-film-run-animate", ["story-film-clip-s01", "story-film-clip-s02"]);
    // Priced with the reference seconds.
    const quoted = (await fakeState()).requests.filter((r) => r.path === "/v1/quotes").map((r) => r.body as Record<string, unknown>);
    expect(quoted.some((b) => Array.isArray(b.reference_videos) && b.reference_mode === "reference" && typeof b.seconds === "number")).toBe(true);
    const videos = (await posts("/v1/videos/generations")).slice(videosBefore).map((r) => r.body as Record<string, unknown>);
    expect(videos).toHaveLength(2);
    for (const body of videos) {
        expect(body).toMatchObject({ model: "seedance-2-5", quality: "720p", reference_mode: "reference", generate_audio: false, aspect_ratio: "16:9" });
        expect(body.reference_videos).toEqual([expect.stringMatching(/\/files\/uploads\/temp\/.+\.mp4$/)]);
        expect(body).not.toHaveProperty("image");
        // The cast's sheets (shot 1: Theo and Mae; shot 2: Mae), then the shot's keyframe (clips run two at a time).
        expect(body.reference_images).toHaveLength(String(body.prompt).includes("Theo") ? 3 : 2);
        expect(String(body.prompt)).toMatch(/^Recreate @Video1 exactly: same motion, timing, blocking and camera move/);
    }
    // The reference went up as an MP4 large enough for the model (a 360p source is scaled up).
    expect((await fakeState()).uploads.slice(uploadsBefore).filter((u) => u.contentType === "video/mp4").length).toBe(2);
    // A second pass pays for nothing: the clip is part of what made each one.
    await expect(page.getByTestId("story-film-run-animate")).toHaveText("Everything is made", { timeout: 20_000 });
});
