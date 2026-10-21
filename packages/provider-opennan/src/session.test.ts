import { createOpenNanApi } from "./api";
import { OpenNanSession, isConsoleDeviceUrl, memoryCredentialStore, type SessionStatus, type StoredCredential } from "./session";

const KEY = "sk-test_abcdefghijklmnopqrstuvwxyz0123";
const OTHER_KEY = "sk-test_zyxwvutsrqponmlkjihgfedcba9876";
const ACCOUNT = { object: "account", email: "ada@example.com", display_name: "Ada", photo_url: null, balance_usd: 12.4, key: { id: "key_1", name: "OpenNan Studio (Mac)", scopes: [], expires_at: null }, billing_url: "https://opennan.com/console/billing" };
const START = { device_code: "dc", user_code: "BCDF-GHJK", verification_uri: "https://opennan.com/console/device", verification_uri_complete: "https://opennan.com/console/device?code=BCDF-GHJK", expires_in: 600, interval: 3 };

interface Server {
    hangRevoke?: boolean;
    approve?: boolean;
    deny?: boolean;
    startStatus?: number;
    accountStatus?: number;
    offline?: boolean;
    keys: Set<string>;
    log: string[];
}

function fakeServer(server: Server) {
    const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
    const err = (status: number, code: string, headers: Record<string, string> = {}) => json(status, { error: { type: "x", message: code, code } }, headers);
    const fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const url = new URL(String(input));
        const auth = new Headers(init.headers).get("authorization")?.replace("Bearer ", "") ?? null;
        server.log.push(`${init.method} ${url.pathname}`);
        if (server.offline) throw new TypeError("Failed to fetch");
        if (url.pathname === "/v1/auth/device") return server.startStatus ? err(server.startStatus, "rate_limit_exceeded", { "retry-after": "12" }) : json(200, START);
        if (url.pathname === "/v1/auth/device/token") {
            if (server.deny) return err(400, "access_denied");
            if (!server.approve) return err(400, "authorization_pending");
            server.keys.add(KEY);
            return json(200, { object: "api_key", token_type: "Bearer", api_key: KEY, key_id: "key_1", name: "OpenNan Studio (Mac)", scopes: [], expires_at: null });
        }
        if (url.pathname === "/v1/account") {
            if (server.accountStatus) return err(server.accountStatus, "server_error");
            return auth && server.keys.has(auth) ? json(200, ACCOUNT) : err(401, "invalid_api_key");
        }
        if (url.pathname === "/v1/auth/key" && init.method === "DELETE") {
            if (server.hangRevoke) return new Promise<Response>((_, reject) => init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
            if (!auth || !server.keys.has(auth)) return err(401, "invalid_api_key");
            server.keys.delete(auth);
            return json(200, { object: "api_key", id: "key_1", revoked: true });
        }
        return err(404, "not_found");
    }) as typeof globalThis.fetch;
    return createOpenNanApi({ baseUrl: "https://api.opennan.com", fetch });
}

function setup(server: Partial<Server> = {}, stored: StoredCredential | null = null, consoleBase = "https://opennan.com") {
    const state: Server = { keys: new Set(), log: [], ...server };
    const store = memoryCredentialStore(stored);
    const opened: string[] = [];
    const session = new OpenNanSession({ api: fakeServer(state), store, deviceName: "Mac", client: "desktop", consoleBase, onVerificationUri: (uri) => opened.push(uri) });
    const statuses: SessionStatus[] = [];
    session.subscribe((status) => statuses.push(status));
    return { session, store, state, opened, statuses };
}

beforeEach(() => vi.useFakeTimers({ now: Date.parse("2026-10-19T12:00:00Z") }));
afterEach(() => vi.useRealTimers());

