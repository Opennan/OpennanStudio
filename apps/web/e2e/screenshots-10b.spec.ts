// Screenshots of the phase 10b editor for docs/theme/phase-10b/ (dark, the only theme, 1440×900):
// SCREENSHOTS=1 pnpm --filter @opennan/web exec playwright test e2e/screenshots-10b.spec.ts. Skipped otherwise.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { createProject, execute, sceneRects, serveFfmpegCoreLocally, snapshot, timelineCanvasBox, waitForSaves } from "./helpers";
import { ROOT, deselect, exportMp4, exportedFramePng, openLibraryTab, previewFrameRect } from "./motion-helpers";

const OUT = path.join(ROOT, "docs", "theme", "phase-10b");
test.skip(!process.env.SCREENSHOTS, "set SCREENSHOTS=1 to write docs/theme/phase-10b");

const shot = async (page: Page, name: string, clip?: { x: number; y: number; width: number; height: number }) => {
    await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(OUT, `${name}.png`), ...(clip ? { clip } : {}) });
};

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const SAMPLES = [path.join(FIXTURES, "sample-gradients.webm"), path.join(FIXTURES, "sample-mandelbrot.webm")];

const SRT = `1
00:00:06,200 --> 00:00:07,600
words light up one by one

2
00:00:07,700 --> 00:00:08,900
karaoke captions in Studio
`;

interface Ids { a: string; b: string; text: string; sticker: string }

async function dismissToasts(page: Page): Promise<void> {
    for (const button of await page.getByRole("button", { name: "Dismiss" }).all()) await button.click().catch(() => undefined);
}

/**
 * The sample project: gradients (zoom in, scale keyframes with ease in-out) then the Mandelbrot zoom at 2×,
 * a TikTok-bold title with a typewriter in and a float loop, a fire sticker, and karaoke captions.
 */
async function setup(page: Page): Promise<Ids> {
    await createProject(page, "Launch teaser");
    await page.getByTestId("media-import-input").setInputFiles(SAMPLES);
    await expect(page.getByTestId("media-item")).toHaveCount(2);
    for (let i = 0; i < 2; i += 1) {
        const tile = page.getByTestId("media-item").nth(i);
        await expect(tile).toContainText("0:06");
        await tile.hover();
        await tile.getByRole("button", { name: /to timeline$/ }).click();
        await expect.poll(async () => (await snapshot(page)).scenes.length).toBe(i + 1);
    }
    const [a, b] = (await snapshot(page)).scenes.map((s) => s.id);
    expect((await execute(page, { type: "animation.set", sceneId: a, slot: "in", animationId: "zoom_in", duration: 1 })).ok).toBe(true);
    expect((await execute(page, { type: "keyframe.set", sceneId: a, time: 1.5, values: { scale: 1 }, easing: "ease_in_out" })).ok).toBe(true);
    expect((await execute(page, { type: "keyframe.set", sceneId: a, time: 4.5, values: { scale: 1.35 } })).ok).toBe(true);
    expect((await execute(page, { type: "speed.set", sceneId: b, speed: 2 })).ok).toBe(true);

    await execute(page, { type: "playhead.seek", seconds: 0 });
    await openLibraryTab(page, "Text");
    await page.getByTestId("text-template-tiktok_bold").click();
    await expect.poll(async () => (await snapshot(page)).clips.filter((c) => c.trackType === "text").length).toBe(1);
    const text = (await snapshot(page)).clips.find((c) => c.trackType === "text")!.id;
    await execute(page, { type: "animation.set", clipId: text, slot: "in", animationId: "typewriter", duration: 2 });
    await execute(page, { type: "animation.set", clipId: text, slot: "loop", animationId: "float" });
    await execute(page, { type: "clip.update", clipIds: [text], patch: { positionY: 0.3 } });

    await execute(page, { type: "playhead.seek", seconds: 6.4 });
    await openLibraryTab(page, "Stickers");
    await page.getByTestId("sticker-card-twemoji:1f525").click();
    await expect.poll(async () => (await snapshot(page)).clips.filter((c) => c.trackType === "sticker").length).toBe(1);
    const sticker = (await snapshot(page)).clips.find((c) => c.trackType === "sticker")!.id;
    await execute(page, { type: "clip.update", clipIds: [sticker], patch: { positionX: 0.82, positionY: 0.22, scale: 1.2, endTime: 9 } });
    await execute(page, { type: "animation.set", clipId: sticker, slot: "in", animationId: "bounce_in", duration: 0.6 });

    const srt = test.info().outputPath("captions.srt");
    fs.mkdirSync(path.dirname(srt), { recursive: true });
    fs.writeFileSync(srt, SRT);
    await page.getByTestId("subtitle-import-input").setInputFiles(srt);
    await expect.poll(async () => (await snapshot(page)).clips.filter((c) => c.trackType === "text").length).toBe(3);
    await execute(page, { type: "caption.style.apply", styleId: "karaoke_highlight" });
    await waitForSaves(page);
    await dismissToasts(page);
    return { a, b, text, sticker };
}

