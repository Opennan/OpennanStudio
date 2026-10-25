import { ProviderRegistry } from "@opennan/provider-sdk";
import { createIpcPersistence } from "./ipc-persistence";
import { DesktopBackend } from "./desktop-backend";
import { createDesktopMediaEnvironment } from "./media-environment";
import { createDesktopRuntime } from "./desktop-runtime";
import { createTestBridge } from "./test-bridge";

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
        expect(runtime.backend).toBeInstanceOf(DesktopBackend);
        expect(runtime.providers).toBe(providers);
    });

    it("keeps projects in the local backend over the bridge's persistence", async () => {
        const { bridge } = createTestBridge();
        const runtime = createDesktopRuntime(bridge, { appOrigin: APP, ui: {}, exportPlatform, providers: new ProviderRegistry() });
        const project = await runtime.backend.createProject({ name: "Trip" });
        await runtime.backend.loadTimeline(project.id);
        runtime.retainProject(project.id)();
        expect((await runtime.backend.listProjects()).map((p) => p.name)).toEqual(["Trip"]);
    });

});
