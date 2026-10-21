// API keys encrypted with Electron's safeStorage (OS keychain / DPAPI / libsecret). Values never leave main
// except into the environment of the one terminal profile that uses them; the renderer sees only which
// names are set. On Linux a "basic_text" backend is plain obfuscation, so keys are refused there.
import { SECRET_NAMES, SecretValueSchema, type SecretName, type SecretStatus } from "../../shared/settings";
import type { DesktopDatabase } from "./database";

export interface SafeStorageLike {
    isEncryptionAvailable(): boolean;
    encryptString(plainText: string): Buffer;
    decryptString(encrypted: Buffer): string;
    getSelectedStorageBackend?(): string;
}

export interface SecretStore {
    list(): SecretStatus[];
    set(name: SecretName, value: string): void;
    get(name: SecretName): string | null;
    remove(name: SecretName): void;
    /** Slots only main uses (the OpenNan session): never listed, never reachable through the secrets IPC. */
    getInternal(name: InternalSecretName): string | null;
    setInternal(name: InternalSecretName, value: string): void;
    removeInternal(name: InternalSecretName): void;
    /** Whether set() encrypts for real (false without safeStorage, and on Linux's basic_text backend). */
    isSecure(): boolean;
}

/** Secrets main keeps for itself. The renderer can neither list, read, write, nor remove them. */
export const INTERNAL_SECRET_NAMES = ["OPENNAN_STUDIO_SESSION"] as const;
export type InternalSecretName = (typeof INTERNAL_SECRET_NAMES)[number];
const MAX_INTERNAL_BYTES = 16 * 1024;

export const UNAVAILABLE = "Secure storage is not available on this system, so API keys cannot be saved.";

export function createSecretStore({ db, safeStorage, platform = process.platform, now = Date.now }: {
    db: DesktopDatabase;
    safeStorage: SafeStorageLike;
    platform?: NodeJS.Platform;
    now?(): number;
}): SecretStore {
    const names = db.prepare("select name from secrets");
    const read = db.prepare("select cipher from secrets where name = ?");
    const write = db.prepare("insert into secrets (name, cipher, updated_at) values (?, ?, ?) on conflict(name) do update set cipher = excluded.cipher, updated_at = excluded.updated_at");
    const remove = db.prepare("delete from secrets where name = ?");
    const known = (name: string): name is SecretName => (SECRET_NAMES as readonly string[]).includes(name);
    const internal = (name: string): name is InternalSecretName => (INTERNAL_SECRET_NAMES as readonly string[]).includes(name);
    const decrypt = (name: string): string | null => {
        if (!safeStorage.isEncryptionAvailable()) return null;
        const row = read.get(name) as { cipher: Buffer } | undefined;
        if (!row) return null;
        try {
            return safeStorage.decryptString(row.cipher);
        } catch {
            return null;
        }
    };
    const secure = () => {
        if (!safeStorage.isEncryptionAvailable()) return false;
        if (platform !== "linux") return true;
        const backend = safeStorage.getSelectedStorageBackend?.() ?? "unknown";
        return backend !== "basic_text" && backend !== "unknown";
    };
    return {
        list() {
            const set = new Set((names.all() as Array<{ name: string }>).map((row) => row.name));
            return SECRET_NAMES.map((name) => ({ name, set: set.has(name) }));
        },
        set(name, value) {
            if (!known(name)) throw new Error("Unknown API key name");
            const parsed = SecretValueSchema.parse(value);
            if (!secure()) throw new Error(UNAVAILABLE);
            write.run(name, safeStorage.encryptString(parsed), now());
        },
        get(name) {
            return known(name) ? decrypt(name) : null;
        },
        remove(name) {
            if (!known(name)) throw new Error("Unknown API key name");
            remove.run(name);
        },
        getInternal(name) {
            return internal(name) ? decrypt(name) : null;
        },
        setInternal(name, value) {
            if (!internal(name)) throw new Error("Unknown internal secret");
            if (typeof value !== "string" || value.length === 0 || value.length > MAX_INTERNAL_BYTES) throw new Error("Invalid internal secret");
            if (!secure()) throw new Error(UNAVAILABLE);
            write.run(name, safeStorage.encryptString(value), now());
        },
        removeInternal(name) {
            if (!internal(name)) throw new Error("Unknown internal secret");
            remove.run(name);
        },
        isSecure: () => secure(),
    };
}
