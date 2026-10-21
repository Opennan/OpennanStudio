// Public types of @opennan/export.
import type { EffectDef, ProjectMeta, SceneData, TimelineClip, TimelineTrack } from "@opennan/timeline-core";
import type { TextState } from "@opennan/timeline-core/text/text-states";

export type ExportResolution = "720p" | "1080p" | "4k";

/** What the export makes: a video file (MP4/WebM), or an animated GIF (phase 10d: 15 fps, at most 640 px wide, no audio, loops forever). */
export type ExportFormatKind = "video" | "gif";

export interface ExportSettings {
    resolution: ExportResolution;
    /** Default "video". "gif": an animated GIF (GIF_DEFAULT_FPS unless `fps` is given, at most GIF_MAX_WIDTH wide, no audio). */
    format?: ExportFormatKind;
    /** "16:9", "9:16", "1:1", "4:5" or any "W:H". Default: the project's aspect ratio. */
    aspectRatio?: string;
    /** Default 30 (GIF: 15). */
    fps?: number;
    /** Default RESOLUTION_BITRATE_KBPS[resolution]. */
    videoBitrateKbps?: number;
    /** Default 192. */
    audioBitrateKbps?: number;
}

/** What is exported: the same data the preview plays (controller.snapshot()). */
export interface ExportInput {
    project: Pick<ProjectMeta, "aspectRatio" | "musicUrl" | "musicVolume">;
    tracks: TimelineTrack[];
    clips: TimelineClip[];
    scenes: SceneData[];
    /** GL effect catalog (backend.listEffects("effect")). Effect-track clips need it. */
    effects?: EffectDef[];
}

/** Output frame. Overlay pixel sizes are authored for the reference frame; frameScale converts them. */
export interface OutputFormat {
    width: number;
    height: number;
    fps: number;
    aspectRatio: number;
    refWidth: number;
    refHeight: number;
    frameScale: number;
}

export interface MediaInfo {
    durationSeconds: number;
    hasVideo: boolean;
    hasAudio: boolean;
    width: number;
    height: number;
}

export type ExportWarningCode =
    | "media-missing"
    | "media-unreadable"
    | "remotion-unsupported"
    | "gl-effect-unsupported"
    | "gl-effect-unknown"
    | "clip-effect-ignored"
    /** Text and emoji clips left out: no OverlayRasterizer in this host (headless node). */
    | "text-unsupported"
    /** A speed curve changes faster than its sliced audio can follow: the sound can drift more than a frame from the picture. */
    | "speed-ramp-audio-approximated"
    /** No H.264 encoder without GPL here: the file is MPEG-4 Part 2 or VP9. */
    | "encoder-fallback"
    /** More Adjust keyframes than the export blends: the look holds the last exported keyframe after it. */
    | "look-keyframes-limited"
    /** Web runner only: long animated (geq) effects, which ffmpeg.wasm renders slowly; the desktop app is faster. */
    | "slow-web-effect"
    /** The fast GPU export could not run this project here; the compatible ffmpeg export ran instead (the message says why). */
    | "gpu-fallback"
    /** A graphic's image (logo-sting's logo) could not be loaded here; the graphic draws without it (phase 10d). */
    | "graphics-asset-missing";

/** Something the export leaves out or approximates. The UI shows these before and after a run. */
export interface ExportWarning {
    code: ExportWarningCode;
    message: string;
    clipId?: string;
    sceneId?: string;
    effectId?: string;
}

/** A bitmap the export needs from a canvas (text, emoji and bundled stickers), drawn by an OverlayRasterizer. */
export type RasterJob =
    | {
        kind: "text";
        id: string;
        clipId: string;
        text: string;
        textStyle: string | null;
        /** Clip scale the bitmap is drawn at. */
        scale: number;
        frameScale: number;
        /** Output frame width in px (caption wrap widths are a fraction of it). */
        frameWidth: number;
        /**
         * Raster states (timeline-core text/text-states.ts), present only when the clip's animation changes
         * its pixels: every state is drawn into one grid atlas (RasterResult.atlas), cell i = states[i].
         */
        states?: TextState[];
    }
    | {
        kind: "emoji";
        id: string;
        clipId: string;
        text: string;
        scale: number;
        frameScale: number;
    }
    | {
        /** A bundled catalog sticker (timeline-core stickers/catalog.ts), drawn from its SVG. */
        kind: "sticker";
        id: string;
        clipId: string;
        stickerId: string;
        /** Clip scale the bitmap is drawn for (the largest the clip reaches). */
        scale: number;
        /** Bitmap size in px: the sticker box at `scale` on the output frame, longest side capped at 2048. */
        width: number;
        height: number;
    }
    | GraphicsRasterJob;

