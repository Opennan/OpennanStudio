// A DesktopBridge for renderer tests: an in-memory project store and vi.fn() everywhere else.
import type { LocalProjectState } from "@opennan/timeline-core";
import type { CloudNamespace } from "../shared/cloud-policy";
import type { DesktopBridge } from "../shared/bridge";
import { DEFAULT_SETTINGS } from "../shared/settings";

/** What the test bridge's cache answers: empty, the default limit. */
export const TEST_CACHE_USAGE = Object.freeze({
    usedBytes: 0, entries: 0, limitBytes: 10 * 1024 ** 3, defaultLimitBytes: 10 * 1024 ** 3, maxLimitBytes: 1024 * 1024 ** 3, pinnedBytes: 0, custom: false,
});

export function createTestBridge(overrides: Partial<DesktopBridge> = {}) {
    const projects = new Map<string, LocalProjectState>();
    /** The cloud file store: "<account>|<namespace>" → key → JSON text. */
    const cloudFiles = new Map<string, Map<string, string>>();
    const cloudNs = (account: string, namespace: CloudNamespace) => {
        const id = `${account}|${namespace}`;
        if (!cloudFiles.has(id)) cloudFiles.set(id, new Map());
        return cloudFiles.get(id)!;
    };
    const bridge: DesktopBridge = {
        e2e: false,
        persistence: {
            load: vi.fn(async (id: string) => (projects.has(id) ? structuredClone(projects.get(id)!) : null)),
            save: vi.fn(async (id: string, state: LocalProjectState) => void projects.set(id, structuredClone(state))),
            list: vi.fn(async () => [...projects.values()].map((s) => structuredClone(s))),
            delete: vi.fn(async (id: string) => void projects.delete(id)),
        },
        media: {
            import: vi.fn(async (_projectId: string, file: File) => ({ url: "opennan-local://media/3f2b8c1e-1d2a-4c3b-9e8f-0a1b2c3d4e5f", name: file.name, size: file.size, mimeType: file.type, durationSeconds: 6 })),
            delete: vi.fn(async () => undefined),
            releaseProject: vi.fn(async () => undefined),
        },
        exports: {
            start: vi.fn(async () => ({ jobId: "export-1" })), cancel: vi.fn(async () => undefined), reset: vi.fn(async () => undefined),
            state: vi.fn(async () => ({ status: "idle" as const })), onState: vi.fn(() => () => undefined),
            fileInfo: vi.fn(async () => ({ size: 2048 })), reveal: vi.fn(async () => undefined),
            gpuBegin: vi.fn(async () => ({ jobId: "3f2b8c1e-1d2a-4c3b-9e8f-0a1b2c3d4e5f" })), gpuChunk: vi.fn(async () => undefined),
            gpuMux: vi.fn(async () => ({ path: "/exports/trip.mp4" })), gpuAbort: vi.fn(async () => undefined),
            gpuProgress: vi.fn(async () => undefined), gpuFallback: vi.fn(async () => ({ jobId: "export-1" })), onGpuCancel: vi.fn(() => () => undefined),
        },
        session: { attach: vi.fn(async () => async () => undefined) },
        terminal: {
            start: vi.fn(async () => "t1"), input: vi.fn(), resize: vi.fn(), kill: vi.fn(),
            onData: vi.fn(() => () => undefined), onExit: vi.fn(() => () => undefined),
        },
        settings: {
            get: vi.fn(async () => ({ ...DEFAULT_SETTINGS })),
            update: vi.fn(async (patch) => ({ ...DEFAULT_SETTINGS, ...patch })),
        },
        secrets: { list: vi.fn(async () => []), set: vi.fn(async () => undefined), remove: vi.fn(async () => undefined) },
        mcp: { info: vi.fn(async () => ({ running: false, url: null, port: null, projectId: null, tokenFile: "/u/mcp/token", configs: { claude: "{}", codex: "", gemini: "{}" } })) },
        app: { info: vi.fn(async () => ({ version: "0.1.0", platform: "darwin", arch: "arm64", ffmpeg: { available: true }, whisper: { available: true } })) },
        account: {
            status: vi.fn(async () => ({ state: "signed-out" as const })),
            start: vi.fn(async () => undefined), reopen: vi.fn(async () => undefined), cancel: vi.fn(async () => undefined),
            signOut: vi.fn(async () => undefined), switchAccount: vi.fn(async () => undefined), refresh: vi.fn(async () => undefined),
            openConsole: vi.fn(async () => undefined), connectKey: vi.fn(async () => undefined),
            onChanged: vi.fn(() => () => undefined), onNotice: vi.fn(() => () => undefined),
        },
        providers: {
            list: vi.fn(async () => []), models: vi.fn(async () => []), run: vi.fn(async () => ({ jobId: "job-main1" })),
            transcribe: vi.fn(async () => ({ jobId: "job-main1" })), cancel: vi.fn(async () => ({ cancelled: true })),
            price: vi.fn(async () => ({ kind: "unknown" as const })), voices: vi.fn(async () => []), onJob: vi.fn(() => () => undefined),
        },
        cloud: {
            request: vi.fn(async () => ({ ok: true as const, value: { status: 200, body: {}, etag: null } })),
            describe: vi.fn(async () => null),
            upload: vi.fn(async () => ({ ok: false as const, error: { status: 0, code: "missing_file", message: "No uploads in tests", fromServer: false } })),
            uploadExport: vi.fn(async () => ({ ok: false as const, error: { status: 0, code: "missing_file", message: "No export uploads in tests", fromServer: false } })),
            cache: vi.fn(async () => ({ ok: false as const, error: { status: 400, code: "download_refused", message: "No downloads in tests", fromServer: false } })),
            duplicate: vi.fn(async () => ({ ok: false as const, error: { status: 0, code: "missing_file", message: "No copies in tests", fromServer: false } })),
            storeGet: vi.fn(async (account: string, namespace: CloudNamespace, key: string) => {
                const text = cloudNs(account, namespace).get(key);
                return text === undefined ? null : JSON.parse(text);
            }),
            storePut: vi.fn(async (account: string, namespace: CloudNamespace, key: string, value: unknown) => void cloudNs(account, namespace).set(key, JSON.stringify(value))),
            storeDelete: vi.fn(async (account: string, namespace: CloudNamespace, key: string) => void cloudNs(account, namespace).delete(key)),
            storeKeys: vi.fn(async (account: string, namespace: CloudNamespace) => [...cloudNs(account, namespace).keys()]),
            cachePin: vi.fn(async () => undefined),
            cacheUsage: vi.fn(async () => ({ ok: true as const, value: { ...TEST_CACHE_USAGE } })),
            cacheSetLimit: vi.fn(async (bytes: number | null) => ({ ok: true as const, value: { ...TEST_CACHE_USAGE, limitBytes: bytes ?? TEST_CACHE_USAGE.defaultLimitBytes, custom: bytes !== null } })),
            cacheClear: vi.fn(async () => ({ ok: true as const, value: { freedBytes: 0, keptBytes: 0 } })),
            stream: vi.fn(async () => ({ ok: false as const, error: { status: 503, code: "director_unavailable", message: "No streams in tests", fromServer: false } })) as DesktopBridge["cloud"]["stream"],
            streamAbort: vi.fn(async () => undefined),
        },
        ai: {
            status: vi.fn(async () => ({ available: false, reason: "No whisper.cpp in tests" })),
            models: vi.fn(async () => []),
            transcribe: vi.fn(async () => ({ jobId: "job-test" })),
            stabilize: vi.fn(async () => ({ jobId: "job-stabilize" })),
            cancel: vi.fn(async () => undefined),
            onJob: vi.fn(() => () => undefined),
        },
        ...overrides,
    };
    return { bridge, projects, cloudFiles };
}
