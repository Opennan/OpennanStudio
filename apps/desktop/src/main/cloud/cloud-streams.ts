// A director turn streamed through main (phase 9b). The renderer starts a stream by id (sender-checked and
// schema-validated by handle(): the one streamable route, a body and the allowed headers); main runs it with the key
// (cloud-host's stream: the same base, no credentials, no redirects) and answers {ok, value: {status}} or the refusal
// as CloudApiError JSON, like request(). The body's bytes then go to the window that started it only, as
// EVENTS.cloudStreamChunk {streamId, bytes}, and EVENTS.cloudStreamEnd {streamId, error?} closes it. An abort from
// the renderer drops the request (the server cancels the turn) and sends nothing more; a window that is destroyed,
// crashes or navigates away aborts its streams. At most MAX_CLOUD_STREAMS_PER_WINDOW run per window. No event
// carries the key: chunks are the server's bytes and errors pass through asCloudError (redacted).
import { CloudApiError, isAbortError } from "@opennan/cloud-backend";
import type { CloudResult } from "../../shared/bridge";
import { MAX_CLOUD_STREAMS_PER_WINDOW } from "../../shared/cloud-policy";
import { EVENTS, IPC } from "../../shared/ipc";
import { handle, type IpcEventLike, type IpcMainLike } from "../ipc/handle";
import { asCloudError, type CloudHost } from "./cloud-host";

/** The parts of Electron's WebContents the streams use. */
export interface StreamWindow {
    id: number;
    isDestroyed(): boolean;
    send(channel: string, payload: unknown): void;
    on(event: "destroyed" | "render-process-gone" | "did-navigate", listener: () => void): unknown;
}

function windowOf(event: IpcEventLike): StreamWindow {
    const sender = event.sender as Partial<StreamWindow> | null | undefined;
    if (!sender || typeof sender.id !== "number" || typeof sender.send !== "function" || typeof sender.isDestroyed !== "function" || typeof sender.on !== "function") {
        throw new Error("Untrusted IPC sender");
    }
    return sender as StreamWindow;
}

const refusal = (status: number, code: string, message: string): CloudResult<never> => ({ ok: false, error: new CloudApiError(status, code, message).toJSON() });

export function registerCloudStreamIpc(ipc: IpcMainLike, { host, maxPerWindow = MAX_CLOUD_STREAMS_PER_WINDOW }: { host: Pick<CloudHost, "stream">; maxPerWindow?: number }): () => void {
    /** Running streams per window: stream id → its abort. */
    const windows = new Map<StreamWindow, Map<string, AbortController>>();

    function abortAll(target: StreamWindow): void {
        const streams = windows.get(target);
        windows.delete(target);
        for (const controller of streams?.values() ?? []) controller.abort();
    }

    function streamsOf(target: StreamWindow): Map<string, AbortController> {
        let streams = windows.get(target);
        if (!streams) {
            streams = new Map();
            windows.set(target, streams);
            if (!watched.has(target)) {
                watched.add(target);
                for (const event of ["destroyed", "render-process-gone", "did-navigate"] as const) target.on(event, () => abortAll(target));
            }
        }
        return streams;
    }
    const watched = new WeakSet<StreamWindow>();

    function emit(target: StreamWindow, controller: AbortController, channel: string, payload: unknown): void {
        if (controller.signal.aborted || target.isDestroyed()) return;
        try {
            target.send(channel, payload);
        } catch {
            controller.abort();
        }
    }

    function finish(target: StreamWindow, streamId: string, controller: AbortController): void {
        const streams = windows.get(target);
        if (streams?.get(streamId) === controller) streams.delete(streamId);
        if (streams?.size === 0) windows.delete(target);
    }

    async function pump(target: StreamWindow, streamId: string, controller: AbortController, body: ReadableStream<Uint8Array>): Promise<void> {
        const reader = body.getReader();
        try {
            for (;;) {
                const { value, done } = await reader.read();
                if (done) break;
                if (controller.signal.aborted) return;
                if (value && value.byteLength > 0) {
                    emit(target, controller, EVENTS.cloudStreamChunk, { streamId, bytes: new Uint8Array(value.buffer, value.byteOffset, value.byteLength) });
                }
            }
            emit(target, controller, EVENTS.cloudStreamEnd, { streamId });
        } catch (error) {
            emit(target, controller, EVENTS.cloudStreamEnd, { streamId, error: asCloudError(error, "network").toJSON() });
        } finally {
            finish(target, streamId, controller);
            if (controller.signal.aborted) reader.cancel().catch(() => undefined);
        }
    }

    handle(ipc, IPC.cloudStreamStart, async ({ streamId, method, path, body, headers }, event): Promise<CloudResult<{ status: number }>> => {
        const target = windowOf(event);
        const streams = streamsOf(target);
        if (streams.has(streamId)) return refusal(400, "desktop_refused", "This stream is already running.");
        if (streams.size >= maxPerWindow) return refusal(429, "desktop_busy", `Studio streams at most ${maxPerWindow} answers at once in a window.`);
        const controller = new AbortController();
        streams.set(streamId, controller);
        try {
            const answer = await host.stream(method, path, { ...(body !== undefined ? { body } : {}), ...(headers ? { headers } : {}) }, controller.signal);
            if (controller.signal.aborted) {
                answer.body.cancel().catch(() => undefined);
                return refusal(0, "aborted", "The stream was stopped.");
            }
            void pump(target, streamId, controller, answer.body);
            return { ok: true, value: { status: answer.status } };
        } catch (error) {
            finish(target, streamId, controller);
            if (controller.signal.aborted && isAbortError(error)) return refusal(0, "aborted", "The stream was stopped.");
            return { ok: false, error: asCloudError(error).toJSON() };
        }
    });

    handle(ipc, IPC.cloudStreamAbort, ({ streamId }, event) => {
        const target = windowOf(event);
        const streams = windows.get(target);
        const controller = streams?.get(streamId);
        if (!controller) return;
        streams!.delete(streamId);
        if (streams!.size === 0) windows.delete(target);
        controller.abort();
    });

    return () => {
        for (const target of [...windows.keys()]) abortAll(target);
    };
}
