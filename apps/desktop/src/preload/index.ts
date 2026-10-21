// The sandboxed preload: builds window.opennan from ipcRenderer and exposes nothing else (spec §7.2).
// Bundled into one CommonJS file (tsup): sandboxed preloads can require only "electron".
import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from "electron";
import { EVENTS, IPC } from "../shared/channels";
import type { AudioInput, MediaSourceRef } from "@opennan/provider-sdk";
import { E2E_ARGUMENT, EXPORT_PORTS_MESSAGE, MAX_IN_MEMORY_IMPORT, type CloudErrorJson, type CloudResult, type CloudStreamEvent, type DesktopBridge } from "../shared/bridge";

const invoke = <T>(channel: string, payload: unknown = {}) => ipcRenderer.invoke(channel, payload) as Promise<T>;

function listen<A extends unknown[]>(channel: string, map: (payload: never) => A, listener: (...args: A) => void): () => void {
    const wrapped = (_event: IpcRendererEvent, payload: unknown) => listener(...map(payload as never));
    ipcRenderer.on(channel, wrapped);
    return () => {
        ipcRenderer.removeListener(channel, wrapped);
    };
}

/**
 * Streamed answers (phase 9b): one listener per event channel, dispatching by stream id to the stream's own listener,
 * which is dropped at its end, error, refusal or abort.
 */
function createStreamRouter() {
    const streams = new Map<string, (event: CloudStreamEvent) => void>();
    let listening = false;
    function listenOnce(): void {
        if (listening) return;
        listening = true;
        ipcRenderer.on(EVENTS.cloudStreamChunk, (_event: IpcRendererEvent, payload: { streamId?: unknown; bytes?: unknown }) => {
            const listener = typeof payload?.streamId === "string" ? streams.get(payload.streamId) : undefined;
            if (listener && payload.bytes instanceof Uint8Array) listener({ type: "chunk", bytes: payload.bytes });
        });
        ipcRenderer.on(EVENTS.cloudStreamEnd, (_event: IpcRendererEvent, payload: { streamId?: unknown; error?: CloudErrorJson }) => {
            const listener = typeof payload?.streamId === "string" ? streams.get(payload.streamId) : undefined;
            if (!listener) return;
            streams.delete(payload.streamId as string);
            listener(payload.error ? { type: "error", error: payload.error } : { type: "end" });
        });
    }
    return {
        add(streamId: string, listener: (event: CloudStreamEvent) => void): void {
            listenOnce();
            streams.set(streamId, (event) => listener(event));
        },
        drop(streamId: string): void {
            streams.delete(streamId);
        },
    };
}

