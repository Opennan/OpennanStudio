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

/**
 * The candidate media ids local projects' saved documents name (phase 9a.1: the cloud cache never evicts such a file).
 * One pass over the projects per call, matched by id, so opennan-local://media/<id> and opennan-media://blob/<id> both
 * count. An id that isn't a media id, or projects that can't be read, count as named (fail closed).
 */
export function createLocalReferenceScan(db: DesktopDatabase): (ids: string[]) => Set<string> {
    return (ids) => {
        if (ids.length === 0) return new Set();
        const named = new Set<string>(ids.filter((id) => !isUuid(id)));
        const wanted = new Set<string>(ids.filter((id) => isUuid(id)));
        if (wanted.size === 0) return named;
        try {
            const rows = db.prepare("select state from projects").iterate() as Iterable<{ state: string }>;
            for (const row of rows) {
                for (const match of row.state.matchAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g)) {
                    if (wanted.has(match[0])) named.add(match[0]);
                }
                if (named.size === ids.length) break;
            }
        } catch {
            return new Set(ids);
        }
        return named;
    };
}
