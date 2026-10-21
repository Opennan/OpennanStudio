// compileExport: TimelineData + SceneData[] → one ffmpeg filter graph and its inputs. Pure: media facts
// (probe results) and text/emoji/sticker bitmaps are passed in.
import type { TimelineClip } from "@opennan/timeline-core";
import { graphicsUnsupportedReason } from "@opennan/timeline-core/graphics/render";
import { parseTimelineKeyframes } from "@opennan/timeline-core/lib/timeline-editing-properties";
import { LOOK_KEYFRAME_LIMIT, lookKeyframeTimes } from "@opennan/timeline-core/motion/look-keyframes";
import { buildAudioSources, sceneAudioUrl } from "../audio-model";
import { quantize, sec } from "../format";
import { collectGlLayers, planGlPasses } from "../gl";
import { FilterGraph } from "../graph";
import { DEFAULT_AUDIO_BITRATE_KBPS, DEFAULT_FPS, GIF_DEFAULT_FPS, RESOLUTION_BITRATE_KBPS, resolveGifFormat, resolveOutputFormat } from "../presets";
import { atlasCropFilter, checkTextAtlas, textAtlasPlan } from "../motion/text-atlas";
import { bundledStickerBox, emojiJobId, graphicsJobId, isBundledSticker, isEmojiSticker, isExportedText, stickerJobId, textJobId } from "../raster/jobs";
import {
    buildSceneLanes, placeScenes, playableClips, sceneImageUrl, sceneShotSequence, sceneVideoUrl, timelineDuration,
} from "../timeline-model";
import { ExportError, type ExportInput, type ExportPlan, type ExportSettings, type ExportWarning, type MediaInfo, type OutputFormat, type RasterResult } from "../types";
import { compileAudio } from "./audio";
import type { CompileContext } from "./context";
import { compileClipLane, planClipLanes, type ClipLane } from "./clip-lanes";
import { compileEffectSpan, effectSpans } from "./effect-spans";
import { compileGraphicsOverlay, graphicsClips } from "./graphics";
import { compileSceneLanes } from "./lanes";
import { compileOverlay, overlayReadSpan, overlaySeek, type OverlaySource } from "./overlays";
import { SLOW_WEB_EFFECT_SECONDS, slowWebEffectSeconds } from "./slow-web";

export { SLOW_WEB_EFFECT_SECONDS, slowWebEffectSeconds } from "./slow-web";

export interface CompileOptions {
    /** Probe results by media URL. Missing entries are unreadable media. */
    media: ReadonlyMap<string, MediaInfo>;
    /** Text, emoji, and sticker bitmaps by RasterJob.id (a missing bitmap leaves its clip out with `text-unsupported`). */
    rasters: ReadonlyMap<string, RasterResult>;
    /** False when the runner cannot run GL passes: effect layers become warnings. */
    gl: boolean;
    /** False on runners far slower than native ffmpeg (ffmpeg.wasm): long geq effects warn. Default true. */
    nativeSpeed?: boolean;
}

export interface StaticWarningOptions {
    gl: boolean;
    /** False on runners far slower than native ffmpeg (the web app's ffmpeg.wasm). Default true. */
    nativeSpeed?: boolean;
}

export function exportFormat(input: ExportInput, settings: ExportSettings): OutputFormat {
    const ratio = settings.aspectRatio ?? input.project.aspectRatio;
    if (settings.format === "gif") return resolveGifFormat(ratio, settings.resolution, settings.fps ?? GIF_DEFAULT_FPS);
    return resolveOutputFormat(ratio, settings.resolution, settings.fps ?? DEFAULT_FPS);
}

/** The export's length in seconds and output frames (compileExport and planGpuExport use the same numbers). */
export function exportLength(input: ExportInput, format: OutputFormat): { durationSeconds: number; frameCount: number } {
    const durationSeconds = quantize(timelineDuration(input.scenes, playableClips(input.clips, input.tracks)), format.fps);
    return { durationSeconds, frameCount: Math.round(durationSeconds * format.fps) };
}

