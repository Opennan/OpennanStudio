// Rasterizer and GL frame processor across a message port, for hosts that run the node runner in one
// process and draw in another. Phase 6 wires it: createNodeRunner in the Electron main process with
// createRemoteRasterizer / createRemoteGlFrameProcessor, and the renderer serving createBrowserRasterizer
// (@opennan/export/web) and createWebGlFrameProcessor (@opennan/export/web-gl) on one port each.
// Pixels move as transferred ArrayBuffers where the port supports it (Electron's MessagePortMain copies).
// Budget: a 1080p RGBA frame is 8.3 MB; keep a round trip under about 25 ms (about 7.5 s of overhead per
// 10 s of GL effect at 30 fps). If a host cannot meet that, run the GL pass in the renderer instead.
import type { GlFrame, GlFrameProcessor } from "./gl";
import type { OverlayRasterizer } from "./raster/canvas-rasterizer";
import type { GlEffectSpec, RasterJob, RasterResult } from "./types";

/** The part of a DOM or Node MessagePort the bridge uses. Adapt Electron's MessagePortMain (.on/.off). */
export interface BridgePort {
    postMessage(message: unknown, transfer?: ArrayBuffer[]): void;
    addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
    removeEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
    start?(): void;
}

type BridgeRequest =
    | { id: number; kind: "raster"; job: RasterJob }
    | { id: number; kind: "gl"; frame: GlFrame; effects: GlEffectSpec[] };
type BridgeResponse = { id: number; ok: true; value: unknown } | { id: number; ok: false; message: string };

/** A view whose whole buffer can be transferred without detaching memory someone else holds. */
function ownBuffer(data: Uint8Array): Uint8Array {
    return data.byteOffset === 0 && data.byteLength === data.buffer.byteLength && data.buffer instanceof ArrayBuffer ? data : data.slice();
}

function bridgeClient(port: BridgePort) {
    let next = 0;
    const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
    const onMessage = (event: { data: unknown }) => {
        // A malformed reply (e.g. a transfer the port could not carry arrives as null) is ignored: throwing here
        // would be an uncaught exception in the main process.
        const response = event.data as BridgeResponse | null;
        if (!response || typeof response !== "object" || typeof response.id !== "number") return;
        const waiter = pending.get(response.id);
        if (!waiter) return;
        pending.delete(response.id);
        if (response.ok) waiter.resolve(response.value);
        else waiter.reject(new Error(response.message));
    };
    port.addEventListener("message", onMessage);
    port.start?.();
    return {
        call<T>(request: (id: number) => BridgeRequest, transfer: ArrayBuffer[] = []): Promise<T> {
            const id = next++;
            return new Promise<T>((resolve, reject) => {
                pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
                port.postMessage(request(id), transfer);
            });
        },
        close() {
            port.removeEventListener("message", onMessage);
            for (const waiter of pending.values()) waiter.reject(new Error("bridge closed"));
            pending.clear();
        },
    };
}

/** Most bytes a renderer may answer for one graphics clip's image sequence (main writes them to its job folder). */
export const MAX_GRAPHICS_SEQUENCE_BYTES = 2 * 2 ** 30;

/** Largest bitmap side a renderer may return; browsers cap canvases at about this size. */
const MAX_RASTER_SIDE = 16384;

const inRange = (value: unknown, min: number): value is number =>
    typeof value === "number" && Number.isFinite(value) && value >= min && value <= MAX_RASTER_SIDE;

/**
 * The renderer process is a separate trust domain: its answer reaches the filter graph and the encoder,
 * so a result that breaks the RasterResult contract is refused rather than compiled.
 */