export function createBridge(): DesktopBridge {
    const streams = createStreamRouter();
    return {
        e2e: process.argv.includes(E2E_ARGUMENT),
        persistence: {
            load: (projectId) => invoke(IPC.persistenceLoad, { projectId }),
            save: (projectId, state) => invoke(IPC.persistenceSave, { projectId, state }),
            list: () => invoke(IPC.persistenceList),
            delete: (projectId) => invoke(IPC.persistenceDelete, { projectId }),
        },
        media: {
            async import(projectId, file, kind) {
                const path = webUtils.getPathForFile(file);
                if (path) return invoke(IPC.mediaImportPath, { projectId, path, kind });
                if (file.size > MAX_IN_MEMORY_IMPORT) throw new Error("This file is too large to import without a file path");
                const bytes = new Uint8Array(await file.arrayBuffer());
                return invoke(IPC.mediaImportBytes, { projectId, name: file.name || "media", mimeType: file.type, kind, bytes });
            },
            delete: (projectId, id) => invoke(IPC.mediaDelete, { projectId, id }),
            releaseProject: (projectId) => invoke(IPC.mediaReleaseProject, { projectId }),
        },
        exports: {
            start: (options, snapshot) => invoke(IPC.exportStart, { options, snapshot }),
            cancel: () => invoke(IPC.exportCancel),
            reset: () => invoke(IPC.exportReset),
            state: () => invoke(IPC.exportState),
            onState: (listener) => listen(EVENTS.exportState, (state: never) => [state] as [never], listener),
            fileInfo: (path) => invoke(IPC.exportFileInfo, { path }),
            reveal: (path) => invoke(IPC.exportReveal, { path }),
            gpuBegin: (options, snapshot, container, codec) => invoke(IPC.exportGpuBegin, { options, snapshot, container, ...(codec ? { codec } : {}) }),
            gpuChunk: (jobId, position, bytes) => invoke(IPC.exportGpuChunk, { jobId, position, bytes }),
            gpuMux: (jobId) => invoke(IPC.exportGpuMux, { jobId }),
            gpuAbort: (jobId, error) => invoke(IPC.exportGpuAbort, { jobId, ...(error ? { error: { code: error.code, message: error.message } } : {}) }),
            gpuProgress: (jobId, { phase, ratio, etaSeconds }) => invoke(IPC.exportGpuProgress, { jobId, phase, ratio, ...(etaSeconds === undefined ? {} : { etaSeconds }) }),
            gpuFallback: (jobId) => invoke(IPC.exportGpuFallback, { jobId }),
            onGpuCancel: (listener) => listen(EVENTS.exportGpuCancel, (p: { jobId: string }) => [p?.jobId] as [string], listener),
        },
        session: {
            async attach(projectId, respond) {
                const onRequest = (_event: IpcRendererEvent, request: { id: number; method: string; args: unknown[] }) => {
                    void respond(request.method, Array.isArray(request.args) ? request.args : []).then(
                        (value) => invoke(IPC.sessionResponse, { id: request.id, ok: true, value }),
                        (error: unknown) => invoke(IPC.sessionResponse, { id: request.id, ok: false, error: String(error instanceof Error ? error.message : error).slice(0, 4000) }),
                    ).catch(() => undefined);
                };
                ipcRenderer.on(EVENTS.sessionRequest, onRequest);
                await invoke(IPC.sessionAttach, { projectId });
                return async () => {
                    ipcRenderer.removeListener(EVENTS.sessionRequest, onRequest);
                    await invoke(IPC.sessionDetach, { projectId });
                };
            },
        },
        terminal: {
            start: (projectId, profile, cols, rows) => invoke<{ terminalId: string }>(IPC.terminalStart, { projectId, profile, cols, rows }).then((r) => r.terminalId),
            input: (terminalId, data) => void invoke(IPC.terminalInput, { terminalId, data }).catch(() => undefined),
            resize: (terminalId, cols, rows) => void invoke(IPC.terminalResize, { terminalId, cols, rows }).catch(() => undefined),
            kill: (terminalId) => void invoke(IPC.terminalKill, { terminalId }).catch(() => undefined),
            onData: (listener) => listen(EVENTS.terminalData, (p: { terminalId: string; data: string }) => [p.terminalId, p.data] as [string, string], listener),
            onExit: (listener) => listen(EVENTS.terminalExit, (p: { terminalId: string; code: number }) => [p.terminalId, p.code] as [string, number], listener),
        },
        settings: {
            get: () => invoke(IPC.settingsGet),
            update: (patch) => invoke(IPC.settingsUpdate, patch),
        },
        secrets: {
            list: () => invoke(IPC.secretsList),
            set: (name, value) => invoke(IPC.secretsSet, { name, value }),
            remove: (name) => invoke(IPC.secretsRemove, { name }),
        },
        mcp: { info: () => invoke(IPC.mcpInfo) },
        app: { info: () => invoke(IPC.appInfo) },
        account: {
            status: () => invoke(IPC.accountStatus),
            start: (signup) => invoke(IPC.accountStart, { signup }),
            reopen: () => invoke(IPC.accountReopen),
            cancel: () => invoke(IPC.accountCancel),
            signOut: () => invoke(IPC.accountSignOut),
            switchAccount: () => invoke(IPC.accountSwitch),
            refresh: () => invoke(IPC.accountRefresh),
            openConsole: (page) => invoke(IPC.accountOpenConsole, { page }),
            connectKey: (key) => invoke(IPC.accountConnectKey, { key }),
            onChanged: (listener) => listen(EVENTS.accountChanged, (status: never) => [status] as [never], listener),
            onNotice: (listener) => listen(EVENTS.accountNotice, (notice: never) => [notice] as [never], listener),
        },
        providers: {
            list: () => invoke(IPC.providersList),
            models: (providerId, capability) => invoke(IPC.providersModels, { providerId, capability }),
            run: ({ providerId, capability, input, projectId }) => invoke(IPC.providersRun, { providerId, capability, input, projectId }),
            transcribe: ({ providerId, audio, language, model, expectedMaxUsd }) => invoke(IPC.providersTranscribe, {
                providerId, audio: audioFields(audio),
                ...(language === undefined ? {} : { language }), ...(model === undefined ? {} : { model }), ...(expectedMaxUsd === undefined ? {} : { expectedMaxUsd }),
            }),
            cancel: (jobId) => invoke(IPC.providersCancel, { jobId }),
            price: (providerId, request) => invoke(IPC.providersPrice, { providerId, request: { capability: request.capability, input: request.input, units: request.units } }),
            voices: (providerId) => invoke(IPC.providersVoices, { providerId }),
            onJob: (listener) => listen(EVENTS.providersJob, (event: never) => [event] as [never], listener),
        },
        cloud: {
            request: (method, path, { body, query, headers }) => invoke(IPC.cloudRequest, {
                method, path, ...(body === undefined ? {} : { body }), ...(query === undefined ? {} : { query }), ...(headers === undefined ? {} : { headers }),
            }),
            describe: (mediaId) => invoke(IPC.cloudDescribe, { mediaId }),
            upload: (mediaId, serverProjectId) => invoke(IPC.cloudUpload, { mediaId, serverProjectId }),
            uploadExport: (path, serverProjectId) => invoke(IPC.cloudUploadExport, { path, serverProjectId }),
            cache: (url, sizeBytes) => invoke(IPC.cloudCache, { url, sizeBytes }),
            duplicate: (mediaId, projectId) => invoke(IPC.cloudDuplicate, { mediaId, projectId }),
            storeGet: (account, namespace, key) => invoke(IPC.cloudStoreGet, { account, namespace, key }),
            storePut: (account, namespace, key, value) => invoke(IPC.cloudStorePut, { account, namespace, key, value }),
            storeDelete: (account, namespace, key) => invoke(IPC.cloudStoreDelete, { account, namespace, key }),
            storeKeys: (account, namespace) => invoke(IPC.cloudStoreKeys, { account, namespace }),
            cachePin: (ids) => invoke(IPC.cloudCachePin, { ids }),
            cacheUsage: () => invoke(IPC.cloudCacheUsage, {}),
            cacheSetLimit: (bytes) => invoke(IPC.cloudCacheSetLimit, { bytes }),
            cacheClear: () => invoke(IPC.cloudCacheClear, {}),
            async stream(streamId, method, path, { body, headers }, listener) {
                // Listening before asking: main may send bytes before its answer arrives.
                streams.add(streamId, listener);
                try {
                    const result = await invoke<CloudResult<{ status: number }>>(IPC.cloudStreamStart, {
                        streamId, method, path, ...(body === undefined ? {} : { body }), ...(headers === undefined ? {} : { headers }),
                    });
                    if (!result?.ok) streams.drop(streamId);
                    return result;
                } catch (error) {
                    streams.drop(streamId);
                    throw error;
                }
            },
            streamAbort(streamId) {
                streams.drop(streamId);
                return invoke(IPC.cloudStreamAbort, { streamId });
            },
        },
        ai: {
            status: () => invoke(IPC.aiStatus),
            models: () => invoke(IPC.aiModels),
            transcribe: (input) => invoke(IPC.aiTranscribe, {
                ...(input.language === undefined ? {} : { language: input.language }), ...(input.model === undefined ? {} : { model: input.model }),
                ...("source" in input ? { source: sourceFields(input.source) } : { snapshot: input.snapshot }),
            }),
            stabilize: ({ projectId, source }) => invoke(IPC.aiStabilize, { projectId, source: sourceFields(source) }),
            cancel: (jobId) => invoke(IPC.aiCancel, { jobId }),
            onJob: (listener) => listen(EVENTS.aiJob, (event: never) => [event] as [never], listener),
        },
    };
}

/** A MediaSourceRef with exactly its fields. */
function sourceFields(source: MediaSourceRef): MediaSourceRef {
    return {
        mediaUrl: source.mediaUrl,
        ...(source.startSeconds === undefined ? {} : { startSeconds: source.startSeconds }),
        ...(source.endSeconds === undefined ? {} : { endSeconds: source.endSeconds }),
    };
}

/** An AudioInput with exactly its fields. */
function audioFields(audio: AudioInput): AudioInput {
    if (audio.kind === "timeline") return { kind: "timeline", snapshot: audio.snapshot };
    const { mediaUrl, ...range } = sourceFields({ mediaUrl: audio.url, startSeconds: audio.startSeconds, endSeconds: audio.endSeconds });
    return { kind: "media", url: mediaUrl, ...range };
}

/** MessagePorts cannot cross contextBridge: hand the export drawing ports to the page with postMessage. */
export function forwardExportPorts(): void {
    ipcRenderer.on(EVENTS.exportPorts, (event) => {
        window.postMessage(EXPORT_PORTS_MESSAGE, window.location.origin, event.ports);
    });
}

contextBridge.exposeInMainWorld("opennan", createBridge());
forwardExportPorts();
