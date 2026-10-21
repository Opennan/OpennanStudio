// State shared by the compile steps.
import type { FilterGraph } from "../graph";
import type { ExportPlan, ExportWarning, MediaInfo, OutputFormat, RasterResult } from "../types";

export interface CompileContext {
    graph: FilterGraph;
    format: OutputFormat;
    /** Whole frames at format.fps. */
    duration: number;
    media: ReadonlyMap<string, MediaInfo>;
    rasters: ReadonlyMap<string, RasterResult>;
    warnings: ExportWarning[];
    /** Job files the graph reads (raster PNGs, look CLUTs, masks); named by the compiler, never from project data. */
    files: ExportPlan["files"];
    /** File names by content key, so identical generated images are written once. */
    fileKeys: Map<string, string>;
}

/** Adds (or reuses) a generated job file and returns its name. */
export function addFile(ctx: CompileContext, key: string, prefix: string, make: () => Uint8Array): string {
    const existing = ctx.fileKeys.get(key);
    if (existing) return existing;
    const name = `${prefix}-${ctx.files.length}.png`;
    ctx.files.push({ name, data: make() });
    ctx.fileKeys.set(key, name);
    return name;
}
