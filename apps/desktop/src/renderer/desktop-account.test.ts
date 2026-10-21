// The renderer's view of main's account: statuses from main, actions to main, the prompt flag in settings.
import type { SessionStatus } from "@opennan/provider-opennan";
import { createDesktopAccount, E2E_ONBOARDING_KEY } from "./desktop-account";
import { createTestBridge } from "./test-bridge";

function setup(options: { status?: SessionStatus; prompted?: boolean; e2e?: boolean; flag?: string } = {}) {
    const { bridge } = createTestBridge({ e2e: options.e2e ?? false });
    let changed: ((status: SessionStatus) => void) | null = null;
    bridge.account.status = vi.fn(async () => options.status ?? { state: "signed-out" as const });
    bridge.account.onChanged = vi.fn((listener) => {
        changed = listener;
        return () => undefined;
    });
    bridge.settings.get = vi.fn(async () => ({ mcpPort: 4319, terminalCustomCommand: "", terminalDefaultProfile: "shell" as const, providerRouting: { overrides: {}, opennanDefault: true }, signInPrompted: options.prompted ?? false, cloudCacheLimitBytes: null, agentSharesWithoutAsking: false }));
    const storage = { getItem: (key: string) => (key === E2E_ONBOARDING_KEY ? options.flag ?? null : null) };
    const account = createDesktopAccount(bridge, storage);
    return { bridge, account, push: (status: SessionStatus) => changed!(status) };
}

describe("createDesktopAccount", () => {
    it("stays restoring until main's status and the prompt flag are known, then follows main", async () => {
        const { account, push } = setup();
        expect(account.status()).toEqual({ state: "restoring" });
        const listener = vi.fn();
        account.subscribe(listener);
        await account.ready;
        expect(account.status()).toEqual({ state: "signed-out" });
        push({ state: "starting", signup: false });
        expect(account.status()).toEqual({ state: "starting", signup: false });
        expect(listener).toHaveBeenCalledTimes(2);
    });

    it("sends actions to main and cleans IPC error prefixes", async () => {
        const { bridge, account } = setup();
        await account.startSignIn({ signup: true });
        expect(bridge.account.start).toHaveBeenCalledWith(true);
        account.openBrowserAgain();
        account.cancelSignIn();
        await account.signOut();
        await account.switchAccount();
        await account.refresh();
        account.openConsole("keys");
        expect(bridge.account.openConsole).toHaveBeenCalledWith("keys");
        bridge.account.connectKey = vi.fn(async () => { throw new Error("Error invoking remote method 'opennan:account:connect-key': Error: That key was not accepted by OpenNan."); });
        await expect(account.connectWithKey(" sk-x ")).rejects.toThrow(/^That key was not accepted by OpenNan\.$/);
        expect(bridge.account.connectKey).toHaveBeenCalledWith("sk-x");
        expect(account.keepSignedIn).toBeUndefined();
        expect(account.popupBlocked).toBeUndefined();
    });

    it("prompts once (remembered in settings); e2e builds only when asked", async () => {
        const fresh = setup();
        await fresh.account.ready;
        expect(fresh.account.onboarding.pending()).toBe(true);
        fresh.account.onboarding.dismiss();
        expect(fresh.bridge.settings.update).toHaveBeenCalledWith({ signInPrompted: true });
        expect(fresh.account.onboarding.pending()).toBe(false);
        const seen = setup({ prompted: true });
        await seen.account.ready;
        expect(seen.account.onboarding.pending()).toBe(false);
        const e2e = setup({ e2e: true });
        await e2e.account.ready;
        expect(e2e.account.onboarding.pending()).toBe(false);
        const asked = setup({ e2e: true, flag: "1" });
        await asked.account.ready;
        expect(asked.account.onboarding.pending()).toBe(true);
    });
});