/** Every media URL the export may read (probe these before compiling). */
export function collectMediaUrls(input: ExportInput): string[] {
    const urls = new Set<string>();
    const add = (url: string | null | undefined) => {
        if (url) urls.add(url);
    };
    for (const scene of input.scenes) {
        const shots = sceneShotSequence(scene);
        if (shots) shots.forEach((shot) => add(shot.url));
        else add(sceneVideoUrl(scene) ?? sceneImageUrl(scene));
        add(sceneAudioUrl(scene));
    }
    for (const clip of playableClips(input.clips, input.tracks)) {
        // Bundled stickers are drawn from the catalog's SVG, never read as media.
        if (clip.trackType === "video" || clip.trackType === "audio" || (clip.trackType === "sticker" && !isBundledSticker(clip))) add(clip.mediaUrl);
    }
    add(input.project.musicUrl);
    return [...urls];
}

/** Warnings known without probing (shown in the export dialog before starting). */
export function staticExportWarnings(input: ExportInput, options: StaticWarningOptions): ExportWarning[] {
    const warnings: ExportWarning[] = [];
    const clips = playableClips(input.clips, input.tracks);
    for (const clip of clips) {
        const graphics = graphicsUnsupportedReason(clip);
        if (graphics === "custom-code") {
            warnings.push({ code: "remotion-unsupported", message: "This graphic runs custom code, which needs the Remotion add-on to render; it is left out.", clipId: clip.id });
        } else if (graphics === "unknown-template") {
            warnings.push({ code: "remotion-unsupported", message: "This graphic's template is not in this version's template catalog; it is left out.", clipId: clip.id });
        } else if ((clip.trackType === "video" || clip.trackType === "audio") && !clip.mediaUrl) {
            warnings.push({ code: "media-missing", message: "Clip has no media yet; it is left out.", clipId: clip.id });
        } else if (clip.trackType === "sticker" && clip.stickerId && !isBundledSticker(clip) && !clip.mediaUrl && !clip.textContent) {
            warnings.push({ code: "media-missing", message: "This sticker is not in this version's sticker catalog; it is left out.", clipId: clip.id });
        }
    }
    // Adjust keyframes beyond the export's CLUT limit (motion/lut-keyframes.ts), known before probing.
    const tooManyLookKeyframes = (json: string | null | undefined) => Boolean(json) && lookKeyframeTimes(parseTimelineKeyframes(json)).length > LOOK_KEYFRAME_LIMIT;
    const limited = `Only the first ${LOOK_KEYFRAME_LIMIT} Adjust keyframes export; the look holds the last of them after it.`;
    for (const clip of clips) {
        if ((clip.trackType === "video" || clip.trackType === "sticker") && tooManyLookKeyframes(clip.keyframesJson)) warnings.push({ code: "look-keyframes-limited", message: limited, clipId: clip.id });
    }
    for (const scene of input.scenes) {
        if (tooManyLookKeyframes(scene.keyframesJson)) warnings.push({ code: "look-keyframes-limited", message: limited, sceneId: scene.id });
    }
    const layers = collectGlLayers(clips, placeScenes(input.scenes, input.tracks), input.effects ?? [], warnings);
    if (!options.gl) {
        for (const layer of layers) {
            warnings.push({
                code: "gl-effect-unsupported",
                message: "This export runner cannot render GL effects; the effect is left out. Export from the desktop app to include it.",
                clipId: layer.clipId,
                sceneId: layer.sceneId,
                effectId: layer.effects[0]?.id,
            });
        }
    }
    if (options.nativeSpeed === false) {
        const seconds = slowWebEffectSeconds(input);
        if (seconds > SLOW_WEB_EFFECT_SECONDS) {
            warnings.push({
                code: "slow-web-effect",
                message: `Animated effects cover about ${Math.round(seconds)} s of this video. The browser renders them slowly, so this export can take a long time; the desktop app exports them much faster.`,
            });
        }
    }
    return warnings;
}

