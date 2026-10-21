// Runtime-neutral export helpers shared by every export platform (web ffmpeg.wasm, desktop native ffmpeg).
import type { EffectDef, ControllerSnapshot, TimelineBackend } from "@opennan/timeline-core";
import type { ExportInput, ExportResult } from "@opennan/export";
import { exportFileName } from "../ui/format";

const CODEC_LABEL: Record<string, string> = {
    mpeg4: "MPEG-4 Part 2", "libvpx-vp9": "VP9", "webcodecs-vp9": "VP9", "webcodecs-av1": "AV1", "webcodecs-vp8": "VP8",
};

/** The format line of an animated GIF export (phase 10d). */
export const GIF_FORMAT_LABEL = "GIF (no audio, loops)";

/** The format line after an export: what the encoder actually produced. */
export function exportFormatLabel(result: Pick<ExportResult, "container" | "encoder">): string {
    if (result.container === "gif") return GIF_FORMAT_LABEL;
    const codec = CODEC_LABEL[result.encoder] ?? "H.264";
    return result.container === "webm" ? `WebM (${codec}, Opus)` : `MP4 (${codec}, AAC)`;
}

export function exportInputFromSnapshot(snapshot: ControllerSnapshot, effects: EffectDef[]): ExportInput {
    return {
        project: {
            aspectRatio: snapshot.project?.aspectRatio ?? "16:9",
            musicUrl: snapshot.project?.musicUrl ?? null,
            musicVolume: snapshot.project?.musicVolume ?? 1,
        },
        tracks: snapshot.tracks,
        clips: snapshot.clips,
        scenes: snapshot.scenes,
        effects,
    };
}

export async function loadEffectCatalog(backend: TimelineBackend): Promise<EffectDef[]> {
    return backend.listEffects ? backend.listEffects("effect") : [];
}

/** Phase 3's file name ("beach-trip.mp4") with the container the encoder produced. */
export function exportFileNameFor(projectName: string, result: Pick<ExportResult, "container">): string {
    return exportFileName(projectName).replace(/\.mp4$/, `.${result.container}`);
}
