// The Share dialog's host (phase 9c): load the project's links, create / rotate / turn off, copy the active link (the
// checked URL only), remember the options per device, map refusals to codes, and Export and share (export → upload →
// final video → link) with progress and cancel. Tokens never reach storage.
import { CloudApiError, type CloudApi, type CloudMethod, type CloudRequest } from "@opennan/cloud-backend";
import { SHARE_OPTIONS_KEY, ShareHost, type ShareHostDeps } from "./share-host";
import { shareSiteOf } from "./use-share";

const TOKEN = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKL";
const TOKEN2 = "ZYXWVUTSRQPONMLKJIHGFEDCBA9876543210zyxwvutsrqpo";
const link = (id: string, token: string, overrides: Record<string, unknown> = {}) => ({
    object: "project_share", id, project_id: "p1", token, url: `https://opennan.com/s/${token}`, status: "active", allow_download: false,
    expires_at: "2026-11-20T10:00:00Z", created_at: "2026-10-21T10:00:00Z", revoked_at: null, views: 3, last_viewed_at: "2026-10-21T12:00:00Z", ...overrides,
});
const A = "shr_aaaaaaaaaaaaaaaaaaaaaaaa";
const B = "shr_bbbbbbbbbbbbbbbbbbbbbbbb";

interface Call { method: CloudMethod; path: string; request?: CloudRequest }

function harness(options: { answer?: (call: Call) => unknown; deps?: Partial<ShareHostDeps> } = {}) {
    const calls: Call[] = [];
    const api: CloudApi = {
        baseUrl: "https://api.opennan.com",
        async request<T>(method: CloudMethod, path: string, request?: CloudRequest) {
            calls.push({ method, path, request });
            const body = options.answer ? await options.answer({ method, path, request }) : { object: "list", data: [] };
            return { status: 200, body: body as T, etag: null };
        },
    };
    const store = new Map<string, string>();
    const copied: string[] = [];
    const deps: ShareHostDeps = {
        api, serverId: "p1", site: {},
        storage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => void store.set(k, v) },
        clipboard: async (text) => void copied.push(text),
        isSignedIn: () => true, openSignIn: vi.fn(async () => false),
        ...options.deps,
    };
    return { host: new ShareHost(deps), calls, store, copied, deps };
}

