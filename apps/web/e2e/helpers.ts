// Shared Playwright helpers for apps/web. window.__studio exists in the e2e build only
// (vite build --mode e2e: src/platform/studio-runtime.ts E2E -> StudioRuntime.debug; set in src/editor/editor-screen.tsx).
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page } from "@playwright/test";
import { FFMPEG_CORE_SHA256, FFMPEG_CORE_VERSION } from "@opennan/export/web";

export const FIXTURE_VIDEO = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "testsrc-6s.webm");
/** 2x2 black PNG. */
export const BLACK_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAC0lEQVR4nGNgQAYAAA4AAamRc7EAAAAASUVORK5CYII=";

export interface StudioClip { id: string; trackType: string; trackIndex: number; startTime: number; endTime: number; mediaUrl: string | null; textContent?: string | null }
export interface StudioScene { id: string; duration: number; trackIndex?: number | null; sourceVideoUrl?: string | null; cardConfig?: string | null; fitMode?: string | null }
export interface StudioSnapshot {
    clips: StudioClip[];
    scenes: StudioScene[];
    markers: Array<{ time: number; label?: string | null }>;
    project: { name: string; aspectRatio: string; storyFilmJson?: string | null } | null;
    currentTime: number;
}

type StudioWindow = {
    __studio?: {
        controller: { snapshot(): unknown; execute(command: unknown): Promise<{ ok: boolean }> };
        store: { getState(): { activeTimelineSaves: number } };
    };
};

export async function snapshot(page: Page): Promise<StudioSnapshot> {
    await page.waitForFunction(() => Boolean((window as unknown as StudioWindow).__studio?.controller));
    return page.evaluate(() => JSON.parse(JSON.stringify((window as unknown as StudioWindow).__studio!.controller.snapshot())));
}

export async function execute(page: Page, command: Record<string, unknown>): Promise<{ ok: boolean }> {
    return page.evaluate((c) => (window as unknown as StudioWindow).__studio!.controller.execute(c), command);
}

/** Optimistic edits show before LocalBackend has written IndexedDB; wait for the write before a reload. */
export async function waitForSaves(page: Page): Promise<void> {
    await expect.poll(() => page.evaluate(() => (window as unknown as StudioWindow).__studio!.store.getState().activeTimelineSaves)).toBe(0);
}

export async function createProject(page: Page, name: string, preset = "16:9 Landscape"): Promise<void> {
    await page.goto("/#/");
    await page.getByRole("button", { name: "New project" }).first().click();
    const dialog = page.getByRole("dialog", { name: "New project" });
    await dialog.getByLabel("Project name").fill(name);
    await dialog.getByRole("radio", { name: preset }).check();
    await dialog.getByRole("button", { name: "Create project" }).click();
    await expect(page.getByRole("region", { name: "Media", exact: true })).toBeVisible();
    await expect.poll(() => page.evaluate(() => Boolean((window as unknown as StudioWindow).__studio))).toBe(true);
    await expect.poll(async () => (await snapshot(page)).project?.name).toBe(name);
}

/** Shortcuts skip keys aimed at buttons and fields (editor-layout.tsx:1703-1714), so tests press keys on the page. */
export async function blurFocus(page: Page): Promise<void> {
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}

/** Scene rectangles the timeline canvas draws, read through its debug hook as apps/playground/e2e/smoke.spec.ts:4-18 does. */
export interface SceneRect { id: string; x: number; y: number; startSeconds: number; duration: number }

export async function sceneRects(page: Page): Promise<SceneRect[]> {
    return page.evaluate(() => (window as unknown as { __timelineDebugRects?: () => SceneRect[] }).__timelineDebugRects?.() ?? []);
}

/** Pixels per second. */
export async function timelineZoom(page: Page): Promise<number> {
    return page.evaluate(() => (window as unknown as { __timelineDebugMarkers: () => { zoom: number } }).__timelineDebugMarkers().zoom);
}

export async function timelineCanvasBox(page: Page): Promise<{ x: number; y: number; width: number; height: number }> {
    const canvas = page.locator('[data-testid="timeline-tracks-scroll"] canvas');
    await expect(canvas).toBeVisible();
    const box = await canvas.boundingBox();
    if (!box) throw new Error("timeline canvas not visible");
    return box;
}

/** A mouse drag in steps, so the canvas sees a move between down and up (apps/playground/e2e/smoke.spec.ts:32-38). */
export async function dragBy(page: Page, from: { x: number; y: number }, dx: number): Promise<void> {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + dx / 2, from.y, { steps: 5 });
    await page.mouse.move(from.x + dx, from.y, { steps: 10 });
    await page.mouse.up();
}