/**
 * A built-in graphics clip (timeline-core graphics) as a full-frame image sequence for the ffmpeg path: one
 * entry per output frame the clip shows on, from `firstFrame`. Each entry is drawn on a clear `width × height`
 * canvas: the template frame filling the canvas, then placed with `matrix` (canvas setTransform) at `opacity`
 * as one layer; null draws nothing. RasterResult.sequence has one PNG per entry (equal entries may share one).
 */
export interface GraphicsRasterJob {
    kind: "graphics";
    id: string;
    clipId: string;
    templateId: string;
    propsJson: string | null;
    /** The clip's timeline span (template frame count and animation timing). */
    startTime: number;
    endTime: number;
    width: number;
    height: number;
    /** Output frame of entry 0. */
    firstFrame: number;
    frames: Array<GraphicsRasterFrame | null>;
    /** Always 1 (RasterResult.scale echo). */
    scale: 1;
}

export interface GraphicsRasterFrame {
    /** Template frame (timeline-core graphicsFrameAt). */
    frame: number;
    matrix: [number, number, number, number, number, number];
    opacity: number;
}

/** A text state atlas: `count` cells of cellWidth × cellHeight px, row-major in a cols × rows grid from the PNG's top-left. */
export interface TextAtlas {
    cols: number;
    rows: number;
    cellWidth: number;
    cellHeight: number;
    count: number;
}

export interface RasterResult {
    /** RasterJob.id; only a map key. compileExport names the bitmap file itself (never from clip ids). */
    id: string;
    png: Uint8Array;
    /** PNG size in px. */
    width: number;
    height: number;
    /**
     * Layout box inside the PNG (text box or emoji box); the PNG adds `pad` px on each side. For an atlas these
     * describe one cell at `scale` before any shrinking (the cell is ceil(box + 2·pad) unless the atlas shrank).
     */
    boxWidth: number;
    boxHeight: number;
    pad: number;
    /** Clip scale the bitmap was drawn at (RasterJob.scale). */
    scale: number;
    /** Text jobs with `states`: the grid of state cells in the PNG. */
    atlas?: TextAtlas;
    /** Graphics jobs: one full-frame PNG per GraphicsRasterJob.frames entry (`png` is the first). */
    sequence?: Uint8Array[];
    /** Graphics jobs: the output frame of sequence[0] (GraphicsRasterJob.firstFrame). */
    firstFrame?: number;
    /** Graphics jobs: image URLs the template wanted but could not use (drawn without them). */
    missingAssets?: string[];
}

export interface PlanInput {
    /** "media": a timeline media URL; "file": a job file named by compileExport (`raster-<n>.png`, ExportPlan.files). */
    kind: "media" | "file";
    source: string;
    /** ffmpeg options placed before this input's -i. */
    options: string[];
}

export interface GlEffectSpec {
    id: string;
    /** Body defining `vec4 effect(sampler2D tex, vec2 uv)` (timeline-media EffectRenderer contract). */
    glsl: string;
    floatParams: Record<string, number>;
    keyColor?: [number, number, number];
}

/** A time range whose composited frames run through a GL effect stack. */
export interface GlPass {
    start: number;
    end: number;
    effects: GlEffectSpec[];
}

export interface ExportPlan {
    format: OutputFormat;
    durationSeconds: number;
    inputs: PlanInput[];
    filterGraph: string;
    videoLabel: string;
    audioLabel: string;
    files: Array<{ name: string; data: Uint8Array }>;
    glPasses: GlPass[];
    warnings: ExportWarning[];
    videoBitrateKbps: number;
    audioBitrateKbps: number;
}

export type ExportErrorCode =
    | "empty-timeline"
    | "resolution-unsupported"
    | "no-encoder"
    | "media-read-failed"
    | "ffmpeg-failed"
    /** The media does not fit the runner's memory budget (ffmpeg.wasm); export from the desktop app. */
    | "too-large"
    /** The ffmpeg.wasm core could not be loaded or failed its SHA-256 check. */
    | "core-unavailable"
    /** The timeline has no audible source (compileAudioMix). */
    | "no-audio"
    /** The runner cannot do this (renderAudio on ffmpeg.wasm). */
    | "runner-unsupported"
    | "cancelled";

export class ExportError extends Error {
    readonly code: ExportErrorCode;
    /** ffmpeg log tail or other diagnostics. */
    readonly detail?: string;

    constructor(code: ExportErrorCode, message: string, detail?: string) {
        super(message);
        this.name = "ExportError";
        this.code = code;
        this.detail = detail;
    }
}
