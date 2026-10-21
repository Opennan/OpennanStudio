// A cancellable export with observable state, for UIs (React hosts wrap it in useSyncExternalStore).
import { exportTimeline, type ExportProgress, type ExportResult, type ExportTimelineOptions } from "./export-timeline";
import { ExportError, type ExportErrorCode, type ExportInput, type ExportSettings } from "./types";

export type ExportSessionState =
    | { status: "idle" }
    | { status: "running"; progress: ExportProgress }
    | { status: "done"; result: ExportResult }
    | { status: "error"; code: ExportErrorCode | "unknown"; message: string; detail?: string }
    | { status: "cancelled" };

export interface ExportSession {
    getState(): ExportSessionState;
    subscribe(listener: () => void): () => void;
    /**
     * Resolves when the export settles; never rejects (failures land in the state). While an export runs,
     * a second call resolves at once with the running state and starts nothing.
     */
    start(input: ExportInput, settings: ExportSettings): Promise<ExportSessionState>;
    cancel(): void;
    reset(): void;
}

export type ExportSessionOptions = Omit<ExportTimelineOptions, "signal" | "onProgress">;

export function createExportSession(options: ExportSessionOptions): ExportSession {
    let state: ExportSessionState = { status: "idle" };
    let controller: AbortController | null = null;
    const listeners = new Set<() => void>();
    const set = (next: ExportSessionState) => {
        state = next;
        listeners.forEach((listener) => listener());
    };

    return {
        getState: () => state,
        subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        async start(input, settings) {
            if (state.status === "running") return state;
            const current = new AbortController();
            controller = current;
            set({ status: "running", progress: { phase: "probe", ratio: 0 } });
            try {
                const result = await exportTimeline(input, settings, {
                    ...options,
                    signal: current.signal,
                    onProgress: (progress) => {
                        if (controller === current) set({ status: "running", progress });
                    },
                });
                if (controller === current) set({ status: "done", result });
            } catch (error) {
                if (controller !== current) return state;
                if (current.signal.aborted || (error instanceof ExportError && error.code === "cancelled")) set({ status: "cancelled" });
                else if (error instanceof ExportError) set({ status: "error", code: error.code, message: error.message, detail: error.detail });
                else set({ status: "error", code: "unknown", message: error instanceof Error ? error.message : String(error) });
            } finally {
                if (controller === current) controller = null;
            }
            return state;
        },
        cancel() {
            controller?.abort();
        },
        reset() {
            if (state.status !== "running") set({ status: "idle" });
        },
    };
}
