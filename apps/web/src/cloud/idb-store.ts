// CloudStore over IndexedDB (database "opennan-studio-cloud", one object store), keys scoped by account: a cloud
// project's queue, confirmed document, working copy and upload map survive a reload, a crash, or a week offline.
import type { CloudStore, StoreNamespace } from "@opennan/cloud-backend";

export const CLOUD_DB_NAME = "opennan-studio-cloud";
const STORE = "kv";

export function openCloudDb(factory: IDBFactory, name = CLOUD_DB_NAME): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const request = factory.open(name, 1);
        request.onupgradeneeded = () => {
            if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

export function createIdbCloudStore(accountId: string, factory: IDBFactory, name = CLOUD_DB_NAME): CloudStore {
    let db: Promise<IDBDatabase> | null = null;
    const open = () => (db ??= openCloudDb(factory, name));
    const prefix = (namespace: StoreNamespace) => `${accountId}\u0000${namespace}\u0000`;
    async function run<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
        const database = await open();
        return new Promise<T>((resolve, reject) => {
            const transaction = database.transaction(STORE, mode);
            const request = action(transaction.objectStore(STORE));
            transaction.oncomplete = () => resolve(request.result);
            transaction.onerror = () => reject(transaction.error ?? request.error);
            transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
        });
    }
    return {
        async get<T>(namespace: StoreNamespace, key: string) {
            const value = await run("readonly", (store) => store.get(prefix(namespace) + key) as IDBRequest<T | undefined>);
            return value ?? null;
        },
        async put(namespace, key, value) {
            await run("readwrite", (store) => store.put(structuredClone(value), prefix(namespace) + key));
        },
        async delete(namespace, key) {
            await run("readwrite", (store) => store.delete(prefix(namespace) + key));
        },
        async keys(namespace) {
            const start = prefix(namespace);
            const keys = await run("readonly", (store) => store.getAllKeys(IDBKeyRange.bound(start, `${start}￿`)) as IDBRequest<IDBValidKey[]>);
            return keys.map((key) => String(key).slice(start.length));
        },
    };
}
