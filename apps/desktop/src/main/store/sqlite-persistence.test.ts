import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LocalBackend, createEmptyProject, type LocalProjectState } from "@opennan/timeline-core";
import { describeTimelineBackendContract } from "@opennan/timeline-core/testing";
import { openDatabase } from "./database";
import { createMediaStore } from "./media-store";
import { createLocalReferenceScan, createSqlitePersistence } from "./sqlite-persistence";

function tempStore() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opennan-persist-"));
    const file = path.join(dir, "store.sqlite");
    const db = openDatabase(file);
    const media = createMediaStore({ db, root: path.join(dir, "media") });
    return { dir, file, db, media, cleanup: () => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

describeTimelineBackendContract("LocalBackend (SQLite persistence)", async () => {
    const { db, media, cleanup } = tempStore();
    const backend = new LocalBackend({ persistence: createSqlitePersistence({ db, media }) });
    return { backend, projectId: randomUUID(), cleanup };
});

const stateFor = (id: string, name = "P"): LocalProjectState => ({ ...createEmptyProject(id), meta: { ...createEmptyProject(id).meta, name } });

describe("createSqlitePersistence", () => {
    let store: ReturnType<typeof tempStore>;
    beforeEach(() => {
        store = tempStore();
    });
    afterEach(() => store.cleanup());

    it("round-trips project state and lists projects, newest first", async () => {
        let clock = 1;
        const p = createSqlitePersistence({ db: store.db, media: store.media, now: () => clock++ });
        const a = randomUUID();
        const b = randomUUID();
        await p.saveProject(a, stateFor(a, "A"));
        await p.saveProject(b, { ...stateFor(b, "B"), updatedAt: 99 });
        expect(await p.loadProject(a)).toEqual(stateFor(a, "A"));
        expect((await p.listProjects!()).map((s) => s.meta.name)).toEqual(["B", "A"]);
        expect(await p.loadProject(randomUUID())).toBeNull();
    });

    it("survives reopening the database file", async () => {
        const id = randomUUID();
        await createSqlitePersistence({ db: store.db, media: store.media }).saveProject(id, stateFor(id, "Kept"));
        store.db.close();
        const db = openDatabase(store.file);
        expect((await createSqlitePersistence({ db, media: store.media }).loadProject(id))?.meta.name).toBe("Kept");
        db.close();
        store.db = openDatabase(store.file);
    });

    it("deleteProject removes the row and the project's media files", async () => {
        const id = randomUUID();
        const p = createSqlitePersistence({ db: store.db, media: store.media });
        await p.saveProject(id, stateFor(id));
        const source = path.join(store.dir, "a.mp4");
        fs.writeFileSync(source, "v");
        const media = await store.media.importPath({ projectId: id, path: source, kind: "video" });
        const mediaId = media.url.slice("opennan-local://media/".length);
        const file = store.media.pathOf(mediaId)!;
        await p.deleteProject!(id);
        expect(await p.loadProject(id)).toBeNull();
        expect(fs.existsSync(file)).toBe(false);
    });

    it("refuses a state whose meta.id is not the row id", async () => {
        const p = createSqlitePersistence({ db: store.db, media: store.media });
        await expect(p.saveProject(randomUUID(), stateFor(randomUUID()))).rejects.toThrow("meta.id");
    });

    it("stores and reads blobs as disk-backed files", async () => {
        const p = createSqlitePersistence({ db: store.db, media: store.media });
        const id = randomUUID();
        await p.putBlob(id, new Blob([new Uint8Array([1, 2])], { type: "image/png" }));
        const blob = await p.getBlob(id);
        expect(blob?.type).toBe("image/png");
        expect(new Uint8Array(await blob!.arrayBuffer())).toEqual(new Uint8Array([1, 2]));
        await p.deleteBlob!(id);
        expect(await p.getBlob(id)).toBeNull();
        await expect(p.putBlob("nope", new Blob(["x"], { type: "image/png" }))).rejects.toThrow("invalid media id");
    });

    it("tells whether any local project's saved document names a media file (in either URL form)", async () => {
        const p = createSqlitePersistence({ db: store.db, media: store.media });
        const named = randomUUID();
        const viaProtocol = randomUUID();
        const a = randomUUID();
        await p.saveProject(a, { ...stateFor(a), scenes: [{ id: "s1", mediaUrl: `opennan-local://media/${named}`, posterUrl: `opennan-media://blob/${viaProtocol}` }] as never });
        const scan = createLocalReferenceScan(store.db);
        const unnamed = randomUUID();
        // One pass over the projects for every candidate (review: Clear cache with many files never stalls main).
        expect([...scan([named, viaProtocol, unnamed, "not-a-uuid"])].sort()).toEqual([named, viaProtocol, "not-a-uuid"].sort());
        expect(scan([])).toEqual(new Set());
    });

    it("counts every candidate as named when the projects can't be read (fail closed)", () => {
        const broken = { prepare: () => { throw new Error("database is locked"); } } as unknown as Parameters<typeof createLocalReferenceScan>[0];
        const id = randomUUID();
        expect([...createLocalReferenceScan(broken)([id])]).toEqual([id]);
    });
});
