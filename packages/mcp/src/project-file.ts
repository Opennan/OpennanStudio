// Project files for headless mode: one JSON document per project, a sibling
// "<file>.media/" folder for imported media blobs, and "<file>.lock" for the writer.
import { createWriteStream, openAsBlob, promises as fs } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import type { LocalPersistence, LocalProjectState } from "@opennan/timeline-core";

export const PROJECT_FILE_FORMAT = "opennan-studio-project";
export const PROJECT_FILE_VERSION = 1;

export interface ProjectFile {
    format: typeof PROJECT_FILE_FORMAT;
    version: typeof PROJECT_FILE_VERSION;
    project: LocalProjectState;
}

export class ProjectFileError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ProjectFileError";
    }
}

export function parseProjectFile(text: string, source = "project file"): ProjectFile {
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        throw new ProjectFileError(`${source} is not valid JSON`);
    }
    const doc = parsed as Partial<ProjectFile> | null;
    if (!doc || doc.format !== PROJECT_FILE_FORMAT) throw new ProjectFileError(`${source} is not an OpenNan Studio project (format must be "${PROJECT_FILE_FORMAT}")`);
    if (doc.version !== PROJECT_FILE_VERSION) throw new ProjectFileError(`${source} has unsupported version ${String(doc.version)}`);
    const project = doc.project;
    if (!project || typeof project.meta?.id !== "string" || project.meta.id.length === 0) throw new ProjectFileError(`${source} has no project id`);
    for (const key of ["tracks", "clips", "scenes"] as const) {
        if (!Array.isArray(project[key])) throw new ProjectFileError(`${source} project.${key} must be an array`);
    }
    return doc as ProjectFile;
}

export function serializeProjectFile(project: LocalProjectState): string {
    const doc: ProjectFile = { format: PROJECT_FILE_FORMAT, version: PROJECT_FILE_VERSION, project };
    return `${JSON.stringify(doc, null, 2)}\n`;
}

export async function readProjectFile(file: string): Promise<ProjectFile> {
    return parseProjectFile(await fs.readFile(file, "utf8"), file);
}

/** Writes through a temp file and rename, so a crash never leaves half a project. */
export async function writeProjectFile(file: string, project: LocalProjectState): Promise<void> {
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, serializeProjectFile(project));
    await fs.rename(tmp, file);
}

export function mediaDirFor(projectFile: string): string {
    return path.join(path.dirname(projectFile), `${path.basename(projectFile)}.media`);
}

/** The file that holds media blob `id` (the part after opennan-local://media/) in a media folder. */
export function blobPathFor(mediaDir: string, id: string): string {
    return path.join(mediaDir, id.replace(/[^A-Za-z0-9_-]/g, "_"));
}

export interface ProjectLock {
    file: string;
    release(): Promise<void>;
}

/** Lock files this process holds; a second writer in the same process is refused too. */
const HELD = new Set<string>();

function processAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        // EPERM: the process exists but belongs to another user.
        return (error as NodeJS.ErrnoException).code === "EPERM";
    }
}

/** The lock file's text and its owner pid; null when the file is gone. */
async function readLock(lockFile: string): Promise<{ text: string; pid: number | null } | null> {
    let text: string;
    try {
        text = await fs.readFile(lockFile, "utf8");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
    }
    try {
        const pid = Number((JSON.parse(text) as { pid?: unknown }).pid);
        return { text, pid: Number.isInteger(pid) && pid > 0 ? pid : null };
    } catch {
        return { text, pid: null };
    }
}

/**
 * Removes a stale lock while holding "<lock>.takeover" (created with "wx"), and only if the
 * lock still has the text that was judged stale. Returns false when another opener holds the
 * guard or the lock changed; the caller then looks again.
 */
async function lockAgeMs(lockFile: string): Promise<number> {
    const stat = await fs.stat(lockFile).catch(() => null);
    return stat ? Date.now() - stat.mtimeMs : Number.POSITIVE_INFINITY;
}

async function takeOverStaleLock(lockFile: string, staleText: string): Promise<boolean> {
    const guard = `${lockFile}.takeover`;
    try {
        await fs.writeFile(guard, String(process.pid), { flag: "wx", mode: 0o600 });
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        // A guard left behind by a crash mid-takeover is stale after 10 s.
        const stat = await fs.stat(guard).catch(() => null);
        if (stat && Date.now() - stat.mtimeMs > 10_000) await fs.rm(guard, { force: true });
        return false;
    }
    try {
        const current = await readLock(lockFile);
        if (current && current.text !== staleText) return false;
        await fs.rm(lockFile, { force: true });
        return true;
    } finally {
        await fs.rm(guard, { force: true });
    }
}

