// The GPU export path in a real browser (phase 10c): the same project through the GPU compositor (WebGL2 +
// WebCodecs) and through ffmpeg.wasm, frames compared at fixed times (inside a transition window, with a look,
// an effect, a keyframed overlay, animated text, and a sticker), plus a cancel that leaves the page usable.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const CORE_DIR = path.join(ROOT, "apps/playground/node_modules/@ffmpeg/core/dist/esm");
const SAMPLE = "/sample/testsrc-6s.webm";

function ffmpeg(): string {
    const local = path.join(ROOT, "apps/desktop/resources/ffmpeg", `${process.platform}-${process.arch}`, "ffmpeg");
    for (const candidate of [process.env.OPENNAN_PARITY_FFMPEG, local, "ffmpeg"]) {
        if (candidate && spawnSync(candidate, ["-version"]).status === 0) return candidate;
    }
    throw new Error("an ffmpeg binary is needed to decode the exported files");
}

function frame(file: string, seconds: number, w = 160, h = 90): number[] {
    return Array.from(execFileSync(ffmpeg(), [
        "-hide_banner", "-loglevel", "error", "-ss", seconds.toFixed(3), "-i", file, "-frames:v", "1",
        "-vf", `scale=${w}:${h}:flags=area`, "-f", "rawvideo", "-pix_fmt", "rgb24", "-",
    ]));
}

function meanDiff(a: number[], b: number[]): number {
    let sum = 0;
    for (let i = 0; i < a.length; i += 1) sum += Math.abs(a[i] - b[i]);
    return sum / a.length;
}

function probe(file: string): { streams: Array<{ codec_type: string; codec_name: string; nb_frames?: string }>; format: { duration: string } } {
    const ffprobe = ffmpeg().replace(/ffmpeg$/, "ffprobe");
    return JSON.parse(execFileSync(ffprobe, ["-v", "error", "-show_entries", "stream=codec_type,codec_name,nb_frames:format=duration", "-of", "json", file], { encoding: "utf8" }));
}

const track = (type: string, index: number) => ({ type, index, label: "", muted: false, locked: false, visible: true, volume: 1 });
const scene = (id: string, start: number, patch: Record<string, unknown>) => ({
    id, order: 0, caption: "", startTime: "0", endTime: "0", startImageUrl: null, endImageUrl: null, videoUrl: null, sourceVideoUrl: SAMPLE,
    status: "ready", transition: "cut", cardType: "source_clip", duration: 6, frameConsistencyScore: null, audioUrl: null, audioText: null,
    cardConfig: null, timelinePositionSeconds: start || 0.001, fitMode: "contain", ...patch,
});

/** A 6 s project: two scenes with looks, an effect, a mask, and a dissolve, a keyframed masked overlay, animated text, a sticker, and a graphic. */
async function project(page: Page) {
    const clip = (input: Record<string, unknown>, id: string) =>
        page.evaluate(([i, d]) => (window as unknown as { __bench: { clip(i: unknown, d: string): unknown } }).__bench.clip(i, d), [input, id] as const);
    return {
        project: { aspectRatio: "16:9", musicUrl: null, musicVolume: 1 },
        tracks: [track("video", 1), track("video", 2), track("text", 1), track("sticker", 1), track("remotion", 1)],
        scenes: [
            scene("a", 0, { cardConfig: JSON.stringify({ trimStart: 0, trimEnd: 3 }), visualFilter: "warm", filterIntensity: 0.8, visualTransition: "cross_dissolve", visualTransitionDuration: 1 }),
            scene("b", 3, {
                cardConfig: JSON.stringify({ trimStart: 2, trimEnd: 5 }), adjustmentsJson: JSON.stringify({ exposure: 0.3, vignette: 0.4 }),
                // A feathered circle mask on the main track: black outside it.
                maskJson: JSON.stringify({ shape: "circle", x: 0.5, y: 0.5, width: 0.9, height: 0.9, feather: 0.3 }),
                effects: [{ id: "fx", clipId: null, sceneId: "b", effectId: "fx_rgb_split", order: 0, paramsJson: null, enabled: true, ownerScope: "project" }],
            }),
        ],
        clips: [
            await clip({
                trackType: "video", trackIndex: 2, startTime: 1, endTime: 5, mediaUrl: SAMPLE, mediaType: "video", scale: 0.4, positionX: 0.9, positionY: 0.1,
                keyframesJson: JSON.stringify([{ time: 0, position_x: 0.9, position_y: 0.1, mask_rotation: 0 }, { time: 4, position_x: 0.1, position_y: 0.9, mask_rotation: 90 }]),
                // A keyframed heart mask on the overlay (alpha through the composite).
                maskJson: JSON.stringify({ shape: "heart", x: 0.5, y: 0.5, width: 0.8, height: 0.8, feather: 0.1 }),
            }, "pip"),
            await clip({
                trackType: "text", trackIndex: 1, startTime: 0.2, endTime: 5.5, textContent: "GPU export", positionX: 0.5, positionY: 0.8, scale: 1,
                textStyle: JSON.stringify({ fontSize: 96, color: "#ffffff", fontWeight: 800, bgColor: "#000000" }),
                animationJson: JSON.stringify({ in: { id: "fade", duration: 0.5 } }),
            }, "title"),
            await clip({ trackType: "sticker", trackIndex: 1, startTime: 0, endTime: 6, stickerId: "twemoji:2b50", scale: 0.5, positionX: 0.1, positionY: 0.15 }, "star"),
            // A built-in graphic (phase 10d): drawn by the same Canvas 2D code in both engines.
            await clip({
                trackType: "remotion", trackIndex: 1, startTime: 1.2, endTime: 4.8, remotionTemplateId: "lower-third",
                remotionPropsJson: JSON.stringify({ name: "Graphics export", role: "Phase 10d", barColor: "#e11d48" }), rotationDegrees: -4,
            }, "lower"),
        ],
    };
}

