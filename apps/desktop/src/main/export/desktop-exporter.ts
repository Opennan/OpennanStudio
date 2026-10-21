// Native export in the main process (spec §7.2): @opennan/export's node runner on the bundled LGPL ffmpeg,
// wrapped by @opennan/mcp's createStudioExporter so the Export button, assemble_video, get_export_status,
// and preview_timeline_frame share one pipeline and one "export already running" rule. Media is read only
// from the media library (no network, no other schemes); text bitmaps and GL frames are drawn by the
// renderer over MessageChannelMain ports (createRemoteRasterizer / createRemoteGlFrameProcessor).
import fs from "node:fs";
import path from "node:path";
import {
    createRemoteGlFrameProcessor, createRemoteRasterizer, type BridgePort, type ExportRunner, type ExportSessionState, type GlFrameProcessor, type OverlayRasterizer,
} from "@opennan/export";
import { createNodeRunner } from "@opennan/export/node";
import { createStudioExporter, type StudioExporter } from "@opennan/mcp";
import type { EffectDef } from "@opennan/timeline-core";
import { localMediaId } from "../../shared/media-policy";
import type { MediaStore } from "../store/media-store";
import type { FfmpegPaths } from "./ffmpeg-paths";

export const FFMPEG_MISSING = "Export needs the bundled ffmpeg, which is missing from this build.";

/** The part of Electron's MessagePortMain the bridge uses. */
export interface MainPortLike {
    on(event: "message", listener: (event: { data: unknown }) => void): unknown;
    off(event: "message", listener: (event: { data: unknown }) => void): unknown;
    postMessage(message: unknown): void;
    start(): void;
    close(): void;
}

/** BridgePort over MessagePortMain. Its postMessage transfers ports only, so ArrayBuffer transfer lists are dropped (copied instead). */
export function adaptPort(port: MainPortLike): BridgePort {
    return {
        postMessage: (message) => port.postMessage(message),
        addEventListener: (_type, listener) => void port.on("message", listener),
        removeEventListener: (_type, listener) => void port.off("message", listener),
        start: () => port.start(),
    };
}

/** "Beach trip!" -> "beach-trip"; at most 60 characters; "export" when nothing is left. */
export function slug(name: string | null | undefined): string {
    const cleaned = (name ?? "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60).replace(/-+$/, "");
    return cleaned || "export";
}

const pad = (value: number) => String(value).padStart(2, "0");

/** <dir>/<base>-<yyyymmdd-hhmmss>.<ext>, never an existing file. */
export function uniquePath(dir: string, base: string, ext: string, now = new Date()): string {
    const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    for (let n = 1; ; n += 1) {
        const file = path.join(dir, `${base}-${stamp}${n > 1 ? `-${n}` : ""}.${ext}`);
        if (!fs.existsSync(file)) return file;
    }
}

export interface DesktopExporterOptions {
    ffmpeg: FfmpegPaths | null;
    mediaStore: Pick<MediaStore, "pathOf" | "root">;
    exportsDir: string;
    /** GL effect catalog: the attached session's listEffects("effect"), else []. */
    effects?(): Promise<EffectDef[]>;
    /** True while the editor's GPU export runs (gpu-jobs.ts): main's own exports refuse meanwhile. */
    busy?(): boolean;
}

export interface DesktopExporter {
    exporter: StudioExporter;
    available: boolean;
    /** The node runner (the GPU jobs' audio mux); null without ffmpeg. */
    runner: ExportRunner | null;
    attachRendererPorts(raster: MainPortLike, gl: MainPortLike): void;
    detachRenderer(): void;
    /** The project name the next export's file is named after. */
    setTarget(projectName: string | null | undefined): void;
}

function unavailableExporter(): StudioExporter {
    const idle: ExportSessionState = { status: "idle" };
    return {
        onExport: async () => ({ error: FFMPEG_MISSING }),
        frameRenderer: { renderFrame: async () => { throw new Error(FFMPEG_MISSING); } },
        status: () => null,
        settled: async () => null,
        cancel: () => undefined,
        getState: () => idle,
        isBusy: () => false,
        subscribe: () => () => undefined,
        reset: () => undefined,
    };
}

export function createDesktopExporter(options: DesktopExporterOptions): DesktopExporter {
    let target = "export";
    let raster: { port: MainPortLike; rasterizer: OverlayRasterizer & { close(): void } } | null = null;
    let gl: { port: MainPortLike; processor: GlFrameProcessor } | null = null;
    const detachRenderer = () => {
        raster?.rasterizer.close();
        gl?.processor.dispose?.();
        raster?.port.close();
        gl?.port.close();
        raster = null;
        gl = null;
    };
    const base = {
        attachRendererPorts(rasterPort: MainPortLike, glPort: MainPortLike) {
            detachRenderer();
            raster = { port: rasterPort, rasterizer: createRemoteRasterizer(adaptPort(rasterPort)) };
            gl = { port: glPort, processor: createRemoteGlFrameProcessor(adaptPort(glPort)) };
        },
        detachRenderer,
        setTarget(projectName: string | null | undefined) {
            target = slug(projectName);
        },
    };
    if (!options.ffmpeg) return { ...base, exporter: unavailableExporter(), available: false, runner: null };

    const runner = createNodeRunner({
        ffmpegPath: options.ffmpeg.ffmpegPath,
        ffprobePath: options.ffmpeg.ffprobePath,
        mediaRoots: [options.mediaStore.root],
        resolveSource: (url) => {
            const id = localMediaId(url);
            return id ? options.mediaStore.pathOf(id) : null;
        },
        outputPath: (container) => {
            fs.mkdirSync(options.exportsDir, { recursive: true });
            return uniquePath(options.exportsDir, target, container);
        },
    });
    const rasterizer: OverlayRasterizer = {
        rasterize: (job) => {
            if (!raster) throw new Error("The editor window is not available to draw text");
            return raster.rasterizer.rasterize(job);
        },
    };
    const glProcessor: GlFrameProcessor = {
        process: (frame, effects) => {
            if (!gl) throw new Error("The editor window is not available to draw effects");
            return gl.processor.process(frame, effects);
        },
    };
    const exporter = createStudioExporter({ runner, rasterizer, glProcessor, effects: options.effects ?? (async () => []), busy: options.busy });
    return { ...base, exporter, available: true, runner };
}
