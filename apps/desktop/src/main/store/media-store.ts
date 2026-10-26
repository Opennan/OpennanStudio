// Media files of every project: <root>/<id><ext>, one row each in `media`. Ids are created here, never taken
// from the renderer; imports copy the user's file (a copy-on-write clone where the filesystem has one), so
// projects keep working when the original moves. Lookups only ever resolve to real files inside the root.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { isRemotePath } from "@opennan/mcp";
import type { UploadedMedia } from "@opennan/timeline-core";
import { isUuid } from "../../shared/ids";
import { MEDIA_EXTENSIONS, extensionForMime, type MediaKindName } from "../../shared/media-types";
import type { DesktopDatabase } from "./database";

export const LOCAL_MEDIA_PREFIX = "opennan-local://media/";
const STORED_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z0-9]{2,5}$/;

export interface StoredMedia extends UploadedMedia {
    id: string;
    /** Pixel size of a video or image (probed at import; phase 11: a stacked AI result keeps its on-screen size). */
    width?: number;
    height?: number;
}

export interface MediaInfoRow {
    id: string;
    projectId: string | null;
    fileName: string;
    mimeType: string;
    size: number;
    originalName: string;
    durationSeconds: number | null;
}

export interface MediaStoreOptions {
    db: DesktopDatabase;
    root: string;
    /** Duration and pixel-size probe (the bundled ffprobe); failures are ignored. */
    probe?(file: string): Promise<{ durationSeconds?: number; width?: number; height?: number } | null>;
    /** Largest in-memory import (importBytes). Default 512 MiB. */
    maxBytes?: number;
    now?(): number;
}

export interface MediaStore {
    root: string;
    importPath(input: { projectId: string; path: string; kind: MediaKindName }): Promise<StoredMedia>;
    importBytes(input: { projectId: string; name: string; mimeType: string; kind: MediaKindName; bytes: Uint8Array }): Promise<StoredMedia>;
    putBlob(blob: Blob, input: { projectId: string | null; name: string; mimeType: string; kind?: MediaKindName; id?: string }): Promise<StoredMedia>;
    /**
     * Moves a file main itself wrote (a cloud download in the app data folder) into the library under a new id, or
     * under `id` when main reserved one (a uuid no row or file has yet); the extension comes from the name, else the
     * type. The file is gone from `path` afterwards.
     */
    adoptFile(input: { projectId: string | null; path: string; name: string; mimeType: string; id?: string }): Promise<StoredMedia>;
    /** A copy of a stored file under a new id (a copy-on-write clone where the filesystem has one). */
    copy(id: string, projectId: string | null): Promise<StoredMedia>;
    /** The project's files belong to no project any more: deleting the project keeps them (Save to OpenNan). */
    releaseProject(projectId: string): void;
    /** The real path of a stored file, or null for unknown ids and anything outside the root. */
    pathOf(id: string): string | null;
    info(id: string): MediaInfoRow | null;
    delete(id: string): Promise<void>;
    /** Deletes the file only when `projectId` owns it (released, cached, or other projects' files are kept). */
    deleteOwned(projectId: string, id: string): Promise<boolean>;
    deleteProject(projectId: string): Promise<void>;
}

export const DEFAULT_MAX_BYTES = 512 * 1024 * 1024;

const isInside = (file: string, root: string) => file === root || file.startsWith(root.endsWith(path.sep) ? root : root + path.sep);

function extensionOf(name: string): string | null {
    const ext = path.extname(name).toLowerCase();
    return ext in MEDIA_EXTENSIONS ? ext : null;
}

