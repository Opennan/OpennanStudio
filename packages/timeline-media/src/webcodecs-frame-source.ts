// Hardware-accelerated timeline frame extraction via Mediabunny (WebCodecs).
//
// This is the fast path behind the timeline filmstrip: instead of seeking a
// pooled <video> element once per frame (~50-200ms each, serialized), it decodes
// all requested frame times for a clip in a single pipelined, hardware-accelerated
// pass. Mediabunny is dynamically imported so it never lands in the initial bundle
// and SSR is unaffected. Callers must treat a `false`/`null` result as "fall back
// to the <video> path" so unsupported browsers/codecs degrade gracefully.


// Bitmap box: frames are drawn into this max size, preserving source aspect so the
// renderer's center-crop reads the correct aspect ratio.
const FRAME_MAX_W = 160;
const FRAME_MAX_H = 90;
// Mirror the <video> pool bound so long sessions don't retain every decoder.
const MAX_INPUT_POOL_SIZE = 16;

type Mediabunny = typeof import("mediabunny");
type MbInput = import("mediabunny").Input;
type MbVideoSampleSink = import("mediabunny").VideoSampleSink;

interface InputEntry {
    input: MbInput;
    sink: MbVideoSampleSink;
}

// Lazy singleton import of the runtime so the ~tree-shaken module loads only on
// first decode.
let mediabunnyPromise: Promise<Mediabunny> | null = null;
function loadMediabunny(): Promise<Mediabunny> {
    if (!mediabunnyPromise) mediabunnyPromise = import("mediabunny");
    return mediabunnyPromise;
}

// Per-URL Input + VideoSampleSink pool. Values are promises so concurrent
// requests for the same URL share one decoder. A resolved `null` marks a URL the
// WebCodecs path can't handle (no video track / undecodable codec / load error).
const inputPool = new Map<string, Promise<InputEntry | null>>();
const inputAccessOrder: string[] = [];
const activeInputs = new Map<string, number>();

export function isWebCodecsFrameDecodeSupported(): boolean {
    if (typeof window === "undefined") return false;
    if (typeof VideoDecoder === "undefined") return false;
    // WebCodecs requires a secure context.
    return window.isSecureContext === true;
}

// Dedupe + clamp + sort + round requested times to match the thumbnail cache key
// format (`url@time.toFixed(2)`), so decoded frames land on the exact keys the
// renderer reads back.
export function planFrameTimes(times: number[]): number[] {
    const seen = new Set<number>();
    const out: number[] = [];
    for (const time of times) {
        if (!Number.isFinite(time)) continue;
        const rounded = Math.round(Math.max(0, time) * 100) / 100;
        if (seen.has(rounded)) continue;
        seen.add(rounded);
        out.push(rounded);
    }
    out.sort((a, b) => a - b);
    return out;
}

function touchInput(url: string) {
    const idx = inputAccessOrder.indexOf(url);
    if (idx !== -1) inputAccessOrder.splice(idx, 1);
    inputAccessOrder.push(url);
}

function markActive(url: string, delta: number) {
    const next = (activeInputs.get(url) ?? 0) + delta;
    if (next > 0) activeInputs.set(url, next);
    else activeInputs.delete(url);
}

async function disposeInput(url: string) {
    const entryPromise = inputPool.get(url);
    inputPool.delete(url);
    const idx = inputAccessOrder.indexOf(url);
    if (idx !== -1) inputAccessOrder.splice(idx, 1);
    if (!entryPromise) return;
    try {
        const entry = await entryPromise;
        entry?.input.dispose();
    } catch {
        // Already failed/disposed — nothing to free.
    }
}

function pruneInputPool() {
    while (inputPool.size > MAX_INPUT_POOL_SIZE) {
        const idx = inputAccessOrder.findIndex((url) => (activeInputs.get(url) ?? 0) === 0);
        if (idx < 0) return; // everything pooled is currently decoding
        const [oldest] = inputAccessOrder.splice(idx, 1);
        if (oldest) void disposeInput(oldest);
    }
}

