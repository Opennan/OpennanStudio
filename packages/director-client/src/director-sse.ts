// A server-sent events reader over a fetch body (ReadableStream<Uint8Array>): EventSource can neither send an
// Authorization header nor a POST body, so Studio reads the director's stream itself. It follows the HTML living
// standard's parsing rules where Studio needs them: UTF-8 decoded across chunk boundaries, CRLF / LF / CR line ends
// (a CRLF split over two chunks is one), `field: value` with one optional space, multi-line `data:` joined with "\n",
// comment lines (":") ignored, an event dispatched on a blank line (named "message" when it has no `event:` field,
// dropped when it has no data). A stream that sends no byte at all for `idleMs` (the server pings every 15 s) fails
// with SseIdleError; an abort cancels the body and rejects with an AbortError.

export interface SseEvent {
    event: string;
    data: string;
}

export interface ReadSseOptions {
    signal?: AbortSignal;
    /** No byte for this long (heartbeats count) fails the read; default 30 s, 0 = never. */
    idleMs?: number;
}

export const SSE_IDLE_MS = 30_000;

export class SseIdleError extends Error {
    constructor(ms: number) {
        super(`No data from OpenNan for ${Math.round(ms / 1000)} s.`);
        this.name = "SseIdleError";
    }
}

function abortError(): Error {
    const error = new Error("The stream was stopped.");
    error.name = "AbortError";
    return error;
}

export async function* readSse(body: ReadableStream<Uint8Array>, options: ReadSseOptions = {}): AsyncGenerator<SseEvent> {
    const idleMs = options.idleMs ?? SSE_IDLE_MS;
    const signal = options.signal;
    const reader = body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    let skipLf = false;
    let name = "";
    let data: string[] | null = null;
    let finished = false;

    const nextChunk = (): Promise<ReadableStreamReadResult<Uint8Array>> => {
        if (signal?.aborted) return Promise.reject(abortError());
        return new Promise((resolve, reject) => {
            let timer: ReturnType<typeof setTimeout> | undefined;
            const onAbort = () => {
                cleanup();
                reject(abortError());
            };
            const cleanup = () => {
                if (timer !== undefined) clearTimeout(timer);
                signal?.removeEventListener("abort", onAbort);
            };
            if (idleMs > 0) {
                timer = setTimeout(() => {
                    cleanup();
                    reject(new SseIdleError(idleMs));
                }, idleMs);
            }
            signal?.addEventListener("abort", onAbort, { once: true });
            reader.read().then((result) => {
                cleanup();
                resolve(result);
            }, (error) => {
                cleanup();
                reject(error);
            });
        });
    };

    /** One complete line: updates the pending event; answers it when the line dispatches one. */
    const line = (text: string): SseEvent | null => {
        if (text === "") {
            const out = data !== null ? { event: name || "message", data: data.join("\n") } : null;
            name = "";
            data = null;
            return out;
        }
        if (text.startsWith(":")) return null;
        const colon = text.indexOf(":");
        const field = colon < 0 ? text : text.slice(0, colon);
        let value = colon < 0 ? "" : text.slice(colon + 1);
        if (value.startsWith(" ")) value = value.slice(1);
        if (field === "event") name = value;
        else if (field === "data") (data ??= []).push(value);
        return null;
    };

    try {
        while (true) {
            const { value, done } = await nextChunk();
            if (done) {
                finished = true;
                buffer += decoder.decode();
                // An event still open when the stream ends is never dispatched (the standard drops it).
                return;
            }
            buffer += decoder.decode(value, { stream: true });
            let start = 0;
            for (let i = 0; i < buffer.length; i++) {
                const ch = buffer.charCodeAt(i);
                if (ch === 10 && skipLf && i === start) {
                    // The LF of a CRLF whose CR ended the previous line (possibly in the previous chunk).
                    skipLf = false;
                    start = i + 1;
                    continue;
                }
                skipLf = false;
                if (ch === 13 || ch === 10) {
                    const event = line(buffer.slice(start, i));
                    if (ch === 13) skipLf = true;
                    start = i + 1;
                    if (event) yield event;
                }
            }
            buffer = buffer.slice(start);
        }
    } finally {
        if (!finished) await reader.cancel().catch(() => undefined);
        reader.releaseLock();
    }
}
