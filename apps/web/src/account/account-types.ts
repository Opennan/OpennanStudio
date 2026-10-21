// The shell's account and provider-settings seams (StudioRuntime.account, StudioRuntime.providerSettings). The web
// app implements them in the page (platform/account-web.ts), desktop over IPC to main. Statuses never carry a key.
import type { OpenCapability } from "@opennan/provider-sdk";
import type { AccountInfo, SessionNotice, SessionStatus } from "@opennan/provider-opennan";

export type { AccountInfo, SessionNotice, SessionStatus };

export type ConsolePage = "billing" | "usage" | "keys";

export interface AccountPlatform {
    status(): SessionStatus;
    subscribe(listener: () => void): () => void;
    /** Starts Sign in with OpenNan. The web build opens its popup synchronously first, so call it from the click. */
    startSignIn(options: { signup?: boolean }): Promise<void>;
    openBrowserAgain(): void;
    cancelSignIn(): void;
    signOut(): Promise<void>;
    switchAccount(): Promise<void>;
    refresh(): Promise<void>;
    openConsole(page: ConsolePage): void;
    /** "OpenNan API key (advanced)". Rejects with a message to show. */
    connectWithKey(key: string): Promise<void>;
    onNotice(listener: (notice: SessionNotice) => void): () => void;
    /** opennan.com, for the "enter the code" hint. */
    consoleOrigin: string;
    /** Web: the browser blocked the approval popup (the modal then shows a link). */
    popupBlocked?(): boolean;
    /** Web: "Keep me signed in on this browser". */
    keepSignedIn?: { get(): boolean; set(value: boolean): void };
    /** The first-launch prompt: pending until shown once. */
    onboarding: { pending(): boolean; dismiss(): void };
}

export type ProviderKeyId = "fal";

export interface ProviderRouting {
    overrides: Partial<Record<OpenCapability, string>>;
    opennanDefault: boolean;
}

export const DEFAULT_ROUTING: ProviderRouting = { overrides: {}, opennanDefault: true };

export interface ProviderPlatform {
    routing(): ProviderRouting;
    setRouting(next: ProviderRouting): Promise<void>;
    subscribe(listener: () => void): () => void;
    /** Bring-your-own keys this platform can keep (empty when no such provider is built in). */
    keys(): Array<{ id: ProviderKeyId; name: string; set: boolean }>;
    setKey(id: ProviderKeyId, key: string): Promise<void>;
    removeKey(id: ProviderKeyId): Promise<void>;
}

/** An account seam that is never signed in (tests, hosts without OpenNan). */
export function signedOutAccount(overrides: Partial<AccountPlatform> = {}): AccountPlatform {
    const status: SessionStatus = { state: "signed-out" };
    return {
        status: () => status,
        subscribe: () => () => undefined,
        startSignIn: async () => undefined,
        openBrowserAgain: () => undefined,
        cancelSignIn: () => undefined,
        signOut: async () => undefined,
        switchAccount: async () => undefined,
        refresh: async () => undefined,
        openConsole: () => undefined,
        connectWithKey: async () => {
            throw new Error("OpenNan is not available here.");
        },
        onNotice: () => () => undefined,
        consoleOrigin: "https://opennan.com",
        onboarding: { pending: () => false, dismiss: () => undefined },
        ...overrides,
    };
}

/** Routing kept in memory (tests, hosts without settings). */
export function memoryProviderSettings(initial: ProviderRouting = DEFAULT_ROUTING): ProviderPlatform {
    let routing = initial;
    const listeners = new Set<() => void>();
    return {
        routing: () => routing,
        async setRouting(next) {
            routing = next;
            for (const listener of [...listeners]) listener();
        },
        subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        keys: () => [],
        setKey: async () => undefined,
        removeKey: async () => undefined,
    };
}
