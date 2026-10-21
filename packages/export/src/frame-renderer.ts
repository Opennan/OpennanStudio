// Single frames for the read API (spec §5.1.1 previewFrame): the same compile as a full export, one PNG
// out. Structurally a timeline-core FrameRenderer (phase 5), so hosts pass it to the controller as is.
// GL effects are not applied to these frames. Agents reach this through previewFrame (phase 5): the
// runner's source policy (node runner, Task 17a) decides which media it may open; hosts must not widen
// it for agent-triggered renders.
import { untilAborted } from "./abort";
import type { EffectDef, ProjectMeta, SceneData, TimelineClip, TimelineTrack } from "@opennan/timeline-core";
import { collectMediaUrls, compileExport, exportFormat, exportLength } from "./compile";
import { parseAspectRatio } from "./presets";
import type { OverlayRasterizer } from "./raster/canvas-rasterizer";
import { planGraphicsJobs, planRasterJobs } from "./raster/jobs";
import type { ExportRunner } from "./runner";
import { playableClips } from "./timeline-model";
import { ExportError, type ExportInput, type RasterResult } from "./types";

/** The parts of a controller snapshot a frame needs (ControllerSnapshot satisfies it). */
export interface FrameSnapshot {
    project: Pick<ProjectMeta, "aspectRatio" | "musicUrl" | "musicVolume"> | null;
    tracks: TimelineTrack[];
    clips: TimelineClip[];
    scenes: SceneData[];
}

export interface ExportFrameRequest {
    snapshot: FrameSnapshot;
    seconds: number;
    width?: number;
    height?: number;
    signal?: AbortSignal;
}

export interface ExportFrame {
    mimeType: "image/png";
    data: Uint8Array;
    width: number;
    height: number;
}

export interface ExportFrameRendererOptions {
    runner: ExportRunner;
    /** Optional: without one, text and emoji are left out of the frame (`text-unsupported`). */
    rasterizer?: OverlayRasterizer;
    /** GL effect catalog; frames skip GL passes but keep the rest of the composite. */
    effects?: () => EffectDef[] | Promise<EffectDef[]>;
}

/** Longest side of a single frame: the 4K export's long edge. Agent-chosen sizes never exceed it. */
export const MAX_FRAME_SIDE = 3840;

/**
 * Output size: both sides given → as is; one side → the other from the project ratio; none → the 720p frame.
 * Sizes come from agents (previewFrame), so a side that is not a finite positive number is rejected and a
 * frame whose longest side exceeds MAX_FRAME_SIDE is scaled down to it, keeping its ratio.
 */
export function frameSize(aspectRatio: string | null | undefined, width?: number, height?: number): { width: number; height: number } | null {
    for (const side of [width, height]) {
        if (side !== undefined && !(Number.isFinite(side) && side > 0)) {
            throw new ExportError("resolution-unsupported", `Frame sides must be finite positive numbers (got ${side}).`);
        }
    }
    const ratio = parseAspectRatio(aspectRatio);
    let w: number;
    let h: number;
    if (width !== undefined && height !== undefined) [w, h] = [width, height];
    else if (width !== undefined) [w, h] = [width, width / ratio];
    else if (height !== undefined) [w, h] = [height * ratio, height];
    else return null;
    const scale = Math.min(1, MAX_FRAME_SIDE / Math.max(w, h));
    const even = (value: number) => Math.min(MAX_FRAME_SIDE, Math.max(2, Math.round(value / 2) * 2));
    return { width: even(w * scale), height: even(h * scale) };
}

export function createExportFrameRenderer(options: ExportFrameRendererOptions) {
    return {
        async renderFrame(request: ExportFrameRequest): Promise<ExportFrame> {
            if (!options.runner.renderFrame) throw new ExportError("no-encoder", "This export runner cannot render single frames.");
            const size = frameSize(request.snapshot.project?.aspectRatio ?? "16:9", request.width, request.height);
            const input: ExportInput = {
                project: {
                    aspectRatio: request.snapshot.project?.aspectRatio ?? "16:9",
                    musicUrl: request.snapshot.project?.musicUrl ?? null,
                    musicVolume: request.snapshot.project?.musicVolume ?? 1,
                },
                tracks: request.snapshot.tracks,
                clips: request.snapshot.clips,
                scenes: request.snapshot.scenes,
                effects: options.effects ? await options.effects() : [],
            };
            const settings = { resolution: "720p" as const };
            const media = await options.runner.probe(collectMediaUrls(input), request.signal);
            const rasters = new Map<string, RasterResult>();
            const { rasterizer } = options;
            if (rasterizer) {
                const format = exportFormat(input, settings);
                const clips = playableClips(input.clips, input.tracks);
                const { frameCount } = exportLength(input, format);
                // Graphics: only the frames around the requested one (a sequence of the whole clip would be wasted).
                const k = Math.max(0, Math.min(frameCount - 1, Math.round(Math.max(0, request.seconds) * format.fps)));
                const window = { first: Math.max(0, k - 1), last: k + 1 };
                for (const job of [...planRasterJobs(clips, format), ...planGraphicsJobs(clips, format, frameCount, window)]) {
                    rasters.set(job.id, await untilAborted(rasterizer.rasterize(job), request.signal));
                }
            }
            const plan = compileExport(input, settings, { media, rasters, gl: false });
            const seconds = Math.max(0, Math.min(request.seconds, plan.durationSeconds - 1 / plan.format.fps));
            const data = await options.runner.renderFrame(plan, seconds, { size: size ?? undefined, signal: request.signal });
            return { mimeType: "image/png", data, width: size?.width ?? plan.format.width, height: size?.height ?? plan.format.height };
        },
    };
}
