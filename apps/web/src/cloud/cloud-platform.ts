// The shell's cloud seam (StudioRuntime.cloud): the OpenNan cloud backend of the signed-in account, built only when
// something asks for it (the Cloud tab, a cloud project, Save to OpenNan), so a person who never opts in never
// starts any cloud work. One backend per account: signing in to another account builds a new one over that
// account's own store, so a queue is never sent to the wrong account; signing in again to the same one resumes it.
import { storageFromJson, type CloudApi, type OpenNanCloudBackend, type StorageInfo } from "@opennan/cloud-backend";
import type { ExportResult } from "@opennan/export";
import type { LocalBackend } from "@opennan/timeline-core";
import type { AccountPlatform, SessionStatus } from "../account/account-types";
import type { TabLocks } from "./tab-lock";

export interface CloudPlatform {
    /** The signed-in account's cloud backend (built on first use); null while signed out with none built. */
    backend(): OpenNanCloudBackend | null;
    /** The backend if one was built, without building one. */
    peek(): OpenNanCloudBackend | null;
    /** The backend changed (built, replaced, gone). */
    subscribe(listener: () => void): () => void;
    /** Local projects (Save to OpenNan moves one; Download a local copy makes one). */
    local: LocalBackend;
    /** Object URLs for media a cloud working copy holds on this device. */
    resolveLocalUrl(url: string): string | null;
    /** One tab at a time per cloud project (web); absent where one window edits (desktop). */
    locks?: TabLocks;
    /**
     * The signed-in account's cloud storage (GET /v1/storage), read without building the cloud backend and kept
     * `maxAgeMs` (default 30 s) per account; null while signed out or without an API on this host (phase 9a.1).
     */
    storage(options?: { maxAgeMs?: number }): Promise<StorageInfo> | null;
    /**
     * Uploads an export of the open project with its server id (phase 9c: Export and share): web from the page, desktop
     * through main (only a file main exported). Absent: no Export and share on this host.
     */
    uploadExport?(result: ExportResult, serverId: string, options: { signal: AbortSignal; onProgress(ratio: number): void; name?: string }): Promise<{ mediaUrl: string }>;
    /** Share links on this machine's loopback (the e2e fake) are accepted: e2e runs of a host whose API is a proxy (9c.1). */
    loopbackShares?: boolean;
}

export type ExportUpload = NonNullable<CloudPlatform["uploadExport"]>;

/** How long the account menu's storage meter reuses an answer. */
export const STORAGE_MAX_AGE_MS = 30_000;

/** The email store a backend keyed by the account id moves its records from (and the old backend's dispose). */
export interface CloudMigration {
    from: string;
    waitFor: Promise<unknown>;
}

const REMEMBERED_ACCOUNT = "opennan-studio:cloud-account";

function remembered(): { keyId: string; account: string; legacy: string | null } | null {
    try {
        const value = JSON.parse(globalThis.localStorage?.getItem(REMEMBERED_ACCOUNT) ?? "null");
        if (!value || typeof value.keyId !== "string" || typeof value.account !== "string") return null;
        return { keyId: value.keyId, account: value.account, legacy: typeof value.legacy === "string" ? value.legacy : null };
    } catch {
        return null;
    }
}

function forget(): void {
    try {
        globalThis.localStorage?.removeItem(REMEMBERED_ACCOUNT);
    } catch {
        // nothing kept
    }
}

function remember(keyId: string, account: string, legacy: string | null): void {
    try {
        globalThis.localStorage?.setItem(REMEMBERED_ACCOUNT, JSON.stringify({ keyId, account, ...(legacy ? { legacy } : {}) }));
    } catch {
        // private mode: offline reloads then wait for the account
    }
}

/**
 * The store name of the signed-in account: "id:<account id>" when /v1/account sends a stable id (phase 9a.1), else its
 * email (keys differ per device; the account does not). `legacy` is the email a store keyed by the id moves from.
 * Offline, before the account could be read, the key this same API key had last time; otherwise none, so a queue is
 * never filed under the wrong account.
 */
