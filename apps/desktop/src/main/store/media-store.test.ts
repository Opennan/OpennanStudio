import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase, type DesktopDatabase } from "./database";
import { createMediaStore, type MediaStore } from "./media-store";

const P = "3f2b8c1e-1d2a-4c3b-9e8f-0a1b2c3d4e5f";
const Q = "4f2b8c1e-1d2a-4c3b-9e8f-0a1b2c3d4e5f";

describe("media store", () => {
    let dir: string;
    let root: string;
    let db: DesktopDatabase;
    let store: MediaStore;
    let video: string;

    beforeEach(() => {
        dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "opennan-media-")));
        root = path.join(dir, "media");
        db = openDatabase(":memory:");
        store = createMediaStore({ db, root, probe: async () => ({ durationSeconds: 6 }) });
        video = path.join(dir, "clip.mp4");
        fs.writeFileSync(video, Buffer.alloc(1234, 7));
    });
    afterEach(() => {
        db.close();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    const idOf = (url: string) => url.slice("opennan-local://media/".length);

    it("imports a file by path with a new id, its extension, and a probed duration", async () => {
        const media = await store.importPath({ projectId: P, path: video, kind: "video" });
        expect(media).toMatchObject({ name: "clip.mp4", size: 1234, mimeType: "video/mp4", durationSeconds: 6 });
        expect(media.url).toMatch(/^opennan-local:\/\/media\/[0-9a-f-]{36}$/);
        const id = idOf(media.url);
        expect(fs.readFileSync(path.join(root, `${id}.mp4`))).toEqual(fs.readFileSync(video));
        expect(store.pathOf(id)).toBe(path.join(store.root, `${id}.mp4`));
        expect(store.info(id)).toMatchObject({ projectId: P, originalName: "clip.mp4", durationSeconds: 6 });
    });

    it("returns the probed pixel size of a video or image (none for audio or unreadable files)", async () => {
        const sized = createMediaStore({ db, root, probe: async (file) => (file.endsWith(".mp4") ? { durationSeconds: 2, width: 1920, height: 1080 } : { durationSeconds: 2, width: 0, height: 0 }) });
        expect(await sized.importPath({ projectId: P, path: video, kind: "video" })).toMatchObject({ width: 1920, height: 1080, durationSeconds: 2 });
        const audio = await sized.importBytes({ projectId: P, name: "a.wav", mimeType: "audio/wav", kind: "audio", bytes: new Uint8Array(4) });
        expect(audio.width).toBeUndefined();
    });

    it("refuses paths that are not regular media files", async () => {
        const text = path.join(dir, "notes.txt");
        fs.writeFileSync(text, "secret");
        await expect(store.importPath({ projectId: P, path: "relative.mp4", kind: "video" })).rejects.toThrow("absolute");
        await expect(store.importPath({ projectId: P, path: "//attacker.example/share/a.mp4", kind: "video" })).rejects.toThrow("Network paths");
        await expect(store.importPath({ projectId: P, path: text, kind: "video" })).rejects.toThrow("not a supported media file");
        fs.mkdirSync(path.join(dir, "folder.mp4"));
        await expect(store.importPath({ projectId: P, path: path.join(dir, "folder.mp4"), kind: "video" })).rejects.toThrow("not a file");
        await expect(store.importPath({ projectId: P, path: path.join(dir, "missing.mp4"), kind: "video" })).rejects.toThrow("does not exist");
        const media = await store.importPath({ projectId: P, path: video, kind: "video" });
        await expect(store.importPath({ projectId: P, path: store.pathOf(idOf(media.url))!, kind: "video" })).rejects.toThrow("already in the media library");
    });

    it.skipIf(process.platform === "win32")("checks a symlink's target, not its name", async () => {
        const secret = path.join(dir, "secret.txt");
        fs.writeFileSync(secret, "secret");
        fs.symlinkSync(secret, path.join(dir, "link.mp4"));
        await expect(store.importPath({ projectId: P, path: path.join(dir, "link.mp4"), kind: "video" })).rejects.toThrow("not a supported media file");
        fs.symlinkSync(video, path.join(dir, "link2.mp4"));
        await expect(store.importPath({ projectId: P, path: path.join(dir, "link2.mp4"), kind: "video" })).resolves.toMatchObject({ name: "link2.mp4" });
    });

    it("imports bytes up to the cap", async () => {
        const small = createMediaStore({ db, root, maxBytes: 4 });
        await expect(small.importBytes({ projectId: P, name: "a.png", mimeType: "image/png", kind: "image", bytes: new Uint8Array([1, 2, 3]) }))
            .resolves.toMatchObject({ name: "a.png", size: 3, mimeType: "image/png" });
        await expect(small.importBytes({ projectId: P, name: "b.png", mimeType: "image/png", kind: "image", bytes: new Uint8Array(5) })).rejects.toThrow("too large");
        await expect(small.importBytes({ projectId: P, name: "c.exe", mimeType: "application/x-msdownload", kind: "image", bytes: new Uint8Array(1) })).rejects.toThrow("not a supported");
        await expect(small.importBytes({ projectId: P, name: "blob", mimeType: "audio/wav", kind: "audio", bytes: new Uint8Array(2) })).resolves.toMatchObject({ mimeType: "audio/wav" });
    });

    it("stores a Blob by streaming it", async () => {
        const media = await store.putBlob(new Blob([new Uint8Array([9, 8, 7])], { type: "audio/wav" }), { projectId: P, name: "a.wav", mimeType: "audio/wav" });
        expect(fs.readFileSync(store.pathOf(idOf(media.url))!)).toEqual(Buffer.from([9, 8, 7]));
        const id = randomUUID();
        await expect(store.putBlob(new Blob(["x"]), { projectId: null, name: "x.wav", mimeType: "audio/wav", id })).resolves.toMatchObject({ url: `opennan-local://media/${id}` });
        await expect(store.putBlob(new Blob(["x"]), { projectId: null, name: "x.wav", mimeType: "audio/wav", id: "../x" })).rejects.toThrow("invalid media id");
    });

    it("resolves only known ids to files inside the root", () => {
        expect(store.pathOf("not-a-uuid")).toBeNull();
        expect(store.pathOf(randomUUID())).toBeNull();
        const evil = randomUUID();
        db.prepare("insert into media values (?, ?, ?, ?, ?, ?, ?, ?)").run(evil, P, "../../etc/passwd", "video/mp4", 1, "x", null, 0);
        expect(store.pathOf(evil)).toBeNull();
        const other = randomUUID();
        db.prepare("insert into media values (?, ?, ?, ?, ?, ?, ?, ?)").run(other, P, `${randomUUID()}.mp4`, "video/mp4", 1, "x", null, 0);
        expect(store.pathOf(other)).toBeNull(); // file name must belong to the row's id
    });

    it("deletes one file and every file of a project", async () => {
        const a = await store.importPath({ projectId: P, path: video, kind: "video" });
        const b = await store.importPath({ projectId: P, path: video, kind: "video" });
        const c = await store.importPath({ projectId: Q, path: video, kind: "video" });
        const fileA = store.pathOf(idOf(a.url))!;
        await store.delete(idOf(a.url));
        expect(fs.existsSync(fileA)).toBe(false);
        expect(store.info(idOf(a.url))).toBeNull();
        await store.deleteProject(P);
        expect(store.pathOf(idOf(b.url))).toBeNull();
        expect(store.pathOf(idOf(c.url))).not.toBeNull();
    });
    it("adopts a downloaded file by moving it into the library (cloud cache)", async () => {
        const temp = path.join(dir, "download.part");
        fs.writeFileSync(temp, Buffer.alloc(10, 3));
        const media = await store.adoptFile({ projectId: null, path: temp, name: "clip.webm", mimeType: "video/webm" });
        expect(media).toMatchObject({ name: "clip.webm", size: 10, mimeType: "video/webm", durationSeconds: 6 });
        expect(fs.existsSync(temp)).toBe(false);
        expect(fs.readFileSync(store.pathOf(media.id)!)).toEqual(Buffer.alloc(10, 3));
        expect(store.info(media.id)).toMatchObject({ projectId: null, originalName: "clip.webm" });
        // The extension comes from the name, else the type; anything else is refused and the file stays where it was.
        const typed = path.join(dir, "typed.part");
        fs.writeFileSync(typed, "x");
        await expect(store.adoptFile({ projectId: null, path: typed, name: "blob", mimeType: "audio/mpeg" })).resolves.toMatchObject({ mimeType: "audio/mpeg" });
        const text = path.join(dir, "notes.part");
        fs.writeFileSync(text, "x");
        await expect(store.adoptFile({ projectId: null, path: text, name: "notes.txt", mimeType: "text/plain" })).rejects.toThrow("not a supported media file");
        expect(fs.existsSync(text)).toBe(true);
        await expect(store.adoptFile({ projectId: null, path: "relative.part", name: "a.mp4", mimeType: "video/mp4" })).rejects.toThrow("absolute");
    });

    it("adopts a file under an id main reserved (a cloud download), never one that is taken or not a uuid", async () => {
        const reserved = randomUUID();
        const temp = path.join(dir, "reserved.part");
        fs.writeFileSync(temp, Buffer.alloc(7, 1));
        const media = await store.adoptFile({ id: reserved, projectId: null, path: temp, name: "a.webm", mimeType: "video/webm" });
        expect(media).toMatchObject({ id: reserved, url: `opennan-local://media/${reserved}`, size: 7 });
        expect(fs.readFileSync(store.pathOf(reserved)!)).toEqual(Buffer.alloc(7, 1));
        const again = path.join(dir, "again.part");
        fs.writeFileSync(again, "x");
        await expect(store.adoptFile({ id: reserved, projectId: null, path: again, name: "a.webm", mimeType: "video/webm" })).rejects.toThrow("already");
        expect(fs.readFileSync(store.pathOf(reserved)!)).toEqual(Buffer.alloc(7, 1));
        await expect(store.adoptFile({ id: "../x", projectId: null, path: again, name: "a.webm", mimeType: "video/webm" })).rejects.toThrow("invalid media id");
        // A file left in the root without its row is not overwritten either.
        const orphan = randomUUID();
        fs.writeFileSync(path.join(store.root, `${orphan}.webm`), "old");
        await expect(store.adoptFile({ id: orphan, projectId: null, path: again, name: "a.webm", mimeType: "video/webm" })).rejects.toThrow("already");
        expect(fs.readFileSync(path.join(store.root, `${orphan}.webm`), "utf8")).toBe("old");
        expect(fs.existsSync(again)).toBe(true);
    });

    it("copies a stored file under a new id for another project", async () => {
        const a = await store.importPath({ projectId: P, path: video, kind: "video" });
        const copy = await store.copy(a.id, Q);
        expect(copy.id).not.toBe(a.id);
        expect(copy).toMatchObject({ name: "clip.mp4", size: 1234, mimeType: "video/mp4", url: `opennan-local://media/${copy.id}` });
        expect(store.info(copy.id)).toMatchObject({ projectId: Q });
        expect(fs.readFileSync(store.pathOf(copy.id)!)).toEqual(fs.readFileSync(video));
        // Deleting the copy's project keeps the original.
        await store.deleteProject(Q);
        expect(store.pathOf(copy.id)).toBeNull();
        expect(store.pathOf(a.id)).not.toBeNull();
        await expect(store.copy(randomUUID(), Q)).rejects.toThrow("no longer");
        await expect(store.copy("../x", Q)).rejects.toThrow("no longer");
    });

    it("releases a project's files so deleting the project keeps them (Save to OpenNan)", async () => {
        const a = await store.importPath({ projectId: P, path: video, kind: "video" });
        const b = await store.importPath({ projectId: Q, path: video, kind: "video" });
        store.releaseProject(P);
        expect(store.info(a.id)).toMatchObject({ projectId: null });
        await store.deleteProject(P);
        expect(store.pathOf(a.id)).not.toBeNull();
        expect(store.info(b.id)).toMatchObject({ projectId: Q });
    });
    it("deletes a file for a project only when that project owns it", async () => {
        const owned = await store.importPath({ projectId: P, path: video, kind: "video" });
        const other = await store.importPath({ projectId: Q, path: video, kind: "video" });
        const released = await store.importPath({ projectId: P, path: video, kind: "video" });
        store.releaseProject(P);
        const mine = await store.importPath({ projectId: P, path: video, kind: "video" });
        expect(await store.deleteOwned(P, mine.id)).toBe(true);
        expect(store.pathOf(mine.id)).toBeNull();
        expect(await store.deleteOwned(P, other.id)).toBe(false);
        expect(await store.deleteOwned(P, released.id)).toBe(false);
        expect(await store.deleteOwned(P, owned.id)).toBe(false); // released with the project above
        expect(await store.deleteOwned(P, randomUUID())).toBe(false);
        for (const media of [other, released, owned]) expect(store.pathOf(media.id)).not.toBeNull();
    });
    it("removes an adopted file again when it cannot be recorded", async () => {
        const other = openDatabase(":memory:");
        const broken = createMediaStore({ db: other, root });
        other.close();
        const temp = path.join(dir, "download.part");
        fs.writeFileSync(temp, "x");
        const before = fs.readdirSync(root);
        await expect(broken.adoptFile({ projectId: null, path: temp, name: "a.webm", mimeType: "video/webm" })).rejects.toThrow();
        expect(fs.readdirSync(root)).toEqual(before);
    });
});
