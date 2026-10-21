import { BackendRouter, CLOUD_SIGN_IN_NEEDED, CloudApiError, OpenNanCloudBackend } from "@opennan/cloud-backend";
import type { SessionStatus } from "@opennan/provider-opennan";
import { ProviderRegistry } from "@opennan/provider-sdk";
import { signedOutAccount } from "@opennan/web/studio";
import { createIpcPersistence } from "./ipc-persistence";
import { DesktopBackend } from "./desktop-backend";
import { createDesktopMediaEnvironment } from "./media-environment";
import { createDesktopRuntime } from "./desktop-runtime";
import { TEST_CACHE_USAGE, createTestBridge } from "./test-bridge";

const ID = "3f2b8c1e-1d2a-4c3b-9e8f-0a1b2c3d4e5f";
const APP = "opennan-app://app";
const exportPlatform = { resolutions: ["720p"], formatLabel: "x", resolutionNote: null, gl: true, createExporter: vi.fn() } as never;

describe("ipc persistence", () => {
    it("round-trips projects through the bridge and never moves blobs over IPC", async () => {
        const { bridge } = createTestBridge();
        const persistence = createIpcPersistence(bridge);
        const state = { meta: { id: "p", name: "P", musicUrl: null, musicVolume: 1, aspectRatio: "16:9" }, tracks: [], clips: [], scenes: [] };
        await persistence.saveProject("p", state);
        await expect(persistence.loadProject("p")).resolves.toEqual(state);
        await expect(persistence.listProjects!()).resolves.toHaveLength(1);
        await expect(persistence.getBlob("x")).resolves.toBeNull();
        await expect(persistence.putBlob("x", new Blob())).rejects.toThrow("uploadFile");
        // Main deletes a project's files with its row (only the files that project owns), never one by id from here.
        await persistence.deleteBlob!("x");
        expect(bridge.media.delete).not.toHaveBeenCalled();
    });
});

describe("DesktopBackend", () => {
    it("hands files to main and returns main's media", async () => {
        const { bridge } = createTestBridge();
        const backend = new DesktopBackend({ persistence: createIpcPersistence(bridge) }, bridge);
        const project = await backend.createProject({ name: "Trip" });
        const file = new File([new Uint8Array(4)], "clip.mp4", { type: "video/mp4" });
        const onProgress = vi.fn();
        const media = await backend.uploadFile(project.id, file, "video", { onProgress });
        expect(bridge.media.import).toHaveBeenCalledWith(project.id, file, "video");
        expect(media).toMatchObject({ url: `opennan-local://media/${ID}`, durationSeconds: 6 });
        expect(onProgress).toHaveBeenCalledWith(100);
        await expect(backend.readMedia(media.url)).resolves.toBeNull();
    });

    it("refuses an aborted upload before calling main", async () => {
        const { bridge } = createTestBridge();
        const backend = new DesktopBackend({ persistence: createIpcPersistence(bridge) }, bridge);
        const controller = new AbortController();
        controller.abort();
        await expect(backend.uploadFile("p", new Blob(), "video", { signal: controller.signal })).rejects.toThrow("aborted");
        expect(bridge.media.import).not.toHaveBeenCalled();
    });

    it("deleting a project deletes its row (main removes the files it owns) and no media by id", async () => {
        const { bridge } = createTestBridge();
        const backend = new DesktopBackend({ persistence: createIpcPersistence(bridge) }, bridge);
        const project = await backend.createProject({ name: "Trip" });
        const media = await backend.uploadFile(project.id, new File([new Uint8Array(1)], "a.mp4", { type: "video/mp4" }), "video");
        await backend.saveToLibrary(project.id, media);
        await backend.deleteProject(project.id);
        expect(bridge.media.delete).not.toHaveBeenCalled();
        expect(bridge.persistence.delete).toHaveBeenCalledWith(project.id);
    });
});

describe("DesktopBackend.detachProject (Save to OpenNan)", () => {
    it("releases the project's media in main before removing the document, and deletes no media", async () => {
        const { bridge } = createTestBridge();
        const order: string[] = [];
        vi.mocked(bridge.media.releaseProject).mockImplementation(async () => void order.push("release"));
        vi.mocked(bridge.persistence.delete).mockImplementation(async () => void order.push("delete"));
        const backend = new DesktopBackend({ persistence: createIpcPersistence(bridge) }, bridge);
        const project = await backend.createProject({ name: "Trip" });
        const media = await backend.uploadFile(project.id, new File([new Uint8Array(1)], "a.mp4", { type: "video/mp4" }), "video");
        await backend.saveToLibrary(project.id, media);
        await backend.detachProject(project.id);
        expect(order).toEqual(["release", "delete"]);
        expect(bridge.media.releaseProject).toHaveBeenCalledWith(project.id);
        expect(bridge.media.delete).not.toHaveBeenCalled();
    });
});

