// The desktop renderer's OpenNan cloud backend for one account (phase 9a, track F). Everything that needs the key or
// the disk runs in main over window.opennan.cloud: API calls (a proxy CloudApi; main adds the key and sends only the
// allowlisted routes), the state files (an IPC CloudStore bound to the account), hashing and uploads of media-store
// files, downloads of cloud media into the media store, and copies for local projects. The working copies are a
// DesktopBackend whose documents live in the store's "mirror" namespace and whose media are media-store files, so a
// cached cloud file plays as opennan-local://media/<id> like any imported file. Phase 9a.1: the media host tells main
// which cached files open cloud projects use (pins: main's cache never evicts them), and a backend whose store moved
// from the account's email to its id migrates the records first (migratingStore over the two IPC stores).
import {
    CloudApiError, OpenNanCloudBackend, migratingStore, type CloudApi, type CloudMethod, type CloudRequest, type CloudResponse, type CloudStore, type CloudStreamResponse,
    type MediaHost, type NetworkStatus,
} from "@opennan/cloud-backend";
import type { LocalPersistence, LocalProjectState } from "@opennan/timeline-core";
import type { CloudRequestPayload, CloudResult, CloudStreamEvent, CloudStreamPayload, DesktopBridge } from "../shared/bridge";
import { MAX_CACHE_PINS } from "../shared/settings";
import { MAX_CLOUD_MEDIA_BYTES, cloudStorageUrlRule, type CloudRequestMethod } from "../shared/cloud-policy";
import { localMediaId } from "../shared/media-policy";
import { DesktopBackend } from "./desktop-backend";

/** The proxy's base URL: uploads (which check it) never run in the renderer. */
export const DESKTOP_CLOUD_BASE = "desktop://opennan";
/** "Edited N ago on <device>" (main's host name is not exposed to the renderer). */
export const DESKTOP_DEVICE_NAME = "OpenNan Studio desktop";

type CloudBridge = Pick<DesktopBridge, "cloud" | "media" | "e2e">;

function abortError(signal: AbortSignal): unknown {
    return signal.reason instanceof Error && signal.reason.name === "AbortError" ? signal.reason : new DOMException("The operation was aborted.", "AbortError");
}

/** The call's answer, or an AbortError as soon as `signal` aborts (main may still finish the work). */
function raceAbort<T>(run: () => Promise<T>, signal: AbortSignal | undefined): Promise<T> {
    if (!signal) return run();
    if (signal.aborted) return Promise.reject(abortError(signal));
    return new Promise<T>((resolve, reject) => {
        const onAbort = () => reject(abortError(signal));
        signal.addEventListener("abort", onAbort, { once: true });
        run().then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
    });
}

/** Main's answer as a value, or its CloudApiError rebuilt; a payload main refused becomes desktop_refused. */
export async function unwrap<T>(call: () => Promise<CloudResult<T>>): Promise<T> {
    let result: CloudResult<T>;
    try {
        result = await call();
    } catch (error) {
        throw new CloudApiError(400, "desktop_refused", error instanceof Error ? error.message.slice(0, 500) : String(error));
    }
    if (!result.ok) throw CloudApiError.fromJSON(result.error);
    return result.value;
}

/**
 * Export and share on desktop (phase 9c): main uploads the export it wrote (a file of its exports folder, checked again
 * there) with the project's id; the key and the file stay in main. Main's upload can't be stopped half way: a Cancel
 * ends the share flow and the uploaded file is simply not used.
 */
export function createDesktopExportUpload(bridge: Pick<DesktopBridge, "cloud">) {
    return async (result: { output: { kind: string; path?: string } }, serverId: string, run: { signal: AbortSignal; onProgress(ratio: number): void }): Promise<{ mediaUrl: string }> => {
        const file = result.output.kind === "file" ? result.output.path : undefined;
        if (!file || file === "main") throw new Error("This export can't be shared: export again and share.");
        const stopped = () => Object.assign(new Error("The upload was cancelled."), { name: "AbortError" });
        if (run.signal.aborted) throw stopped();
        run.onProgress(0);
        const uploaded = await unwrap(() => bridge.cloud.uploadExport(file, serverId));
        if (run.signal.aborted) throw stopped();
        run.onProgress(1);
        return { mediaUrl: uploaded.mediaUrl };
    };
}