describe("ShareHost", () => {
    it("loads the links and shows the active one with its views", async () => {
        const { host, calls } = harness({ answer: () => ({ object: "list", data: [link(A, TOKEN), link(B, TOKEN2, { status: "revoked", revoked_at: "2026-10-20T10:00:00Z" })] }) });
        await host.load();
        const state = host.snapshot();
        expect(calls).toEqual([expect.objectContaining({ method: "GET", path: "/v1/projects/p1/shares" })]);
        expect(state.status).toBe("ready");
        expect(state.active).toMatchObject({ id: A, url: `https://opennan.com/s/${TOKEN}`, views: 3 });
        expect(state.links.map((l) => [l.id, l.status])).toEqual([[A, "active"], [B, "revoked"]]);
    });

    it("creates with the remembered options (default 30 days, no download), remembers changes, and never stores a token", async () => {
        const { host, calls, store } = harness({ answer: (call) => (call.method === "POST" ? { ...link(A, TOKEN), replaced: [] } : { object: "list", data: [] }) });
        await host.load();
        expect(host.snapshot().options).toEqual({ days: 30, allowDownload: false });
        host.setOptions({ days: 7, allowDownload: true });
        expect(JSON.parse(store.get(SHARE_OPTIONS_KEY)!)).toEqual({ days: 7, allowDownload: true });
        expect(await host.create()).toBe(true);
        expect(calls.at(-1)).toMatchObject({ method: "POST", path: "/v1/projects/p1/shares", request: { body: { expires_in_days: 7, allow_download: true } } });
        expect(host.snapshot().active?.id).toBe(A);
        expect([...store.values()].join()).not.toContain(TOKEN);
        // Out-of-range options are clamped to the server's bounds.
        host.setOptions({ days: 900 });
        expect(host.snapshot().options.days).toBe(365);
        host.setOptions({ days: 0 });
        expect(host.snapshot().options.days).toBe(1);
    });

    it("rotates: the new link is active and the replaced one shows as turned off", async () => {
        let n = 0;
        const { host } = harness({ answer: (call) => {
            if (call.method === "GET") return { object: "list", data: [link(A, TOKEN)] };
            n += 1;
            return { ...link(B, TOKEN2), replaced: [A] };
        } });
        await host.load();
        expect(await host.rotate()).toBe(true);
        expect(n).toBe(1);
        expect(host.snapshot().active).toMatchObject({ id: B, token: TOKEN2 });
        expect(host.snapshot().links.find((l) => l.id === A)).toMatchObject({ status: "revoked", url: null });
    });

    it("turns the active link off by its id", async () => {
        const { host, calls } = harness({ answer: (call) => (call.method === "DELETE" ? link(A, TOKEN, { status: "revoked", revoked_at: "2026-10-21T13:00:00Z" }) : { object: "list", data: [link(A, TOKEN)] }) });
        await host.load();
        expect(await host.turnOff()).toBe(true);
        expect(calls.at(-1)).toMatchObject({ method: "DELETE", path: `/v1/projects/p1/shares/${A}` });
        expect(host.snapshot().active).toBeNull();
        expect(host.snapshot().links[0]).toMatchObject({ status: "revoked", url: null });
    });

    it("stop sharing (two links shown active) shows exactly what OpenNan changed; a link it left alone is read again, never guessed", async () => {
        let deleted = false;
        const { host, calls } = harness({
            answer: (call) => {
                if (call.method === "DELETE") {
                    deleted = true;
                    return { object: "list", data: [link(A, TOKEN, { status: "revoked", revoked_at: "2026-10-21T13:00:00Z" })] };
                }
                // B was turned off on another device meanwhile.
                return { object: "list", data: deleted ? [link(A, TOKEN, { status: "revoked", revoked_at: "2026-10-21T13:00:00Z" }), link(B, TOKEN2, { status: "revoked", revoked_at: "2026-10-21T12:59:00Z" })] : [link(A, TOKEN), link(B, TOKEN2)] };
            },
        });
        await host.load();
        expect(await host.turnOff()).toBe(true);
        expect(calls.map((c) => c.method)).toEqual(["GET", "DELETE", "GET"]);
        expect(host.snapshot().active).toBeNull();
        expect(host.snapshot().links.map((l) => [l.id, l.status, l.url])).toEqual([[A, "revoked", null], [B, "revoked", null]]);
    });

    it("stop sharing that names every link shown active needs no second read", async () => {
        const { host, calls } = harness({
            answer: (call) => (call.method === "DELETE"
                ? { object: "list", data: [link(A, TOKEN, { status: "revoked", revoked_at: "2026-10-21T13:00:00Z" }), link(B, TOKEN2, { status: "revoked", revoked_at: "2026-10-21T13:00:00Z" })] }
                : { object: "list", data: [link(A, TOKEN), link(B, TOKEN2)] }),
        });
        await host.load();
        expect(await host.turnOff()).toBe(true);
        expect(calls.map((c) => c.method)).toEqual(["GET", "DELETE"]);
        expect(host.snapshot().links.map((l) => [l.id, l.status, l.revokedAt])).toEqual([[A, "revoked", Date.parse("2026-10-21T13:00:00Z")], [B, "revoked", Date.parse("2026-10-21T13:00:00Z")]]);
    });

    it("shows the link on the share answer's share_base_url (and on the account's when the answer has none)", async () => {
        const staged = harness({ answer: () => ({ object: "list", data: [link(A, TOKEN, { url: `https://staging.opennan.com/s/${TOKEN}`, share_base_url: "https://staging.opennan.com/s" })] }) });
        await staged.host.load();
        expect(staged.host.snapshot().active?.url).toBe(`https://staging.opennan.com/s/${TOKEN}`);
        const account = harness({ answer: () => ({ object: "list", data: [link(A, TOKEN, { url: `https://staging.opennan.com/s/${TOKEN}` })] }), deps: { site: { shareBaseUrl: "https://staging.opennan.com/s" } } });
        await account.host.load();
        expect(account.host.snapshot().active?.url).toBe(`https://staging.opennan.com/s/${TOKEN}`);
    });

    it("copies only the checked share URL, and says when the clipboard refused", async () => {
        const { host, copied } = harness({ answer: () => ({ object: "list", data: [link(A, TOKEN, { url: `https://evil.example/s/${TOKEN}` })] }) });
        await host.load();
        expect(await host.copy()).toBe(true);
        expect(copied).toEqual([`https://opennan.com/s/${TOKEN}`]);
        expect(host.snapshot().copied).toBe(true);
        const refused = harness({ answer: () => ({ object: "list", data: [link(A, TOKEN)] }), deps: { clipboard: async () => { throw new Error("denied"); } } });
        await refused.host.load();
        expect(await refused.host.copy()).toBe(false);
        expect(refused.host.snapshot().error).toMatchObject({ code: "copy_failed" });
    });

    it("maps refusals: the 50-link limit, nothing to show, a rate limit with its wait, signed out, a gone project, the network", async () => {
        const cases: Array<[CloudApiError, Record<string, unknown>]> = [
            [new CloudApiError(409, "share_limit_reached", "x", { fromServer: true }), { code: "limit" }],
            [new CloudApiError(409, "share_nothing_to_show", "x", { fromServer: true }), { code: "nothing_to_show" }],
            [new CloudApiError(429, "rate_limit_exceeded", "x", { retryAfterSeconds: 120, fromServer: true }), { code: "rate_limited", retryAfterSeconds: 120 }],
            [new CloudApiError(401, "signed_out", "x"), { code: "signed_out" }],
            [new CloudApiError(404, "not_found", "x", { fromServer: true }), { code: "not_found" }],
            [new CloudApiError(0, "network", "x"), { code: "network" }],
            [new CloudApiError(500, "server_error", "x", { fromServer: true }), { code: "server" }],
        ];
        for (const [error, expected] of cases) {
            const { host } = harness({ answer: (call) => { if (call.method === "POST") throw error; return { object: "list", data: [] }; } });
            await host.load();
            expect(await host.create()).toBe(false);
            expect(host.snapshot().error).toMatchObject(expected);
            expect(host.snapshot().nothingToShow).toBe(expected.code === "nothing_to_show");
        }
    });

    it("signed out: asks to sign in and sends nothing when that is dismissed", async () => {
        const { host, calls, deps } = harness({ deps: { isSignedIn: () => false } });
        expect(await host.create()).toBe(false);
        expect(deps.openSignIn).toHaveBeenCalled();
        expect(calls).toHaveLength(0);
    });
});

