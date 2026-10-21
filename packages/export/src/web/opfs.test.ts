// OPFS export files with a fake origin private file system: positioned writes, a stream a mediabunny target already
// closed (locked), abort deleting the file, stale files swept, and only safe names removed.
import { createOpfsFile, createOpfsVideoSink, opfsAvailable, removeOpfsExport, sweepOpfsExports } from "./opfs";

class FakeFile {
    bytes = new Uint8Array(0);
    lastModified = Date.now();
}

function fakeFileSystem() {
    const files = new Map<string, FakeFile>();
    const dir = {
        kind: "directory",
        async getFileHandle(name: string, options?: { create?: boolean }) {
            if (!files.has(name)) {
                if (!options?.create) throw new DOMException("missing", "NotFoundError");
                files.set(name, new FakeFile());
            }
            const file = files.get(name)!;
            return {
                kind: "file",
                async createWritable() {
                    let staged = new Uint8Array(0);
                    return new WritableStream<{ type: "write"; data: Uint8Array; position: number }>({
                        write({ data, position }) {
                            if (position + data.byteLength > staged.byteLength) {
                                const grown = new Uint8Array(position + data.byteLength);
                                grown.set(staged);
                                staged = grown;
                            }
                            staged.set(data, position);
                        },
                        close() {
                            file.bytes = staged;
                            file.lastModified = Date.now();
                        },
                    });
                },
                async getFile() {
                    return Object.assign(new Blob([file.bytes]), { lastModified: file.lastModified });
                },
            };
        },
        async removeEntry(name: string) {
            if (!files.delete(name)) throw new DOMException("missing", "NotFoundError");
        },
        async *entries() {
            for (const name of files.keys()) yield [name, await dir.getFileHandle(name)] as const;
        },
    };
    const root = { async getDirectoryHandle() { return dir; } };
    return { files, root };
}

describe("OPFS export files", () => {
    let fs: ReturnType<typeof fakeFileSystem>;
    beforeEach(() => {
        fs = fakeFileSystem();
        vi.stubGlobal("navigator", { storage: { getDirectory: async () => fs.root } });
        vi.stubGlobal("FileSystemFileHandle", class { createWritable() {} });
    });
    afterEach(() => vi.unstubAllGlobals());

    it("is available with a writable OPFS and writes at positions", async () => {
        expect(opfsAvailable()).toBe(true);
        const file = await createOpfsFile("video", "mp4");
        const writer = file.writable.getWriter();
        await writer.write({ type: "write", data: new Uint8Array([3, 4]), position: 2 });
        await writer.write({ type: "write", data: new Uint8Array([1, 2]), position: 0 });
        writer.releaseLock();
        const blob = await file.finish();
        expect([...new Uint8Array(await blob.arrayBuffer())]).toEqual([1, 2, 3, 4]);
        expect(file.name).toMatch(/^video-\d+-\d+\.mp4$/);
    });

    it("hands over a file whose stream a mediabunny target already closed (still locked)", async () => {
        const file = await createOpfsFile("export", "webm");
        const writer = file.writable.getWriter();
        await writer.write({ type: "write", data: new Uint8Array([9]), position: 0 });
        await writer.close();
        const blob = await file.finish();
        expect(blob.size).toBe(1);
    });

    it("aborting deletes the file; the video sink releases its file after the mux", async () => {
        const file = await createOpfsFile("video", "mp4");
        await file.abort();
        expect(fs.files.has(file.name)).toBe(false);
        const sink = await createOpfsVideoSink("mp4");
        const writer = sink.writable.getWriter();
        await writer.write({ type: "write", data: new Uint8Array([1]), position: 0 });
        await writer.close();
        const video = await sink.done();
        expect(video).toMatchObject({ kind: "blob", opfsName: expect.stringMatching(/^video-/) });
        await sink.release?.();
        expect(fs.files.size).toBe(0);
    });

    it("sweeps stale files and never removes names with path syntax", async () => {
        const old = await createOpfsFile("export", "mp4");
        await old.finish();
        fs.files.get(old.name)!.lastModified = Date.now() - 2 * 60 * 60 * 1000;
        const fresh = await createOpfsFile("export", "mp4");
        await fresh.finish();
        expect(await sweepOpfsExports()).toBe(1);
        expect([...fs.files.keys()]).toEqual([fresh.name]);
        await removeOpfsExport("../" + fresh.name);
        expect(fs.files.has(fresh.name)).toBe(true);
        await removeOpfsExport(fresh.name);
        expect(fs.files.size).toBe(0);
    });
});
