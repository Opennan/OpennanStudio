// Sign in with OpenNan on desktop (phase 8): the whole account lives in main. The key is kept in an internal
// safeStorage slot (never listed, never sent to the renderer); the renderer gets statuses and notices only. The
// browser opens with shell.openExternal, without the link dialog, but only for the configured console's device
// page; the window comes to the front when sign-in succeeds. On Linux without a real keyring (basic_text) the key
// stays in memory for this run only.
import {
    DEFAULT_API_BASE, DEFAULT_CONSOLE_BASE, OpenNanSession, cleanDeviceName, createOpenNanApi, isAllowedApiBase, isConsoleDeviceUrl,
    type CredentialStore, type SessionNotice, type SessionStatus, type StoredCredential,
} from "@opennan/provider-opennan";
import { EVENTS } from "../../shared/channels";
import type { SecretStore } from "../store/secrets";

export const CONSOLE_PAGES = ["billing", "usage", "keys"] as const;
export type ConsolePageName = (typeof CONSOLE_PAGES)[number];
export const SESSION_SLOT = "OPENNAN_STUDIO_SESSION";
export const MEMORY_ONLY_WARNING = "This system has no secure key storage: OpenNan stays signed in until Studio quits.";

export interface AccountServiceOptions {
    apiBase: string;
    consoleBase: string;
    secrets: Pick<SecretStore, "getInternal" | "setInternal" | "removeInternal" | "isSecure">;
    openExternal(url: string): Promise<unknown> | unknown;
    focusWindow(): void;
    deviceName: string;
    send(channel: string, payload: unknown): void;
    warn?(message: string): void;
    fetch?: typeof globalThis.fetch;
}

export interface AccountService {
    session: OpenNanSession;
    ready: Promise<void>;
    status(): SessionStatus;
    start(signup: boolean): Promise<void>;
    reopen(): void;
    cancel(): void;
    signOut(): Promise<void>;
    switchAccount(): Promise<void>;
    refresh(): Promise<void>;
    openConsole(page: ConsolePageName): void;
    connectKey(key: string): Promise<void>;
}

/**
 * opennan.com addresses. Only an unpackaged e2e run (OPENNAN_STUDIO_E2E=1, the Playwright smoke) may point them at
 * the fake OpenNan server with OPENNAN_STUDIO_API_BASE / OPENNAN_STUDIO_CONSOLE_BASE; a packaged app never reads them.
 */
export function openNanBases(env: Record<string, string | undefined>, isPackaged: boolean): { apiBase: string; consoleBase: string; overridden: boolean } {
    const api = env.OPENNAN_STUDIO_API_BASE;
    if (isPackaged || env.OPENNAN_STUDIO_E2E !== "1" || !api || !isAllowedApiBase(api)) return { apiBase: DEFAULT_API_BASE, consoleBase: DEFAULT_CONSOLE_BASE, overridden: false };
    const consoleBase = env.OPENNAN_STUDIO_CONSOLE_BASE && isAllowedApiBase(env.OPENNAN_STUDIO_CONSOLE_BASE) ? env.OPENNAN_STUDIO_CONSOLE_BASE : api;
    return { apiBase: api, consoleBase, overridden: true };
}

/** The console's device page on the configured console origin, and nothing else (shared with every host). */
export { isConsoleDeviceUrl };

export function createSecretCredentialStore(secrets: AccountServiceOptions["secrets"], warn: (message: string) => void): CredentialStore {
    let memory: StoredCredential | null = null;
    let warned = false;
    const secure = () => secrets.isSecure();
    return {
        async get() {
            if (!secure()) return memory;
            const raw = secrets.getInternal(SESSION_SLOT);
            if (!raw) return null;
            try {
                const value = JSON.parse(raw) as StoredCredential;
                return typeof value?.apiKey === "string" && typeof value.keyId === "string" ? value : null;
            } catch {
                return null;
            }
        },
        async set(credential) {
            if (!secure()) {
                memory = { ...credential };
                if (!warned) {
                    warned = true;
                    warn(MEMORY_ONLY_WARNING);
                }
                return;
            }
            secrets.setInternal(SESSION_SLOT, JSON.stringify(credential));
        },
        async clear() {
            memory = null;
            try {
                secrets.removeInternal(SESSION_SLOT);
            } catch {
                // nothing stored
            }
        },
        persistence: () => (secure() ? "persistent" : "memory"),
    };
}

export function createAccountService(options: AccountServiceOptions): AccountService {
    const consoleBase = options.consoleBase.replace(/\/+$/, "");
    const warn = options.warn ?? (() => undefined);
    const open = (url: string) => {
        if (!isConsoleDeviceUrl(url, consoleBase)) return false;
        void Promise.resolve(options.openExternal(url)).catch(() => undefined);
        return true;
    };
    const session: OpenNanSession = new OpenNanSession({
        api: createOpenNanApi({ baseUrl: options.apiBase, ...(options.fetch ? { fetch: options.fetch } : {}) }),
        store: createSecretCredentialStore(options.secrets, warn),
        client: "desktop",
        consoleBase,
        deviceName: cleanDeviceName(options.deviceName),
        // The session already refuses any page but the console's device page; main checks again before opening.
        onVerificationUri: (uri) => {
            if (!open(uri)) session.reportError("unknown", "OpenNan sent a sign-in page Studio does not trust.");
        },
    });
    let previous = session.status().state;
    session.subscribe((status) => {
        options.send(EVENTS.accountChanged, status);
        if (status.state === "signed-in" && (previous === "waiting" || previous === "starting")) options.focusWindow();
        previous = status.state;
    });
    session.onNotice((notice: SessionNotice) => options.send(EVENTS.accountNotice, notice));
    const ready = session.restore().catch(() => undefined);
    return {
        session,
        ready,
        status: () => session.status(),
        start: (signup) => session.start({ signup }),
        reopen() {
            const uri = session.pendingVerificationUri();
            if (uri) open(uri);
        },
        cancel: () => session.cancel(),
        signOut: () => session.signOut(),
        switchAccount: () => session.switchAccount(),
        refresh: () => session.refresh(),
        openConsole(page) {
            if (!(CONSOLE_PAGES as readonly string[]).includes(page)) return;
            void Promise.resolve(options.openExternal(`${consoleBase}/console/${page}`)).catch(() => undefined);
        },
        connectKey: (key) => session.connectWithKey(key),
    };
}