/** A fresh stream id ([A-Za-z0-9_-], unique among this window's streams). */
function newStreamId(): string {
    const random = crypto.getRandomValues(new Uint8Array(12));
    return `s${Array.from(random, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * A director turn streamed by main (phase 9b): the bytes main sends become `body`; a refusal is the CloudApiError
 * request() would throw; `signal` (before or during the call, or while reading) and cancelling the body stop main's
 * stream (main drops the request and the server cancels the turn).
 */
async function proxyStream(bridge: Pick<DesktopBridge, "cloud">, method: CloudMethod, path: string, request: CloudRequest): Promise<CloudStreamResponse> {
    const { signal } = request;
    if (signal?.aborted) throw abortError(signal);
    const payload: CloudStreamPayload = {};
    if (request.body !== undefined) payload.body = request.body;
    if (request.headers && Object.keys(request.headers).length > 0) payload.headers = { ...request.headers };
    const streamId = newStreamId();
    // Our own queue (not the stream's): a mid-stream error reaches the reader only after the bytes before it.
    const queue: Uint8Array[] = [];
    let last: { error: unknown } | "end" | null = null;
    let wake: (() => void) | null = null;
    let open = true;
    const settle = (end: { error: unknown } | "end") => {
        open = false;
        signal?.removeEventListener("abort", onAbort);
        last = end;
        wake?.();
    };
    const stopMain = () => void bridge.cloud.streamAbort(streamId).catch(() => undefined);
    const stop = () => {
        if (!open) return;
        settle("end");
        stopMain();
    };
    function onAbort(): void {
        if (!open) return;
        queue.length = 0;
        settle({ error: abortError(signal!) });
        stopMain();
    }
    const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
            while (queue.length === 0 && last === null) await new Promise<void>((resolve) => { wake = resolve; });
            wake = null;
            if (queue.length > 0) controller.enqueue(queue.shift()!);
            else if (last === "end") controller.close();
            else controller.error((last as { error: unknown }).error);
        },
        cancel: stop,
    }, { highWaterMark: 0 });
    const listener = (event: CloudStreamEvent) => {
        if (!open) return;
        if (event.type === "chunk") {
            queue.push(event.bytes);
            wake?.();
        } else settle(event.type === "end" ? "end" : { error: CloudApiError.fromJSON(event.error) });
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
        const { status } = await raceAbort(() => unwrap(() => bridge.cloud.stream(streamId, method as CloudRequestMethod, path, payload, listener)), signal);
        return { status, body };
    } catch (error) {
        // A refusal opened nothing in main; an abort while waiting already asked main to stop.
        if (open) settle({ error });
        throw error;
    }
}

export function createProxyCloudApi(bridge: Pick<DesktopBridge, "cloud">): CloudApi {
    return {
        baseUrl: DESKTOP_CLOUD_BASE,
        request<T>(method: CloudMethod, path: string, request: CloudRequest = {}): Promise<CloudResponse<T>> {
            const payload: CloudRequestPayload = {};
            if (request.body !== undefined) payload.body = request.body;
            const query = Object.entries(request.query ?? {}).filter((entry): entry is [string, string | number | boolean] => entry[1] !== undefined && entry[1] !== null);
            if (query.length > 0) payload.query = Object.fromEntries(query);
            if (request.headers && Object.keys(request.headers).length > 0) payload.headers = { ...request.headers };
            return raceAbort(() => unwrap(() => bridge.cloud.request(method as CloudRequestMethod, path, payload)), request.signal) as Promise<CloudResponse<T>>;
        },
        stream: (method, path, request = {}) => proxyStream(bridge, method, path, request),
    };
}

export function createIpcCloudStore(bridge: Pick<DesktopBridge, "cloud">, accountId: string): CloudStore {
    return {
        get: async <T>(namespace: Parameters<CloudStore["get"]>[0], key: string) => ((await bridge.cloud.storeGet(accountId, namespace, key)) ?? null) as T | null,
        put: (namespace, key, value) => bridge.cloud.storePut(accountId, namespace, key, value),
        delete: (namespace, key) => bridge.cloud.storeDelete(accountId, namespace, key),
        keys: (namespace) => bridge.cloud.storeKeys(accountId, namespace),
    };
}

/**
 * The working copies' persistence: documents in the store's "mirror" namespace; media are media-store files that
 * DesktopBackend.uploadFile hands to main. A working copy never deletes media: the files may be a local project's
 * too (Save to OpenNan keeps them), and cached cloud files are shared by every project that uses them.
 */
export function desktopMirrorPersistence(store: CloudStore): LocalPersistence {
    return {
        loadProject: (projectId) => store.get<LocalProjectState>("mirror", projectId),
        saveProject: (projectId, state) => store.put("mirror", projectId, state),
        async listProjects() {
            const out: LocalProjectState[] = [];
            for (const key of await store.keys("mirror")) {
                const state = await store.get<LocalProjectState>("mirror", key);
                if (state) out.push(state);
            }
            return out;
        },
        deleteProject: (projectId) => store.delete("mirror", projectId),
        async putBlob() {
            throw new Error("Desktop stores media through DesktopBackend.uploadFile");
        },
        async getBlob() {
            return null;
        },
        deleteBlob: async () => undefined,
    };
}

/** OpenNan's storage (never a temporary upload); the e2e build adds the loopback fake's files (main checks its port). */
export function desktopCloudUrlCheck(e2e: boolean): (url: string) => boolean {
    return cloudStorageUrlRule(e2e ? "loopback" : null);
}

export function createDesktopMediaHost(bridge: Pick<DesktopBridge, "cloud">, isCloudUrl: (url: string) => boolean): MediaHost {
    const cache = async (remoteUrl: string, sizeBytes: number | null, signal?: AbortSignal): Promise<string> => {
        const size = sizeBytes !== null && Number.isInteger(sizeBytes) && sizeBytes >= 0 && sizeBytes <= MAX_CLOUD_MEDIA_BYTES ? sizeBytes : null;
        return (await raceAbort(() => unwrap(() => bridge.cloud.cache(remoteUrl, size)), signal)).url;
    };
    return {
        async describe(localUrl) {
            const id = localMediaId(localUrl);
            return id ? bridge.cloud.describe(id) : null;
        },
        async upload(localUrl, serverProjectId, signal, onProgress) {
            const id = localMediaId(localUrl);
            if (!id) throw new CloudApiError(0, "missing_file", "This media file is not on this device.");
            const result = await raceAbort(() => unwrap(() => bridge.cloud.upload(id, serverProjectId)), signal);
            onProgress?.(result.sizeBytes);
            return result;
        },
        cache,
        pin(localUrls) {
            const ids = [...new Set(localUrls.map((url) => localMediaId(url)).filter((id): id is string => id !== null))].slice(0, MAX_CACHE_PINS);
            // Best effort: a pin main refused only leaves those files evictable.
            void bridge.cloud.cachePin(ids).catch(() => undefined);
        },
        async copyToLocal(url, _target, projectId, signal) {
            const local = isCloudUrl(url) ? await cache(url, null, signal) : url;
            const id = localMediaId(local);
            if (!id) throw new Error("This media file is not on this device.");
            return (await unwrap(() => bridge.cloud.duplicate(id, projectId))).url;
        },
    };
}

/** navigator.onLine with its events, and page visibility. */
export function browserNetwork(): NetworkStatus {
    return {
        online: () => globalThis.navigator?.onLine !== false,
        visible: () => typeof document === "undefined" || document.visibilityState !== "hidden",
        subscribe(listener) {
            if (typeof window === "undefined") return () => undefined;
            window.addEventListener("online", listener);
            window.addEventListener("offline", listener);
            document.addEventListener("visibilitychange", listener);
            return () => {
                window.removeEventListener("online", listener);
                window.removeEventListener("offline", listener);
                document.removeEventListener("visibilitychange", listener);
            };
        },
    };
}

export interface DesktopCloudOptions {
    network?: NetworkStatus;
    /** The store this account's records move from first (its email store, once OpenNan sent an account id). */
    migration?: { from: string; waitFor: Promise<unknown> };
}

export function createDesktopCloudBackend(bridge: CloudBridge, accountId: string, options: DesktopCloudOptions = {}): OpenNanCloudBackend {
    const logger = { warn: (...args: unknown[]) => console.warn(...args) };
    const { migration } = options;
    // One window edits on desktop: nothing else uses the old store while it moves.
    const store = migratingStore(createIpcCloudStore(bridge, accountId), migration ? createIpcCloudStore(bridge, migration.from) : null, { ...(migration ? { waitFor: migration.waitFor } : {}), logger });
    const isCloudUrl = desktopCloudUrlCheck(bridge.e2e);
    return new OpenNanCloudBackend({
        api: createProxyCloudApi(bridge),
        store,
        mirror: new DesktopBackend({ persistence: desktopMirrorPersistence(store) }, bridge),
        media: createDesktopMediaHost(bridge, isCloudUrl),
        isCloudUrl,
        deviceName: DESKTOP_DEVICE_NAME,
        network: options.network ?? browserNetwork(),
        logger,
    });
}
