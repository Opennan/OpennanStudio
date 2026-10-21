// An in-memory origin private file system and Web Locks for unit tests of the media cache (jsdom has neither).
// createWritable() commits on close() only, as browsers do (a crash mid-write leaves the old file).

type Node = { kind: "file"; blob: File } | { kind: "directory"; dir: FakeDirectory };

export class FakeDirectory {
    readonly nodes = new Map<string, Node>();
    failWritesFor: string | null = null;
    /** getFile() calls per file name (tests count index reads). */
    readonly reads = new Map<string, number>();

    async getDirectoryHandle(name: string, options: { create?: boolean } = {}): Promise<FakeDirectory> {
        const node = this.nodes.get(name);
        if (node?.kind === "directory") return node.dir;
        if (node) throw new DOMException("not a directory", "TypeMismatchError");
        if (!options.create) throw new DOMException("missing", "NotFoundError");
        const dir = new FakeDirectory();
        this.nodes.set(name, { kind: "directory", dir });
        return dir;
    }

    async getFileHandle(name: string, options: { create?: boolean } = {}) {
        let node = this.nodes.get(name);
        if (node?.kind === "directory") throw new DOMException("is a directory", "TypeMismatchError");
        if (!node) {
            if (!options.create) throw new DOMException("missing", "NotFoundError");
            node = { kind: "file", blob: new File([], name) };
            this.nodes.set(name, node);
        }
        const self = this;
        return {
            kind: "file" as const,
            name,
            async getFile(): Promise<File> {
                self.reads.set(name, (self.reads.get(name) ?? 0) + 1);
                const current = self.nodes.get(name);
                if (!current || current.kind !== "file") throw new DOMException("missing", "NotFoundError");
                return current.blob;
            },
            async createWritable() {
                if (self.failWritesFor === name) throw new DOMException("quota", "QuotaExceededError");
                const parts: BlobPart[] = [];
                return {
                    async write(data: BlobPart) {
                        parts.push(data instanceof Uint8Array ? data.slice() : data);
                    },
                    async close() {
                        const type = parts.length === 1 && parts[0] instanceof Blob ? (parts[0] as Blob).type : "";
                        self.nodes.set(name, { kind: "file", blob: new File(parts, name, { type, lastModified: Date.now() }) });
                    },
                    async abort() {
                        parts.length = 0;
                    },
                };
            },
        };
    }

    async removeEntry(name: string): Promise<void> {
        if (!this.nodes.delete(name)) throw new DOMException("missing", "NotFoundError");
    }

    async *keys(): AsyncIterableIterator<string> {
        for (const name of [...this.nodes.keys()]) yield name;
    }

    /** Test helper: the files' names and sizes. */
    files(): Record<string, number> {
        const out: Record<string, number> = {};
        for (const [name, node] of this.nodes) if (node.kind === "file") out[name] = node.blob.size;
        return out;
    }
}

export function fakeStorage(options: { quota?: number | null } = {}) {
    const root = new FakeDirectory();
    const manager = {
        getDirectory: async () => root,
        persist: async () => true,
        persisted: async () => true,
        ...(options.quota === null ? {} : { estimate: async () => ({ quota: options.quota ?? 100 * 1024 ** 3, usage: 0 }) }),
    };
    return { root, manager: manager as unknown as StorageManager, cacheDir: () => root.getDirectoryHandle("media-cache", { create: true }) };
}

/** Web Locks shared by the "tabs" a test makes (exclusive and shared modes, query()). */
export function fakeLocks() {
    const held: Array<{ name: string; mode: LockMode; client: number }> = [];
    const waiting: Array<() => void> = [];
    let clients = 0;
    const wake = () => {
        for (const run of waiting.splice(0)) run();
    };
    function manager() {
        const client = ++clients;
        return {
            async request(name: string, optionsOrRun: LockOptions | (() => Promise<unknown>), maybeRun?: (lock: unknown) => Promise<unknown>) {
                const options: LockOptions = typeof optionsOrRun === "function" ? {} : optionsOrRun;
                const run = (typeof optionsOrRun === "function" ? optionsOrRun : maybeRun)!;
                const mode = options.mode ?? "exclusive";
                // Granted a moment later, as browsers do.
                await Promise.resolve();
                const free = () => !held.some((h) => h.name === name && (mode === "exclusive" || h.mode === "exclusive"));
                while (!free()) await new Promise<void>((resolve) => waiting.push(resolve));
                const lock = { name, mode, client };
                held.push(lock);
                try {
                    return await run({ name, mode });
                } finally {
                    held.splice(held.indexOf(lock), 1);
                    wake();
                }
            },
            async query() {
                return { held: held.map((h) => ({ name: h.name, mode: h.mode, clientId: String(h.client) })), pending: [] };
            },
        } as unknown as LockManager;
    }
    return { manager, held: () => held.map((h) => `${h.mode}:${h.name}`) };
}