/**
 * Exclusive writer lock "<file>.lock" holding { pid, startedAt }. A live owner (this
 * process or another) is refused; a lock whose pid is gone is stale and taken over.
 */
export async function lockProjectFile(projectFile: string): Promise<ProjectLock> {
    const lockFile = `${projectFile}.lock`;
    const refuse = (pid: number) => new ProjectFileError(
        `${projectFile} is already open for writing (pid ${pid}). Close it there, or open it with --read-only.`,
    );
    if (HELD.has(lockFile)) throw refuse(process.pid);
    // A lock this process is still writing (open succeeded, contents not yet written or HELD not yet set)
    // looks stale for a moment: wait a little before taking over our own pid or an unreadable fresh file.
    let settling = 0;
    for (let attempt = 0; attempt < 60; attempt += 1) {
        try {
            await fs.writeFile(lockFile, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), { flag: "wx", mode: 0o600 });
            HELD.add(lockFile);
            return {
                file: lockFile,
                async release() {
                    if (!HELD.delete(lockFile)) return;
                    await fs.rm(lockFile, { force: true });
                },
            };
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
            // A concurrent open in this process may have won the lock in the meantime.
            if (HELD.has(lockFile)) throw refuse(process.pid);
            const seen = await readLock(lockFile);
            if (!seen) continue;
            if (seen.pid !== null && seen.pid !== process.pid && processAlive(seen.pid)) throw refuse(seen.pid);
            if ((seen.pid === process.pid || (seen.pid === null && (await lockAgeMs(lockFile)) < 2000)) && settling < 10) {
                settling += 1;
                await new Promise((resolve) => setTimeout(resolve, 20));
                continue;
            }
            // Stale: take it over under a guard file, so a fresh lock another opener just created is never deleted.
            if (!(await takeOverStaleLock(lockFile, seen.text))) await new Promise((resolve) => setTimeout(resolve, 20));
        }
    }
    throw new ProjectFileError(`Could not lock ${projectFile}`);
}

export interface FilePersistence extends LocalPersistence {
    /** Resolves when every queued write has reached the disk. */
    flush(): Promise<void>;
    /** Flushes, then releases the writer lock. */
    close(): Promise<void>;
}

/**
 * LocalBackend persistence over one project file. A writer holds the project lock
 * until close(); readOnly takes no lock and keeps writes in memory.
 */
export async function openFilePersistence(projectFile: string, options: { readOnly?: boolean } = {}): Promise<FilePersistence> {
    const lock = options.readOnly ? null : await lockProjectFile(projectFile);
    const mediaDir = mediaDirFor(projectFile);
    const memoryBlobs = new Map<string, Blob>();
    let latest: LocalProjectState | null = null;
    let queue: Promise<void> = Promise.resolve();
    const enqueue = (task: () => Promise<void>) => {
        queue = queue.then(task, task);
        return queue;
    };
    const blobPath = (id: string) => blobPathFor(mediaDir, id);

    return {
        async loadProject(projectId) {
            if (latest?.meta.id === projectId) return structuredClone(latest);
            const file = await readProjectFile(projectFile);
            return file.project.meta.id === projectId ? file.project : null;
        },
        async saveProject(_projectId, state) {
            latest = structuredClone(state);
            if (options.readOnly) return;
            const snapshot = structuredClone(state);
            await enqueue(() => writeProjectFile(projectFile, snapshot));
        },
        async putBlob(id, blob) {
            if (options.readOnly) {
                memoryBlobs.set(id, blob);
                return;
            }
            await enqueue(async () => {
                await fs.mkdir(mediaDir, { recursive: true });
                const target = blobPath(id);
                const tmp = `${target}.${process.pid}.tmp`;
                // Streamed: a local file from openAsBlob (publish_*_to_timeline) is copied, never held in memory.
                await pipeline(Readable.fromWeb(blob.stream() as unknown as NodeReadableStream<Uint8Array>), createWriteStream(tmp, { mode: 0o600 }));
                await fs.rename(tmp, target);
                await fs.writeFile(`${target}.type`, blob.type);
            });
        },
        async getBlob(id) {
            const memory = memoryBlobs.get(id);
            if (memory) return memory;
            try {
                const type = await fs.readFile(`${blobPath(id)}.type`, "utf8").catch(() => "");
                // Lazy: LocalBackend.hydrateMedia asks for every media blob at load; nothing is read until used.
                return await openAsBlob(blobPath(id), { type });
            } catch {
                return null;
            }
        },
        flush: () => queue,
        async close() {
            try {
                await queue;
            } finally {
                await lock?.release();
            }
        },
    };
}
