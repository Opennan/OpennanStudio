// The GPU export path (phase 10c): probe (mediabunny) → rasterize text/stickers (the ffmpeg path's rasterizer) →
// per-frame draw lists (plan.ts) → WebGL2 compositor (the preview's LookRenderer) → WebCodecs encoder → the
// runner's mux with the export's own audio graph. Anything it cannot do (support.ts, no WebGL2, no encoder, a codec
// WebCodecs cannot decode, a failure before the mux) returns a fallback reason and exportTimeline runs ffmpeg.
import { GRAPHICS_FONT_FACES } from "@opennan/timeline-core/graphics/draw/helpers";
import { graphicsAssetUrls } from "@opennan/timeline-core/graphics/render";
import type { GraphicsContext } from "@opennan/timeline-core/graphics/types";
import type { TextFontFace } from "@opennan/timeline-core/text/fonts";
import type { LookRenderer } from "@opennan/timeline-media/looks/look-renderer";
import { checkAborted, untilAborted } from "../abort";
import { collectMediaUrls, exportFormat, staticExportWarnings } from "../compile";
import { compileMux } from "../compile/mux";
import { containerMimeType } from "../encoders";
import type { ExportProgress, ExportResult, ExportTimelineOptions } from "../export-timeline";
import { collectGlLayers, type GlFrameProcessor } from "../gl";
import { RESOLUTION_BITRATE_KBPS } from "../presets";
import { drawGraphicsEntry, type GraphicsCanvasPair } from "../raster/graphics-frame";
import { planRasterJobs } from "../raster/jobs";
import { placeScenes, playableClips } from "../timeline-model";
import { ExportError, type ExportInput, type ExportSettings, type ExportWarning, type RasterResult } from "../types";
import { GpuCompositor } from "./compositor";
import { chooseGpuCodec, createGpuEncoder, type GpuCodecChoice, type GpuEncoder, type GpuVideoSink } from "./encode";
import { GpuMedia } from "./media";
import { planGpuExport } from "./plan";
import { gpuExportSupport } from "./support";
import { exportTimelineGpuInWorker, type GpuWorkerHost } from "./worker/client";

type Mediabunny = typeof import("mediabunny");
type VideoCodec = import("mediabunny").VideoCodec;

export interface GpuExportOptions {
    /** mediabunny (a dynamic import in hosts, so it stays out of the first bundle). */
    loadMediabunny(): Promise<Mediabunny>;
    /** A mediabunny Source for a media URL: ranged reads, auth headers for the host's own origin only. */
    createSource(url: string, mediabunny: Mediabunny): import("mediabunny").Source | Promise<import("mediabunny").Source>;
    /** Bytes of a still image. */
    fetchBlob(url: string, signal?: AbortSignal): Promise<Blob>;
    /** A WebGL2 LookRenderer on its own canvas, or null when WebGL2 is unavailable. Disposed after the export. */
    createRenderer(): LookRenderer | null;
    /** Cheap WebGL2 check for the dialog (no renderer is created). Default: true. */
    isAvailable?(): boolean;
    /** Runs legacy catalog (GLSL) effects on the composite. */
    glProcessor?: GlFrameProcessor;
    /** Stream the encoded video to the host (desktop: chunks to main; web: a file in the origin private file system). */
    createVideoSink?(container: "mp4" | "webm"): GpuVideoSink | Promise<GpuVideoSink>;
    /**
     * Run the export in a worker (phase 10d, web): the page keeps the UI, text bitmaps, and the ffmpeg.wasm mux. When
     * the worker cannot run here (no WebGL2 on OffscreenCanvas, no WebCodecs in workers, the script failed to load),
     * the page runs the GPU path itself.
     */
    worker?: GpuWorkerHost;
    /** Codec preference. Default avc, vp9, av1, vp8. */
    codecs?: VideoCodec[];
    /** A 2D canvas for graphics frames. Default `new OffscreenCanvas(width, height)`. */
    createCanvas?(width: number, height: number): OffscreenCanvas | HTMLCanvasElement;
    /** Loads bundled font faces before graphics draw (default: the document's or worker's FontFaceSet). */
    loadFonts?(faces: TextFontFace[]): Promise<void>;
}

