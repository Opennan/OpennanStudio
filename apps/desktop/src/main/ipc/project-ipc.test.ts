import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { IPC } from "../../shared/ipc";
import { openDatabase, type DesktopDatabase } from "../store/database";
import { createMediaStore, type MediaStore } from "../store/media-store";
import { createSqlitePersistence } from "../store/sqlite-persistence";
import type { IpcEventLike, IpcMainLike } from "./handle";
import { registerProjectIpc } from "./project-ipc";

describe("project IPC", () => {
    let dir: string;
    let db: DesktopDatabase;
    let media: MediaStore;
    let invoke: (channel: string, payload: unknown, frame?: unknown) => Promise<unknown>;
    let save: ReturnType<typeof vi.fn<(projectId: string, state: never) => Promise<void>>>;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "opennan-pipc-"));
        db = openDatabase(":memory:");
        media = createMediaStore({ db, root: path.join(dir, "media") });
        const persistence = createSqlitePersistence({ db, media });
        save = vi.fn((projectId: string, state: never) => persistence.saveProject(projectId, state));
        const handlers = new Map<string, (event: IpcEventLike, payload: unknown) => unknown>();
        const ipc: IpcMainLike = { handle: (channel, listener) => void handlers.set(channel, listener) };
        registerProjectIpc(ipc, { persistence: { ...persistence, saveProject: save }, media });
        const top = { url: "opennan-app://app/" } as { url: string; top?: unknown };
        top.top = top;
        invoke = async (channel, payload, frame = top) => handlers.get(channel)!({ senderFrame: frame as never }, payload);
    });
    afterEach(() => {
        db.close();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it("saves, lists, and loads projects", async () => {
        const id = randomUUID();
        const state = { meta: { id, name: "Trip", musicUrl: null, musicVolume: 1, aspectRatio: "16:9" }, tracks: [], clips: [], scenes: [] };
        await invoke(IPC.persistenceSave, { projectId: id, state });
        expect(await invoke(IPC.persistenceList, {})).toHaveLength(1);
        expect(await invoke(IPC.persistenceLoad, { projectId: id })).toEqual(state);
        await expect(invoke(IPC.persistenceSave, { projectId: randomUUID(), state })).rejects.toThrow("meta.id");
    });

    it("imports media by path into the media root", async () => {
        const source = path.join(dir, "clip.webm");
        fs.writeFileSync(source, "video");
        const result = await invoke(IPC.mediaImportPath, { projectId: randomUUID(), path: source, kind: "video" }) as { url: string };
        expect(result.url).toMatch(/^opennan-local:\/\/media\/[0-9a-f-]{36}$/);
        expect(result).not.toHaveProperty("id");
        expect(fs.existsSync(media.pathOf(result.url.slice("opennan-local://media/".length))!)).toBe(true);
        const notes = path.join(dir, "notes.txt");
        fs.writeFileSync(notes, "x");
        await expect(invoke(IPC.mediaImportPath, { projectId: randomUUID(), path: notes, kind: "video" })).rejects.toThrow("not a supported media file");
        await expect(invoke(IPC.mediaImportPath, { projectId: randomUUID(), path: "../x.mp4", kind: "video" })).rejects.toThrow("absolute");
    });

    it("refuses untrusted senders before touching the store", async () => {
        const id = randomUUID();
        const state = { meta: { id, name: "x" }, tracks: [], clips: [], scenes: [] };
        await expect(invoke(IPC.persistenceSave, { projectId: id, state }, { url: "https://evil.test/" })).rejects.toThrow("Untrusted");
        expect(save).not.toHaveBeenCalled();
    });
    it("imports media for a cloud project's working copy and releases a local project's media before it is detached", async () => {
        const source = path.join(dir, "clip.webm");
        fs.writeFileSync(source, "video");
        const cloud = await invoke(IPC.mediaImportPath, { projectId: "cloud-abc", path: source, kind: "video" }) as { url: string };
        const local = randomUUID();
        const owned = await invoke(IPC.mediaImportPath, { projectId: local, path: source, kind: "video" }) as { url: string };
        const idOf = (url: string) => url.slice("opennan-local://media/".length);
        expect(media.info(idOf(cloud.url))).toMatchObject({ projectId: "cloud-abc" });
        await invoke(IPC.mediaReleaseProject, { projectId: local });
        await invoke(IPC.persistenceDelete, { projectId: local });
        expect(media.pathOf(idOf(owned.url))).not.toBeNull();
        await expect(invoke(IPC.mediaReleaseProject, { projectId: "cloud-abc" })).rejects.toThrow("Invalid");
    });

    it("deletes a media file only for the project that owns it", async () => {
        const source = path.join(dir, "clip.webm");
        fs.writeFileSync(source, "video");
        const idOf = (url: string) => url.slice("opennan-local://media/".length);
        const local = randomUUID();
        const owned = idOf((await invoke(IPC.mediaImportPath, { projectId: local, path: source, kind: "video" }) as { url: string }).url);
        const cloud = idOf((await invoke(IPC.mediaImportPath, { projectId: "cloud-abc", path: source, kind: "video" }) as { url: string }).url);
        await invoke(IPC.mediaDelete, { projectId: local, id: cloud });
        expect(media.pathOf(cloud)).not.toBeNull();
        await invoke(IPC.mediaDelete, { projectId: local, id: owned });
        expect(media.pathOf(owned)).toBeNull();
        await expect(invoke(IPC.mediaDelete, { id: cloud })).rejects.toThrow("Invalid");
    });
});
