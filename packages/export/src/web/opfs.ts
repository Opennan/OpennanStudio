// Export files in the origin private file system (phase 10d): the GPU export streams its encoded video there and the
// streaming mux writes the final file there, so a long web export never holds a whole video in memory. Files live in
// one folder; each export removes its own files when done, and files an aborted tab left behind are swept on the next
// export.
import type { ExportOutput } from "../runner";
import type { GpuVideoSink } from "../gpu/encode";

export const OPFS_EXPORT_DIR = "opennan-exports";

type Directory = FileSystemDirectoryHandle & {
    entries?(): AsyncIterableIterator<[string, FileSystemHandle]>;
};

/** The origin private file system has a folder for exports and writable files (Chromium, Electron, recent Firefox/Safari). */
export function opfsAvailable(): boolean {
    return typeof navigator !== "undefined" && typeof navigator.storage?.getDirectory === "function"
        && typeof FileSystemFileHandle !== "undefined" && "createWritable" in FileSystemFileHandle.prototype;
}

async function exportDir(): Promise<Directory> {
    const root = await navigator.storage.getDirectory();
    return (await root.getDirectoryHandle(OPFS_EXPORT_DIR, { create: true })) as Directory;
}

let counter = 0;

export interface OpfsFile {
    name: string;
    writable: WritableStream<{ type: "write"; data: Uint8Array; position: number }>;
    /** Closes the stream and returns the file (disk-backed). */
    finish(): Promise<File>;
    /** Abandons the stream and deletes the file. */
    abort(): Promise<void>;
}

/** A new file `<prefix>-<time>-<n>.<ext>` in the exports folder, open for positioned writes. */
export async function createOpfsFile(prefix: string, ext: string): Promise<OpfsFile> {
    const dir = await exportDir();
    counter += 1;
    const name = `${prefix}-${Date.now()}-${counter}.${ext}`;
    const handle = await dir.getFileHandle(name, { create: true });
    const stream = await handle.createWritable();
    let closed = false;
    return {
        name,
        writable: stream as unknown as WritableStream<{ type: "write"; data: Uint8Array; position: number }>,
        async finish() {
            if (!closed) {
                closed = true;
                // A mediabunny StreamTarget closes the stream itself when its output finalizes (and keeps it locked).
                if (!stream.locked) await stream.close();
            }
            return handle.getFile();
        },
        async abort() {
            if (!closed) {
                closed = true;
                if (!stream.locked) await stream.abort().catch(() => undefined);
            }
            await removeOpfsExport(name);
        },
    };
}

/** Deletes an export file by name (ignored when it is already gone). */
export async function removeOpfsExport(name: string): Promise<void> {
    if (!/^[A-Za-z0-9._-]+$/.test(name)) return;
    try {
        await (await exportDir()).removeEntry(name);
    } catch {
        // Gone already, or still open elsewhere: the next sweep takes it.
    }
}

/** Deletes export files older than `maxAgeMs` (an export interrupted by a closed tab or a crash). */
export async function sweepOpfsExports(maxAgeMs = 60 * 60 * 1000, now = Date.now()): Promise<number> {
    if (!opfsAvailable()) return 0;
    let removed = 0;
    try {
        const dir = await exportDir();
        if (!dir.entries) return 0;
        for await (const [name, handle] of dir.entries()) {
            if (handle.kind !== "file") continue;
            const file = await (handle as FileSystemFileHandle).getFile().catch(() => null);
            if (!file || now - file.lastModified < maxAgeMs) continue;
            await dir.removeEntry(name).catch(() => undefined);
            removed += 1;
        }
    } catch {
        return removed;
    }
    return removed;
}

/** The GPU encoder's sink: the encoded video goes to an OPFS file; the mux reads it back as a disk-backed Blob. */
export async function createOpfsVideoSink(container: "mp4" | "webm"): Promise<GpuVideoSink> {
    const file = await createOpfsFile("video", container);
    return {
        writable: file.writable,
        done: async () => ({ kind: "blob", blob: await file.finish(), opfsName: file.name }),
        abort: () => file.abort(),
        release: () => removeOpfsExport(file.name),
    };
}

/** The streaming mux's output: the final export as an OPFS file, handed over as a disk-backed Blob. */
export async function createOpfsOutput(container: "mp4" | "webm"): Promise<{
    writable: WritableStream<{ type: "write"; data: Uint8Array; position: number }>;
    finish(): Promise<ExportOutput>;
    abort(): Promise<void>;
}> {
    const file = await createOpfsFile("export", container);
    return {
        writable: file.writable,
        finish: async () => ({ kind: "blob", blob: await file.finish(), opfsName: file.name }),
        abort: () => file.abort(),
    };
}