/** Loads bundled faces through the document's (or a worker's) FontFaceSet; failures draw with fallback fonts. */
async function defaultLoadFonts(faces: TextFontFace[]): Promise<void> {
    const set = (globalThis as { document?: { fonts?: FontFaceSet }; fonts?: FontFaceSet }).document?.fonts ?? (globalThis as { fonts?: FontFaceSet }).fonts;
    if (!set) return;
    await Promise.allSettled(faces.map((face) => set.load(`${face.style} ${face.weight} 32px "${face.family}"`)));
}

export type GpuExportOutcome = { kind: "done"; result: ExportResult } | { kind: "fallback"; reason: string };

export type GpuReadiness = { ok: true; choice: GpuCodecChoice } | { ok: false; reason: string };

/**
 * Whether the GPU path will take this export, as far as can be told without reading media (the Export dialog's
 * engine line): the project's features, WebGL2, and a WebCodecs encoder. A codec WebCodecs cannot decode is only
 * found when the export probes, and then falls back.
 */
/**
 * Bitrate of a GIF's intermediate video (phase 10d): far above what its small frames need, so the WebCodecs encode
 * (quality mode, no dropped frames) adds next to nothing before the palette step.
 */
export const GIF_INTERMEDIATE_KBPS = 12000;

const videoBitrate = (settings: ExportSettings) =>
    settings.format === "gif" ? GIF_INTERMEDIATE_KBPS : settings.videoBitrateKbps ?? RESOLUTION_BITRATE_KBPS[settings.resolution];

export async function gpuExportReadiness(input: ExportInput, settings: ExportSettings, gpu: GpuExportOptions): Promise<GpuReadiness> {
    if (gpu.isAvailable && !gpu.isAvailable()) return { ok: false, reason: "WebGL2 is not available" };
    const support = gpuExportSupport(input, { gl: Boolean(gpu.glProcessor) });
    if (!support.ok) return { ok: false, reason: support.reasons[0].message };
    try {
        const mb = await gpu.loadMediabunny();
        const format = exportFormat(input, settings);
        const choice = await chooseGpuCodec(mb, format, videoBitrate(settings), gpu.codecs);
        return choice ? { ok: true, choice } : { ok: false, reason: "this browser has no WebCodecs video encoder" };
    } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
}

/** Progress every this many ms at most (the UI re-renders on each). */
const PROGRESS_INTERVAL_MS = 250;

