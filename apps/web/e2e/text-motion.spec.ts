// Phase 10b end to end: a text template from the Text tab, a typewriter in-animation and a loop from the
// inspector's Animation tab, the preview revealing the text over time, undo/redo, and an exported MP4 whose
// frames show the same reveal (and match the preview at the same times).
import { expect, test, type Page } from "@playwright/test";
import { createProject, execute, serveFfmpegCoreLocally, snapshot, waitForSaves } from "./helpers";
import { countPixels, deselect, exportMp4, exportedFrame, isWhite, meanDiff, openLibraryTab, previewAt, type Frame } from "./motion-helpers";

interface TextClip { id: string; trackType: string; startTime: number; endTime: number; textContent?: string | null; textStyle?: string | null; animationJson?: string | null }

async function textClips(page: Page): Promise<TextClip[]> {
    return ((await snapshot(page)).clips as unknown as TextClip[]).filter((c) => c.trackType === "text");
}

const animation = async (page: Page) => JSON.parse((await textClips(page))[0]?.animationJson ?? "{}") as Record<string, { id: string; duration?: number; period?: number } | undefined>;

// Typewriter over 0..2 s: a fifth, half, and four fifths of the glyphs, then all of them.
const TIMES = [0.4, 1.0, 1.6, 3.0];
const W = 320;
const H = 180;

test("a template, typewriter in and a loop, the reveal in the preview, undo/redo, and the export agrees", async ({ page }) => {
    test.setTimeout(420_000);
    await serveFfmpegCoreLocally(page);
    await createProject(page, "Text motion");

    await openLibraryTab(page, "Text");
    await expect(page.getByTestId(/^text-template-/)).toHaveCount(20);
    await page.getByTestId("text-template-tiktok_bold").click();
    await expect.poll(async () => (await textClips(page)).length).toBe(1);
    const [clip] = await textClips(page);
    expect(clip.textContent).toBe("POV: you finally did it");
    expect(JSON.parse(clip.textStyle ?? "{}")).toMatchObject({ fontWeight: "900", strokeWidth: 8, strokeColor: "#000000" });
    expect(JSON.parse(clip.textStyle ?? "{}").fontFamily).toContain("Montserrat");
    expect((await animation(page)).in?.id).toBe("pop");

    // The inspector of the new (selected) clip: Animation → In → Typewriter, 2 s; Loop → Float.
    await execute(page, { type: "selection.set", clipIds: [clip.id] });
    await page.getByTestId("inspector-tab-animation").click();
    await page.getByTestId("anim-slot-in").click();
    await page.getByTestId("anim-card-in-typewriter").click();
    await expect.poll(async () => (await animation(page)).in?.id).toBe("typewriter");
    await page.getByTestId("anim-duration").getByRole("slider").fill("2");
    await expect.poll(async () => (await animation(page)).in?.duration).toBe(2);
    await page.getByTestId("anim-slot-loop").click();
    await page.getByTestId("anim-card-loop-float").click();
    await expect.poll(async () => (await animation(page)).loop?.id).toBe("float");
    await expect(page.getByTestId("anim-slot-in")).toHaveAttribute("data-applied", "true");
    await waitForSaves(page);

    // Undo the loop, the duration, and the typewriter; redo all three.
    await execute(page, { type: "history.undo" });
    await expect.poll(async () => (await animation(page)).loop).toBeUndefined();
    await execute(page, { type: "history.undo" });
    await expect.poll(async () => (await animation(page)).in?.duration).not.toBe(2);
    await execute(page, { type: "history.undo" });
    await expect.poll(async () => (await animation(page)).in?.id).toBe("pop");
    await execute(page, { type: "history.redo" });
    await execute(page, { type: "history.redo" });
    await execute(page, { type: "history.redo" });
    await expect.poll(async () => animation(page)).toMatchObject({ in: { id: "typewriter", duration: 2 }, loop: { id: "float" } });
    await waitForSaves(page);

    // The preview reveals the text glyph by glyph: more white text pixels at each time.
    await deselect(page);
    const preview: Frame[] = [];
    for (const t of TIMES) preview.push(await previewAt(page, t, W, H));
    const previewCounts = preview.map((f) => countPixels(f, isWhite));
    for (let i = 1; i < TIMES.length; i += 1) {
        expect(previewCounts[i], `preview text pixels at ${TIMES[i]} s > at ${TIMES[i - 1]} s (${previewCounts.join(", ")})`).toBeGreaterThan(previewCounts[i - 1] * 1.15);
    }
    expect(previewCounts[0]).toBeGreaterThan(0);

    const file = await exportMp4(page, "text-motion.mp4");
    const exported = TIMES.map((t) => exportedFrame(file, t, W, H));
    const exportCounts = exported.map((f) => countPixels(f, isWhite));
    for (let i = 1; i < TIMES.length; i += 1) {
        expect(exportCounts[i], `export text pixels at ${TIMES[i]} s > at ${TIMES[i - 1]} s (${exportCounts.join(", ")})`).toBeGreaterThan(exportCounts[i - 1] * 1.15);
    }
    TIMES.forEach((t, i) => {
        // Same reveal: the exported count is within a third of the preview's, and the frames agree.
        expect(exportCounts[i] / Math.max(1, previewCounts[i]), `export/preview text pixels at ${t} s`).toBeGreaterThan(0.66);
        expect(exportCounts[i] / Math.max(1, previewCounts[i]), `export/preview text pixels at ${t} s`).toBeLessThan(1.5);
        expect(meanDiff(exported[i], preview[i]), `export vs preview at ${t} s`).toBeLessThan(4);
    });
});
