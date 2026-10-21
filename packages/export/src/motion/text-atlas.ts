// Text raster states in the export (phase 10b): a text clip whose animation changes its pixels (typewriter,
// wipe, blur, glow, letters, karaoke) is drawn once per state into a grid atlas PNG; the overlay chain
// picks the current state's cell per frame with `crop`, whose x/y evaluate per frame. The state index is
// the same IR expression the preview evaluates (timeline-core text/text-states.ts).
import type { TimelineClip } from "@opennan/timeline-core";
import { emitFfmpeg } from "@opennan/timeline-core/looks/expr";
import { atlasCellExpr, textStatePlan, type TextStatePlan } from "@opennan/timeline-core/text/text-states";
import type { TextAtlas } from "../types";

/**
 * Largest atlas side in px. Keeps the canvas within every browser's limit (Safari caps a canvas at
 * 16.7 M px, 4096²) and the decoded RGBA frame within ffmpeg.wasm's memory; larger grids shrink.
 */
export const MAX_ATLAS_SIDE = 4096;

/** The clip's raster state plan when it has more than one state, else null (one bitmap, as before 10b). */
export function textAtlasPlan(
    clip: Pick<TimelineClip, "textContent" | "textStyle" | "animationJson" | "captionWordsJson" | "startTime" | "endTime">,
): TextStatePlan | null {
    const plan = textStatePlan(clip);
    return plan.animated ? plan : null;
}

/**
 * `crop` selecting the state's cell. Applied right after the overlay's time filters, where the stream
 * time `t` is clip-local (setpts=PTS-STARTPTS, fps), the T of stateAt. `exact=1` keeps odd cell offsets
 * when the negotiated format is chroma-subsampled.
 */
export function atlasCropFilter(plan: TextStatePlan, atlas: TextAtlas): string {
    const cell = atlasCellExpr(plan.stateAt, atlas.cols, atlas.cellWidth, atlas.cellHeight);
    const x = emitFfmpeg(cell.x, { target: "scalar", time: "t" });
    const y = emitFfmpeg(cell.y, { target: "scalar", time: "t" });
    return `crop=w=${atlas.cellWidth}:h=${atlas.cellHeight}:x='${x}':y='${y}':exact=1`;
}

const side = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= MAX_ATLAS_SIDE;

/**
 * The atlas when its grid holds `count` cells inside a `width` × `height` PNG, else null. Raster results
 * can come from another process (desktop renderer); their numbers reach the filter graph only after this.
 */
export function checkTextAtlas(atlas: unknown, width: number, height: number, count: number): TextAtlas | null {
    if (!atlas || typeof atlas !== "object") return null;
    const { cols, rows, cellWidth, cellHeight, count: cells } = atlas as Record<string, unknown>;
    if (!side(cols) || !side(rows) || !side(cellWidth) || !side(cellHeight) || cells !== count) return null;
    if (!side(width) || !side(height) || cols * rows < count || cols * cellWidth > width || rows * cellHeight > height) return null;
    return { cols, rows, cellWidth, cellHeight, count };
}
