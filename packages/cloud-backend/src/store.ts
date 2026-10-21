// Where cloud projects keep their state on this device: per namespace, JSON-safe values by key. Web: IndexedDB
// (idb-store.ts); desktop: files in the app data folder over IPC; tests: memory. A store belongs to one OpenNan
// account, so a queue is never flushed to another account.

export type StoreNamespace = "sync" | "mirror" | "uploads" | "urls" | "lists" | "snapshots";

export const STORE_NAMESPACES: readonly StoreNamespace[] = Object.freeze(["sync", "mirror", "uploads", "urls", "lists", "snapshots"]);

export interface CloudStore {
    get<T>(namespace: StoreNamespace, key: string): Promise<T | null>;
    put(namespace: StoreNamespace, key: string, value: unknown): Promise<void>;
    delete(namespace: StoreNamespace, key: string): Promise<void>;
    keys(namespace: StoreNamespace): Promise<string[]>;
}

export function createMemoryStore(): CloudStore & { dump(): Record<string, Record<string, unknown>> } {
    const data = new Map<string, Map<string, string>>();
    const ns = (name: string) => {
        let map = data.get(name);
        if (!map) data.set(name, (map = new Map()));
        return map;
    };
    return {
        async get<T>(namespace: StoreNamespace, key: string) {
            const text = ns(namespace).get(key);
            return text === undefined ? null : (JSON.parse(text) as T);
        },
        async put(namespace, key, value) {
            ns(namespace).set(key, JSON.stringify(value));
        },
        async delete(namespace, key) {
            ns(namespace).delete(key);
        },
        async keys(namespace) {
            return [...ns(namespace).keys()];
        },
        dump() {
            return Object.fromEntries([...data].map(([name, map]) => [name, Object.fromEntries([...map].map(([k, v]) => [k, JSON.parse(v)]))]));
        },
    };
}