test.beforeEach(async ({ page }) => {
    await page.route("**/ffmpeg-core/*", (route) => route.fulfill({ path: path.join(CORE_DIR, path.basename(new URL(route.request().url()).pathname)) }));
    await page.goto("/?harness=bench");
    await page.waitForFunction(() => "__bench" in window);
});

type BenchResult = { engine: string; seconds: number; container: string; encoder: string; durationSeconds: number; warnings: string[]; base64?: string };

async function exportWith(page: Page, engine: "gpu" | "ffmpeg", input: unknown, format?: "gif"): Promise<{ result: BenchResult; file: string }> {
    const result = await page.evaluate((spec) => (window as unknown as { __bench: { run(s: unknown): Promise<BenchResult> } }).__bench.run(spec), {
        input, resolution: "720p", engine, keepOutput: true, ...(format ? { format } : {}),
    });
    const dir = mkdtempSync(path.join(tmpdir(), "opennan-gpu-e2e-"));
    const file = path.join(dir, `${engine}.${result.container}`);
    writeFileSync(file, Buffer.from(result.base64!, "base64"));
    return { result, file };
}

test("the GPU export matches the ffmpeg export frame by frame", async ({ page }) => {
    test.setTimeout(300_000);
    const input = await project(page);
    const gpu = await exportWith(page, "gpu", input);
    const ffmpegRun = await exportWith(page, "ffmpeg", input);
    expect(gpu.result.engine).toMatch(/^gpu\/webcodecs-/);
    expect(ffmpegRun.result.engine).toBe("ffmpeg.wasm");
    expect(gpu.result.durationSeconds).toBeCloseTo(ffmpegRun.result.durationSeconds, 6);

    const info = probe(gpu.file);
    expect(info.streams.map((s) => s.codec_type).sort()).toEqual(["audio", "video"]);
    expect(Number(info.format.duration)).toBeCloseTo(6, 1);

    // Inside the dissolve (2.5–3.5), on a look, with the effect, the overlay moving, the text fading in, the sticker.
    for (const t of [0.35, 1.5, 2.75, 3.25, 4.4, 5.6]) {
        const diff = meanDiff(frame(gpu.file, t), frame(ffmpegRun.file, t));
        process.stderr.write(`[gpu-parity] ${t}s mean |Δ| ${diff.toFixed(2)}\n`);
        // Measured 0.9–1.4 levels (two decoders, two YUV conversions, two encoders); 3 leaves room for codec noise.
        expect(diff, `GPU vs ffmpeg at ${t}s`).toBeLessThan(3);
    }
    // Different content at different times (the comparison is not trivially equal).
    expect(meanDiff(frame(gpu.file, 0.35), frame(gpu.file, 4.4))).toBeGreaterThan(10);

    // The graphic is in both files while its clip runs (its rose bar at the lower left), and gone after it.
    const roseAt = (file: string, t: number) => {
        const pixels = frame(file, t, 64, 36);
        let rose = 0;
        for (let i = 0; i < pixels.length; i += 3) if (pixels[i] > 170 && pixels[i + 1] < 90 && pixels[i + 2] > 40 && pixels[i + 2] < 140) rose += 1;
        return rose;
    };
    for (const file of [gpu.file, ffmpegRun.file]) {
        expect(roseAt(file, 2.5), `graphic at 2.5 s in ${path.basename(file)}`).toBeGreaterThan(8);
        expect(roseAt(file, 5.6), `no graphic at 5.6 s in ${path.basename(file)}`).toBe(0);
    }
});

