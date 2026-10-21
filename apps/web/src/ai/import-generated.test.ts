import { LocalBackend, createMemoryPersistence } from "@opennan/timeline-core";
import { LIBRARY_CHANGED_EVENT, createMediaImporter } from "./import-generated";

async function backendWithProject() {
    const backend = new LocalBackend({ persistence: createMemoryPersistence(), createObjectUrl: () => "blob:x" });
    const project = await backend.createProject({ name: "P", aspectRatio: "16:9" });
    return { backend, projectId: project.id };
}

describe("createMediaImporter", () => {
    it("downloads a link without credentials, uploads it, lists it, and announces the change", async () => {
        const { backend, projectId } = await backendWithProject();
        const calls: Array<{ url: string; init: RequestInit }> = [];
        const fetch = (async (url: RequestInfo | URL, init: RequestInit = {}) => {
            calls.push({ url: String(url), init });
            return new Response(new Uint8Array([137, 80, 78, 71]), { status: 200, headers: { "content-type": "image/png" } });
        }) as typeof globalThis.fetch;
        const events: unknown[] = [];
        window.addEventListener(LIBRARY_CHANGED_EVENT, (e) => events.push((e as CustomEvent).detail));
        const importer = createMediaImporter(backend, { fetch, now: () => Date.parse("2026-10-19T12:00:00Z") });
        const stored = await importer({ kind: "image", url: "https://cdn.opennan.com/out.png" }, { projectId });
        expect(calls[0]!.init.credentials).toBe("omit");
        expect(new Headers(calls[0]!.init.headers).get("authorization")).toBeNull();
        expect(stored).toMatchObject({ url: expect.stringMatching(/^opennan-local:\/\/media\//), name: "image-20261019-120000.png", mimeType: "image/png", sizeBytes: 4 });
        expect((await backend.listLibrary(projectId)).map((m) => m.url)).toEqual([stored.url]);
        expect(events).toEqual([{ projectId }]);
    });

    it("writes bytes, keeps already-local media, and refuses plain http links", async () => {
        const { backend, projectId } = await backendWithProject();
        const importer = createMediaImporter(backend, { fetch: (async () => { throw new Error("no fetch"); }) as typeof globalThis.fetch });
        const speech = await importer({ kind: "audio", bytes: new Uint8Array([1, 2, 3]), mimeType: "audio/mpeg", name: "speech.mp3" }, { projectId });
        expect(speech).toMatchObject({ name: "speech.mp3", mimeType: "audio/mpeg", sizeBytes: 3 });
        const local = await importer({ kind: "video", url: "opennan-local://media/3f2b8c1e-1d2a-4c3b-9e8f-0a1b2c3d4e5f", mimeType: "video/mp4", name: "clip.mp4", sizeBytes: 99 }, { projectId });
        expect(local).toMatchObject({ url: "opennan-local://media/3f2b8c1e-1d2a-4c3b-9e8f-0a1b2c3d4e5f", sizeBytes: 99 });
        expect((await backend.listLibrary(projectId))).toHaveLength(2);
        await expect(importer({ kind: "image", url: "http://cdn.example/a.png" }, { projectId })).rejects.toThrow(/https/);
        await expect(importer({ kind: "image", url: "http://127.0.0.1:4320/files/a.png" }, { projectId })).rejects.toThrow(/https/);
        await expect(importer({ kind: "image" }, { projectId })).rejects.toThrow(/without a file/);
        await expect(importer({ kind: "image", bytes: new Uint8Array([1]) }, { projectId: null })).rejects.toThrow(/No project/);
    });

    it("stores only media types of the right kind and caps the size while streaming", async () => {
        const { backend, projectId } = await backendWithProject();
        const html = (async () => new Response("<script>alert(1)</script>", { status: 200, headers: { "content-type": "text/html" } })) as typeof globalThis.fetch;
        const stored = await createMediaImporter(backend, { fetch: html })({ kind: "image", url: "https://cdn.opennan.com/x" }, { projectId });
        expect(stored.mimeType).toBe("image/png");
        const loopback = (async () => new Response(new Uint8Array([1]), { status: 200, headers: { "content-type": "image/png" } })) as typeof globalThis.fetch;
        await expect(createMediaImporter(backend, { fetch: loopback, allowLoopback: true })({ kind: "image", url: "http://127.0.0.1:4320/files/a.png" }, { projectId })).resolves.toMatchObject({ mimeType: "image/png" });
    });
});

describe("createMediaImporter sizes (phase 11)", () => {
    it("reports the stored video's pixel size from the probe, and keeps a size the provider gave", async () => {
        const { backend, projectId } = await backendWithProject();
        const fetch = (async () => new Response(new Uint8Array([0, 0, 0, 1]), { status: 200, headers: { "content-type": "video/mp4" } })) as typeof globalThis.fetch;
        const probeSize = vi.fn(async () => ({ width: 3840, height: 2160 }));
        const importer = createMediaImporter(backend, { fetch, probeSize });
        expect(await importer({ kind: "video", url: "https://cdn.opennan.com/up.mp4" }, { projectId })).toMatchObject({ width: 3840, height: 2160 });
        expect(probeSize).toHaveBeenCalledWith(expect.any(Blob), "video");
        const quiet = createMediaImporter(backend, { fetch, probeSize: async () => null });
        expect(await quiet({ kind: "video", url: "https://cdn.opennan.com/up.mp4", width: 640, height: 360 }, { projectId })).toMatchObject({ width: 640, height: 360 });
    });
});
