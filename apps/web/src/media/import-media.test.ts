import { LOCAL_MEDIA_URL_PREFIX, LocalBackend, createMemoryPersistence } from "@opennan/timeline-core";
import { completeMediaDuration, importMediaFiles, type LibraryBackend, type ProbeMedia } from "./import-media";

function backend() {
    let n = 0;
    return new LocalBackend({ persistence: createMemoryPersistence(), idFactory: () => `m-${++n}` });
}

const file = (name: string, type: string, size = 4) => new File([new Uint8Array(size)], name, { type });

describe("importMediaFiles", () => {
    it("uploads supported files in order and adds them to the media bin with their duration", async () => {
        const local = backend();
        const probe: ProbeMedia = async (_file, kind) => (kind === "image" ? {} : { durationSeconds: kind === "video" ? 6 : 2.5 });
        const result = await importMediaFiles(local, "p1", [
            file("clip.webm", "video/webm"), file("notes.txt", "text/plain"), file("voice.wav", "audio/wav"), file("still.png", "image/png"),
        ], probe);
        expect(result.rejected).toEqual([{ name: "notes.txt", reason: "Unsupported file type" }]);
        expect(result.imported.map((m) => [m.name, m.mimeType, m.durationSeconds])).toEqual([
            ["clip.webm", "video/webm", 6], ["voice.wav", "audio/wav", 2.5], ["still.png", "image/png", undefined],
        ]);
        expect(result.imported.every((m) => m.url.startsWith(LOCAL_MEDIA_URL_PREFIX))).toBe(true);
        expect((await local.listLibrary("p1")).map((m) => m.name)).toEqual(["clip.webm", "voice.wav", "still.png"]);
    });

    it("keeps a file whose probe fails, without a duration", async () => {
        const local = backend();
        const result = await importMediaFiles(local, "p1", [file("broken.mp4", "video/mp4")], async () => { throw new Error("decode"); });
        expect(result.imported).toHaveLength(1);
        expect(result.imported[0].durationSeconds).toBeUndefined();
    });

    it("reports a failed upload and continues with the next file", async () => {
        const local = backend();
        let calls = 0;
        const flaky: LibraryBackend = {
            uploadFile: async (...args) => {
                calls += 1;
                if (calls === 1) throw new Error("Disk full");
                return local.uploadFile(...args);
            },
            saveToLibrary: (projectId, media) => local.saveToLibrary(projectId, media),
        };
        const result = await importMediaFiles(flaky, "p1", [file("a.mp4", "video/mp4"), file("b.mp4", "video/mp4")], async () => ({}));
        expect(result.rejected).toEqual([{ name: "a.mp4", reason: "Disk full" }]);
        expect(result.imported.map((m) => m.name)).toEqual(["b.mp4"]);
    });

    it("rejects files over the size limit before storing them", async () => {
        const local = backend();
        const result = await importMediaFiles(local, "p1", [file("big.mp4", "video/mp4", 8), file("ok.mp4", "video/mp4", 4)], async () => ({}), { maxBytes: 4 });
        expect(result.rejected).toEqual([{ name: "big.mp4", reason: "Larger than 4 B, the editor's limit per file" }]);
        expect((await local.listLibrary("p1")).map((m) => m.name)).toEqual(["ok.mp4"]);
    });

    it("explains a full browser storage with the usage", async () => {
        const local = backend();
        const full: LibraryBackend = {
            uploadFile: async () => { throw new DOMException("The quota has been exceeded.", "QuotaExceededError"); },
            saveToLibrary: (projectId, media) => local.saveToLibrary(projectId, media),
        };
        const MB = 1024 * 1024;
        const result = await importMediaFiles(full, "p1", [file("a.mp4", "video/mp4")], async () => ({}), {
            estimate: async () => ({ usage: 512 * MB, quota: 1024 * MB }),
        });
        expect(result.rejected).toEqual([{ name: "a.mp4", reason: "Not enough browser storage (512.0 MB of 1.00 GB used)" }]);
    });

    it("probes the stored blob of media that arrived without a duration", async () => {
        const local = backend();
        const video = await local.uploadFile("p1", file("clip.webm", "video/webm"), "video");
        const image = await local.uploadFile("p1", file("still.png", "image/png"), "image");
        const probe = vi.fn<ProbeMedia>(async (blob) => ({ durationSeconds: blob.size === 4 ? 7 : 1 }));
        expect((await completeMediaDuration(local, video, probe)).durationSeconds).toBe(7);
        expect(await completeMediaDuration(local, image, probe)).toEqual(image);
        expect(await completeMediaDuration(local, { ...video, durationSeconds: 3 }, probe)).toMatchObject({ durationSeconds: 3 });
        expect(probe).toHaveBeenCalledTimes(1);
    });
});