function isStillUrl(clip: TimelineClip): boolean {
    return clip.mediaType === "image" || /\.(png|jpe?g|webp)(\?|#|$)/i.test(clip.mediaUrl ?? "");
}

export function isGifUrl(url: string): boolean {
    return /\.gif(\?|#|$)/i.test(url);
}

export function mediaOverlay(ctx: CompileContext, clip: TimelineClip): OverlaySource | null {
    const url = clip.mediaUrl;
    if (!url) return null;
    const info = ctx.media.get(url);
    if (!info || !info.hasVideo || info.width <= 0) {
        ctx.warnings.push({ code: "media-unreadable", message: "Clip media could not be read; it is left out.", clipId: clip.id });
        return null;
    }
    const duration = Math.max(0, clip.endTime - clip.startTime);
    const { fps, frameScale } = ctx.format;
    const still = isStillUrl(clip) && !isGifUrl(url);
    const options = still
        ? ["-loop", "1", "-framerate", String(fps), "-t", sec(duration)]
        // GIFs loop as their loop count says; -min_delay 1 pins the delay rule (only 0 plays as 10 cs), which FFmpeg 5.1
        // (wasm) and 7.1 (desktop) otherwise apply differently to 1 cs delays (gpu/gif.ts times frames the same way).
        : isGifUrl(url) ? ["-ignore_loop", "0", "-min_delay", "1", "-t", sec(overlayReadSpan(clip))] : [...overlaySeek(clip), "-t", sec(overlayReadSpan(clip))];
    const size = { width: info.width * frameScale, height: info.height * frameScale };
    return {
        clip, input: { kind: "media", source: url, options }, video: !still, text: false, outer: size, box: size, baseScale: 1,
        stream: { width: info.width, height: info.height },
    };
}

export type RasterKind = "text" | "emoji" | "sticker";

/** Bitmap size, anchoring box, decoded size, and atlas crop of a raster overlay, or null when the raster is unusable. */
export function rasterGeometry(ctx: CompileContext, clip: TimelineClip, raster: RasterResult, kind: RasterKind): Pick<OverlaySource, "outer" | "box" | "stream" | "atlasCrop"> | null {
    const box = { width: raster.boxWidth, height: raster.boxHeight };
    if (kind === "sticker") {
        // The sticker box at the bitmap's scale; a bitmap capped below it (MAX_STICKER_SIDE) is scaled up.
        const size = bundledStickerBox(clip.stickerId!, raster.scale, ctx.format)!;
        return { outer: size, box: size, stream: { width: raster.width, height: raster.height } };
    }
    const plan = kind === "text" && raster.atlas !== undefined ? textAtlasPlan(clip) : null;
    if (!plan) {
        // A bitmap the rasterizer capped (canvas-rasterizer.ts cappedSize) is smaller than its padded box: the
        // box is the layer, the bitmap the decoded stream that is scaled up to it.
        const padded = { width: Math.max(1, Math.ceil(raster.boxWidth + raster.pad * 2)), height: Math.max(1, Math.ceil(raster.boxHeight + raster.pad * 2)) };
        if (raster.width < padded.width && raster.height < padded.height) {
            return { outer: padded, box, stream: { width: raster.width, height: raster.height } };
        }
        return { outer: { width: raster.width, height: raster.height }, box };
    }
    // Atlas: each cell is the padded box (the rasterizer's ceil(box + 2·pad)), possibly shrunk to fit the grid.
    const atlas = checkTextAtlas(raster.atlas, raster.width, raster.height, plan.states.length);
    if (!atlas) return null;
    return {
        outer: { width: Math.max(1, Math.ceil(raster.boxWidth + raster.pad * 2)), height: Math.max(1, Math.ceil(raster.boxHeight + raster.pad * 2)) },
        box,
        stream: { width: atlas.cellWidth, height: atlas.cellHeight },
        atlasCrop: atlasCropFilter(plan, atlas),
    };
}

function rasterOverlay(ctx: CompileContext, clip: TimelineClip, jobId: string, kind: RasterKind, files: ExportPlan["files"]): OverlaySource | null {
    const raster = ctx.rasters.get(jobId);
    if (!raster) {
        ctx.warnings.push({
            code: "text-unsupported",
            message: "Text, emoji, and stickers need a canvas rasterizer, which this export host does not have; this clip is left out.",
            clipId: clip.id,
        });
        return null;
    }
    const geometry = rasterGeometry(ctx, clip, raster, kind);
    if (!geometry) {
        ctx.warnings.push({ code: "text-unsupported", message: "The text's animation bitmap does not match the clip; this clip is left out.", clipId: clip.id });
        return null;
    }
    const duration = Math.max(0, clip.endTime - clip.startTime);
    // The compiler names job files; clip ids come from project data and never reach a path.
    const name = `raster-${files.length}.png`;
    files.push({ name, data: raster.png });
    return {
        clip,
        input: { kind: "file", source: name, options: ["-loop", "1", "-framerate", String(ctx.format.fps), "-t", sec(duration)] },
        video: false,
        text: kind === "text",
        ...geometry,
        baseScale: raster.scale,
    };
}

export function compileExport(input: ExportInput, settings: ExportSettings, options: CompileOptions): ExportPlan {
    const format = exportFormat(input, settings);
    const clips = playableClips(input.clips, input.tracks);
    const placed = placeScenes(input.scenes, input.tracks);
    const duration = quantize(timelineDuration(input.scenes, clips), format.fps);
    if (duration < 1 / format.fps) throw new ExportError("empty-timeline", "The timeline is empty: add a clip before exporting.");

    const graph = new FilterGraph();
    const warnings = staticExportWarnings(input, { gl: options.gl, nativeSpeed: options.nativeSpeed });
    const files: ExportPlan["files"] = [];
    const ctx: CompileContext = { graph, format, duration, media: options.media, rasters: options.rasters, warnings, files, fileKeys: new Map() };

    let video = compileSceneLanes(ctx, buildSceneLanes(placed, format.fps));

    // Overlay video/image clips above every scene lane, lower tracks first (preview-panel.tsx:1028-1031).
    const overlayClips = clips
        .filter((clip) => clip.trackType === "video" && (clip.trackIndex ?? 2) >= 2 && clip.mediaUrl)
        .sort((a, b) => (a.trackIndex ?? 2) - (b.trackIndex ?? 2) || a.startTime - b.startTime);
    // Touching clips joined by library transitions compile as one transparent lane each (clip-lanes.ts), at the
    // position of their first clip; every other clip keeps its own overlay.
    const lanes = planClipLanes(ctx, overlayClips, (clip) => mediaOverlay(ctx, clip));
    const laneAt = new Map<string, ClipLane>(lanes.map((lane) => [lane.clips[0].source.clip.id, lane]));
    const inLane = new Set(lanes.flatMap((lane) => lane.clips.map((item) => item.source.clip.id)));
    for (const clip of overlayClips) {
        const lane = laneAt.get(clip.id);
        if (lane) video = compileClipLane(ctx, video, lane);
        if (inLane.has(clip.id)) continue;
        const source = mediaOverlay(ctx, clip);
        if (source) video = compileOverlay(ctx, video, source);
    }

    // Built-in graphics in track order, above video and below text (the preview's graphics layer).
    for (const clip of graphicsClips(clips)) video = compileGraphicsOverlay(ctx, video, clip, ctx.rasters.get(graphicsJobId(clip.id)));

    // Text and stickers in clip order, above video (preview-panel.tsx:1024-1026, 1223-1420).
    for (const clip of clips) {
        let source: OverlaySource | null = null;
        if (isExportedText(clip)) source = rasterOverlay(ctx, clip, textJobId(clip.id), "text", files);
        else if (isBundledSticker(clip)) source = rasterOverlay(ctx, clip, stickerJobId(clip.id), "sticker", files);
        else if (isEmojiSticker(clip)) source = rasterOverlay(ctx, clip, emojiJobId(clip.id), "emoji", files);
        else if (clip.trackType === "sticker" && clip.mediaUrl) source = mediaOverlay(ctx, clip);
        if (source) video = compileOverlay(ctx, video, source);
    }
    // Effect-track spans with built-in effects run on the composite below them (preview: effect-layer-overlay).
    for (const span of effectSpans(clips)) video = compileEffectSpan(ctx, video, span);
    video = graph.chain([video], ["format=yuv420p"], "vout");

    const audio = compileAudio(ctx, buildAudioSources({
        placed, tracks: input.tracks, clips, musicUrl: input.project.musicUrl, musicVolume: input.project.musicVolume, duration, fps: format.fps,
    }));

    const glPasses = options.gl ? planGlPasses(collectGlLayers(clips, placed, input.effects ?? [], []), duration) : [];

    return {
        format,
        durationSeconds: duration,
        inputs: graph.inputs,
        filterGraph: graph.toString(),
        videoLabel: video,
        audioLabel: audio,
        files,
        glPasses,
        warnings: dedupeWarnings(warnings),
        videoBitrateKbps: settings.videoBitrateKbps ?? RESOLUTION_BITRATE_KBPS[settings.resolution],
        audioBitrateKbps: settings.audioBitrateKbps ?? DEFAULT_AUDIO_BITRATE_KBPS,
    };
}

function dedupeWarnings(warnings: ExportWarning[]): ExportWarning[] {
    const seen = new Set<string>();
    return warnings.filter((w) => {
        const key = `${w.code}|${w.clipId ?? ""}|${w.sceneId ?? ""}|${w.effectId ?? ""}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}