async function createEntry(url: string, resolveUrl: (url: string) => string): Promise<InputEntry | null> {
    try {
        const mb = await loadMediabunny();
        // UrlSource streams via HTTP range reads against the same-origin preview
        // proxy, so only the bytes needed for the requested frames are fetched.
        const source = new mb.UrlSource(resolveUrl(url));
        const input = new mb.Input({ source, formats: mb.ALL_FORMATS });
        const track = await input.getPrimaryVideoTrack();
        if (!track) {
            input.dispose();
            return null;
        }
        const decodable = await track.canDecode();
        if (!decodable) {
            input.dispose();
            return null;
        }
        const sink = new mb.VideoSampleSink(track);
        return { input, sink };
    } catch {
        // No video track, unsupported codec, or the proxy can't satisfy range
        // reads — caller falls back to the <video> path.
        return null;
    }
}

function getEntry(url: string, resolveUrl: (url: string) => string): Promise<InputEntry | null> {
    let entryPromise = inputPool.get(url);
    if (!entryPromise) {
        entryPromise = createEntry(url, resolveUrl);
        inputPool.set(url, entryPromise);
    }
    touchInput(url);
    pruneInputPool();
    return entryPromise;
}

function createDrawCanvas(w: number, h: number): { canvas: OffscreenCanvas | HTMLCanvasElement; ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D } | null {
    if (typeof OffscreenCanvas !== "undefined") {
        const canvas = new OffscreenCanvas(w, h);
        const ctx = canvas.getContext("2d");
        if (ctx) return { canvas, ctx };
    }
    if (typeof document !== "undefined") {
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (ctx) return { canvas, ctx };
    }
    return null;
}

/**
 * Decode the requested frame times for a video URL in one WebCodecs pass.
 * Invokes `onFrame(time, bitmap)` for each decoded frame (keyed by the rounded
 * requested time). Returns `true` if the WebCodecs path handled this URL (even if
 * some individual frames were null), or `false` to signal the caller should fall
 * back to the <video> path. Honors `signal` for cancellation.
 */
export async function decodeFramesAtTimes(
    url: string,
    times: number[],
    signal: AbortSignal,
    onFrame: (time: number, bitmap: ImageBitmap) => void,
    resolveUrl: (url: string) => string = (url) => url,
): Promise<boolean> {
    if (!isWebCodecsFrameDecodeSupported()) return false;
    if (signal.aborted) return true;

    const planned = planFrameTimes(times);
    if (planned.length === 0) return true;

    const entry = await getEntry(url, resolveUrl);
    if (!entry) return false; // unsupported — fall back
    if (signal.aborted) return true;

    markActive(url, 1);
    try {
        let index = 0;
        for await (const sample of entry.sink.samplesAtTimestamps(planned)) {
            const requestedTime = planned[index++];
            if (signal.aborted) {
                sample?.close();
                break;
            }
            if (!sample) continue;
            try {
                const dw = sample.displayWidth || FRAME_MAX_W;
                const dh = sample.displayHeight || FRAME_MAX_H;
                const scale = Math.min(FRAME_MAX_W / dw, FRAME_MAX_H / dh, 1);
                const tw = Math.max(1, Math.round(dw * scale));
                const th = Math.max(1, Math.round(dh * scale));
                const surface = createDrawCanvas(tw, th);
                if (!surface) {
                    sample.close();
                    return false;
                }
                surface.ctx.clearRect(0, 0, tw, th);
                sample.draw(surface.ctx, 0, 0, tw, th);
                const bitmap = await createImageBitmap(surface.canvas);
                if (signal.aborted) {
                    bitmap.close();
                } else {
                    onFrame(requestedTime, bitmap);
                }
            } finally {
                sample.close();
            }
        }
        return true;
    } catch {
        // Mid-stream decode failure — let the caller retry via the <video> path.
        return false;
    } finally {
        markActive(url, -1);
        pruneInputPool();
    }
}

// Dispose pooled decoders for URLs no longer visible on the timeline. Mirrors the
// thumbnail cache's `cancelUnused` so decoder memory tracks the visible window.
export function releaseUnusedInputs(keepUrls: Set<string>) {
    for (const url of [...inputPool.keys()]) {
        if (keepUrls.has(url)) continue;
        if ((activeInputs.get(url) ?? 0) > 0) continue;
        void disposeInput(url);
    }
}

// Test-only: reset module state between cases.
export function __resetWebCodecsFrameSourceForTests() {
    for (const url of [...inputPool.keys()]) void disposeInput(url);
    inputPool.clear();
    inputAccessOrder.length = 0;
    activeInputs.clear();
    mediabunnyPromise = null;
}
