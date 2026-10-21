// The browser account over the fake OpenNan server: popup handling, origin check, focus polling, onboarding.
// @vitest-environment node
import { startFakeOpenNan, type FakeOpenNan } from "@opennan/provider-opennan/testing";
import { createWebAccountStorage, memoryKeyValue } from "./account-storage";
import { E2E_ONBOARDING_KEY, E2E_ORIGIN_KEY, ONBOARDING_KEY, createWebAccount, type BrowserLike, type PopupWindow } from "./account-web";

let fake: FakeOpenNan;
beforeAll(async () => {
    fake = await startFakeOpenNan({ intervalSeconds: 1 });
});
afterAll(() => fake.close());
beforeEach(() => fake.reset());

function browser(options: { block?: boolean; hostname?: string } = {}) {
    const opened: Array<{ url: string; target: string; features?: string; popup: PopupWindow | null }> = [];
    const focus: Array<() => void> = [];
    const visibility: Array<() => void> = [];
    const doc = { visibilityState: "visible", addEventListener: (_: string, l: () => void) => void visibility.push(l) };
    const value: BrowserLike = {
        open(url, target, features) {
            const popup = options.block ? null : { opener: "parent" as unknown, closed: false, location: { href: url }, close() { this.closed = true; } };
            opened.push({ url, target, features, popup });
            return popup;
        },
        addEventListener: (_type, listener) => void focus.push(listener),
        document: doc,
        location: { hostname: options.hostname ?? "localhost" },
        navigator: { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/140.0.0.0 Safari/537.36" },
    };
    return { value, opened, focus, visibility, doc };
}

function prefs(initial: Record<string, string> = {}) {
    const data = new Map(Object.entries(initial));
    return { data, getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
}

function account(b: ReturnType<typeof browser>, preferences = prefs(), e2e = false) {
    const storage = createWebAccountStorage({ persistent: memoryKeyValue(), session: memoryKeyValue(), preferences });
    return createWebAccount({ apiBase: fake.url, consoleBase: fake.url, storage, browser: b.value, preferences, e2e });
}

describe("createWebAccount", () => {
    it("opens the popup before any request, cuts its opener, then points it at the approval page", async () => {
        const b = browser();
        const a = account(b);
        await a.ready;
        const starting = a.startSignIn({});
        expect(b.opened).toHaveLength(1);
        expect(b.opened[0]).toMatchObject({ url: "about:blank", target: "opennan-signin" });
        expect(fake.state().requests.filter((r) => r.path === "/v1/auth/device")).toHaveLength(0);
        await starting;
        const popup = b.opened[0]!.popup!;
        expect(popup.opener).toBeNull();
        const status = a.status();
        expect(status.state).toBe("waiting");
        expect(popup.location.href).toBe((status as { verificationUriComplete: string }).verificationUriComplete);
        expect(fake.state().devices[0]).toMatchObject({ client: "web", deviceName: "Web · Chrome on macOS" });
        expect(a.popupBlocked!()).toBe(false);
        fake.approve();
        await vi.waitFor(() => expect(a.status().state).toBe("signed-in"), { timeout: 5000 });
    });

    it("never points the popup at a page other than the console's device page", async () => {
        const b = browser();
        const storage = createWebAccountStorage({ persistent: memoryKeyValue(), session: memoryKeyValue(), preferences: prefs() });
        const a = createWebAccount({ apiBase: fake.url, consoleBase: "https://opennan.com", storage, browser: b.value, preferences: prefs(), e2e: false });
        await a.ready;
        await a.startSignIn({});
        expect(a.status()).toMatchObject({ state: "error", kind: "unknown" });
        expect(b.opened[0]!.popup!.location.href).toBe("about:blank");
        expect(b.opened[0]!.popup!.closed).toBe(true);
    });

    it("reports a blocked popup and opens again in a new window", async () => {
        const b = browser({ block: true });
        const a = account(b);
        await a.ready;
        await a.startSignIn({ signup: true });
        expect(a.popupBlocked!()).toBe(true);
        expect(a.status()).toMatchObject({ state: "waiting", signup: true });
        const ok = browser();
        const other = account(ok);
        await other.ready;
        await other.startSignIn({});
        other.openBrowserAgain();
        expect(ok.opened.map((o) => o.target)).toEqual(["opennan-signin", "_blank"]);
        expect(ok.opened[1]!.popup!.location.href).toBe(ok.opened[0]!.popup!.location.href);
        expect(ok.opened[1]!.popup!.opener).toBeNull();
    });

    it("polls at once when the tab comes back", async () => {
        const b = browser();
        const a = account(b);
        await a.ready;
        await a.startSignIn({});
        const spy = vi.spyOn(a.session, "pollNow");
        b.focus.forEach((l) => l());
        b.visibility.forEach((l) => l());
        expect(spy).toHaveBeenCalledTimes(2);
    });

    it("refuses sign-in from other origins without a request", async () => {
        const b = browser({ hostname: "studio.example.org" });
        const a = account(b);
        await a.ready;
        await a.startSignIn({});
        expect(a.status()).toMatchObject({ state: "error", kind: "origin" });
        expect(b.opened).toEqual([]);
        expect(fake.state().requests).toEqual([]);
        const e2e = browser({ hostname: "studio.example.org" });
        const simulated = account(e2e, prefs({ [E2E_ORIGIN_KEY]: "blocked" }), true);
        await simulated.ready;
        await simulated.startSignIn({});
        expect(simulated.status()).toMatchObject({ state: "error", kind: "origin" });
    });

    it("opens console pages without an opener", () => {
        const b = browser();
        account(b).openConsole("billing");
        expect(b.opened[0]).toMatchObject({ url: `${fake.url}/console/billing`, target: "_blank", features: "noopener,noreferrer" });
    });

    it("switch account opens the popup first, revokes the old key, and starts a new flow", async () => {
        const b = browser();
        const a = account(b);
        await a.ready;
        await a.connectWithKey(fake.mintKey());
        await a.switchAccount();
        expect(fake.state().revokedKeyIds).toHaveLength(1);
        expect(a.status().state).toBe("waiting");
        expect(b.opened[0]!.popup!.location.href).toMatch(/\/console\/device\?code=/);
    });

    it("prompts once; e2e builds only when asked", () => {
        const p = prefs();
        const a = account(browser(), p);
        expect(a.onboarding.pending()).toBe(true);
        a.onboarding.dismiss();
        expect(p.data.get(ONBOARDING_KEY)).toBe("1");
        expect(a.onboarding.pending()).toBe(false);
        expect(account(browser(), prefs(), true).onboarding.pending()).toBe(false);
        expect(account(browser(), prefs({ [E2E_ONBOARDING_KEY]: "1" }), true).onboarding.pending()).toBe(true);
    });

    it("keeps signed in through the storage preference", async () => {
        const p = prefs();
        const a = account(browser(), p);
        expect(a.keepSignedIn!.get()).toBe(true);
        a.keepSignedIn!.set(false);
        await new Promise((r) => setTimeout(r, 0));
        expect(a.keepSignedIn!.get()).toBe(false);
    });
});
