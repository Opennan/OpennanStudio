// Phase 10b end to end: imported SRT captions take the karaoke_highlight caption style from the Text tab
// (every caption clip, one click), the highlighted word moves left to right through a cue in the preview, and
// the exported MP4 highlights the same word at the same time.
import fs from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { createProject, execute, serveFfmpegCoreLocally, snapshot } from "./helpers";
import { centroid, deselect, exportMp4, exportedFrame, meanDiff, openLibraryTab, previewAt, type Frame } from "./motion-helpers";

interface TextClip { id: string; trackType: string; startTime: number; endTime: number; textContent?: string | null; textStyle?: string | null }

async function captionClips(page: Page): Promise<TextClip[]> {
    return ((await snapshot(page)).clips as unknown as TextClip[]).filter((c) => c.trackType === "text").sort((a, b) => a.startTime - b.startTime);
}

const SRT = `1
00:00:00,500 --> 00:00:03,500
one two three four

2
00:00:04,000 --> 00:00:07,000
five six seven eight
`;

/** The highlight colour of karaoke_highlight (#FFE14D) against white text with a black stroke. */
const isHighlight = (r: number, g: number, b: number) => r > 180 && g > 150 && b < 140 && r - b > 90;
const W = 320;
const H = 180;

function highlightX(frame: Frame, label: string): number {
    const c = centroid(frame, isHighlight);
    expect(c, `${label}: a highlighted word`).not.toBeNull();
    expect(c!.n, `${label}: highlighted pixels`).toBeGreaterThan(8);
    return c!.x;
}

test("imported captions take karaoke_highlight; the highlighted word advances in the preview and the export", async ({ page }) => {
    test.setTimeout(420_000);
    await serveFfmpegCoreLocally(page);
    await createProject(page, "Karaoke");

    const srt = test.info().outputPath("captions.srt");
    await fs.writeFile(srt, SRT);
    await page.getByTestId("subtitle-import-input").setInputFiles(srt);
    await expect.poll(async () => (await captionClips(page)).map((c) => c.textContent)).toEqual(["one two three four", "five six seven eight"]);

    // Nothing selected: a caption style goes to every caption clip.
    await deselect(page);
    await openLibraryTab(page, "Text");
    await expect(page.getByTestId(/^caption-style-/)).toHaveCount(8);
    await page.getByTestId("caption-style-karaoke_highlight").click();
    await expect.poll(async () => (await captionClips(page)).map((c) => JSON.parse(c.textStyle ?? "{}").karaoke)).toEqual(["highlight", "highlight"]);
    for (const clip of await captionClips(page)) {
        expect(JSON.parse(clip.textStyle ?? "{}"), clip.textContent ?? "").toMatchObject({ karaoke: "highlight", highlightColor: "#FFE14D", fontWeight: "900" });
    }

    // One undo step restores both clips, redo re-applies.
    await execute(page, { type: "history.undo" });
    await expect.poll(async () => (await captionClips(page)).map((c) => JSON.parse(c.textStyle ?? "{}").karaoke ?? null)).toEqual([null, null]);
    await execute(page, { type: "history.redo" });
    await expect.poll(async () => (await captionClips(page)).map((c) => JSON.parse(c.textStyle ?? "{}").karaoke)).toEqual(["highlight", "highlight"]);

    // Early in cue 1 the first word is lit, late in it the last one; the same in cue 2.
    const times = [0.8, 3.3, 4.3, 6.8];
    const preview: Frame[] = [];
    for (const t of times) preview.push(await previewAt(page, t, W, H));
    const px = preview.map((f, i) => highlightX(f, `preview at ${times[i]} s`));
    expect(px[1] - px[0], `preview: the highlight moves right through cue 1 (${px.join(", ")})`).toBeGreaterThan(W * 0.12);
    expect(px[3] - px[2], `preview: the highlight moves right through cue 2 (${px.join(", ")})`).toBeGreaterThan(W * 0.12);
    expect(meanDiff(preview[0], preview[1]), "two words, two different frames").toBeGreaterThan(0.2);

    const file = await exportMp4(page, "karaoke.mp4");
    const exported = times.map((t) => exportedFrame(file, t, W, H));
    const ex = exported.map((f, i) => highlightX(f, `export at ${times[i]} s`));
    expect(ex[1] - ex[0], `export: the highlight moves right through cue 1 (${ex.join(", ")})`).toBeGreaterThan(W * 0.12);
    expect(ex[3] - ex[2], `export: the highlight moves right through cue 2 (${ex.join(", ")})`).toBeGreaterThan(W * 0.12);
    times.forEach((t, i) => {
        expect(Math.abs(ex[i] - px[i]), `the same word is lit at ${t} s (export ${ex[i]}, preview ${px[i]})`).toBeLessThan(W * 0.05);
        expect(meanDiff(exported[i], preview[i]), `export vs preview at ${t} s`).toBeLessThan(5);
    });
});
