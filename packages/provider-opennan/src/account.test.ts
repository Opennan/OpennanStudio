import { createOpenNanApi } from "./api";
import { getAccount, parseAccount, revokeKey } from "./account";

const KEY = "sk-test_abcdefghijklmnopqrstuvwxyz";
const ACCOUNT = {
    object: "account", email: "ada@example.com", display_name: "Ada Lovelace", photo_url: "https://lh3.example.com/a.png", balance_usd: 12.4,
    key: { id: "key_1", name: "OpenNan Studio (Mac)", scopes: ["api:opennan"], expires_at: null }, billing_url: "https://opennan.com/console/billing",
};

function api(answer: (url: string, init: RequestInit) => Response) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
        calls.push({ url: String(input), init });
        return answer(String(input), init);
    }) as typeof globalThis.fetch;
    return { api: createOpenNanApi({ baseUrl: "https://api.opennan.com", fetch }), calls };
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("account", () => {
    it("maps GET /v1/account", async () => {
        const { api: client, calls } = api(() => json(200, ACCOUNT));
        expect(await getAccount(client, KEY)).toEqual({
            email: "ada@example.com", displayName: "Ada Lovelace", photoUrl: "https://lh3.example.com/a.png", balanceUsd: 12.4,
            keyId: "key_1", keyName: "OpenNan Studio (Mac)", keyExpiresAt: null, billingUrl: "https://opennan.com/console/billing", accountId: null,
            shareBaseUrl: null,
        });
        expect(new Headers(calls[0]!.init.headers).get("authorization")).toBe(`Bearer ${KEY}`);
    });

    it("fills gaps safely", () => {
        expect(parseAccount({ email: "grace@example.com", photo_url: "http://insecure/a.png", balance_usd: "lots", billing_url: "javascript:alert(1)" })).toEqual({
            email: "grace@example.com", displayName: "grace", photoUrl: null, balanceUsd: null, keyId: null, keyName: null, keyExpiresAt: null, billingUrl: null, accountId: null,
            shareBaseUrl: null,
        });
        expect(parseAccount({})).toBeNull();
    });

    it("reads the stable account id when the server sends one (9a.1), and ignores a malformed one", () => {
        expect(parseAccount({ ...ACCOUNT, account_id: "usr_42-a.b:c" })?.accountId).toBe("usr_42-a.b:c");
        for (const bad of ["", "   ", "has space", "a/b", "x".repeat(129), 42, null, "a\u0000b"]) expect(parseAccount({ ...ACCOUNT, account_id: bad })?.accountId).toBeNull();
    });

    it("reads share_base_url (9c.1) as an http(s) URL; Studio checks its host before building a link on it", () => {
        expect(parseAccount({ ...ACCOUNT, share_base_url: "https://opennan.com/s" })?.shareBaseUrl).toBe("https://opennan.com/s");
        expect(parseAccount({ ...ACCOUNT, share_base_url: "http://127.0.0.1:4100/s" })?.shareBaseUrl).toBe("http://127.0.0.1:4100/s");
        for (const bad of ["", "javascript:alert(1)", "opennan.com/s", `https://opennan.com/s${"x".repeat(200)}`, 42, null]) expect(parseAccount({ ...ACCOUNT, share_base_url: bad })?.shareBaseUrl).toBeNull();
    });

    it("passes a 401 through", async () => {
        const { api: client } = api(() => json(401, { error: { type: "authentication_error", message: "Revoked", code: "invalid_api_key" } }));
        await expect(getAccount(client, KEY)).rejects.toMatchObject({ status: 401 });
    });

    it("revokes the calling key and never throws", async () => {
        const { api: client, calls } = api(() => json(200, { object: "api_key", id: "key_1", revoked: true }));
        expect(await revokeKey(client, KEY)).toBe(true);
        expect(calls[0]!.url).toBe("https://api.opennan.com/v1/auth/key");
        expect(calls[0]!.init.method).toBe("DELETE");
        const { api: failing } = api(() => { throw new TypeError("offline"); });
        expect(await revokeKey(failing, KEY)).toBe(false);
        const { api: odd } = api(() => json(200, { revoked: false }));
        expect(await revokeKey(odd, KEY)).toBe(false);
    });
});