export function accountKeys(status: SessionStatus): { key: string; legacy: string | null } | null {
    if (status.state !== "signed-in") return null;
    const keyId = status.account?.keyId ?? null;
    if (status.account?.email) {
        const email = status.account.email.trim().toLowerCase();
        const id = status.account.accountId ?? null;
        const key = id ? `id:${id}` : email;
        const legacy = id ? email : null;
        if (keyId) remember(keyId, key, legacy);
        return { key, legacy };
    }
    const last = remembered();
    return last && (!keyId || last.keyId === keyId) ? { key: last.account, legacy: last.legacy } : null;
}

export function accountKey(status: SessionStatus): string | null {
    return accountKeys(status)?.key ?? null;
}

export interface CloudPlatformOptions {
    account: AccountPlatform;
    local: LocalBackend;
    /** The backend of one account's store; `migration`: the email store to move from first (9a.1). */
    build(accountId: string, migration?: CloudMigration): OpenNanCloudBackend;
    /** A light API client of the signed-in account (the storage meter); none: no meter without a backend. */
    api?(): CloudApi | null;
    locks?: TabLocks;
    now?(): number;
    uploadExport?: ExportUpload;
    loopbackShares?: boolean;
}

export function createCloudPlatform(options: CloudPlatformOptions): CloudPlatform {
    let current: { accountId: string; backend: OpenNanCloudBackend } | null = null;
    /** The last backend's dispose (a migration from its store waits for it). */
    let released: { accountId: string; done: Promise<unknown> } | null = null;
    let storageCache: { accountId: string; at: number; value: Promise<StorageInfo> } | null = null;
    const now = options.now ?? Date.now;
    const listeners = new Set<() => void>();
    const notify = () => {
        for (const listener of listeners) listener();
    };
    let lastKey = accountKey(options.account.status());
    options.account.subscribe(() => {
        // Signing out or starting a new sign-in forgets which account this browser's key belonged to (the next key may
        // be someone else's): until the new account is read there is no backend.
        const state = options.account.status().state;
        if (state === "signed-out" || state === "starting" || state === "waiting") forget();
        const key = accountKey(options.account.status());
        if (key === lastKey) return;
        lastKey = key;
        storageCache = null;
        if (!key || !current) return;
        if (current.accountId === key) {
            current.backend.resume();
            return;
        }
        // Another account (or the same one now keyed by its id): the old backend stops; its queue stays in its own
        // store for when that account returns, or moves to the id store once the old backend let go.
        const old = current;
        current = null;
        released = { accountId: old.accountId, done: old.backend.dispose().catch(() => undefined) };
        notify();
    });
    return {
        backend() {
            if (current) return current.backend;
            const keys = accountKeys(options.account.status());
            if (!keys) return null;
            const migration = keys.legacy && keys.legacy !== keys.key
                ? { from: keys.legacy, waitFor: released?.accountId === keys.legacy ? released.done : Promise.resolve() }
                : undefined;
            current = { accountId: keys.key, backend: migration ? options.build(keys.key, migration) : options.build(keys.key) };
            queueMicrotask(notify);
            return current.backend;
        },
        peek: () => current?.backend ?? null,
        subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        local: options.local,
        resolveLocalUrl: (url) => current?.backend.resolveLocalUrl(url) ?? null,
        ...(options.locks ? { locks: options.locks } : {}),
        ...(options.uploadExport ? { uploadExport: options.uploadExport } : {}),
        ...(options.loopbackShares ? { loopbackShares: true } : {}),
        storage({ maxAgeMs = STORAGE_MAX_AGE_MS } = {}) {
            const key = accountKey(options.account.status());
            if (!key) return null;
            if (storageCache && storageCache.accountId === key && now() - storageCache.at <= maxAgeMs) return storageCache.value;
            const read = current?.backend ? () => current!.backend.storage() : (() => {
                const api = options.api?.();
                return api ? async () => storageFromJson((await api.request<Record<string, unknown>>("GET", "/v1/storage")).body ?? {}) : null;
            })();
            if (!read) return null;
            const entry = { accountId: key, at: now(), value: read() };
            storageCache = entry;
            // A failed read is never reused.
            entry.value.catch(() => {
                if (storageCache === entry) storageCache = null;
            });
            return entry.value;
        },
    };
}
