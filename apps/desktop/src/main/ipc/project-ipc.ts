// Project persistence and media import channels: the renderer's LocalBackend stores documents here, and its
// uploads become files in the media library (copied by main from a path, or written from bytes).
import type { LocalPersistence, LocalProjectState } from "@opennan/timeline-core";
import { IPC } from "../../shared/ipc";
import type { MediaStore } from "../store/media-store";
import { handle, type IpcMainLike } from "./handle";

const publicMedia = ({ id: _id, ...media }: Awaited<ReturnType<MediaStore["importPath"]>>) => media;

export function registerProjectIpc(ipc: IpcMainLike, { persistence, media }: { persistence: LocalPersistence; media: MediaStore }): void {
    handle(ipc, IPC.persistenceLoad, ({ projectId }) => persistence.loadProject(projectId));
    handle(ipc, IPC.persistenceSave, async ({ projectId, state }) => {
        if (state.meta.id !== projectId) throw new Error("project state meta.id does not match the project");
        await persistence.saveProject(projectId, state as unknown as LocalProjectState);
    });
    handle(ipc, IPC.persistenceList, () => persistence.listProjects?.() ?? []);
    handle(ipc, IPC.persistenceDelete, async ({ projectId }) => {
        await persistence.deleteProject?.(projectId);
    });
    handle(ipc, IPC.mediaImportPath, async ({ projectId, path, kind }) => publicMedia(await media.importPath({ projectId, path, kind })));
    handle(ipc, IPC.mediaImportBytes, async (payload) => publicMedia(await media.importBytes(payload)));
    handle(ipc, IPC.mediaDelete, async ({ projectId, id }) => {
        await media.deleteOwned(projectId, id);
    });
}
