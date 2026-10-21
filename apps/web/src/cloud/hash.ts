// SHA-256 of a Blob in a Worker (hash-worker.ts); in this thread where Workers are missing (tests).
import { hashBlob } from "@opennan/cloud-backend";

let worker: Worker | null = null;
let serial = 0;
const waiting = new Map<number, { resolve(hash: string): void; reject(error: Error): void }>();

function hashWorker(): Worker | null {
    if (worker || typeof Worker !== "function") return worker;
    try {
        worker = new Worker(new URL("./hash-worker.ts", import.meta.url), { type: "module" });
        worker.onmessage = (event: MessageEvent<{ id: number; hash?: string; error?: string }>) => {
            const pending = waiting.get(event.data.id);
            waiting.delete(event.data.id);
            if (!pending) return;
            if (event.data.hash) pending.resolve(event.data.hash);
            else pending.reject(new Error(event.data.error ?? "Hashing failed"));
        };
    } catch {
        worker = null;
    }
    return worker;
}

export function hashInWorker(blob: Blob, signal?: AbortSignal): Promise<string> {
    const w = hashWorker();
    if (!w) return hashBlob(blob, signal);
    const id = ++serial;
    return new Promise<string>((resolve, reject) => {
        waiting.set(id, { resolve, reject });
        signal?.addEventListener("abort", () => {
            waiting.delete(id);
            reject(signal.reason ?? new DOMException("Hashing aborted", "AbortError"));
        }, { once: true });
        w.postMessage({ id, blob });
    });
}
