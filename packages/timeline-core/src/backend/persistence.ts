// Persistence for LocalBackend: whole-project documents plus media blobs.
import type { TimelineClip, TimelineTrack } from "../model/timeline";
import type { SceneData } from "../timeline/canvas/types";
import type { ProjectMeta, UploadedMedia } from "./types";

export interface LocalProjectState {
    meta: ProjectMeta;
    tracks: TimelineTrack[];
    clips: TimelineClip[];
    scenes: SceneData[];
    /** Media bin entries (LocalBackend.saveToLibrary), in import order. */
    library?: UploadedMedia[];
    /** Blob ids of every upload, so deleting the project deletes its media. */
    uploads?: string[];
    /** Epoch milliseconds, stamped by LocalBackend on every save. */
    createdAt?: number;
    updatedAt?: number;
}

export interface LocalPersistence {
    loadProject(projectId: string): Promise<LocalProjectState | null>;
    saveProject(projectId: string, state: LocalProjectState): Promise<void>;
    /** Stores the Blob itself, never a copy of its bytes: IndexedDB keeps it on disk. */
    putBlob(id: string, blob: Blob): Promise<void>;
    /** A disk-backed Blob for IndexedDB; reading it does not load the file into memory. */
    getBlob(id: string): Promise<Blob | null>;
    /** Every stored project, for project lists. Optional so existing custom persistences keep compiling. */
    listProjects?(): Promise<LocalProjectState[]>;
    deleteProject?(projectId: string): Promise<void>;
    deleteBlob?(id: string): Promise<void>;
}

/** How phase 1-2 builds stored blobs. Still read, never written. */
interface LegacyStoredBlob {
    type: string;
    data: ArrayBuffer;
}

function blobFromStored(stored: unknown): Blob | null {
    if (stored instanceof Blob) return stored;
    const legacy = stored as Partial<LegacyStoredBlob> | undefined;
    return legacy?.data instanceof ArrayBuffer ? new Blob([legacy.data], { type: legacy.type ?? "" }) : null;
}

export function createMemoryPersistence(): LocalPersistence {
    const projects = new Map<string, LocalProjectState>();
    // A Blob is immutable, so keeping the reference is as safe as a copy.
    const blobs = new Map<string, Blob>();
    return {
        async loadProject(projectId) {
            const state = projects.get(projectId);
            return state ? structuredClone(state) : null;
        },
        async saveProject(projectId, state) {
            projects.set(projectId, structuredClone(state));
        },
        async putBlob(id, blob) {
            blobs.set(id, blob);
        },
        async getBlob(id) {
            return blobs.get(id) ?? null;
        },
        async listProjects() {
            return [...projects.values()].map((state) => structuredClone(state));
        },
        async deleteProject(projectId) {
            projects.delete(projectId);
        },
        async deleteBlob(id) {
            blobs.delete(id);
        },
    };
}

export interface IndexedDbPersistenceOptions {
    dbName?: string;
    indexedDB?: IDBFactory;
}

export function createIndexedDbPersistence(options: IndexedDbPersistenceOptions = {}): LocalPersistence {
    const factory = options.indexedDB ?? globalThis.indexedDB;
    const dbName = options.dbName ?? "opennan-studio";
    let dbPromise: Promise<IDBDatabase> | null = null;

    function open(): Promise<IDBDatabase> {
        if (!factory) return Promise.reject(new Error("IndexedDB is not available"));
        dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
            const request = factory.open(dbName, 1);
            request.onupgradeneeded = () => {
                const db = request.result;
                if (!db.objectStoreNames.contains("projects")) db.createObjectStore("projects");
                if (!db.objectStoreNames.contains("blobs")) db.createObjectStore("blobs");
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
        return dbPromise;
    }

    async function run<T>(storeName: "projects" | "blobs", mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
        const db = await open();
        return new Promise<T>((resolve, reject) => {
            const transaction = db.transaction(storeName, mode);
            const request = action(transaction.objectStore(storeName));
            transaction.oncomplete = () => resolve(request.result);
            transaction.onerror = () => reject(transaction.error ?? request.error);
            transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
        });
    }

    return {
        async loadProject(projectId) {
            const value = await run("projects", "readonly", (store) => store.get(projectId) as IDBRequest<LocalProjectState | undefined>);
            return value ?? null;
        },
        async saveProject(projectId, state) {
            await run("projects", "readwrite", (store) => store.put(structuredClone(state), projectId));
        },
        async putBlob(id, blob) {
            // The structured clone of a Blob/File is stored by reference to its bytes on disk.
            await run("blobs", "readwrite", (store) => store.put(blob, id));
        },
        async getBlob(id) {
            return blobFromStored(await run("blobs", "readonly", (store) => store.get(id) as IDBRequest<unknown>));
        },
        async listProjects() {
            return run("projects", "readonly", (store) => store.getAll() as IDBRequest<LocalProjectState[]>);
        },
        async deleteProject(projectId) {
            await run("projects", "readwrite", (store) => store.delete(projectId));
        },
        async deleteBlob(id) {
            await run("blobs", "readwrite", (store) => store.delete(id));
        },
    };
}