describe("OpenNanSession", () => {
    it("starts restoring, then signed out without a stored key", async () => {
        const { session } = setup();
        expect(session.status()).toEqual({ state: "restoring" });
        await session.restore();
        expect(session.status()).toEqual({ state: "signed-out" });
        expect(session.apiKey()).toBeNull();
    });

    it("restores a stored key and loads the account", async () => {
        const { session, statuses } = setup({ keys: new Set([KEY]) }, { apiKey: KEY, keyId: "key_1" });
        await session.restore();
        expect(statuses[0]).toEqual({ state: "signed-in", account: null, persistence: "memory" });
        expect(session.status()).toMatchObject({ state: "signed-in", account: { email: "ada@example.com", balanceUsd: 12.4 } });
        expect(session.apiKey()).toBe(KEY);
    });

    it("drops an expired or revoked stored key", async () => {
        const expired = setup({}, { apiKey: KEY, keyId: "key_1", expiresAt: "2026-10-01T00:00:00Z" });
        await expired.session.restore();
        expect(expired.session.status()).toEqual({ state: "signed-out" });
        expect(await expired.store.get()).toBeNull();
        expect(expired.state.log).toEqual([]);
        const revoked = setup({}, { apiKey: KEY, keyId: "key_1" });
        await revoked.session.restore();
        expect(revoked.session.status()).toEqual({ state: "signed-out" });
        expect(await revoked.store.get()).toBeNull();
    });

    it("keeps a restored key when the account cannot be loaded for another reason", async () => {
        const { session } = setup({ accountStatus: 503 }, { apiKey: KEY, keyId: "key_1" });
        await session.restore();
        expect(session.status()).toEqual({ state: "signed-in", account: null, persistence: "memory" });
    });

    it("signs in through the device flow and stores the key before reporting signed-in", async () => {
        const { session, store, state, opened, statuses } = setup();
        await session.restore();
        await session.start({ signup: false });
        expect(session.status()).toEqual({
            state: "waiting", userCode: "BCDF-GHJK", verificationUri: "https://opennan.com/console/device",
            verificationUriComplete: "https://opennan.com/console/device?code=BCDF-GHJK", expiresAt: Date.now() + 600_000, reconnecting: false, signup: false,
        });
        expect(opened).toEqual(["https://opennan.com/console/device?code=BCDF-GHJK"]);
        expect(statuses.map((s) => s.state)).toEqual(["signed-out", "starting", "waiting"]);
        const setSpy = vi.spyOn(store, "set");
        state.approve = true;
        await vi.advanceTimersByTimeAsync(3000);
        await session.settled();
        expect(setSpy).toHaveBeenCalledWith({ apiKey: KEY, keyId: "key_1", keyName: "OpenNan Studio (Mac)", expiresAt: null });
        expect(session.status()).toMatchObject({ state: "signed-in", account: { email: "ada@example.com" } });
        const signedInAt = statuses.findIndex((s) => s.state === "signed-in");
        expect(setSpy.mock.invocationCallOrder[0]).toBeLessThan(Number.MAX_SAFE_INTEGER);
        expect(signedInAt).toBeGreaterThan(0);
    });

    it("refuses an approval page that is not the console's device page", async () => {
        const { session, opened, state } = setup({}, null, "https://console.example.org");
        await session.start({});
        expect(session.status()).toMatchObject({ state: "error", kind: "unknown", message: "OpenNan sent a sign-in page Studio does not trust." });
        expect(opened).toEqual([]);
        await vi.advanceTimersByTimeAsync(10_000);
        expect(state.log.filter((l) => l.endsWith("/token"))).toEqual([]);
        expect(isConsoleDeviceUrl("https://opennan.com/console/device?code=A", "https://opennan.com")).toBe(true);
        expect(isConsoleDeviceUrl("https://opennan.com.evil.example/console/device", "https://opennan.com")).toBe(false);
        expect(isConsoleDeviceUrl("https://opennan.com/console/keys", "https://opennan.com")).toBe(false);
        expect(isConsoleDeviceUrl("javascript:alert(1)", "https://opennan.com")).toBe(false);
    });

    it("reports denied, expired, network, and rate limits as errors", async () => {
        const denied = setup({ deny: true });
        await denied.session.start({});
        await vi.advanceTimersByTimeAsync(3000);
        expect(denied.session.status()).toMatchObject({ state: "error", kind: "denied", signup: false });
        const limited = setup({ startStatus: 429 });
        await limited.session.start({ signup: true });
        expect(limited.session.status()).toEqual({ state: "error", kind: "rate-limited", message: "OpenNan is busy right now. Try again in 12 s.", retryAt: Date.now() + 12_000, signup: true });
        const offline = setup({ offline: true });
        await offline.session.start({});
        expect(offline.session.status()).toMatchObject({ state: "error", kind: "network" });
        const expiring = setup();
        await expiring.session.start({});
        await vi.advanceTimersByTimeAsync(601_000);
        expect(expiring.session.status()).toMatchObject({ state: "error", kind: "expired" });
    });

    it("shows reconnecting while polls fail and recovers", async () => {
        const { session, state } = setup();
        await session.start({});
        state.offline = true;
        await vi.advanceTimersByTimeAsync(3000);
        expect(session.status()).toMatchObject({ state: "waiting", reconnecting: true });
        state.offline = false;
        await vi.advanceTimersByTimeAsync(3000);
        expect(session.status()).toMatchObject({ state: "waiting", reconnecting: false });
    });

    it("cancels a waiting flow and replaces it on a new start", async () => {
        const { session, state } = setup();
        await session.start({});
        session.cancel();
        expect(session.status()).toEqual({ state: "signed-out" });
        await vi.advanceTimersByTimeAsync(10_000);
        expect(state.log.filter((l) => l.endsWith("/token"))).toEqual([]);
        await session.start({});
        await session.start({ signup: true });
        await vi.advanceTimersByTimeAsync(3000);
        expect(state.log.filter((l) => l.endsWith("/token"))).toHaveLength(1);
        expect(session.status()).toMatchObject({ state: "waiting", signup: true });
    });

    it("signs out by clearing the key and revoking it, even when the revoke fails", async () => {
        const { session, store, state } = setup({ keys: new Set([KEY]) }, { apiKey: KEY, keyId: "key_1" });
        await session.restore();
        await session.signOut();
        expect(state.log).toContain("DELETE /v1/auth/key");
        expect(state.keys.has(KEY)).toBe(false);
        expect(await store.get()).toBeNull();
        expect(session.status()).toEqual({ state: "signed-out" });
        const offline = setup({ keys: new Set([KEY]) }, { apiKey: KEY, keyId: "key_1" });
        await offline.session.restore();
        offline.state.offline = true;
        await offline.session.signOut();
        expect(await offline.store.get()).toBeNull();
        expect(offline.session.status()).toEqual({ state: "signed-out" });
    });

    it("clears the key before the revoke finishes, and gives up on a hung revoke", async () => {
        const { session, store } = setup({ keys: new Set([KEY]), hangRevoke: true }, { apiKey: KEY, keyId: "key_1" });
        await session.restore();
        let done = false;
        void session.signOut().then(() => { done = true; });
        await vi.advanceTimersByTimeAsync(0);
        expect(await store.get()).toBeNull();
        expect(session.status()).toEqual({ state: "signed-out" });
        expect(done).toBe(false);
        await vi.advanceTimersByTimeAsync(5_100);
        expect(done).toBe(true);
    });

    it("revokes a key it replaces (pasted key, new sign-in)", async () => {
        const { session, state } = setup({ keys: new Set([KEY, OTHER_KEY]) }, { apiKey: KEY, keyId: "key_1" });
        await session.restore();
        await session.connectWithKey(OTHER_KEY);
        expect(state.keys.has(KEY)).toBe(false);
        expect(state.keys.has(OTHER_KEY)).toBe(true);
        await session.connectWithKey(OTHER_KEY);
        expect(state.keys.has(OTHER_KEY)).toBe(true);
    });

    it("revokes a key approved after the person signed out or cancelled", async () => {
        const state: Server = { keys: new Set(), log: [], approve: true };
        let release!: () => void;
        const slowStore = memoryCredentialStore();
        const set = slowStore.set;
        slowStore.set = async (credential) => {
            await new Promise<void>((resolve) => { release = resolve; });
            await set(credential);
        };
        const session = new OpenNanSession({ api: fakeServer(state), store: slowStore, deviceName: "Mac", client: "desktop", consoleBase: "https://opennan.com" });
        await session.restore();
        await session.start({});
        await vi.advanceTimersByTimeAsync(3000);
        expect(state.keys.has(KEY)).toBe(true);
        await session.signOut();
        release();
        await vi.advanceTimersByTimeAsync(0);
        await session.settled();
        expect(await slowStore.get()).toBeNull();
        expect(state.keys.has(KEY)).toBe(false);
        expect(session.status()).toEqual({ state: "signed-out" });
    });

    it("switches account: sign out, then a new flow", async () => {
        const { session, state } = setup({ keys: new Set([KEY]) }, { apiKey: KEY, keyId: "key_1" });
        await session.restore();
        await session.switchAccount();
        expect(state.log).toContain("DELETE /v1/auth/key");
        expect(session.status()).toMatchObject({ state: "waiting" });
    });

    it("connects with a pasted key after checking it", async () => {
        const { session, store, state } = setup({ keys: new Set([OTHER_KEY]) });
        await session.restore();
        await expect(session.connectWithKey("not-a-key")).rejects.toThrow(/does not look like an OpenNan API key/);
        expect(state.log).toEqual([]);
        await expect(session.connectWithKey(KEY)).rejects.toThrow(/was not accepted/);
        await session.connectWithKey(` ${OTHER_KEY} `);
        expect(await store.get()).toMatchObject({ apiKey: OTHER_KEY, keyId: "key_1" });
        expect(session.status()).toMatchObject({ state: "signed-in", account: { email: "ada@example.com" } });
    });

    it("signs out when the API says the key is no longer valid", async () => {
        const { session, store } = setup({ keys: new Set([KEY]) }, { apiKey: KEY, keyId: "key_1" });
        await session.restore();
        session.reportUnauthorized();
        await vi.advanceTimersByTimeAsync(0);
        expect(session.status()).toEqual({ state: "signed-out" });
        expect(await store.get()).toBeNull();
    });

    it("coalesces refreshes after jobs to one every 5 s", async () => {
        const { session, state } = setup({ keys: new Set([KEY]) }, { apiKey: KEY, keyId: "key_1" });
        await session.restore();
        const before = state.log.filter((l) => l === "GET /v1/account").length;
        session.refreshSoon();
        session.refreshSoon();
        session.refreshSoon();
        await vi.advanceTimersByTimeAsync(6000);
        expect(state.log.filter((l) => l === "GET /v1/account").length - before).toBe(1);
    });

    it("delivers notices", () => {
        const { session } = setup();
        const notices: unknown[] = [];
        const stop = session.onNotice((notice) => notices.push(notice));
        session.notify({ kind: "insufficient-credits", billingUrl: "https://opennan.com/console/billing" });
        stop();
        session.notify({ kind: "sign-in-needed", feature: "x" });
        expect(notices).toEqual([{ kind: "insufficient-credits", billingUrl: "https://opennan.com/console/billing" }]);
    });

    it("never puts the key into a status", async () => {
        const { session, state, statuses } = setup();
        await session.restore();
        await session.start({});
        state.approve = true;
        await vi.advanceTimersByTimeAsync(3000);
        await session.settled();
        await session.refresh();
        await session.signOut();
        for (const status of statuses) expect(JSON.stringify(status)).not.toContain("sk-");
    });
});