export async function exportTimelineGpu(input: ExportInput, settings: ExportSettings, options: ExportTimelineOptions & { gpu: GpuExportOptions }): Promise<GpuExportOutcome> {
    const lastStep = settings.format === "gif" ? options.runner.gif : options.runner.mux;
    // Catalog GLSL effects run on the page's GL processor: projects with them render on the page.
    const needsPageGl = Boolean(options.gpu.glProcessor) && collectGlLayers(playableClips(input.clips, input.tracks), placeScenes(input.scenes, input.tracks), input.effects ?? [], []).length > 0;
    if (options.gpu.worker && lastStep && !needsPageGl && gpuExportSupport(input, { gl: Boolean(options.gpu.glProcessor) }).ok) {
        const outcome = await exportTimelineGpuInWorker(input, settings, options, options.gpu.worker);
        if (outcome.kind !== "unavailable") return outcome;
        checkAborted(options.signal);
    }
    const { runner, signal } = options;
    const gpu: GpuExportOptions = { ...options.gpu, worker: undefined };
    const fallback = (reason: string): GpuExportOutcome => ({ kind: "fallback", reason });
    const gif = settings.format === "gif";
    if (gif && !runner.gif) return fallback("this export runner cannot make a GIF from a GPU-encoded video");
    if (!gif && !runner.mux) return fallback("this export runner cannot add audio to a GPU-encoded video");
    const support = gpuExportSupport(input, { gl: Boolean(gpu.glProcessor) });
    if (!support.ok) return fallback(support.reasons[0].message);
    const report = (progress: ExportProgress) => options.onProgress?.({ ...progress, engine: "gpu" });
    let renderer: LookRenderer | null = null;
    let media: GpuMedia | null = null;
    let encoder: GpuEncoder | null = null;
    const bitmaps = new Map<string, Promise<ImageBitmap | null>>();
    const graphicsSlots = new Map<string, GraphicsSlot>();
    let sink: GpuVideoSink | undefined;
    const graphicsImages = new Map<string, ImageBitmap | null>();
    let muxing = false;
    try {
        renderer = gpu.createRenderer();
        if (!renderer) return fallback("WebGL2 is not available");
        const mb = await gpu.loadMediabunny();
        const format = exportFormat(input, settings);
        const bitrate = videoBitrate(settings);
        const choice = await chooseGpuCodec(mb, format, bitrate, gpu.codecs);
        if (!choice) return fallback("this browser has no WebCodecs video encoder");

        report({ phase: "probe", ratio: 0 });
        media = new GpuMedia({ mediabunny: mb, createSource: (url) => gpu.createSource(url, mb), fetchBlob: gpu.fetchBlob });
        const urls = collectMediaUrls(input);
        const probed = await untilAborted(media.probe(urls, signal), signal);
        checkAborted(signal);
        // A file this browser cannot open would silently leave the export (its audio too): ffmpeg may read it.
        const missing = urls.filter((url) => !probed.has(url));
        if (missing.length > 0) return fallback(`a media file could not be read here (${missing.length === 1 ? "1 file" : `${missing.length} files`})`);
        for (const info of probed.values()) {
            if (info.hasVideo && !info.still && !info.decodable) return fallback("a video in this project uses a codec this browser cannot decode");
        }

        const rasters = new Map<string, RasterResult>();
        if (options.rasterizer) {
            const jobs = planRasterJobs(playableClips(input.clips, input.tracks), format);
            for (const [i, job] of jobs.entries()) {
                report({ phase: "raster", ratio: i / Math.max(1, jobs.length) });
                rasters.set(job.id, await untilAborted(options.rasterizer.rasterize(job), signal));
                checkAborted(signal);
            }
        }

        const plan = planGpuExport(input, format, { media: probed, rasters, gl: Boolean(gpu.glProcessor) });
        // A GIF has no audio: the intermediate goes to the runner's GIF step instead of the audio mux.
        const mux = gif ? null : compileMux(input, settings, { media: probed });
        const warnings: ExportWarning[] = dedupe([
            ...staticExportWarnings(input, { gl: Boolean(gpu.glProcessor), nativeSpeed: true }),
            ...plan.warnings,
            ...(mux?.warnings ?? []),
        ]);
        const raster = (id: string) => {
            let entry = bitmaps.get(id);
            if (!entry) {
                const result = rasters.get(id);
                entry = result ? media!.raster(result.png).catch(() => null) : Promise.resolve(null);
                bitmaps.set(id, entry);
            }
            return entry;
        };
        // Built-in graphics: one canvas pair per live clip, redrawn only when its picture changes.
        if (plan.graphics.length > 0) await (gpu.loadFonts ?? defaultLoadFonts)([...GRAPHICS_FONT_FACES]).catch(() => undefined);
        for (const { clipId, clip } of plan.graphics) {
            for (const url of graphicsAssetUrls({ remotionTemplateId: clip.templateId, remotionPropsJson: clip.propsJson })) {
                if (!graphicsImages.has(url)) {
                    graphicsImages.set(url, await gpu.fetchBlob(url, signal).then((blob) => createImageBitmap(blob)).catch(() => null));
                    checkAborted(signal);
                }
                // As the ffmpeg path: the graphic draws without an image that cannot be read here, and says so.
                if (!graphicsImages.get(url)) {
                    warnings.push({ code: "graphics-asset-missing", message: "This graphic's image could not be loaded here; the graphic is exported without it.", clipId });
                }
            }
        }
        const graphicsAssets = { image: (url: string) => graphicsImages.get(url) ?? null };
        const newCanvas = gpu.createCanvas ?? ((w: number, h: number) => new OffscreenCanvas(w, h));
        const compositor = new GpuCompositor(renderer, format, {
            frame: async (read, index) => {
                const decoded = await media!.frame(read, index);
                if (!decoded) return null;
                const frame = await withColorSpace(decoded.sample.toVideoFrame(), decoded.colorSpace);
                return { source: frame, width: frame.displayWidth, height: frame.displayHeight, rotation: decoded.rotation, close: () => frame.close() };
            },
            image: (url) => media!.image(url, signal),
            raster,
            graphics: async (op) => {
                let slot = graphicsSlots.get(op.clipId);
                if (!slot) {
                    const layer = newCanvas(format.width, format.height);
                    const out = newCanvas(format.width, format.height);
                    const pair: GraphicsCanvasPair = {
                        width: format.width, height: format.height, layer,
                        layerContext: layer.getContext("2d") as unknown as GraphicsContext, out: out.getContext("2d") as unknown as GraphicsContext,
                    };
                    slot = { pair, out, layer, key: null };
                    graphicsSlots.set(op.clipId, slot);
                }
                if (slot.key !== op.key) {
                    drawGraphicsEntry(slot.pair, op.clip, op.entry, graphicsAssets);
                    slot.key = op.key;
                }
                return { source: slot.out, width: format.width, height: format.height };
            },
        }, gpu.glProcessor);
        sink = await gpu.createVideoSink?.(choice.container);
        encoder = await createGpuEncoder(mb, { canvas: renderer.canvas, choice, fps: format.fps, bitrateKbps: bitrate, sink });

        // Decoders and images close after the last frame that uses them.
        const streamLast = new Map<string, number>();
        for (const { read, last } of plan.reads) streamLast.set(read.stream, Math.max(streamLast.get(read.stream) ?? -1, last));
        const closing = new Map<number, Array<() => Promise<void>>>();
        const at = (k: number, task: () => Promise<void>) => closing.set(k, [...(closing.get(k) ?? []), task]);
        for (const [stream, last] of streamLast) at(last, () => media!.closeStream(stream));
        for (const { url, last } of plan.images) at(last, () => media!.closeImage(url));
        for (const { clipId, last } of plan.graphics) {
            at(last, async () => {
                const slot = graphicsSlots.get(clipId);
                graphicsSlots.delete(clipId);
                if (slot) releaseCanvases(slot);
            });
        }
        for (const { id, last } of plan.rasters) {
            at(last, async () => {
                const entry = bitmaps.get(id);
                bitmaps.delete(id);
                rasters.delete(id);
                (await entry?.catch(() => null))?.close();
            });
        }

        const started = performance.now();
        let lastReport = 0;
        for (let k = 0; k < plan.frameCount; k += 1) {
            checkAborted(signal);
            await untilAborted(compositor.render(plan.drawList(k)), signal);
            // A lost context draws nothing: never encode the blank canvas.
            if (renderer.isLost) throw new Error("the WebGL context was lost");
            await untilAborted(encoder.add(k), signal);
            for (const task of closing.get(k) ?? []) await task();
            const now = performance.now();
            if (now - lastReport >= PROGRESS_INTERVAL_MS || k === plan.frameCount - 1) {
                lastReport = now;
                const ratio = (k + 1) / plan.frameCount;
                const elapsed = (now - started) / 1000;
                report({ phase: "render", ratio, etaSeconds: ratio > 0.01 ? (elapsed / ratio) * (1 - ratio) : undefined });
            }
        }
        const video = await untilAborted(encoder.finish(), signal);
        encoder = null;
        checkAborted(signal);

        muxing = true;
        if (!mux) {
            report({ phase: "gif", ratio: 0 });
            const output = await runner.gif!({ format, durationSeconds: plan.durationSeconds }, video, { container: choice.container, signal, onProgress: (ratio) => report({ phase: "gif", ratio }) });
            checkAborted(signal);
            return {
                kind: "done",
                result: {
                    output, container: "gif", mimeType: containerMimeType("gif"), encoder: `gif (${choice.name})`,
                    durationSeconds: plan.durationSeconds, width: format.width, height: format.height, warnings, engine: "gpu",
                },
            };
        }
        report({ phase: "mux", ratio: 0 });
        const output = await runner.mux!(mux, video, { container: choice.container, signal, onProgress: (ratio) => report({ phase: "mux", ratio }) });
        checkAborted(signal);
        return {
            kind: "done",
            result: {
                output, container: choice.container, mimeType: containerMimeType(choice.container), encoder: choice.name,
                durationSeconds: plan.durationSeconds, width: format.width, height: format.height, warnings, engine: "gpu",
            },
        };
    } catch (error) {
        if (signal?.aborted || (error instanceof ExportError && error.code === "cancelled")) throw new ExportError("cancelled", "Export cancelled.");
        // A mux that ffmpeg refuses may be about the WebCodecs stream itself: the ffmpeg path renders its own. Any
        // other mux failure (media unreadable, too large) would fail the ffmpeg path the same way.
        if (muxing && !(error instanceof ExportError && error.code === "ffmpeg-failed")) throw error;
        return fallback(`the fast export stopped (${error instanceof Error ? error.message : String(error)})`);
    } finally {
        await encoder?.cancel().catch(() => undefined);
        // The encoded video was only an intermediate (the mux wrote the export): free it (e.g. its OPFS file).
        await sink?.release?.().catch(() => undefined);
        for (const entry of bitmaps.values()) (await entry.catch(() => null))?.close();
        for (const slot of graphicsSlots.values()) releaseCanvases(slot);
        graphicsSlots.clear();
        for (const image of graphicsImages.values()) image?.close();
        await media?.dispose().catch(() => undefined);
        renderer?.dispose();
    }
}

