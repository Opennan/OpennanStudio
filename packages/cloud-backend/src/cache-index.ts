// The index of downloaded cloud media (phase 9a.1): which files the cache itself downloaded, how big they are, and
// when each was last used, so the hosts (web OPFS, desktop media store) can keep the cache under a size limit by
// evicting the least recently used files. Only what this index lists may ever be evicted: a local project's own
// files are never in it. A file still downloading ("partial"), a file an open project pins, and a file used in the
// last minute are never evicted. The hosts own the bytes and the atomic write of the index; every update reads the
// stored index fresh under the host's lock (web: Web Locks, so tabs never overwrite each other's entries).

export interface CacheEntry {
    /** The host's id of the file (web "c-…", desktop a media-store uuid). */
    id: string;
    /** The OpenNan storage URL it was downloaded from ("" when unknown: a file found on disk without its entry). */
    url: string;
    sizeBytes: number;
    lastUsed: number;
    /** "partial": reserved for a download that has not finished (desktop streams it meanwhile). */
    state: "ready" | "partial";
    mimeType?: string;
}

export interface CacheIndexFile {
    version: 2;
    entries: CacheEntry[];
}

export interface CacheIndexStorage {
    /** The stored index as parsed JSON, or null when there is none (or it can't be read). */
    read(): Promise<unknown | null>;
    /** Replaces the stored index atomically (a crash leaves the old one or the new one, never half). */
    write(file: CacheIndexFile): Promise<void>;
    /** An exclusive lock shared by every context writing the same index (web tabs). */
    lock?<T>(run: () => Promise<T>): Promise<T>;
}

/** Entries used this recently are never evicted except by Clear cache (another tab may be about to pin them). */
export const CACHE_GRACE_MS = 60_000;
export const TOUCH_DELAY_MS = 250;

const ID = /^[A-Za-z0-9._-]{1,128}$/;

function isEntry(value: unknown): value is CacheEntry {
    if (typeof value !== "object" || value === null) return false;
    const e = value as Record<string, unknown>;
    return typeof e.id === "string" && ID.test(e.id) && typeof e.url === "string" && e.url.length <= 4096
        && typeof e.sizeBytes === "number" && Number.isFinite(e.sizeBytes) && e.sizeBytes >= 0
        && typeof e.lastUsed === "number" && Number.isFinite(e.lastUsed)
        && (e.state === "ready" || e.state === "partial")
        && (e.mimeType === undefined || (typeof e.mimeType === "string" && e.mimeType.length <= 100));
}

/** The entries of a stored index: version 2, or the 9a desktop map {version 1, entries: {url: id}}; anything else is empty. */
export function parseCacheIndex(raw: unknown): CacheEntry[] {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return [];
    const file = raw as { version?: unknown; entries?: unknown };
    const out = new Map<string, CacheEntry>();
    const keep = (entry: CacheEntry) => {
        const known = out.get(entry.id);
        if (!known || entry.lastUsed > known.lastUsed) out.set(entry.id, entry);
    };
    if (file.version === 1 && typeof file.entries === "object" && file.entries !== null && !Array.isArray(file.entries)) {
        for (const [url, id] of Object.entries(file.entries as Record<string, unknown>)) {
            if (typeof id === "string" && ID.test(id)) keep({ id, url, sizeBytes: 0, lastUsed: 0, state: "ready" });
        }
        return [...out.values()];
    }
    if (file.version !== 2 || !Array.isArray(file.entries)) return [];
    for (const value of file.entries) {
        if (!isEntry(value)) continue;
        const { id, url, sizeBytes, lastUsed, state, mimeType } = value;
        keep({ id, url, sizeBytes, lastUsed, state, ...(mimeType !== undefined ? { mimeType } : {}) });
    }
    return [...out.values()];
}

export interface EvictionOptions {
    limitBytes: number;
    /** Bytes a download about to start will add. */
    incomingBytes?: number;
    isPinned(entry: CacheEntry): boolean;
    now: number;
    graceMs?: number;
    /** Clear cache: every entry that is not pinned or partial, recent ones included. */
    all?: boolean;
}

/** Bytes the finished files take. */
export function cacheBytes(entries: Iterable<CacheEntry>): number {
    let total = 0;
    for (const entry of entries) if (entry.state === "ready") total += entry.sizeBytes;
    return total;
}

/** The entries to evict, least recently used first, so the cache (plus a coming download) fits the limit. */
export function planEviction(entries: readonly CacheEntry[], options: EvictionOptions): CacheEntry[] {
    const grace = options.graceMs ?? CACHE_GRACE_MS;
    const candidates = entries
        .filter((e) => e.state === "ready" && !options.isPinned(e) && (options.all || options.now - e.lastUsed > grace))
        .sort((a, b) => a.lastUsed - b.lastUsed || a.id.localeCompare(b.id));
    if (options.all) return candidates;
    let used = cacheBytes(entries) + Math.max(0, options.incomingBytes ?? 0);
    const victims: CacheEntry[] = [];
    for (const entry of candidates) {
        if (used <= options.limitBytes) break;
        victims.push(entry);
        used -= entry.sizeBytes;
    }
    return victims;
}

function same(a: Map<string, CacheEntry>, b: Map<string, CacheEntry>): boolean {
    if (a.size !== b.size) return false;
    for (const [id, entry] of a) {
        const other = b.get(id);
        if (!other || JSON.stringify(other) !== JSON.stringify(entry)) return false;
    }
    return true;
}

export class MediaCacheIndex {
    private chain: Promise<unknown> = Promise.resolve();
    private readonly touches = new Map<string, number>();
    private touchTimer: ReturnType<typeof setTimeout> | null = null;

    constructor(private readonly storage: CacheIndexStorage, private readonly options: { now(): number }) {}

    /** The stored entries now. */
    async entries(): Promise<CacheEntry[]> {
        return parseCacheIndex(await this.storage.read().catch(() => null));
    }

    /** Runs `fn` on the stored entries (read fresh, under the lock) and writes them back if it changed any. */
    update<T>(fn: (entries: Map<string, CacheEntry>) => T | Promise<T>): Promise<T> {
        const run = async () => {
            const before = new Map((await this.entries()).map((e) => [e.id, e] as const));
            const after = new Map([...before].map(([id, e]) => [id, { ...e }] as const));
            const result = await fn(after);
            if (!same(before, after)) await this.storage.write({ version: 2, entries: [...after.values()] });
            return result;
        };
        const locked = () => (this.storage.lock ? this.storage.lock(run) : run());
        const next = this.chain.catch(() => undefined).then(locked);
        this.chain = next;
        return next;
    }

    /** Marks entries used now; written together a moment later (opening a project touches every file it uses). */
    touch(id: string): void {
        this.touches.set(id, this.options.now());
        if (this.touchTimer !== null) return;
        this.touchTimer = setTimeout(() => {
            this.touchTimer = null;
            void this.flushTouches().catch(() => undefined);
        }, TOUCH_DELAY_MS);
    }

    async flushTouches(): Promise<void> {
        if (this.touchTimer !== null) {
            clearTimeout(this.touchTimer);
            this.touchTimer = null;
        }
        if (this.touches.size === 0) return;
        const touched = new Map(this.touches);
        this.touches.clear();
        await this.update((entries) => {
            for (const [id, at] of touched) {
                const entry = entries.get(id);
                if (entry && entry.lastUsed < at) entry.lastUsed = at;
            }
        });
    }
}