test.beforeAll(() => fs.mkdirSync(OUT, { recursive: true }));

test("text and stickers libraries, the text inspector, animation, keyframes, and speed", async ({ page }) => {
    const ids = await setup(page);

    // Text tab and the text inspector (template grid, then the style controls).
    await execute(page, { type: "playhead.seek", seconds: 2.4 });
    await deselect(page);
    await openLibraryTab(page, "Text");
    await shot(page, "library-text");
    await page.getByTestId("caption-style-karaoke_box").scrollIntoViewIfNeeded();
    await shot(page, "library-text-captions");
    await execute(page, { type: "selection.set", clipIds: [ids.text] });
    await page.getByTestId("inspector-tab-text").click();
    await shot(page, "inspector-text");
    await page.getByTestId("inspector-panel-text").evaluate((el) => {
        const scroller = el.closest(".on-inspector-body") ?? el;
        scroller.scrollTop = scroller.scrollHeight / 2;
    });
    await shot(page, "inspector-text-styles");
    await page.getByTestId("inspector-tab-animation").click();
    await page.getByTestId("anim-slot-loop").click();
    await shot(page, "animation-text-loop");

    // Stickers tab.
    await execute(page, { type: "playhead.seek", seconds: 8.3 });
    await deselect(page);
    await openLibraryTab(page, "Stickers");
    await shot(page, "library-stickers");

    // Animation tab on a main-track clip: In (Zoom in applied), Out, Combo.
    await execute(page, { type: "selection.set", sceneId: ids.a });
    await execute(page, { type: "playhead.seek", seconds: 0.45 });
    await page.getByTestId("inspector-tab-animation").click();
    await page.getByTestId("anim-slot-in").click();
    await page.getByTestId("inspector-panel-animation").evaluate((el) => { el.scrollTop = 0; });
    await shot(page, "animation-clip-in");
    await page.getByTestId("anim-slot-out").click();
    await shot(page, "animation-clip-out");
    await page.getByTestId("anim-slot-combo").click();
    await shot(page, "animation-clip-combo");

    // Keyframe diamonds and the easing of the keyframe under the playhead (Bezier shows its curve editor).
    await page.getByTestId("inspector-tab-video").click();
    await execute(page, { type: "playhead.seek", seconds: 1.5 });
    await expect(page.getByTestId("kf-easing")).toBeVisible();
    await shot(page, "keyframes-easing");
    await page.getByTestId("ease-bezier").click();
    await expect(page.getByTestId("bezier-editor")).toBeVisible();
    await shot(page, "keyframes-bezier");
    await execute(page, { type: "history.undo" });

    // Diamonds on the selected scene in the timeline (the one under the playhead filled white).
    await expect.poll(async () => (await sceneRects(page)).length).toBe(2);
    const box = await timelineCanvasBox(page);
    await shot(page, "timeline-diamonds", { x: Math.max(0, box.x - 112), y: Math.max(0, box.y - 40), width: Math.min(1000, box.width + 112), height: Math.min(260, box.height + 40) });

    // Speed tab on the 2× scene: Normal, then the Hero curve and its editor.
    await execute(page, { type: "selection.set", sceneId: ids.b });
    await execute(page, { type: "playhead.seek", seconds: 7 });
    await page.getByTestId("inspector-tab-speed").click();
    await shot(page, "speed-normal");
    await page.getByTestId("speed-tab").getByRole("button", { name: "Curve", exact: true }).click();
    await page.getByTestId("speed-preset-hero").click();
    await expect(page.getByTestId("curve-editor")).toBeVisible();
    await shot(page, "speed-curve");
});