describe("ShareHost: Export and share", () => {
    function exporting(overrides: Partial<ShareHostDeps> = {}) {
        const steps: string[] = [];
        const answer = (call: Call) => {
            if (call.method === "POST") return { ...link(A, TOKEN), replaced: [] };
            return { object: "list", data: [] };
        };
        const deps: Partial<ShareHostDeps> = {
            exportVideo: vi.fn(async ({ onProgress }) => {
                steps.push("export");
                onProgress(0.5);
                return { kind: "result" } as never;
            }),
            uploadExport: vi.fn(async (_result, serverId, { onProgress }) => {
                steps.push(`upload:${serverId}`);
                onProgress(0.25);
                return { mediaUrl: "https://cdn.opennan.com/uploads/media/x/export.mp4" };
            }),
            setFinalVideo: vi.fn(async (url) => void steps.push(`final:${url}`)),
            exportFinished: vi.fn(),
            ...overrides,
        };
        const env = harness({ answer, deps });
        return { ...env, steps };
    }

    it("exports, uploads with the project's id, sets the final video, then makes the link, showing each step", async () => {
        const { host, steps, deps } = exporting();
        const seen: string[] = [];
        host.subscribe(() => {
            const step = host.snapshot().exporting?.step;
            if (step && seen.at(-1) !== step) seen.push(step);
        });
        expect(await host.exportAndShare()).toBe(true);
        expect(steps).toEqual(["export", "upload:p1", "final:https://cdn.opennan.com/uploads/media/x/export.mp4"]);
        expect(seen).toEqual(["export", "upload", "saving", "link"]);
        expect(host.snapshot()).toMatchObject({ exporting: null, active: { id: A }, nothingToShow: false });
        expect(deps.exportFinished).toHaveBeenCalled();
    });

    it("Cancel during the export or the upload stops it: nothing is set and no link is made", async () => {
        let release!: () => void;
        const { host, calls, deps } = exporting({
            exportVideo: vi.fn(({ signal }) => new Promise((_resolve, reject) => {
                release = () => reject(Object.assign(new Error("cancelled"), { name: "AbortError" }));
                signal.addEventListener("abort", () => release(), { once: true });
            })) as never,
        });
        const running = host.exportAndShare();
        await Promise.resolve();
        expect(host.snapshot().exporting?.step).toBe("export");
        host.cancelExport();
        expect(await running).toBe(false);
        expect(host.snapshot()).toMatchObject({ exporting: null, error: null });
        expect(deps.uploadExport).not.toHaveBeenCalled();
        expect(deps.setFinalVideo).not.toHaveBeenCalled();
        expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
        expect(deps.exportFinished).toHaveBeenCalled();
    });

    it("a failed export or upload says so in plain words; storage full has its own words", async () => {
        const failedExport = exporting({ exportVideo: vi.fn(async () => { throw new Error("Nothing to export: the timeline is empty."); }) as never });
        expect(await failedExport.host.exportAndShare()).toBe(false);
        expect(failedExport.host.snapshot().error).toMatchObject({ code: "export_failed", detail: "Nothing to export: the timeline is empty." });
        const full = exporting({ uploadExport: vi.fn(async () => { throw new CloudApiError(403, "storage_quota_exceeded", "full", { fromServer: true }); }) as never });
        expect(await full.host.exportAndShare()).toBe(false);
        expect(full.host.snapshot().error).toMatchObject({ code: "storage_full" });
        expect(full.deps.setFinalVideo).not.toHaveBeenCalled();
    });

    it("is not offered where the host can't export and upload", async () => {
        const { host } = harness();
        expect(host.canExportAndShare()).toBe(false);
        expect(await host.exportAndShare()).toBe(false);
    });

    it("closed while the export is being set on the project: no link is made afterwards", async () => {
        let finish!: () => void;
        const { host, calls } = exporting({ setFinalVideo: vi.fn(() => new Promise<void>((resolve) => { finish = resolve; })) as never });
        const running = host.exportAndShare();
        await vi.waitFor(() => expect(host.snapshot().exporting?.step).toBe("saving"));
        expect(host.snapshot().exporting?.cancellable).toBe(false);
        host.dispose();
        finish();
        expect(await running).toBe(false);
        expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
    });
});

