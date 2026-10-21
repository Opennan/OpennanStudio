// Where the web build keeps the OpenNan key (and bring-your-own provider keys): IndexedDB (database
// "opennan-studio-account", separate from timeline-core's project database) when "Keep me signed in on this
// browser" is on, sessionStorage when it is off. Turning the preference over moves what is stored.
import type { CredentialPersistence, CredentialStore, StoredCredential } from "@opennan/provider-opennan";

export const ACCOUNT_DB_NAME = "opennan-studio-account";
export const KEEP_SIGNED_IN_KEY = "opennan-studio:keep-signed-in";
const SESSION_PREFIX = "opennan-studio:secret:";
const OPENNAN_SLOT = "opennan";

export interface KeyValueStore {
    get(key: string): Promise<string | null>;
    set(key: string, value: string): Promise<void>;
    delete(key: string): Promise<void>;
}

export function memoryKeyValue(): KeyValueStore & { data: Map<string, string> } {
    const data = new Map<string, string>();
    return {
        data,
        get: async (key) => data.get(key) ?? null,
        set: async (key, value) => void data.set(key, value),
        delete: async (key) => void data.delete(key),
    };
}

/** A key-value store over IndexedDB (one object store, string values). */
export function indexedDbKeyValue(factory: IDBFactory, dbName = ACCOUNT_DB_NAME): KeyValueStore {
    let opening: Promise<IDBDatabase> | null = null;
    const db = () => (opening ??= new Promise<IDBDatabase>((resolve, reject) => {
        const request = factory.open(dbName, 1);
        request.onupgradeneeded = () => request.result.createObjectStore("credentials");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error("IndexedDB is not available"));
    }));
    const run = async <T>(mode: IDBTransactionMode, act: (store: IDBObjectStore) => IDBRequest<T>) => {
        const database = await db();
        return new Promise<T>((resolve, reject) => {
            const request = act(database.transaction("credentials", mode).objectStore("credentials"));
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
        });
    };
    return {
        get: async (key) => {
            const value = await run<unknown>("readonly", (store) => store.get(key));
            return typeof value === "string" ? value : null;
        },
        set: async (key, value) => void (await run("readwrite", (store) => store.put(value, key))),
        delete: async (key) => void (await run("readwrite", (store) => store.delete(key))),
    };
}

export function sessionKeyValue(storage: Storage): KeyValueStore {
    return {
        get: async (key) => storage.getItem(SESSION_PREFIX + key),
        set: async (key, value) => storage.setItem(SESSION_PREFIX + key, value),
        delete: async (key) => storage.removeItem(SESSION_PREFIX + key),
    };
}

export interface WebAccountStorage {
    /** The OpenNan credential store for OpenNanSession. */
    credentials: CredentialStore;
    keepSignedIn(): boolean;
    setKeepSignedIn(value: boolean): Promise<void>;
    getSecret(slot: string): Promise<string | null>;
    setSecret(slot: string, value: string): Promise<void>;
    removeSecret(slot: string): Promise<void>;
}

export function createWebAccountStorage(options: { persistent: KeyValueStore | null; session: KeyValueStore; preferences: Pick<Storage, "getItem" | "setItem"> | null }): WebAccountStorage {
    const readPreference = () => {
        try {
            return options.preferences?.getItem(KEEP_SIGNED_IN_KEY) !== "0";
        } catch {
            return true;
        }
    };
    let keep = readPreference();
    let persistentBroken = options.persistent === null;
    const active = (): KeyValueStore => (keep && !persistentBroken ? options.persistent! : options.session);
    const other = (): KeyValueStore | null => (keep && !persistentBroken ? options.session : options.persistent);
    const guard = async <T>(work: (store: KeyValueStore) => Promise<T>): Promise<T> => {
        try {
            return await work(active());
        } catch (error) {
            if (active() === options.session) throw error;
            persistentBroken = true;
            return work(options.session);
        }
    };
    const slots = new Set<string>([OPENNAN_SLOT]);

    const storage: WebAccountStorage = {
        credentials: {
            async get() {
                const raw = await guard((store) => store.get(OPENNAN_SLOT));
                if (!raw) return null;
                try {
                    const value = JSON.parse(raw) as StoredCredential;
                    return typeof value?.apiKey === "string" && typeof value.keyId === "string" ? value : null;
                } catch {
                    return null;
                }
            },
            set: (credential) => storage.setSecret(OPENNAN_SLOT, JSON.stringify(credential)),
            clear: () => storage.removeSecret(OPENNAN_SLOT),
            persistence: (): CredentialPersistence => (keep && !persistentBroken ? "persistent" : "session"),
        },
        keepSignedIn: () => keep,
        async setKeepSignedIn(value) {
            if (value === keep) return;
            const from = active();
            keep = value;
            try {
                options.preferences?.setItem(KEEP_SIGNED_IN_KEY, value ? "1" : "0");
            } catch {
                // the preference lasts for this page only
            }
            const to = active();
            if (from === to) return;
            for (const slot of slots) {
                const existing = await from.get(slot).catch(() => null);
                if (existing !== null) await to.set(slot, existing).catch(() => undefined);
                await from.delete(slot).catch(() => undefined);
            }
        },
        getSecret: (slot) => {
            slots.add(slot);
            return guard((store) => store.get(slot));
        },
        async setSecret(slot, value) {
            slots.add(slot);
            await guard((store) => store.set(slot, value));
            await other()?.delete(slot).catch(() => undefined);
        },
        async removeSecret(slot) {
            await options.session.delete(slot).catch(() => undefined);
            await options.persistent?.delete(slot).catch(() => undefined);
        },
    };
    return storage;
}