test("auto-captions dialog with the caption styles", async ({ page }) => {
    await createProject(page, "Launch teaser");
    // The web build has no transcriber: register a stand-in (window.__studio.providers in e2e builds).
    await page.evaluate(() => {
        const studio = (window as unknown as { __studio: { providers: { register(p: unknown): void } } }).__studio;
        studio.providers.register({
            info: { id: "e2e-whisper", name: "Whisper (on device)", capabilities: ["audio.transcribe"] },
            audio: { models: async () => [{ id: "base", label: "Whisper base", default: true, installed: true, sizeBytes: 148 * 1024 * 1024 }] },
        });
    });
    await page.getByRole("button", { name: "Auto captions" }).click();
    const dialog = page.getByRole("dialog", { name: "Auto captions" });
    await expect(dialog.getByRole("radiogroup", { name: "Caption style" })).toBeVisible();
    await expect(dialog.getByRole("radio")).toHaveCount(8);
    await dialog.locator('[data-style="karaoke_highlight"]').click();
    await page.waitForTimeout(800);
    await shot(page, "auto-captions-styles");
});

test("preview handles with a snap guide, a karaoke frame, and exported frames per feature", async ({ page }) => {
    test.setTimeout(900_000);
    await serveFfmpegCoreLocally(page);
    const ids = await setup(page);

    // Handles: the sticker selected and dragged toward the frame centre; the guides show while the pointer is down.
    await execute(page, { type: "playhead.seek", seconds: 8.3 });
    await execute(page, { type: "selection.set", clipIds: [ids.sticker] });
    const preview = page.locator(".editor-preview");
    const frame = await previewFrameRect(page);
    const from = { x: frame.x + frame.w * 0.82, y: frame.y + frame.h * 0.22 };
    const pick = await page.evaluate(([x, y]) => {
        const canvas = document.querySelector<HTMLCanvasElement>("canvas[data-preview-canvas]")!;
        const rect = canvas.getBoundingClientRect();
        const ratio = canvas.width / rect.width;
        // The sticker's drawn centre near the expected spot (its box hangs from the position anchor).
        const data = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data;
        let sx = 0, sy = 0, n = 0;
        for (let yy = 0; yy < canvas.height; yy += 2) for (let xx = Math.floor(canvas.width / 2); xx < canvas.width; xx += 2) {
            const a = data[(yy * canvas.width + xx) * 4 + 3];
            const r = data[(yy * canvas.width + xx) * 4];
            const g = data[(yy * canvas.width + xx) * 4 + 1];
            if (a > 200 && r > 180 && g < 170) { sx += xx; sy += yy; n += 1; }
        }
        return n ? { x: rect.left + sx / n / ratio, y: rect.top + sy / n / ratio } : { x, y };
    }, [from.x, from.y] as const);
    await page.mouse.move(pick.x, pick.y);
    await page.mouse.down();
    const target = { x: frame.x + frame.w / 2 + 2, y: pick.y + 30 };
    await page.mouse.move((pick.x + target.x) / 2, (pick.y + target.y) / 2, { steps: 8 });
    await page.mouse.move(target.x, target.y, { steps: 8 });
    await shot(page, "preview-handles-guide", (await preview.boundingBox())!);
    await page.mouse.up();
    await execute(page, { type: "history.undo" });

    // A karaoke caption frame in the preview.
    await execute(page, { type: "playhead.seek", seconds: 7.0 });
    await page.waitForTimeout(300);
    await deselect(page);
    await page.waitForTimeout(500);
    await shot(page, "caption-karaoke", (await preview.boundingBox())!);

    // One export, a frame per feature.
    const file = await exportMp4(page, "phase-10b.mp4", 880_000);
    const frames: Array<[string, number]> = [
        ["export-clip-animation", 0.45],
        ["export-text-animation", 1.0],
        ["export-keyframes", 3.6],
        ["export-speed", 6.9],
        ["export-sticker", 8.3],
    ];
    for (const [name, seconds] of frames) exportedFramePng(file, seconds, path.join(OUT, `${name}.png`));
});
