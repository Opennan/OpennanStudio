// The motion tracker in a Web Worker (phase 10d). The worker is built from source text (timeline-core's
// self-contained motionTrackerRuntime plus a small message loop) as a blob: URL, so hosts need no bundler
// configuration for it; hosts whose CSP forbids blob: workers pass their own channel factory.
//
// Protocol (page → worker): { id, type: "start", pass, frame, region, options } creates the pass's tracker on its
// start frame; { id, type: "step", pass, frame } tracks into the next frame. Every request is answered with
// { id, point } or { id, error }, in order. Frame pixels are transferred, not copied.
import { motionTrackerRuntime, type LumaFrame, type TrackPoint, type TrackRegion, type TrackerOptions } from "@opennan/timeline-core/tracking/tracker";

export interface TrackerChannel {
    /** Creates pass `pass`'s tracker on its start frame; resolves with the start point. */
    start(pass: string, frame: LumaFrame, region: TrackRegion, options?: TrackerOptions): Promise<TrackPoint>;
    /** Tracks pass `pass` into the next frame. Calls may overlap: answers come in call order. */
    step(pass: string, frame: LumaFrame): Promise<TrackPoint>;
    /** Stops the worker (pending calls reject). */
    dispose(): void;
}

type Request =
    | { id: number; type: "start"; pass: string; frame: LumaFrame; region: TrackRegion; options?: TrackerOptions }
    | { id: number; type: "step"; pass: string; frame: LumaFrame };
type Reply = { id: number; point?: TrackPoint; error?: string };
type WithoutId<T> = T extends unknown ? Omit<T, "id"> : never;

/** The message loop the worker runs; `runtime` is motionTrackerRuntime(). Self-contained like the runtime. */
function workerMain(scope: { onmessage: ((event: { data: Request }) => void) | null; postMessage(message: Reply): void }, runtime: ReturnType<typeof motionTrackerRuntime>): void {
    const trackers: Record<string, { step(frame: LumaFrame): TrackPoint }> = {};
    scope.onmessage = (event) => {
        const request = event.data;
        try {
            if (request.type === "start") {
                const tracker = runtime.createTracker(request.frame, request.region, request.options || {});
                trackers[request.pass] = tracker;
                scope.postMessage({ id: request.id, point: tracker.start });
            } else {
                const tracker = trackers[request.pass];
                if (!tracker) throw new Error(`no tracker for pass ${request.pass}`);
                scope.postMessage({ id: request.id, point: tracker.step(request.frame) });
            }
        } catch (error) {
            scope.postMessage({ id: request.id, error: error instanceof Error ? error.message : String(error) });
        }
    };
}

/** The worker script: the runtime and the message loop from their own source text. */
export function trackerWorkerSource(): string {
    return `"use strict";\n(${workerMain.toString()})(self, (${motionTrackerRuntime.toString()})());\n`;
}

/** Request/answer bookkeeping shared by the worker and the in-process channel. */
function channelOver(send: (request: Request, transfer: Transferable[]) => void, stop: () => void): { channel: TrackerChannel; receive(reply: Reply): void; fail(error: Error): void } {
    let nextId = 1;
    let stopped = false;
    const pending = new Map<number, { resolve(point: TrackPoint): void; reject(error: Error): void }>();
    const call = (request: WithoutId<Request>): Promise<TrackPoint> => {
        if (stopped) return Promise.reject(new Error("the tracker was stopped"));
        const id = nextId++;
        return new Promise<TrackPoint>((resolve, reject) => {
            pending.set(id, { resolve, reject });
            const data = request.frame.data as unknown as { buffer?: ArrayBuffer };
            const transfer = data.buffer instanceof ArrayBuffer ? [data.buffer] : [];
            send({ ...request, id } as Request, transfer);
        });
    };
    const fail = (error: Error) => {
        for (const entry of pending.values()) entry.reject(error);
        pending.clear();
    };
    return {
        channel: {
            start: (pass, frame, region, options) => call({ type: "start", pass, frame, region, options }),
            step: (pass, frame) => call({ type: "step", pass, frame }),
            dispose: () => {
                if (stopped) return;
                stopped = true;
                stop();
                fail(new Error("the tracker was stopped"));
            },
        },
        receive: (reply) => {
            const entry = pending.get(reply.id);
            if (!entry) return;
            pending.delete(reply.id);
            if (reply.error !== undefined || !reply.point) entry.reject(new Error(reply.error ?? "the tracker sent no point"));
            else entry.resolve(reply.point);
        },
        fail,
    };
}

let workerUrl: string | null = null;

/** A channel to a dedicated tracker worker (blob: URL, created once per page). */
export function createWorkerTrackerChannel(): TrackerChannel {
    workerUrl ??= URL.createObjectURL(new Blob([trackerWorkerSource()], { type: "text/javascript" }));
    const worker = new Worker(workerUrl);
    const link = channelOver((request, transfer) => worker.postMessage(request, transfer), () => worker.terminate());
    worker.onmessage = (event: MessageEvent<Reply>) => link.receive(event.data);
    worker.onerror = (event) => {
        event.preventDefault?.();
        link.fail(new Error(event.message || "the tracker worker failed"));
    };
    return link.channel;
}

/** The same protocol in-process (tests, and pages without Worker): the runtime runs on the calling thread, one call per task. */
export function createInlineTrackerChannel(): TrackerChannel {
    const scope: Parameters<typeof workerMain>[0] = { onmessage: null, postMessage: (reply) => link.receive(reply) };
    workerMain(scope, motionTrackerRuntime());
    let stopped = false;
    const link = channelOver((request) => {
        // Answer asynchronously like a worker, so callers never depend on synchronous replies.
        setTimeout(() => {
            if (!stopped) scope.onmessage?.({ data: request });
        }, 0);
    }, () => {
        stopped = true;
    });
    return link.channel;
}

/** A worker channel where workers exist, else the in-process one. */
export function createDefaultTrackerChannel(): TrackerChannel {
    if (typeof Worker !== "undefined" && typeof Blob !== "undefined" && typeof URL !== "undefined" && typeof URL.createObjectURL === "function") {
        try {
            return createWorkerTrackerChannel();
        } catch {
            // A Worker constructor that throws (no blob: URLs here): the in-process channel. A CSP that blocks blob:
            // workers fails later instead (the run reports the error); both shipped CSPs allow worker-src blob:.
        }
    }
    return createInlineTrackerChannel();
}
