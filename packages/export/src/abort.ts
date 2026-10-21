// Cancellation helpers. Host-provided steps (rasterizers, bridges to another process) do not take a
// signal, so a cancelled export must not wait on them: untilAborted settles as soon as the signal aborts.
import { ExportError } from "./types";

export function checkAborted(signal?: AbortSignal): void {
    if (signal?.aborted) throw new ExportError("cancelled", "Export cancelled.");
}

/** Resolves or rejects with `promise`, or rejects with `cancelled` once `signal` aborts, whichever is first. */
export function untilAborted<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) return promise;
    if (signal.aborted) return Promise.reject(new ExportError("cancelled", "Export cancelled."));
    return new Promise<T>((resolve, reject) => {
        const onAbort = () => reject(new ExportError("cancelled", "Export cancelled."));
        signal.addEventListener("abort", onAbort, { once: true });
        promise.then(
            (value) => {
                signal.removeEventListener("abort", onAbort);
                resolve(value);
            },
            (error: unknown) => {
                signal.removeEventListener("abort", onAbort);
                reject(error);
            },
        );
    });
}