describe("desktop media environment", () => {
    it("plays imported media and refuses everything else", () => {
        const media = createDesktopMediaEnvironment(APP);
        expect(media.resolveMediaUrl(`opennan-local://media/${ID}`)).toBe(`opennan-media://blob/${ID}`);
        expect(media.resolveMediaUrl(`blob:${APP}/x`)).toBe(`blob:${APP}/x`);
        expect(media.resolveMediaUrl("https://evil.test/a.mp4").startsWith("opennan-media://refused/")).toBe(true);
        expect(media.canFetchMediaBytes!("https://evil.test/a.mp4")).toBe(false);
        expect(media.canFetchMediaBytes!(`opennan-local://media/${ID}`)).toBe(true);
        expect(media.shouldPreloadBlob!(`opennan-local://media/${ID}`)).toBe(false);
    });
});

describe("desktop runtime", () => {
    it("describes the desktop platform", async () => {
        const { bridge } = createTestBridge({ e2e: true });
        const providers = new ProviderRegistry();
        const runtime = createDesktopRuntime(bridge, { appOrigin: APP, ui: {}, exportPlatform, providers });
        expect(runtime.platform).toBe("desktop");
        expect(runtime.debug).toBe(true);
        expect(runtime.maxMediaBytes).toBeGreaterThan(2 * 1024 ** 3);
        await expect(runtime.storage.persisted()).resolves.toBe("persistent");
        expect(runtime.backend).toBeInstanceOf(BackendRouter);
        expect((runtime.backend as BackendRouter).local).toBeInstanceOf(DesktopBackend);
        expect((window as unknown as { __studioCloud?: unknown }).__studioCloud).toBe(runtime.cloud);
        delete (window as unknown as { __studioCloud?: unknown }).__studioCloud;
        // Share links on the e2e fake's loopback are accepted in e2e runs only (review 9c.1).
        expect(runtime.cloud?.loopbackShares).toBe(true);
        const production = createDesktopRuntime(createTestBridge().bridge, { appOrigin: APP, ui: {}, exportPlatform, providers });
        expect(production.cloud?.loopbackShares).toBeUndefined();
        expect((window as unknown as { __studioCloud?: unknown }).__studioCloud).toBeUndefined();
        expect(runtime.providers).toBe(providers);
    });

    it("routes local projects to the local backend with no cloud work, and cloud ids to the account's cloud backend", async () => {
        const { bridge } = createTestBridge();
        const build = vi.fn();
        const runtime = createDesktopRuntime(bridge, { appOrigin: APP, ui: {}, exportPlatform, providers: new ProviderRegistry(), buildCloud: build });
        const project = await runtime.backend.createProject({ name: "Trip" });
        await runtime.backend.loadTimeline(project.id);
        runtime.retainProject(project.id)();
        expect(build).not.toHaveBeenCalled();
        expect(bridge.cloud.request).not.toHaveBeenCalled();
        expect(bridge.cloud.storeGet).not.toHaveBeenCalled();
        // Signed out: no cloud backend, a cloud project asks to sign in.
        expect(runtime.cloud?.backend()).toBeNull();
        await expect(runtime.backend.loadTimeline("cloud-srv1")).rejects.toThrow(CLOUD_SIGN_IN_NEEDED);
    });

    it("builds one cloud backend per signed-in account over the bridge, filed under the account's email", async () => {
        const { bridge } = createTestBridge();
        let status: SessionStatus = { state: "signed-in", account: { email: "Ada@Example.com", displayName: "Ada", photoUrl: null, balanceUsd: 1 } } as never;
        const listeners = new Set<() => void>();
        const account = signedOutAccount({ status: () => status, subscribe: (l) => (listeners.add(l), () => listeners.delete(l)) });
        const runtime = createDesktopRuntime(bridge, { appOrigin: APP, ui: {}, exportPlatform, providers: new ProviderRegistry(), account });
        const cloud = runtime.cloud!.backend()!;
        expect(cloud).toBeInstanceOf(OpenNanCloudBackend);
        expect(runtime.cloud!.backend()).toBe(cloud);
        vi.mocked(bridge.cloud.request).mockResolvedValue({ ok: true, value: { status: 200, body: { data: [], next_cursor: null }, etag: null } });
        await cloud.listCloudProjects();
        expect(bridge.cloud.storePut).toHaveBeenCalledWith("ada@example.com", "lists", "active", []);
        status = { state: "signed-out" };
        for (const l of listeners) l();
        await cloud.dispose();
    });

    it("reads, limits and clears the cloud media cache through main, main's errors as CloudApiError", async () => {
        const { bridge } = createTestBridge();
        const runtime = createDesktopRuntime(bridge, { appOrigin: APP, ui: {}, exportPlatform, providers: new ProviderRegistry() });
        const cache = runtime.mediaCache!;
        expect(await cache.usage()).toEqual(TEST_CACHE_USAGE);
        expect(await cache.setLimit(2 * 1024 ** 3)).toMatchObject({ limitBytes: 2 * 1024 ** 3, custom: true });
        expect(bridge.cloud.cacheSetLimit).toHaveBeenLastCalledWith(2 * 1024 ** 3);
        expect(await cache.setLimit(null)).toMatchObject({ custom: false });
        expect(await cache.clear()).toEqual({ freedBytes: 0, keptBytes: 0 });
        vi.mocked(bridge.cloud.cacheUsage).mockResolvedValueOnce({ ok: false, error: { status: 0, code: "desktop_failed", message: "disk full", fromServer: false } });
        const error = await cache.usage().catch((e: unknown) => e);
        expect(error).toBeInstanceOf(CloudApiError);
        expect(error).toMatchObject({ code: "desktop_failed", message: "disk full" });
        vi.mocked(bridge.cloud.cacheSetLimit).mockRejectedValueOnce(new Error("Invalid opennan:cloud:cache-set-limit payload"));
        await expect(cache.setLimit(1)).rejects.toMatchObject({ name: "CloudApiError", code: "desktop_refused" });
    });

    it("files the cloud backend under the account id once OpenNan sends one, moving the email store's records first", async () => {
        const { bridge, cloudFiles } = createTestBridge();
        await bridge.cloud.storePut("ada@example.com", "sync", "cloud-old", { revision: 1 });
        const status = { state: "signed-in", account: { email: "Ada@Example.com", accountId: "usr_42", displayName: "Ada", photoUrl: null, balanceUsd: 1 } } as never as SessionStatus;
        const account = signedOutAccount({ status: () => status, subscribe: () => () => undefined });
        const runtime = createDesktopRuntime(bridge, { appOrigin: APP, ui: {}, exportPlatform, providers: new ProviderRegistry(), account });
        const cloud = runtime.cloud!.backend()!;
        vi.mocked(bridge.cloud.request).mockResolvedValue({ ok: true, value: { status: 200, body: { data: [], next_cursor: null }, etag: null } });
        await cloud.listCloudProjects();
        expect(bridge.cloud.storePut).toHaveBeenCalledWith("id:usr_42", "lists", "active", []);
        expect(cloudFiles.get("id:usr_42|sync")?.has("cloud-old")).toBe(true);
        expect(cloudFiles.get("ada@example.com|sync")?.has("cloud-old")).toBe(false);
        await cloud.dispose();
    });

    it("reads the storage meter through main's proxy without building the cloud backend", async () => {
        const { bridge } = createTestBridge();
        const status = { state: "signed-in", account: { email: "ada@example.com", displayName: "Ada", photoUrl: null, balanceUsd: 1 } } as never as SessionStatus;
        const account = signedOutAccount({ status: () => status, subscribe: () => () => undefined });
        const build = vi.fn();
        const runtime = createDesktopRuntime(bridge, { appOrigin: APP, ui: {}, exportPlatform, providers: new ProviderRegistry(), account, buildCloud: build });
        vi.mocked(bridge.cloud.request).mockResolvedValue({ ok: true, value: { status: 200, body: { media_bytes: 10, limits: { media_bytes: 100 } }, etag: null } });
        await expect(runtime.cloud!.storage()).resolves.toMatchObject({ mediaBytes: 10 });
        expect(bridge.cloud.request).toHaveBeenCalledWith("GET", "/v1/storage", {});
        expect(build).not.toHaveBeenCalled();
    });
});
