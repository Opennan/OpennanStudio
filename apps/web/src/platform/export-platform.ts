// How the editor exports on this platform. Web: @opennan/export on ffmpeg.wasm in the tab, a download at the
// end (export/web-export.ts). Desktop: native LGPL ffmpeg in the main process, a file on disk (apps/desktop).
import type { ExportEngine, ExportFormatKind, ExportInput, ExportResolution, ExportResult, ExportSession } from "@opennan/export";
import type { ControllerSnapshot, ExportCommandOutcome, TimelineBackend, TimelineController } from "@opennan/timeline-core";
import type { MediaEnvironment } from "@opennan/timeline-media";

/** What the Export dialog watches and controls. */
export type ExportSessionView = Pick<ExportSession, "getState" | "subscribe" | "cancel" | "reset">;

/** TimelineProvider onExport: export.start from agents and shortcuts lands here. */
export interface ExportCommandHandler {
    (options: Record<string, unknown>, snapshot: ControllerSnapshot): Promise<ExportCommandOutcome>;
    /** export.cancel (phase 10d): stops the running export (when `jobId` is given, only if it is that one). */
    cancel?(jobId: string | undefined): Promise<ExportCommandOutcome>;
}

/** A finished export as the dialog reports it. */
export interface ExportDelivery {
    fileName: string;
    size: number;
    /** Web: object URL for "Download again". */
    url?: string;
    /** Desktop: where the file was written. */
    path?: string;
    /** Web: the export's file in the origin private file system, deleted on release. */
    opfsName?: string;
}

/** Which engine an export will use, as the dialog shows it before the run. */
export interface ExportEnginePreview {
    engine: ExportEngine;
    /** The format line for this engine, e.g. "MP4 (H.264, AAC)". */
    formatLabel: string;
    /** Why the fast (GPU) engine will not run, when it will not. */
    reason?: string;
    /** As ExportPlatform.nativeSpeed / gl, for this engine. */
    nativeSpeed: boolean;
    gl: boolean;
}

export interface PlatformExporter {
    session: ExportSessionView;
    /** The engine the next export of `input` will use (no media is read). Absent: the platform's defaults. */
    engine?(input: ExportInput, resolution: ExportResolution, format?: ExportFormatKind): Promise<ExportEnginePreview>;
    /** The dialog's Export button. `format` defaults to "video" (phase 10d: "gif" makes an animated GIF). */
    start(request: { controller: TimelineController; backend: TimelineBackend; resolution: ExportResolution; format?: ExportFormatKind }): Promise<void>;
    /** TimelineProvider onExport; `show` opens the dialog. */
    commandHandler(backend: TimelineBackend, show: () => void): ExportCommandHandler;
    /** Called once per finished result: web downloads it, desktop reads the file size. */
    deliver(result: ExportResult, projectName: string): Promise<ExportDelivery>;
    /** Releases what deliver() allocated (object URLs). */
    release?(delivery: ExportDelivery): void;
    /** Desktop: "Show in folder". */
    reveal?(delivery: ExportDelivery): void;
    dispose(): void;
}

export interface ExportPlatform {
    resolutions: readonly ExportResolution[];
    /** What the dialog offers to make (phase 10d). Absent: video only (no format picker). */
    formats?: readonly ExportFormatKind[];
    /** Format line before an export runs. */
    formatLabel: string;
    /** Shown after the size line, e.g. "4K needs the desktop app"; null for none. */
    resolutionNote: string | null;
    /** Whether GL effects export (the warnings list them otherwise). */
    gl: boolean;
    /** False when exports run far slower than native ffmpeg (web: ffmpeg.wasm), so long animated effects warn. Default true. */
    nativeSpeed?: boolean;
    createExporter(media: MediaEnvironment): PlatformExporter;
}