export function silentWav(seconds: number, sampleRate = 48_000): Buffer {
    const data = Math.round(seconds * sampleRate) * 4;
    const wav = Buffer.alloc(44 + data);
    wav.write("RIFF", 0);
    wav.writeUInt32LE(36 + data, 4);
    wav.write("WAVEfmt ", 8);
    wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20);
    wav.writeUInt16LE(2, 22);
    wav.writeUInt32LE(sampleRate, 24);
    wav.writeUInt32LE(sampleRate * 4, 28);
    wav.writeUInt16LE(4, 32);
    wav.writeUInt16LE(16, 34);
    wav.write("data", 36);
    wav.writeUInt32LE(data, 40);
    return wav;
}

/** The app's self-hosted core path (./ffmpeg-core/, src/export/web-export.ts FFMPEG_CORE_BASE). */
export const FFMPEG_CORE_ROUTE = "**/ffmpeg-core/*";

/**
 * Answers the app's ./ffmpeg-core/ requests from node_modules/@ffmpeg/core, counting them. The files
 * must be the bytes the app pins (@opennan/export/web FFMPEG_CORE_SHA256), or the app refuses them.
 * Returns how many core requests reached the route.
 */
export async function serveFfmpegCoreLocally(page: Page): Promise<{ requests(): number }> {
    const require = createRequire(import.meta.url);
    const esm = path.join(path.dirname(require.resolve("@ffmpeg/core")), "..", "esm");
    for (const [name, sha256] of Object.entries(FFMPEG_CORE_SHA256)) {
        const digest = createHash("sha256").update(await fs.readFile(path.join(esm, name))).digest("hex");
        if (digest !== sha256) throw new Error(`${name} in node_modules is not @ffmpeg/core@${FFMPEG_CORE_VERSION}`);
    }
    let requests = 0;
    await page.route(FFMPEG_CORE_ROUTE, (route) => {
        requests += 1;
        const file = path.basename(new URL(route.request().url()).pathname);
        return route.fulfill({
            path: path.join(esm, file),
            contentType: file.endsWith(".wasm") ? "application/wasm" : "text/javascript",
            headers: { "Access-Control-Allow-Origin": "*" },
        });
    });
    return { requests: () => requests };
}

export interface Mp4Track { handler: string; width: number; height: number }

/** Minimal ISO-BMFF reader: the mvhd duration, and per trak its hdlr type and tkhd size. */
export function readMp4Info(bytes: Buffer): { durationSeconds: number; tracks: Mp4Track[] } {
    type Box = { type: string; start: number; end: number };
    const children = (start: number, end: number): Box[] => {
        const boxes: Box[] = [];
        let offset = start;
        while (offset + 8 <= end) {
            let size = bytes.readUInt32BE(offset);
            const type = bytes.toString("latin1", offset + 4, offset + 8);
            let header = 8;
            if (size === 1) {
                size = Number(bytes.readBigUInt64BE(offset + 8));
                header = 16;
            } else if (size === 0) {
                size = end - offset;
            }
            if (size < header || offset + size > end) throw new Error(`Bad MP4 box ${type} at ${offset}`);
            boxes.push({ type, start: offset + header, end: offset + size });
            offset += size;
        }
        return boxes;
    };
    const find = (boxes: Box[], type: string): Box => {
        const box = boxes.find((b) => b.type === type);
        if (!box) throw new Error(`MP4 box ${type} missing`);
        return box;
    };
    const moov = find(children(0, bytes.length), "moov");
    const moovChildren = children(moov.start, moov.end);
    const mvhd = find(moovChildren, "mvhd");
    const v1 = bytes[mvhd.start] === 1;
    const timescale = bytes.readUInt32BE(mvhd.start + (v1 ? 20 : 12));
    const duration = v1 ? Number(bytes.readBigUInt64BE(mvhd.start + 24)) : bytes.readUInt32BE(mvhd.start + 16);
    const tracks = moovChildren.filter((b) => b.type === "trak").map((trak) => {
        const trakChildren = children(trak.start, trak.end);
        const tkhd = find(trakChildren, "tkhd");
        const mdia = find(trakChildren, "mdia");
        const hdlr = find(children(mdia.start, mdia.end), "hdlr");
        return {
            handler: bytes.toString("latin1", hdlr.start + 8, hdlr.start + 12),
            // width and height are the last 8 bytes of tkhd, 16.16 fixed point.
            width: bytes.readUInt32BE(tkhd.end - 8) / 65536,
            height: bytes.readUInt32BE(tkhd.end - 4) / 65536,
        };
    });
    return { durationSeconds: duration / timescale, tracks };
}