describe("ShareHost: recovering from a failed read", () => {
    it("reads again, and signs in first when signed out", async () => {
        let signedIn = false;
        const openSignIn = vi.fn(async () => (signedIn = true));
        const { host, calls } = harness({ deps: { isSignedIn: () => signedIn, openSignIn } });
        await host.load();
        expect(host.snapshot()).toMatchObject({ status: "error", error: { code: "signed_out" } });
        expect(await host.retry()).toBe(true);
        expect(openSignIn).toHaveBeenCalled();
        expect(host.snapshot().status).toBe("ready");
        expect(calls).toHaveLength(1);
    });
});

describe("shareSiteOf", () => {
    it("reads the account's share_base_url when signed in, and nothing otherwise", () => {
        const account = { email: "a@example.com", displayName: "A", photoUrl: null, balanceUsd: 1, keyId: null, keyName: null, keyExpiresAt: null, billingUrl: null };
        expect(shareSiteOf({ state: "signed-in", account: { ...account, shareBaseUrl: "https://opennan.com/s" }, persistence: "persistent" })).toEqual({ shareBaseUrl: "https://opennan.com/s" });
        expect(shareSiteOf({ state: "signed-in", account: null, persistence: "persistent" })).toEqual({ shareBaseUrl: null });
        expect(shareSiteOf({ state: "signed-out" })).toEqual({ shareBaseUrl: null });
    });
});