/** A small looping GIF (testsrc2, 10 fps, 1.2 s) made with the native ffmpeg, served at /sample/legacy.gif. */
function legacyGif(): string {
    const dir = mkdtempSync(path.join(tmpdir(), "opennan-gpu-gif-"));
    const file = path.join(dir, "legacy.gif");
    execFileSync(ffmpeg(), ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=s=160x90:r=10:d=1.2", "-loop", "0", file]);
    return file;
}

test("chroma key, legacy blur, blend modes, reverse, and a GIF render on the GPU path as on ffmpeg (phase 10d)", async ({ page }) => {
    test.setTimeout(300_000);
    const gif = legacyGif();
    await page.route("**/sample/legacy.gif", (route) => route.fulfill({ path: gif, contentType: "image/gif" }));
    const clip = (input: Record<string, unknown>, id: string) =>
        page.evaluate(([i, d]) => (window as unknown as { __bench: { clip(i: unknown, d: string): unknown } }).__bench.clip(i, d), [input, id] as const);
    const input = {
        project: { aspectRatio: "16:9", musicUrl: null, musicVolume: 1 },
        tracks: [track("video", 1), track("video", 2), track("video", 3), track("sticker", 1)],
        scenes: [scene("a", 0, { cardConfig: JSON.stringify({ trimStart: 0, trimEnd: 6 }) })],
        clips: [
            // testsrc's green bars keyed out over the scene, graded with the screen blend mode.
            await clip({
                trackType: "video", trackIndex: 2, startTime: 0, endTime: 3, mediaUrl: SAMPLE, mediaType: "video", scale: 0.7, positionX: 0.3, positionY: 0.4,
                chromaKeyEnabled: true, chromaKeyColor: "#00ff00", chromaKeySimilarity: 0.3, chromaKeyBlend: 0.1, blendMode: "screen",
            }, "keyed"),
            // Reversed and blurred, with the overlay blend mode.
            await clip({
                trackType: "video", trackIndex: 3, startTime: 3, endTime: 6, mediaUrl: SAMPLE, mediaType: "video", scale: 0.6, positionX: 0.7, positionY: 0.6,
                reversePlayback: true, blurStrength: 6, blendMode: "overlay",
            }, "reversed"),
            await clip({ trackType: "sticker", trackIndex: 1, startTime: 0.4, endTime: 5.8, mediaUrl: "/sample/legacy.gif", mediaType: "video", scale: 1.5, positionX: 0.85, positionY: 0.15 }, "gif"),
        ],
    };
    const gpu = await exportWith(page, "gpu", input);
    const ffmpegRun = await exportWith(page, "ffmpeg", input);
    // No fallback: every feature is on the GPU path.
    expect(gpu.result.engine).toMatch(/^gpu\/webcodecs-/);
    expect(gpu.result.warnings).not.toContain("gpu-fallback");
    for (const t of [0.55, 1.35, 2.6, 3.4, 4.45, 5.5]) {
        const diff = meanDiff(frame(gpu.file, t), frame(ffmpegRun.file, t));
        process.stderr.write(`[gpu-parity legacy] ${t}s mean |Δ| ${diff.toFixed(2)}\n`);
        expect(diff, `GPU vs ffmpeg at ${t}s`).toBeLessThan(3);
    }
    // The key, the blur, and the reversed playback change the picture (the comparison is not trivially equal).
    expect(meanDiff(frame(gpu.file, 3.4), frame(gpu.file, 5.5))).toBeGreaterThan(2);
});

test("a GIF export matches between the GPU and ffmpeg engines (phase 10d)", async ({ page }) => {
    test.setTimeout(300_000);
    const input = await project(page);
    const gpu = await exportWith(page, "gpu", input, "gif");
    const ffmpegRun = await exportWith(page, "ffmpeg", input, "gif");
    expect(gpu.result).toMatchObject({ engine: "gpu/gif (webcodecs-avc)", container: "gif" });
    expect(ffmpegRun.result).toMatchObject({ engine: "ffmpeg.wasm", container: "gif", encoder: "gif" });
    for (const file of [gpu.file, ffmpegRun.file]) {
        const info = probe(file);
        expect(info.streams.map((s) => [s.codec_type, s.codec_name])).toEqual([["video", "gif"]]);
        // GIF delays are whole centiseconds: 15 fps frames alternate 6 and 7 cs.
        expect(Math.abs(Number(info.format.duration) - 6)).toBeLessThan(0.15);
    }
    for (const t of [0.35, 1.5, 3.25, 4.4, 5.6]) {
        const diff = meanDiff(frame(gpu.file, t), frame(ffmpegRun.file, t));
        process.stderr.write(`[gpu-parity gif] ${t}s mean |Δ| ${diff.toFixed(2)}\n`);
        // Two palettes from nearly equal frames (the GPU path's goes through a WebCodecs intermediate), dithered.
        expect(diff, `GPU vs ffmpeg GIF at ${t}s`).toBeLessThan(6);
    }
});

test("cancelling a GPU export stops it and the next export still runs", async ({ page }) => {
    test.setTimeout(180_000);
    const input = await project(page);
    const outcome = await page.evaluate((spec) => (window as unknown as { __bench: { runCancelled(s: unknown, ms: number): Promise<string> } }).__bench.runCancelled(spec, 400), {
        input, resolution: "720p", engine: "gpu",
    });
    expect(outcome).toBe("cancelled");
    const again = await exportWith(page, "gpu", input);
    expect(again.result.engine).toMatch(/^gpu\//);
    expect(Number(probe(again.file).format.duration)).toBeCloseTo(6, 1);
});
