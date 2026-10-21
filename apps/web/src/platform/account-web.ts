// Sign in with OpenNan in the browser: the device flow runs in the page (OpenNanSession), the approval page opens
// in a popup created synchronously in the click handler (so browsers allow it) with opener cut, polling speeds up
// when the tab regains focus, and the key lives in IndexedDB or sessionStorage (account-storage.ts). No
// postMessage, no redirect back into the app: the page only polls opennan.com.
import { OpenNanSession, createOpenNanApi, webDeviceName, type SessionStatus } from "@opennan/provider-opennan";
import type { AccountPlatform, ConsolePage } from "../account/account-types";
import type { WebAccountStorage } from "./account-storage";

export const SIGN_IN_HOSTS = new Set(["studio.opennan.com", "localhost", "127.0.0.1"]);
export const ONBOARDING_KEY = "opennan-studio:signin-prompted";
export const E2E_ONBOARDING_KEY = "opennan-studio:e2e-onboarding";
export const E2E_ORIGIN_KEY = "opennan-studio:e2e-origin";
const POPUP_FEATURES = "popup=yes,width=520,height=760";

export interface PopupWindow {
    opener: unknown;
    closed: boolean;
    location: { href: string };
    close(): void;
}

export interface BrowserLike {
    open(url: string, target: string, features?: string): PopupWindow | null;
    addEventListener(type: "focus", listener: () => void): void;
    document?: { visibilityState: string; addEventListener(type: "visibilitychange", listener: () => void): void };
    location: { hostname: string };
    navigator: { userAgent: string };
}

export interface WebAccountOptions {
    apiBase: string;
    consoleBase: string;
    storage: WebAccountStorage;
    browser: BrowserLike;
    preferences: Pick<Storage, "getItem" | "setItem"> | null;
    e2e: boolean;
    fetch?: typeof globalThis.fetch;
}

export interface WebAccount extends AccountPlatform {
    session: OpenNanSession;
    storage: WebAccountStorage;
    ready: Promise<void>;
}

export function isSignInOrigin(hostname: string, e2e: boolean): boolean {
    return e2e || SIGN_IN_HOSTS.has(hostname);
}

export function createWebAccount(options: WebAccountOptions): WebAccount {
    const { browser, preferences, storage } = options;
    const consoleBase = options.consoleBase.replace(/\/+$/, "");
    const api = createOpenNanApi({ baseUrl: options.apiBase, ...(options.fetch ? { fetch: options.fetch } : {}) });
    const session = new OpenNanSession({
        api, store: storage.credentials, client: "web", consoleBase,
        deviceName: () => webDeviceName(browser.navigator.userAgent),
    });
    const listeners = new Set<() => void>();
    let blocked = false;
    let snapshot: SessionStatus = session.status();
    const changed = () => {
        snapshot = { ...session.status() } as SessionStatus;
        for (const listener of [...listeners]) listener();
    };
    session.subscribe(changed);
    const pref = (key: string) => {
        try {
            return preferences?.getItem(key) ?? null;
        } catch {
            return null;
        }
    };
    const allowed = () => isSignInOrigin(browser.location.hostname, options.e2e) && !(options.e2e && pref(E2E_ORIGIN_KEY) === "blocked");

    /** Opens an empty popup now (inside the click), cut from this page; null when the browser blocked it. */
    const openPopup = (target: string): PopupWindow | null => {
        let popup: PopupWindow | null = null;
        try {
            popup = browser.open("about:blank", target, POPUP_FEATURES);
        } catch {
            popup = null;
        }
        if (popup) {
            try {
                popup.opener = null;
            } catch {
                // already cut
            }
        }
        blocked = popup === null;
        return popup;
    };
    const point = (popup: PopupWindow | null, uri: string | null) => {
        if (!uri) {
            popup?.close();
            return;
        }
        if (popup && !popup.closed) popup.location.href = uri;
        else blocked = true;
        changed();
    };
    const flow = async (popup: PopupWindow | null, signup: boolean) => {
        await session.start({ signup });
        point(popup, session.pendingVerificationUri());
    };

    browser.addEventListener("focus", () => session.pollNow());
    browser.document?.addEventListener("visibilitychange", () => {
        if (browser.document?.visibilityState === "visible") session.pollNow();
    });

    const ready = session.restore().catch(() => undefined);

    return {
        session,
        storage,
        ready,
        consoleOrigin: consoleBase,
        status: () => snapshot,
        subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        async startSignIn({ signup = false }) {
            if (!allowed()) {
                session.reportError("origin", "Sign-in is available on studio.opennan.com and in the desktop app.", signup);
                return;
            }
            const popup = openPopup("opennan-signin");
            await flow(popup, signup);
        },
        openBrowserAgain() {
            const uri = session.pendingVerificationUri();
            if (!uri) return;
            point(openPopup("_blank"), uri);
        },
        cancelSignIn: () => session.cancel(),
        signOut: () => session.signOut(),
        async switchAccount() {
            if (!allowed()) {
                await session.signOut();
                session.reportError("origin", "Sign-in is available on studio.opennan.com and in the desktop app.");
                return;
            }
            const popup = openPopup("opennan-signin");
            await session.signOut();
            await flow(popup, false);
        },
        refresh: () => session.refresh(),
        openConsole(page: ConsolePage) {
            try {
                browser.open(`${consoleBase}/console/${page}`, "_blank", "noopener,noreferrer");
            } catch {
                // popup blocked: nothing else to do from here
            }
        },
        connectWithKey: (key) => session.connectWithKey(key),
        onNotice: (listener) => session.onNotice(listener),
        popupBlocked: () => blocked,
        keepSignedIn: {
            get: () => storage.keepSignedIn(),
            set: (value) => void storage.setKeepSignedIn(value),
        },
        onboarding: {
            pending: () => pref(ONBOARDING_KEY) !== "1" && (!options.e2e || pref(E2E_ONBOARDING_KEY) === "1"),
            dismiss: () => {
                try {
                    preferences?.setItem(ONBOARDING_KEY, "1");
                } catch {
                    // shown again next time
                }
            },
        },
    };
}
