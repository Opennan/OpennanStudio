// The audio detectors in a Web Worker (phase 11). The worker is built from source text (timeline-core's self-contained
// analysisRuntime plus a small message loop) as a blob: URL, like the 10d tracker worker, so hosts need no bundler
// configuration; pages without Worker (and tests) use the same loop in-process.
//
// Protocol (page → worker): { id, kind: "silences" | "beats", pcm, sampleRate, options } with the PCM transferred.
// Each request is answered with { id, silences } / { id, beats } or { id, error }. Times are seconds from the first sample.
import { analysisRuntime } from "@opennan/timeline-core/analysis/runtime";
import type { BeatOptions, SilenceOptions, TimeRange } from "@opennan/timeline-core";

export interface AnalysisResult {
    silences?: TimeRange[];
    beats?: { bpm: number; times: number[] };
}

export interface AnalysisChannel {
    /** Runs one detector over mono PCM; the PCM's buffer is transferred to the worker. */
    run(kind: "silences" | "beats", pcm: Float32Array, sampleRate: number, options?: SilenceOptions | BeatOptions): Promise<AnalysisResult>;
    /** Stops the worker (pending runs reject). */
    dispose(): void;
}

type Request = { id: number; kind: "silences" | "beats"; pcm: Float32Array; sampleRate: number; options?: SilenceOptions | BeatOptions };
type Reply = { id: number; error?: string } & AnalysisResult;

/** The message loop the worker runs; `runtime` is analysisRuntime(). Self-contained like the runtime. */
function workerMain(scope: { onmessage: ((event: { data: Request }) => void) | null; postMessage(message: Reply): void }, runtime: ReturnType<typeof analysisRuntime>): void {
    scope.onmessage = (event) => {
        const request = event.data;
        try {
            if (request.kind === "silences") scope.postMessage({ id: request.id, silences: runtime.detectSilences(request.pcm, request.sampleRate, (request.options || {}) as SilenceOptions) });
            else if (request.kind === "beats") scope.postMessage({ id: request.id, beats: runtime.detectBeats(request.pcm, request.sampleRate, (request.options || {}) as BeatOptions) });
            else throw new Error(`unknown analysis kind ${String(request.kind)}`);
        } catch (error) {
            scope.postMessage({ id: request.id, error: error instanceof Error ? error.message : String(error) });
        }
    };
}

/** The worker script: the runtime and the message loop from their own source text. */
export function analysisWorkerSource(): string {
    return `"use strict";\n(${workerMain.toString()})(self, (${analysisRuntime.toString()})());\n`;
}

function channelOver(send: (request: Request, transfer: Transferable[]) => void, stop: () => void): { channel: AnalysisChannel; receive(reply: Reply): void; fail(error: Error): void } {
    let nextId = 1;
    let stopped = false;
    const pending = new Map<number, { resolve(result: AnalysisResult): void; reject(error: Error): void }>();
    const fail = (error: Error) => {
        for (const entry of pending.values()) entry.reject(error);
        pending.clear();
    };
    return {
        channel: {
            run(kind, pcm, sampleRate, options) {
                if (stopped) return Promise.reject(new Error("the analyzer was stopped"));
                const id = nextId++;
                return new Promise<AnalysisResult>((resolve, reject) => {
                    pending.set(id, { resolve, reject });
                    send({ id, kind, pcm, sampleRate, options }, pcm.buffer instanceof ArrayBuffer ? [pcm.buffer] : []);
                });
            },
            dispose() {
                if (stopped) return;
                stopped = true;
                stop();
                fail(new Error("the analyzer was stopped"));
            },
        },
        receive(reply) {
            const entry = pending.get(reply.id);
            if (!entry) return;
            pending.delete(reply.id);
            if (reply.error !== undefined) entry.reject(new Error(reply.error));
            else entry.resolve({ ...(reply.silences ? { silences: reply.silences } : {}), ...(reply.beats ? { beats: reply.beats } : {}) });
        },
        fail,
    };
}

let workerUrl: string | null = null;

/** A channel to a dedicated analysis worker (blob: URL, created once per page). */
export function createWorkerAnalysisChannel(): AnalysisChannel {
    workerUrl ??= URL.createObjectURL(new Blob([analysisWorkerSource()], { type: "text/javascript" }));
    const worker = new Worker(workerUrl);
    const link = channelOver((request, transfer) => worker.postMessage(request, transfer), () => worker.terminate());
    worker.onmessage = (event: MessageEvent<Reply>) => link.receive(event.data);
    worker.onerror = (event) => {
        event.preventDefault?.();
        link.fail(new Error(event.message || "the analysis worker failed"));
    };
    return link.channel;
}

/** The same protocol in-process (tests, and pages without Worker): answered on a later task, like a worker. */
export function createInlineAnalysisChannel(): AnalysisChannel {
    const scope: Parameters<typeof workerMain>[0] = { onmessage: null, postMessage: (reply) => link.receive(reply) };
    workerMain(scope, analysisRuntime());
    let stopped = false;
    const link = channelOver((request) => {
        setTimeout(() => {
            if (!stopped) scope.onmessage?.({ data: request });
        }, 0);
    }, () => {
        stopped = true;
    });
    return link.channel;
}

/** A worker channel where workers exist, else the in-process one. */
export function createDefaultAnalysisChannel(): AnalysisChannel {
    if (typeof Worker !== "undefined" && typeof Blob !== "undefined" && typeof URL !== "undefined" && typeof URL.createObjectURL === "function") {
        try {
            return createWorkerAnalysisChannel();
        } catch {
            // A Worker constructor that throws (no blob: URLs here): the in-process channel.
        }
    }
    return createInlineAnalysisChannel();
}
