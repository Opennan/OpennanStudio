// The models folder: catalog models only, named by the catalog (never by input), downloaded on first use with a
// verified download, and trusted later through a stamp ({ sha256, size, mtimeMs }) that must match the file.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { downloadVerified } from "./download";
import { DEFAULT_WHISPER_MODEL, WHISPER_MODELS, findWhisperModel, type WhisperModel } from "./models";
import { checkAbsolutePath } from "./whisper-args";

export interface ModelProgress {
    received: number;
    total: number;
}

export interface EnsureOptions {
    signal?: AbortSignal;
    /** Called only while a download runs. */
    onDownload?(progress: ModelProgress): void;
}

export interface ModelStore {
    readonly dir: string;
    list(): Promise<Array<WhisperModel & { installed: boolean; default: boolean }>>;
    /** The verified model file; downloads it when it is missing or does not match. */
    ensure(id: string, options?: EnsureOptions): Promise<string>;
}

export interface ModelStoreOptions {
    dir: string;
    fetch?: typeof fetch;
    catalog?: readonly WhisperModel[];
}

interface Stamp { sha256: string; size: number; mtimeMs: number }

export async function sha256File(file: string): Promise<string> {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
    return hash.digest("hex");
}

async function regularFile(file: string): Promise<{ size: number; mtimeMs: number } | null> {
    const info = await lstat(file).catch(() => null);
    if (!info) return null;
    if (!info.isFile()) throw new Error(`${path.basename(file)} is not a regular file`);
    return { size: info.size, mtimeMs: info.mtimeMs };
}

export function createModelStore(options: ModelStoreOptions): ModelStore {
    const dir = checkAbsolutePath(options.dir, "models folder");
    const catalog = options.catalog ?? WHISPER_MODELS;
    const inflight = new Map<string, { promise: Promise<string>; signal?: AbortSignal }>();
    const fileOf = (model: WhisperModel) => path.join(dir, model.file);
    const stampOf = (model: WhisperModel) => `${fileOf(model)}.verified`;

    async function stampMatches(model: WhisperModel): Promise<boolean> {
        const file = await regularFile(fileOf(model));
        if (!file) return false;
        const stampFile = await regularFile(stampOf(model)).catch(() => null);
        if (!stampFile || stampFile.size > 4096) return false;
        try {
            const stamp = JSON.parse(await readFile(stampOf(model), "utf8")) as Stamp;
            return stamp.sha256 === model.sha256 && stamp.size === file.size && stamp.mtimeMs === file.mtimeMs && file.size === model.sizeBytes;
        } catch {
            return false;
        }
    }

    async function writeStamp(model: WhisperModel): Promise<void> {
        const file = await regularFile(fileOf(model));
        if (!file) throw new Error(`${model.file} disappeared`);
        await rm(stampOf(model), { force: true });
        await writeFile(stampOf(model), JSON.stringify({ sha256: model.sha256, size: file.size, mtimeMs: file.mtimeMs } satisfies Stamp), { mode: 0o600, flag: "wx" });
    }

    async function ensureModel(model: WhisperModel, ensureOptions: EnsureOptions): Promise<string> {
        await mkdir(dir, { recursive: true, mode: 0o700 });
        const file = fileOf(model);
        if (await stampMatches(model)) return file;
        const existing = await regularFile(file);
        if (existing) {
            if (existing.size === model.sizeBytes && (await sha256File(file)) === model.sha256) {
                await writeStamp(model);
                return file;
            }
            await rm(file, { force: true });
        }
        await rm(stampOf(model), { force: true });
        // Part files a crash or a kill left behind (each up to the model's size).
        for (const name of await readdir(dir)) if (name.startsWith(`${model.file}.part-`)) await rm(path.join(dir, name), { force: true });
        await downloadVerified({
            url: model.url, sha256: model.sha256, sizeBytes: model.sizeBytes, dest: file, fetch: options.fetch, signal: ensureOptions.signal,
            onProgress: (received, total) => ensureOptions.onDownload?.({ received, total }),
        });
        await writeStamp(model);
        return file;
    }

    return {
        dir,
        async list() {
            return Promise.all(catalog.map(async (model) => ({
                ...model,
                installed: await stampMatches(model).catch(() => false),
                default: model.id === DEFAULT_WHISPER_MODEL,
            })));
        },
        async ensure(id, ensureOptions = {}) {
            const model = findWhisperModel(id, catalog);
            if (!model) throw new Error(`Unknown model: ${String(id).slice(0, 64)}`);
            let running = inflight.get(model.id);
            // A download its first caller cancelled must not fail the next caller: wait for it to unwind, start anew.
            while (running?.signal?.aborted) {
                await running.promise.catch(() => undefined);
                running = inflight.get(model.id);
            }
            if (running) return running.promise;
            const entry = { promise: ensureModel(model, ensureOptions), signal: ensureOptions.signal };
            entry.promise = entry.promise.finally(() => {
                if (inflight.get(model.id) === entry) inflight.delete(model.id);
            });
            inflight.set(model.id, entry);
            return entry.promise;
        },
    };
}
