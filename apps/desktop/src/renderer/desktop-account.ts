// The desktop AccountPlatform: a view of main's account (account-service.ts) over the bridge. Statuses and notices
// come from main; actions go to main; no key is ever here. The first-launch prompt is remembered in settings.
import type { AccountPlatform, ConsolePage } from "@opennan/web/studio";
import type { SessionStatus } from "@opennan/provider-opennan";
import type { DesktopBridge } from "../shared/bridge";

export const DESKTOP_CONSOLE_ORIGIN = "https://opennan.com";
export const E2E_ONBOARDING_KEY = "opennan-studio:e2e-onboarding";

const clean = (error: unknown) => new Error((error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (Error: )?/, ""));

export function createDesktopAccount(bridge: Pick<DesktopBridge, "account" | "settings" | "e2e">, storage: Pick<Storage, "getItem"> | null = globalThis.localStorage ?? null): AccountPlatform & { ready: Promise<void> } {
    const listeners = new Set<() => void>();
    let status: SessionStatus = { state: "restoring" };
    let fromMain: SessionStatus | null = null;
    let prompted: boolean | null = null;
    const publish = () => {
        // Stay "restoring" until both main's status and the prompt flag are known (no chip flicker, no early prompt).
        const next = fromMain && prompted !== null ? fromMain : { state: "restoring" as const };
        if (next === status) return;
        status = next;
        for (const listener of [...listeners]) listener();
    };
    bridge.account.onChanged((next) => {
        fromMain = next;
        publish();
    });
    const ready = Promise.all([
        bridge.account.status().then((next) => {
            if (!fromMain) fromMain = next;
        }),
        bridge.settings.get().then((settings) => {
            prompted = settings.signInPrompted;
        }, () => {
            prompted = true;
        }),
    ]).then(publish, publish);
    const e2eOnboarding = () => {
        try {
            return storage?.getItem(E2E_ONBOARDING_KEY) === "1";
        } catch {
            return false;
        }
    };
    const call = <T>(work: Promise<T>) => work.catch((error: unknown) => {
        throw clean(error);
    });
    return {
        ready,
        consoleOrigin: DESKTOP_CONSOLE_ORIGIN,
        status: () => status,
        subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        startSignIn: ({ signup }) => call(bridge.account.start(signup === true)),
        openBrowserAgain: () => void bridge.account.reopen().catch(() => undefined),
        cancelSignIn: () => void bridge.account.cancel().catch(() => undefined),
        signOut: () => call(bridge.account.signOut()),
        switchAccount: () => call(bridge.account.switchAccount()),
        refresh: () => bridge.account.refresh().catch(() => undefined),
        openConsole: (page: ConsolePage) => void bridge.account.openConsole(page).catch(() => undefined),
        connectWithKey: (key) => call(bridge.account.connectKey(key.trim())),
        onNotice: (listener) => bridge.account.onNotice(listener),
        onboarding: {
            pending: () => prompted === false && (!bridge.e2e || e2eOnboarding()),
            dismiss: () => {
                prompted = true;
                void bridge.settings.update({ signInPrompted: true }).catch(() => undefined);
            },
        },
    };
}
