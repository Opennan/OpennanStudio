// Cloud projects' state on this computer (phase 9a, decision 23): JSON files under the app data folder,
// <root>/<sha256(account)[:24]>/<namespace>/<key>.json, written temp-then-rename so a crash never leaves half a
// queue. The renderer's CloudStore reaches it over validated IPC; the account name is hashed and keys are short ids,
// so nothing the renderer sends becomes a path of its own. Keys are spelled into file names reversibly (an upper-case
// letter becomes "^" + the letter, ":" becomes "~"), so keys that differ only in case stay apart on macOS and Windows.
// Writes to one file run in the order they were asked (reads wait for them), each fsynced before its rename; temp
// files a crash left are swept when the store starts; a damaged record is renamed to .corrupt and reported, never
// read as "no record" (which would look like an empty queue).
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { CLOUD_NAMESPACES, MAX_CLOUD_VALUE_BYTES, caseSafeName, isCloudStoreKey, jsonLength, type CloudNamespace } from "../../shared/cloud-policy";

export interface CloudFileStore {
    get<T = unknown>(account: string, namespace: CloudNamespace, key: string): Promise<T | null>;
    put(account: string, namespace: CloudNamespace, key: string, value: unknown): Promise<void>;
    delete(account: string, namespace: CloudNamespace, key: string): Promise<void>;
    keys(account: string, namespace: CloudNamespace): Promise<string[]>;
}

export interface CloudFileStoreOptions {
    /** <userData>/cloud */
    root: string;
    maxValueBytes?: number;
}

export const MAX_ACCOUNT_CHARS = 320;

export function fileNameOf(key: string): string {
    return `${caseSafeName(key)}.json`;
}

const ACCOUNT_FOLDER = /^[0-9a-f]{24}$/;

/** Removes the temp files of writes a crash interrupted (<root>/<account>/<namespace>/*.tmp). */
export async function sweepStoreTemp(root: string): Promise<void> {
    const list = (dir: string) => fs.promises.readdir(dir).catch(() => [] as string[]);
    for (const account of await list(root)) {
        if (!ACCOUNT_FOLDER.test(account)) continue;
        for (const namespace of CLOUD_NAMESPACES) {
            const dir = path.join(root, account, namespace);
            for (const name of await list(dir)) if (name.endsWith(".tmp")) await fs.promises.rm(path.join(dir, name), { force: true }).catch(() => undefined);
        }
    }
}

export function keyOfFileName(name: string): string | null {
    if (!name.endsWith(".json")) return null;
    const key = name.slice(0, -".json".length).replace(/\^([a-z])|~/g, (match, letter: string | undefined) => (letter ? letter.toUpperCase() : ":"));
    return isCloudStoreKey(key) && fileNameOf(key) === name ? key : null;
}

export function accountFolder(account: string): string {
    return createHash("sha256").update(account, "utf8").digest("hex").slice(0, 24);
}

export function createCloudFileStore(options: CloudFileStoreOptions): CloudFileStore {
    const maxValueBytes = options.maxValueBytes ?? MAX_CLOUD_VALUE_BYTES;
    const ready = sweepStoreTemp(options.root);
    const chains = new Map<string, Promise<void>>();

    /** Runs `work` after every earlier write to `file`. */
    function chain(file: string, work: () => Promise<void>): Promise<void> {
        const next = (chains.get(file) ?? ready).catch(() => undefined).then(work);
        chains.set(file, next);
        void next.catch(() => undefined).finally(() => {
            if (chains.get(file) === next) chains.delete(file);
        });
        return next;
    }

    async function settled(file: string): Promise<void> {
        await ready;
        await (chains.get(file) ?? Promise.resolve()).catch(() => undefined);
    }

    function dirOf(account: string, namespace: CloudNamespace): string {
        if (typeof account !== "string" || account.length === 0 || account.length > MAX_ACCOUNT_CHARS) throw new Error("invalid cloud account");
        if (!(CLOUD_NAMESPACES as readonly string[]).includes(namespace)) throw new Error("invalid cloud namespace");
        return path.join(options.root, accountFolder(account), namespace);
    }

    function fileOf(account: string, namespace: CloudNamespace, key: string): string {
        const dir = dirOf(account, namespace);
        if (!isCloudStoreKey(key)) throw new Error("invalid cloud key");
        return path.join(dir, fileNameOf(key));
    }

    return {
        async get<T>(account: string, namespace: CloudNamespace, key: string): Promise<T | null> {
            const file = fileOf(account, namespace, key);
            await settled(file);
            let text: string;
            try {
                text = await fs.promises.readFile(file, "utf8");
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
                throw error;
            }
            try {
                return JSON.parse(text) as T;
            } catch {
                await fs.promises.rename(file, `${file}.corrupt`).catch(() => undefined);
                throw new Error(`A cloud record on this computer was damaged and set aside (${namespace}/${key}).`);
            }
        },
        async put(account, namespace, key, value) {
            const file = fileOf(account, namespace, key);
            if (value === undefined) throw new Error("cloud values must be JSON");
            const length = jsonLength(value);
            if (!Number.isFinite(length)) throw new Error("cloud values must be JSON");
            if (length > maxValueBytes) throw new Error(`cloud value is too large (more than ${maxValueBytes} bytes)`);
            const text = JSON.stringify(value);
            return chain(file, async () => {
                await fs.promises.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
                const temp = `${file}.${randomUUID()}.tmp`;
                try {
                    const handle = await fs.promises.open(temp, "wx", 0o600);
                    try {
                        await handle.writeFile(text, "utf8");
                        await handle.sync();
                    } finally {
                        await handle.close();
                    }
                    await fs.promises.rename(temp, file);
                } catch (error) {
                    await fs.promises.rm(temp, { force: true }).catch(() => undefined);
                    throw error;
                }
            });
        },
        async delete(account, namespace, key) {
            const file = fileOf(account, namespace, key);
            return chain(file, () => fs.promises.rm(file, { force: true }));
        },
        async keys(account, namespace) {
            const dir = dirOf(account, namespace);
            await ready;
            let names: string[];
            try {
                names = await fs.promises.readdir(dir);
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
                throw error;
            }
            return names.map(keyOfFileName).filter((key): key is string => key !== null);
        },
    };
}