interface GraphicsSlot {
    pair: GraphicsCanvasPair;
    layer: OffscreenCanvas | HTMLCanvasElement;
    out: OffscreenCanvas | HTMLCanvasElement;
    key: string | null;
}

/** Frees a graphics clip's canvases (a zero-size canvas drops its backing store). */
function releaseCanvases(slot: GraphicsSlot): void {
    for (const canvas of [slot.layer, slot.out]) {
        canvas.width = 0;
        canvas.height = 0;
    }
}

/**
 * `frame` re-wrapped with `colorSpace` (the planes copied once), so the browser converts YUV to RGB as ffmpeg does
 * for files without a colour matrix; the frame itself when no override is needed or possible.
 */
export async function withColorSpace(frame: VideoFrame, colorSpace: VideoColorSpaceInit | null): Promise<VideoFrame> {
    if (!colorSpace || !frame.format || frame.format.startsWith("RGB") || frame.format.startsWith("BGR")) return frame;
    try {
        const rect = frame.visibleRect!;
        const data = new Uint8Array(frame.allocationSize());
        const layout = await frame.copyTo(data);
        const fixed = new VideoFrame(data, {
            format: frame.format, codedWidth: rect.width, codedHeight: rect.height, displayWidth: frame.displayWidth, displayHeight: frame.displayHeight,
            timestamp: frame.timestamp, layout, colorSpace,
        });
        frame.close();
        return fixed;
    } catch {
        return frame;
    }
}

function dedupe(warnings: ExportWarning[]): ExportWarning[] {
    const seen = new Set<string>();
    return warnings.filter((w) => {
        const key = `${w.code}|${w.clipId ?? ""}|${w.sceneId ?? ""}|${w.effectId ?? ""}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}
