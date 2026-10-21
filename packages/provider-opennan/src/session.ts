// OpenNanSession: the Sign in with OpenNan state machine every host shares (web page, desktop main, CLI).
// restoring → signed-out | signed-in; start() → starting → waiting → signed-in | error. The key lives only in the
// host's CredentialStore and in this object; no status, notice, or error message ever contains it.
import { getAccount, revokeKey, type AccountInfo } from "./account";
import type { OpenNanApi } from "./api";
import { createDevicePoller, startDeviceSignIn, type DeviceClient, type DevicePoller } from "./device-flow";
import { DeviceFlowError, OpenNanApiError, openNanErrorMessage } from "./errors";

export type CredentialPersistence = "persistent" | "session" | "memory";
export type SessionErrorKind = "expired" | "denied" | "network" | "rate-limited" | "origin" | "unknown";

export type SessionStatus =
    | { state: "restoring" }
    | { state: "signed-out" }
    | { state: "starting"; signup: boolean }
    | { state: "waiting"; userCode: string; verificationUri: string; verificationUriComplete: string; expiresAt: number; reconnecting: boolean; signup: boolean }
    | { state: "signed-in"; account: AccountInfo | null; persistence: CredentialPersistence }
    | { state: "error"; kind: SessionErrorKind; message: string; retryAt?: number; signup: boolean };

export interface StoredCredential {
    apiKey: string;
    keyId: string;
    keyName?: string;
    /** ISO time for expiring keys (web), else null/absent. */
    expiresAt?: string | null;
}

export interface CredentialStore {
    get(): Promise<StoredCredential | null>;
    set(credential: StoredCredential): Promise<void>;
    clear(): Promise<void>;
    /** Where set() keeps the key: on disk (encrypted/IndexedDB), for this browser session, or in memory only. */
    persistence(): CredentialPersistence;
}

export type SessionNotice =
    | { kind: "insufficient-credits"; billingUrl: string }
    | { kind: "sign-in-needed"; feature: string };

export interface OpenNanSessionOptions {
    api: OpenNanApi;
    store: CredentialStore;
    deviceName: string | (() => string);
    client: DeviceClient;
    /** opennan.com: Buy credits falls back to it, and the approval page must be its /console/device. */
    consoleBase?: string;
    /** Called when a flow is waiting: desktop opens the browser here, the CLI prints it. */
    onVerificationUri?(uri: string): void;
    now?(): number;
}

export const API_KEY_PATTERN = /^sk-[A-Za-z0-9_-]{20,200}$/;
export const UNTRUSTED_PAGE_MESSAGE = "OpenNan sent a sign-in page Studio does not trust.";

/** The console's device page on the console origin, and nothing else: hosts open or print only this. */
export function isConsoleDeviceUrl(url: string, consoleBase: string): boolean {
    try {
        const target = new URL(url);
        const base = new URL(consoleBase);
        return target.origin === base.origin && target.pathname === "/console/device" && !target.username && !target.password;
    } catch {
        return false;
    }
}
const REFRESH_SPACING_MS = 5_000;
/** A revoke that has not answered by then is given up (the local key is already gone). */
export const REVOKE_TIMEOUT_MS = 5_000;

