// A scriptable AccountPlatform for unit tests: set the status, read what the UI called.
import type { AccountInfo, SessionNotice, SessionStatus } from "@opennan/provider-opennan";
import type { AccountPlatform, ConsolePage } from "./account-types";

export const TEST_ACCOUNT: AccountInfo = {
    email: "ada@example.com", displayName: "Ada Lovelace", photoUrl: null, balanceUsd: 12.4, keyId: "key_1", keyName: "OpenNan Studio (test)",
    keyExpiresAt: null, billingUrl: "https://opennan.com/console/billing",
};

export interface FakeAccount extends AccountPlatform {
    calls: string[];
    consoles: ConsolePage[];
    setStatus(status: SessionStatus): void;
    notice(notice: SessionNotice): void;
    blocked: boolean;
    keep: boolean;
    pending: boolean;
}

export function createFakeAccount(initial: SessionStatus = { state: "signed-out" }, options: { keepSignedIn?: boolean } = {}): FakeAccount {
    let status = initial;
    const listeners = new Set<() => void>();
    const noticeListeners = new Set<(n: SessionNotice) => void>();
    const fake: FakeAccount = {
        calls: [],
        consoles: [],
        blocked: false,
        keep: true,
        pending: false,
        status: () => status,
        subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        setStatus(next) {
            status = next;
            for (const listener of [...listeners]) listener();
        },
        notice(n) {
            for (const listener of [...noticeListeners]) listener(n);
        },
        async startSignIn({ signup }) {
            fake.calls.push(signup ? "start:signup" : "start");
        },
        openBrowserAgain: () => void fake.calls.push("reopen"),
        cancelSignIn: () => void fake.calls.push("cancel"),
        async signOut() {
            fake.calls.push("signOut");
        },
        async switchAccount() {
            fake.calls.push("switch");
        },
        async refresh() {
            fake.calls.push("refresh");
        },
        openConsole: (page) => void fake.consoles.push(page),
        async connectWithKey(key) {
            fake.calls.push(`key:${key.slice(0, 3)}`);
            if (!key.startsWith("sk-")) throw new Error("That does not look like an OpenNan API key (sk-…).");
        },
        onNotice(listener) {
            noticeListeners.add(listener);
            return () => noticeListeners.delete(listener);
        },
        consoleOrigin: "https://opennan.com",
        popupBlocked: () => fake.blocked,
        onboarding: { pending: () => fake.pending, dismiss: () => { fake.pending = false; fake.calls.push("onboarding:dismiss"); } },
    };
    if (options.keepSignedIn) fake.keepSignedIn = { get: () => fake.keep, set: (value) => { fake.keep = value; } };
    return fake;
}
