// LocalBackend persistence on the desktop store (spec §6 "SqlitePersistence for desktop"). Project documents
// are rows of JSON; media are files owned by the media store. The renderer's LocalBackend reaches the
// project methods over IPC (renderer/ipc-persistence.ts); putBlob/getBlob serve main-side callers only.
import fs from "node:fs";
import type { LocalPersistence, LocalProjectState } from "@opennan/timeline-core";
import { isUuid } from "../../shared/ids";
import type { DesktopDatabase } from "./database";
import type { MediaStore } from "./media-store";

export interface SqlitePersistenceOptions {
    db: DesktopDatabase;
    media: MediaStore;
    now?(): number;
}

export function createSqlitePersistence({ db, media, now = Date.now }: SqlitePersistenceOptions): LocalPersistence {
    const load = db.prepare("select state from projects where id = ?");
    const upsert = db.prepare(
        "insert into projects (id, state, created_at, updated_at) values (?, ?, ?, ?) "
        + "on conflict(id) do update set state = excluded.state, updated_at = excluded.updated_at",
    );
    const list = db.prepare("select state from projects order by updated_at desc");
    const remove = db.prepare("delete from projects where id = ?");
    return {
        async loadProject(projectId) {
            const row = load.get(projectId) as { state: string } | undefined;
            return row ? (JSON.parse(row.state) as LocalProjectState) : null;
        },
        async saveProject(projectId, state) {
            if (state.meta?.id !== projectId) throw new Error(`project state meta.id ${String(state.meta?.id)} does not match ${projectId}`);
            const stamp = now();
            upsert.run(projectId, JSON.stringify(state), state.createdAt ?? stamp, state.updatedAt ?? stamp);
        },
        async listProjects() {
            return (list.all() as Array<{ state: string }>).map((row) => JSON.parse(row.state) as LocalProjectState);
        },
        async deleteProject(projectId) {
            remove.run(projectId);
            await media.deleteProject(projectId);
        },
        async putBlob(id, blob) {
            if (!isUuid(id)) throw new Error("invalid media id");
            const name = (blob as Blob & { name?: string }).name ?? id;
            await media.putBlob(blob, { id, projectId: null, name, mimeType: blob.type });
        },
        async getBlob(id) {
            const file = media.pathOf(id);
            if (!file) return null;
            return fs.openAsBlob(file, { type: media.info(id)?.mimeType ?? "" });
        },
        async deleteBlob(id) {
            await media.delete(id);
        },
    };
}
