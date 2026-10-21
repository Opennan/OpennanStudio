// Export and share's export step (phase 9c): the editor's own exporter runs a 720p video export of the timeline (the
// GPU path when it can run, as every export: WebGL2 + WebCodecs, else the compatible export), its progress followed,
// Cancel stopping it, its failure in its own words. It never takes over an export the person started, and the export
// dialog never delivers (downloads) its result: the share flow resets the session when it is done with it.
import type { ExportResolution, ExportResult, ExportSessionState } from "@opennan/export";

/** What a share link plays: a 720p MP4 (quick to export and upload; the share page plays it at any size). */
export const SHARE_EXPORT_RESOLUTION: ExportResolution = "720p";

export interface ShareExporter {
    session: {
        getState(): ExportSessionState;
        subscribe(listener: () => void): () => void;
        cancel(): void;
    };
    /** Starts the editor's export (the platform exporter's start with the open project's controller and backend). */
    start(request: { resolution: ExportResolution }): Promise<void>;
}

function abortError(): Error {
    const error = new Error("The export was cancelled.");
    error.name = "AbortError";
    return error;
}

export function exportForShare(exporter: ShareExporter, options: { signal: AbortSignal; onProgress(ratio: number): void }): Promise<ExportResult> {
    if (exporter.session.getState().status === "running") return Promise.reject(new Error("An export is already running: share once it has finished."));
    if (options.signal.aborted) return Promise.reject(abortError());
    return new Promise<ExportResult>((resolve, reject) => {
        let started = false;
        let settled = false;
        const finish = (fn: () => void) => {
            if (settled) return;
            settled = true;
            unsubscribe();
            options.signal.removeEventListener("abort", onAbort);
            fn();
        };
        const read = () => {
            const state = exporter.session.getState();
            if (state.status === "running") {
                started = true;
                options.onProgress(state.progress.ratio);
            } else if (!started) {
                return;
            } else if (state.status === "done") {
                finish(() => resolve(state.result));
            } else if (state.status === "error") {
                finish(() => reject(new Error(state.message)));
            } else if (state.status === "cancelled" || state.status === "idle") {
                finish(() => reject(abortError()));
            }
        };
        const unsubscribe = exporter.session.subscribe(read);
        const onAbort = () => {
            if (exporter.session.getState().status === "running") exporter.session.cancel();
            finish(() => reject(abortError()));
        };
        options.signal.addEventListener("abort", onAbort, { once: true });
        exporter.start({ resolution: SHARE_EXPORT_RESOLUTION }).then(read, (error: unknown) => finish(() => reject(error instanceof Error ? error : new Error(String(error)))));
        read();
    });
}
