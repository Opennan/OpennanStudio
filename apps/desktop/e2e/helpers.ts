// Shared helpers for the desktop smoke: launch the built app on a fresh user-data folder with the e2e switch
// (window.__studio and the timeline debug hooks), and read results with the bundled ffprobe.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron, expect, type ElectronApplication, type Page } from "@playwright/test";

export const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const FIXTURE_VIDEO = path.join(APP_DIR, "e2e", "fixtures", "testsrc-6s.webm");
/** 11 s of speech (JFK's 1961 inaugural address, public domain): provider-local's fixture, one copy in the repo. */
export const FIXTURE_SPEECH = path.resolve(APP_DIR, "..", "..", "packages", "provider-local", "test", "fixtures", "jfk.wav");
const WHISPER_DIR = path.join(APP_DIR, "resources", "whisper", `${process.platform}-${process.arch}`);
const MODEL_CACHE = path.resolve(APP_DIR, "..", "..", ".cache", "whisper-models");

/**
 * The tiny whisper model for the auto-captions step, downloaded once into <repo>/.cache/whisper-models with
 * provider-local's verified download (catalog URL, SHA-256). Returns why the step cannot run, or null.
 */
export async function ensureTinyModel(): Promise<string | null> {
    if (!fs.existsSync(path.join(WHISPER_DIR, "checksums.json"))) return `no whisper.cpp in ${WHISPER_DIR} (pnpm --filter @opennan/desktop fetch:whisper)`;
    const { downloadVerified, findWhisperModel, sha256File } = await import("@opennan/provider-local");
    const tiny = findWhisperModel("tiny")!;
    const cached = path.join(MODEL_CACHE, tiny.file);
    if (fs.existsSync(cached) && (await sha256File(cached)) === tiny.sha256) return null;
    fs.mkdirSync(MODEL_CACHE, { recursive: true });
    fs.rmSync(cached, { force: true });
    try {
        await downloadVerified({ url: tiny.url, sha256: tiny.sha256, sizeBytes: tiny.sizeBytes, dest: cached });
        return null;
    } catch (error) {
        return `the tiny model could not be downloaded: ${error instanceof Error ? error.message : String(error)}`;
    }
}

/** Puts the cached tiny model where the app keeps models; the app checks its SHA-256 before using it. */
export function seedTinyModel(userData: string): void {
    const dir = path.join(userData, "models", "whisper");
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(path.join(MODEL_CACHE, "ggml-tiny.bin"), path.join(dir, "ggml-tiny.bin"));
}

export interface Studio {
    app: ElectronApplication;
    page: Page;
    userData: string;
    exportsDir: string;
    close(): Promise<void>;
}

export async function launchStudio(options: { prepare?(userData: string): void; userData?: string; env?: Record<string, string>; keepUserData?: boolean } = {}): Promise<Studio> {
    const userData = options.userData ?? fs.mkdtempSync(path.join(os.tmpdir(), "opennan-e2e-"));
    options.prepare?.(userData);
    const exportsDir = path.join(userData, "exports");
    const app = await _electron.launch({
        args: [APP_DIR],
        env: { ...process.env, OPENNAN_STUDIO_USER_DATA: userData, OPENNAN_STUDIO_EXPORTS_DIR: exportsDir, OPENNAN_STUDIO_E2E: "1", OPENNAN_DISABLE_UPDATES: "1", ...(options.env ?? {}) },
    });
    const page = await app.firstWindow();
    return {
        app, page, userData, exportsDir,
        async close() {
            await app.close();
            if (!options.keepUserData) fs.rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
        },
    };
}

type StudioWindow = { __studio?: { controller: { snapshot(): unknown; execute(command: unknown): Promise<{ ok: boolean }> }; store: { getState(): { activeTimelineSaves: number } } } };

export interface Snapshot {
    clips: Array<{ id: string; textContent?: string | null; mediaUrl?: string | null }>;
    scenes: Array<{ id: string; duration: number }>;
    project: { name: string } | null;
}

export async function snapshot(page: Page): Promise<Snapshot> {
    return page.evaluate(() => JSON.parse(JSON.stringify((window as unknown as StudioWindow).__studio!.controller.snapshot())));
}

export async function execute(page: Page, command: Record<string, unknown>): Promise<{ ok: boolean }> {
    return page.evaluate((c) => (window as unknown as StudioWindow).__studio!.controller.execute(c), command);
}

export async function waitForSaves(page: Page): Promise<void> {
    await expect.poll(() => page.evaluate(() => (window as unknown as StudioWindow).__studio!.store.getState().activeTimelineSaves)).toBe(0);
}

export async function blurFocus(page: Page): Promise<void> {
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}

/** The ffprobe next to the app's ffmpeg (fetched into resources/ffmpeg), or OPENNAN_FFPROBE. */
export function ffprobePath(): string {
    if (process.env.OPENNAN_FFPROBE) return process.env.OPENNAN_FFPROBE;
    return path.join(APP_DIR, "resources", "ffmpeg", `${process.platform}-${process.arch}`, process.platform === "win32" ? "ffprobe.exe" : "ffprobe");
}

/** The bundled ffmpeg (fetched into resources/ffmpeg), or OPENNAN_FFMPEG. */
export function ffmpegPath(): string {
    if (process.env.OPENNAN_FFMPEG) return process.env.OPENNAN_FFMPEG;
    return path.join(APP_DIR, "resources", "ffmpeg", `${process.platform}-${process.arch}`, process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
}

export interface RgbFrame { width: number; height: number; data: Buffer }

/** One decoded frame at `seconds` as packed RGB24, decoded with the bundled ffmpeg. */
export function decodeFrame(file: string, seconds: number, width: number, height: number): RgbFrame {
    const data = execFileSync(ffmpegPath(), ["-v", "error", "-ss", String(seconds), "-i", file, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { maxBuffer: 64 * 1024 * 1024 });
    if (data.length !== width * height * 3) throw new Error(`expected a ${width}×${height} RGB frame, got ${data.length} bytes`);
    return { width, height, data };
}

export interface Rect { x: number; y: number; width: number; height: number }

/** Mean absolute difference per channel (0..255) between two frames inside `rect`. */
export function regionDifference(a: RgbFrame, b: RgbFrame, rect: Rect): number {
    let sum = 0;
    for (let y = rect.y; y < rect.y + rect.height; y += 1) {
        for (let x = rect.x; x < rect.x + rect.width; x += 1) {
            const i = (y * a.width + x) * 3;
            sum += Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2]);
        }
    }
    return sum / (rect.width * rect.height * 3);
}

export function probe(file: string): { duration: number; streams: Array<{ codec_type: string; codec_name: string; width?: number; height?: number }> } {
    const json = JSON.parse(execFileSync(ffprobePath(), ["-v", "error", "-show_entries", "format=duration:stream=codec_type,codec_name,width,height", "-of", "json", file], { encoding: "utf8" }));
    return { duration: Number(json.format.duration), streams: json.streams };
}

/** The Electron binary (Node's require("electron") is its path), for spawning the app in --mcp-bridge mode. */
export function electronBinary(): string {
    return createRequire(path.join(APP_DIR, "package.json"))("electron") as string;
}