function checkRasterResult(job: RasterJob, value: unknown): RasterResult {
    const result = value as Partial<RasterResult> | null;
    const valid = typeof result === "object" && result !== null
        && result.png instanceof Uint8Array
        && result.id === job.id
        && result.scale === job.scale
        && inRange(result.width, 1) && inRange(result.height, 1)
        && inRange(result.boxWidth, 0) && inRange(result.boxHeight, 0) && inRange(result.pad, 0)
        && (job.kind !== "graphics" || (
            Array.isArray(result.sequence) && result.sequence.length === job.frames.length && result.sequence.every((png) => png instanceof Uint8Array)
            && result.firstFrame === job.firstFrame && result.width === job.width && result.height === job.height
            && result.sequence.reduce((sum, png) => sum + png.byteLength, 0) <= MAX_GRAPHICS_SEQUENCE_BYTES
            && (result.missingAssets === undefined || (Array.isArray(result.missingAssets) && result.missingAssets.length <= 8 && result.missingAssets.every((url) => typeof url === "string" && url.length <= 4096)))
        ));
    if (!valid) throw new Error(`invalid raster result for ${job.id} from the renderer process`);
    return result as RasterResult;
}

/** Main-process side of a rasterizer served by serveOverlayRasterizer. */
export function createRemoteRasterizer(port: BridgePort): OverlayRasterizer & { close(): void } {
    const client = bridgeClient(port);
    return {
        rasterize: async (job) => checkRasterResult(job, await client.call<unknown>((id) => ({ id, kind: "raster", job }))),
        close: client.close,
    };
}

/** Main-process side of a GL processor served by serveGlFrameProcessor. */
export function createRemoteGlFrameProcessor(port: BridgePort): GlFrameProcessor {
    const client = bridgeClient(port);
    return {
        async process(frame, effects) {
            const data = ownBuffer(frame.data);
            const expected = frame.width * frame.height * 4;
            const out = await client.call<unknown>((id) => ({ id, kind: "gl", frame: { ...frame, data }, effects }), [data.buffer as ArrayBuffer]);
            if (!(out instanceof Uint8Array) || out.length !== expected) {
                throw new Error(`invalid GL frame from the renderer process (expected ${expected} RGBA bytes)`);
            }
            return out;
        },
        dispose: client.close,
    };
}

function serve(port: BridgePort, handle: (request: BridgeRequest) => Promise<{ value: unknown; transfer: ArrayBuffer[] }>): () => void {
    const onMessage = (event: { data: unknown }) => {
        const request = event.data as BridgeRequest;
        const fail = (error: unknown) =>
            port.postMessage({ id: request.id, ok: false, message: error instanceof Error ? error.message : String(error) } satisfies BridgeResponse);
        // A value the port cannot clone or transfer is answered as an error, so the caller never waits forever.
        handle(request).then(({ value, transfer }) => port.postMessage({ id: request.id, ok: true, value } satisfies BridgeResponse, transfer)).catch(fail);
    };
    port.addEventListener("message", onMessage);
    port.start?.();
    return () => port.removeEventListener("message", onMessage);
}

/** Renderer side: answers createRemoteRasterizer with a local rasterizer (createBrowserRasterizer). */
export function serveOverlayRasterizer(port: BridgePort, rasterizer: OverlayRasterizer): () => void {
    return serve(port, async (request) => {
        if (request.kind !== "raster") throw new Error(`unexpected ${request.kind} request on a rasterizer port`);
        const result = await rasterizer.rasterize(request.job);
        if (result.sequence) {
            // Shared entries stay shared in the clone (one copy per distinct PNG); nothing is transferred, so the
            // first PNG may also appear in the sequence.
            return { value: result, transfer: [] };
        }
        const png = ownBuffer(result.png);
        return { value: { ...result, png }, transfer: [png.buffer as ArrayBuffer] };
    });
}

/** Renderer side: answers createRemoteGlFrameProcessor with a local processor (createWebGlFrameProcessor). */
export function serveGlFrameProcessor(port: BridgePort, processor: GlFrameProcessor): () => void {
    return serve(port, async (request) => {
        if (request.kind !== "gl") throw new Error(`unexpected ${request.kind} request on a GL port`);
        const out = ownBuffer(await processor.process(request.frame, request.effects));
        return { value: out, transfer: [out.buffer as ArrayBuffer] };
    });
}