export function createMediaStore(options: MediaStoreOptions): MediaStore {
    const { db } = options;
    fs.mkdirSync(options.root, { recursive: true, mode: 0o700 });
    const realRoot = fs.realpathSync.native(options.root);
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    const now = options.now ?? Date.now;
    const insert = db.prepare(
        "insert into media (id, project_id, file_name, mime_type, size, original_name, duration_seconds, created_at) values (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    const select = db.prepare("select * from media where id = ?");
    const remove = db.prepare("delete from media where id = ?");
    const byProject = db.prepare("select id from media where project_id = ?");
    const release = db.prepare("update media set project_id = null where project_id = ?");

    /** finish(), or the file is removed again (no file in the root without its row). */
    async function finishOrRemove(id: string, projectId: string | null, ext: string, originalName: string): Promise<StoredMedia> {
        try {
            return await finish(id, projectId, ext, originalName);
        } catch (error) {
            await fs.promises.rm(path.join(realRoot, `${id}${ext}`), { force: true }).catch(() => undefined);
            throw error;
        }
    }

    async function finish(id: string, projectId: string | null, ext: string, originalName: string): Promise<StoredMedia> {
        const fileName = `${id}${ext}`;
        const file = path.join(realRoot, fileName);
        const size = (await fs.promises.stat(file)).size;
        const probed = await options.probe?.(file).catch(() => null);
        const duration = probed?.durationSeconds && probed.durationSeconds > 0 ? probed.durationSeconds : null;
        const mimeType = MEDIA_EXTENSIONS[ext].mimeType;
        insert.run(id, projectId, fileName, mimeType, size, originalName, duration, now());
        const sized = probed?.width && probed.height && probed.width > 0 && probed.height > 0 ? { width: probed.width, height: probed.height } : {};
        return {
            id, url: `${LOCAL_MEDIA_PREFIX}${id}`, name: originalName, size, mimeType,
            ...(duration ? { durationSeconds: duration } : {}), ...sized,
        };
    }

    const store: MediaStore = {
        root: realRoot,
        async importPath({ projectId, path: source }) {
            if (!path.isAbsolute(source)) throw new Error("Media paths must be absolute");
            // Not even realpath for network shares: resolving \\host\share already contacts the host.
            if (isRemotePath(source)) throw new Error("Network paths cannot be imported; copy the file to this computer first");
            const real = await fs.promises.realpath(source).catch(() => {
                throw new Error("The file does not exist");
            });
            const stat = await fs.promises.stat(real);
            if (!stat.isFile()) throw new Error("This path is not a file");
            const ext = extensionOf(real);
            if (!ext) throw new Error("This is not a supported media file");
            if (isInside(real, realRoot)) throw new Error("This file is already in the media library");
            const id = randomUUID();
            await fs.promises.copyFile(real, path.join(realRoot, `${id}${ext}`), fs.constants.COPYFILE_EXCL | fs.constants.COPYFILE_FICLONE);
            return finishOrRemove(id, projectId, ext, path.basename(source));
        },
        async importBytes({ projectId, name, mimeType, bytes }) {
            if (bytes.byteLength > maxBytes) throw new Error("This file is too large to import from memory");
            const ext = extensionOf(name) ?? extensionForMime(mimeType);
            if (!ext) throw new Error("This is not a supported media file");
            const id = randomUUID();
            await fs.promises.writeFile(path.join(realRoot, `${id}${ext}`), bytes, { flag: "wx", mode: 0o600 });
            return finishOrRemove(id, projectId, ext, path.basename(name) || `media${ext}`);
        },
        async putBlob(blob, input) {
            if (input.id !== undefined && !isUuid(input.id)) throw new Error("invalid media id");
            const ext = extensionOf(input.name) ?? extensionForMime(input.mimeType || blob.type);
            if (!ext) throw new Error("This is not a supported media file");
            const id = input.id ?? randomUUID();
            const out = fs.createWriteStream(path.join(realRoot, `${id}${ext}`), { flags: "wx", mode: 0o600 });
            await pipeline(Readable.fromWeb(blob.stream() as import("node:stream/web").ReadableStream), out);
            return finishOrRemove(id, input.projectId, ext, path.basename(input.name) || `media${ext}`);
        },
        async adoptFile({ projectId, path: source, name, mimeType, id: reserved }) {
            if (reserved !== undefined && !isUuid(reserved)) throw new Error("invalid media id");
            if (!path.isAbsolute(source)) throw new Error("Media paths must be absolute");
            const ext = extensionOf(name) ?? extensionForMime(mimeType);
            if (!ext) throw new Error("This is not a supported media file");
            const id = reserved ?? randomUUID();
            const target = path.join(realRoot, `${id}${ext}`);
            if (reserved !== undefined) {
                // rename() would replace an existing file silently.
                const taken = select.get(id) !== undefined || (await fs.promises.lstat(target).then(() => true, () => false));
                if (taken) throw new Error("This media id is already in the media library");
            }
            try {
                await fs.promises.rename(source, target);
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
                await fs.promises.copyFile(source, target, fs.constants.COPYFILE_EXCL);
                await fs.promises.rm(source, { force: true });
            }
            await fs.promises.chmod(target, 0o600).catch(() => undefined);
            return finishOrRemove(id, projectId, ext, path.basename(name) || `media${ext}`);
        },
        async copy(id, projectId) {
            const source = store.pathOf(id);
            const row = store.info(id);
            if (!source || !row) throw new Error("This media file is no longer on this device.");
            const ext = path.extname(row.fileName).toLowerCase();
            if (!(ext in MEDIA_EXTENSIONS)) throw new Error("This is not a supported media file");
            const copyId = randomUUID();
            await fs.promises.copyFile(source, path.join(realRoot, `${copyId}${ext}`), fs.constants.COPYFILE_EXCL | fs.constants.COPYFILE_FICLONE);
            return finishOrRemove(copyId, projectId, ext, row.originalName);
        },
        releaseProject(projectId) {
            release.run(projectId);
        },
        pathOf(id) {
            const row = store.info(id);
            if (!row || !STORED_NAME.test(row.fileName) || !row.fileName.startsWith(id)) return null;
            try {
                const real = fs.realpathSync.native(path.join(realRoot, row.fileName));
                return isInside(real, realRoot) && real !== realRoot ? real : null;
            } catch {
                return null;
            }
        },
        info(id) {
            if (!isUuid(id)) return null;
            const row = select.get(id) as Record<string, unknown> | undefined;
            if (!row) return null;
            return {
                id: row.id as string, projectId: (row.project_id as string | null) ?? null, fileName: row.file_name as string,
                mimeType: row.mime_type as string, size: row.size as number, originalName: row.original_name as string,
                durationSeconds: (row.duration_seconds as number | null) ?? null,
            };
        },
        async delete(id) {
            const file = store.pathOf(id);
            if (isUuid(id)) remove.run(id);
            if (file) await fs.promises.rm(file, { force: true });
        },
        async deleteOwned(projectId, id) {
            const row = store.info(id);
            if (!row || row.projectId === null || row.projectId !== projectId) return false;
            await store.delete(id);
            return true;
        },
        async deleteProject(projectId) {
            for (const row of byProject.all(projectId) as Array<{ id: string }>) await store.delete(row.id);
        },
    };
    return store;
}
