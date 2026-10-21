// Frame rendering for the read API (spec §5.1.1 previewFrame). The renderer is
// injected: @opennan/export provides one (phase 4), hosts without it get
// { ok: false, unavailable: true } and agents fall back to describeTimeline().
import type { TimelineClip } from "../model/timeline";
import type { SceneData } from "../timeline/canvas/types";
import { getSceneDuration, getSceneStart } from "../timeline/scene-timing";
import type { ControllerSnapshot } from "./timeline-controller";

export interface FrameRequest {
    snapshot: ControllerSnapshot;
    /** Timeline seconds, already clamped to [0, timeline duration]. */
    seconds: number;
    width?: number;
    height?: number;
    signal?: AbortSignal;
}

export interface RenderedFrame {
    mimeType: "image/png" | "image/jpeg" | "image/webp";
    data: Uint8Array;
    width: number;
    height: number;
}

export interface FrameRenderer {
    renderFrame(request: FrameRequest): Promise<RenderedFrame>;
}

export interface PreviewFrameOptions {
    width?: number;
    height?: number;
    signal?: AbortSignal;
}

export type PreviewFrameResult =
    | { ok: true; seconds: number; frame: RenderedFrame }
    | { ok: false; seconds: number; error: string; unavailable?: boolean };

/** End of the last clip or scene, in timeline seconds. */
export function timelineDurationSeconds(snapshot: { clips: TimelineClip[]; scenes: SceneData[] }): number {
    let end = 0;
    for (const clip of snapshot.clips) end = Math.max(end, clip.endTime);
    snapshot.scenes.forEach((scene, i) => {
        end = Math.max(end, getSceneStart(scene, snapshot.scenes, i) + getSceneDuration(scene));
    });
    return end;
}