export function memoryCredentialStore(initial: StoredCredential | null = null): CredentialStore {
    let value = initial;
    return {
        get: async () => value,
        set: async (credential) => {
            value = { ...credential };
        },
        clear: async () => {
            value = null;
        },
        persistence: () => "memory",
    };
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

export class OpenNanSession {
    private current: SessionStatus = { state: "restoring" };
    private key: string | null = null;
    private poller: DevicePoller | null = null;
    private flow = 0;
    private background: Promise<void> = Promise.resolve();
    private lastRefresh = 0;
    private refreshTimer: ReturnType<typeof setTimeout> | null = null;
    private verificationUri: string | null = null;
    private readonly listeners = new Set<(status: SessionStatus) => void>();
    private readonly noticeListeners = new Set<(notice: SessionNotice) => void>();
    private readonly now: () => number;

    constructor(private readonly options: OpenNanSessionOptions) {
        this.now = options.now ?? Date.now;
    }

    get api(): OpenNanApi {
        return this.options.api;
    }

    status(): SessionStatus {
        return this.current;
    }

    subscribe(listener: (status: SessionStatus) => void): () => void {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    onNotice(listener: (notice: SessionNotice) => void): () => void {
        this.noticeListeners.add(listener);
        return () => {
            this.noticeListeners.delete(listener);
        };
    }

    notify(notice: SessionNotice): void {
        for (const listener of [...this.noticeListeners]) listener(notice);
    }

    /** Where Buy credits goes: the account's billing_url, else <console>/console/billing. */
    billingUrl(): string {
        const account = this.current.state === "signed-in" ? this.current.account : null;
        return account?.billingUrl ?? `${(this.options.consoleBase ?? "https://opennan.com").replace(/\/+$/, "")}/console/billing`;
    }

    /** The key while signed in (provider calls); never part of a status. */
    apiKey(): string | null {
        return this.current.state === "signed-in" ? this.key : null;
    }

    /** The current flow's approval URL (Open browser again). */
    pendingVerificationUri(): string | null {
        return this.current.state === "waiting" ? this.verificationUri : null;
    }

    /** Resolves when the work a start() or restore() left running (token exchange, account load) has finished. */
    settled(): Promise<void> {
        return this.background;
    }

    async restore(): Promise<void> {
        const credential = await this.options.store.get().catch(() => null);
        if (!credential || !API_KEY_PATTERN.test(credential.apiKey)) {
            if (credential) await this.options.store.clear().catch(() => undefined);
            if (this.current.state === "restoring") this.set({ state: "signed-out" });
            return;
        }
        if (credential.expiresAt && Date.parse(credential.expiresAt) <= this.now()) {
            await this.options.store.clear().catch(() => undefined);
            this.set({ state: "signed-out" });
            return;
        }
        this.key = credential.apiKey;
        this.set({ state: "signed-in", account: null, persistence: this.options.store.persistence() });
        await this.refresh();
    }

    async start(options: { signup?: boolean } = {}): Promise<void> {
        const signup = options.signup === true;
        this.stopFlow();
        const flow = ++this.flow;
        this.set({ state: "starting", signup });
        const deviceName = typeof this.options.deviceName === "function" ? this.options.deviceName() : this.options.deviceName;
        let start;
        try {
            start = await startDeviceSignIn(this.options.api, { deviceName, client: this.options.client, signup }, this.now);
        } catch (error) {
            if (flow === this.flow) this.fail(error, signup);
            return;
        }
        if (flow !== this.flow) return;
        // A hostile or broken answer must not send people to another page they would trust as opennan.com.
        if (!isConsoleDeviceUrl(start.verificationUriComplete, this.options.consoleBase ?? "https://opennan.com")) {
            this.set({ state: "error", kind: "unknown", message: UNTRUSTED_PAGE_MESSAGE, signup });
            return;
        }
        this.verificationUri = start.verificationUriComplete;
        const poller = createDevicePoller(this.options.api, start, {
            now: this.now,
            onReconnecting: (reconnecting) => {
                if (flow === this.flow && this.current.state === "waiting") this.set({ ...this.current, reconnecting });
            },
        });
        this.poller = poller;
        this.set({
            state: "waiting", userCode: start.userCode, verificationUri: start.verificationUri, verificationUriComplete: start.verificationUriComplete,
            expiresAt: start.expiresAt, reconnecting: false, signup,
        });
        this.options.onVerificationUri?.(start.verificationUriComplete);
        this.background = poller.result.then(async (token) => {
            // Approved after the person cancelled or signed out: that key is not wanted, so it must not stay live.
            if (flow !== this.flow) {
                await this.revokeQuietly(token.apiKey);
                return;
            }
            this.poller = null;
            const previous = this.key;
            try {
                await this.options.store.set({ apiKey: token.apiKey, keyId: token.keyId, keyName: token.keyName, expiresAt: token.expiresAt });
            } catch (error) {
                await this.revokeQuietly(token.apiKey);
                this.set({ state: "error", kind: "unknown", message: `Signed in, but the key could not be saved: ${errorText(error)}`, signup });
                return;
            }
            if (flow !== this.flow) {
                // Signed out (or restarted) while the key was being saved: take it back out and revoke it.
                const stored = await this.options.store.get().catch(() => null);
                if (stored?.apiKey === token.apiKey) await this.options.store.clear().catch(() => undefined);
                await this.revokeQuietly(token.apiKey);
                return;
            }
            this.key = token.apiKey;
            this.set({ state: "signed-in", account: null, persistence: this.options.store.persistence() });
            if (previous && previous !== token.apiKey) void this.revokeQuietly(previous);
            await this.refresh();
        }, (error: unknown) => {
            if (flow !== this.flow || (error as { name?: string }).name === "AbortError") return;
            this.poller = null;
            this.fail(error, signup);
        });
    }

    /** Polls at once (window focus, tab visible), within the poller's spacing rule. */
    pollNow(): void {
        this.poller?.pollNow();
    }

    cancel(): void {
        if (this.current.state !== "starting" && this.current.state !== "waiting" && this.current.state !== "error") return;
        this.stopFlow();
        this.flow += 1;
        this.set(this.key ? { state: "signed-in", account: null, persistence: this.options.store.persistence() } : { state: "signed-out" });
        if (this.key) void this.refresh();
    }

    /** A host-detected error (the web build's origin check). */
    reportError(kind: SessionErrorKind, message: string, signup = false): void {
        this.stopFlow();
        this.flow += 1;
        this.set({ state: "error", kind, message, signup });
    }

    /** Forgets the key here first (store and memory), then revokes it on the server (best effort, bounded). */
    async signOut(): Promise<void> {
        this.stopFlow();
        this.flow += 1;
        const key = this.key;
        this.key = null;
        await this.options.store.clear().catch(() => undefined);
        this.set({ state: "signed-out" });
        if (key) await this.revokeQuietly(key);
    }

    async switchAccount(): Promise<void> {
        await this.signOut();
        await this.start({});
    }

    /** Reloads the account (balance). A 401 means the key was revoked or expired: signed out. */
    async refresh(): Promise<void> {
        const key = this.key;
        if (!key || this.current.state !== "signed-in") return;
        this.lastRefresh = this.now();
        try {
            const account = await getAccount(this.options.api, key);
            if (this.key === key && this.current.state === "signed-in") this.set({ ...this.current, account });
        } catch (error) {
            if (error instanceof OpenNanApiError && error.status === 401 && this.key === key) await this.dropKey();
        }
    }

    /** Refresh soon (after a job settles), at most once every 5 s. */
    refreshSoon(): void {
        if (this.refreshTimer || this.current.state !== "signed-in") return;
        const wait = Math.max(0, this.lastRefresh + REFRESH_SPACING_MS - this.now());
        this.refreshTimer = setTimeout(() => {
            this.refreshTimer = null;
            void this.refresh();
        }, wait);
    }

    /** "OpenNan API key (advanced)": checks the key with GET /v1/account, then keeps it like a signed-in key. */
    async connectWithKey(input: string): Promise<void> {
        const key = input.trim();
        if (!API_KEY_PATTERN.test(key)) throw new Error("That does not look like an OpenNan API key (sk-…).");
        let account: AccountInfo;
        try {
            account = await getAccount(this.options.api, key);
        } catch (error) {
            if (error instanceof OpenNanApiError && (error.status === 401 || error.status === 403)) throw new Error("That key was not accepted by OpenNan.");
            throw new Error(`The key could not be checked: ${error instanceof OpenNanApiError ? openNanErrorMessage(error) : errorText(error)}`);
        }
        this.stopFlow();
        this.flow += 1;
        const previous = this.key;
        await this.options.store.set({ apiKey: key, keyId: account.keyId ?? "manual", keyName: account.keyName ?? "API key", expiresAt: account.keyExpiresAt });
        this.key = key;
        this.set({ state: "signed-in", account, persistence: this.options.store.persistence() });
        if (previous && previous !== key) await this.revokeQuietly(previous);
    }

    private async revokeQuietly(key: string): Promise<void> {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), REVOKE_TIMEOUT_MS);
        try {
            await revokeKey(this.options.api, key, controller.signal);
        } finally {
            clearTimeout(timer);
        }
    }

    /** The API refused the key (401): it was revoked or expired. */
    reportUnauthorized(): void {
        if (this.key) void this.dropKey();
    }

    private async dropKey(): Promise<void> {
        this.key = null;
        await this.options.store.clear().catch(() => undefined);
        this.set({ state: "signed-out" });
    }

    private stopFlow(): void {
        this.poller?.cancel();
        this.poller = null;
        this.verificationUri = null;
    }

    private fail(error: unknown, signup: boolean): void {
        if (error instanceof DeviceFlowError) {
            const status: SessionStatus = { state: "error", kind: error.kind, message: error.message, signup };
            if (error.kind === "rate-limited") status.retryAt = this.now() + (error.retryAfterSeconds ?? 30) * 1000;
            this.set(status);
            return;
        }
        this.set({ state: "error", kind: "unknown", message: errorText(error), signup });
    }

    private set(status: SessionStatus): void {
        this.current = status;
        for (const listener of [...this.listeners]) listener(status);
    }
}
