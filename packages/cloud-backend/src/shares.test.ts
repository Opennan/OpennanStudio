import { startFakeOpenNan, type FakeOpenNan } from "@opennan/provider-opennan/testing";
import { createCloudApi, isCloudApiError, type CloudApi } from "./api";
import {
    checkShareBase, createShare, listShares, parseShare, revokeShare, shareUrlOf, stopSharing, SHARE_DEFAULT_DAYS, SHARE_MAX_DAYS, SHARE_DAY_CHOICES, type ShareSite,
} from "./shares";

let fake: FakeOpenNan;
let api: CloudApi;
let site: ShareSite;

beforeAll(async () => {
    fake = await startFakeOpenNan();
});
afterAll(() => fake.close());
beforeEach(() => {
    fake.reset();
    const key = fake.mintKey();
    api = createCloudApi({ baseUrl: fake.url, apiKey: () => key });
    site = {};
});

async function projectWithMedia(): Promise<string> {
    const created = await api.request<{ id: string }>("POST", "/v1/projects", { body: { name: "Film" } });
    const id = created.body.id;
    await api.request("POST", `/v1/projects/${id}/changes`, {
        body: { scenes: { create: [{ id: crypto.randomUUID(), start_image_url: `${fake.url}/files/results/a.png` }] } }, headers: { "Idempotency-Key": crypto.randomUUID() },
    });
    return id;
}

const TOKEN = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKL";

describe("share links over the cloud API", () => {
    it("creates, lists, rotates, revokes one and stops sharing", async () => {
        const id = await projectWithMedia();
        const { link, replaced } = await createShare(api, id, {}, site);
        expect(replaced).toEqual([]);
        expect(link).toMatchObject({ status: "active", allowDownload: false, views: 0, lastViewedAt: null, revokedAt: null });
        expect(link.url).toBe(`${fake.url}/s/${link.token}`);
        expect(Math.round(((link.expiresAt ?? 0) - Date.now()) / 86_400_000)).toBe(SHARE_DEFAULT_DAYS);
        const rotated = await createShare(api, id, { expiresInDays: 7, allowDownload: true }, site);
        expect(rotated.replaced).toEqual([link.id]);
        expect(rotated.link.allowDownload).toBe(true);
        const listed = await listShares(api, id, site);
        expect(listed.map((s) => [s.id, s.status])).toEqual([[rotated.link.id, "active"], [link.id, "revoked"]]);
        // Only the active link carries a URL to show or copy.
        expect(listed[1]!.url).toBeNull();
        const revoked = await revokeShare(api, id, rotated.link.id, site);
        expect(revoked).toMatchObject({ id: rotated.link.id, status: "revoked", url: null });
        const again = await createShare(api, id, {}, site);
        expect((await stopSharing(api, id, site)).map((s) => s.id)).toEqual([again.link.id]);
        expect(await stopSharing(api, id, site)).toEqual([]);
    });

    it("builds the link on the share answer's share_base_url, and on https://opennan.com/s for servers without one", async () => {
        const id = await projectWithMedia();
        const { link } = await createShare(api, id, {}, site);
        expect(link.url).toBe(`${fake.url}/s/${link.token}`);
        await fetch(`${fake.url}/__test/cloud/share-base-url`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ value: null }) });
        const older = await createShare(api, id, {}, site);
        // An older server names no base: its url on the fake's own site is not opennan.com's share page.
        expect(older.link.url).toBe(`https://opennan.com/s/${older.link.token}`);
        // The account's share_base_url (GET /v1/account) stands in for a share answer without one.
        expect((await listShares(api, id, { shareBaseUrl: `${fake.url}/s` }))[0]!.url).toBe(`${fake.url}/s/${older.link.token}`);
        // Against a production API a loopback base is never used, even when the server names one.
        const production: CloudApi = { baseUrl: "https://api.opennan.com", request: (method, path, request) => api.request(method, path, request) };
        await fetch(`${fake.url}/__test/cloud/share-base-url`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ value: `${fake.url}/s` }) });
        expect((await listShares(production, id, site))[0]!.url).toBe(`https://opennan.com/s/${older.link.token}`);
        // A host that knows it runs against the e2e fake (desktop's proxy API has no loopback address) says so.
        expect((await listShares(production, id, { ...site, allowLoopback: true }))[0]!.url).toBe(`${fake.url}/s/${older.link.token}`);
    });

    it("stop sharing answers exactly the links it changed: an expired link stays expired and is not in the answer", async () => {
        const id = await projectWithMedia();
        const first = (await createShare(api, id, {}, site)).link;
        await fetch(`${fake.url}/__test/cloud/share-expire`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ share_id: first.id }) });
        const second = (await createShare(api, id, {}, site)).link;
        const changed = await stopSharing(api, id, site);
        expect(changed.map((s) => [s.id, s.status, s.url])).toEqual([[second.id, "revoked", null]]);
        const listed = await listShares(api, id, site);
        expect(listed.map((s) => [s.id, s.status, s.revokedAt])).toEqual([[second.id, "revoked", changed[0]!.revokedAt], [first.id, "expired", null]]);
    });

    it("sends the server's strict body (whole days 1–365, a boolean) and refuses out-of-range options before sending", async () => {
        const id = await projectWithMedia();
        const calls: unknown[] = [];
        const spy: CloudApi = { baseUrl: api.baseUrl, request: (method, path, request) => (calls.push({ method, path, body: request?.body }), api.request(method, path, request)) };
        await createShare(spy, id, { expiresInDays: 365, allowDownload: false }, site);
        expect(calls).toEqual([{ method: "POST", path: `/v1/projects/${id}/shares`, body: { expires_in_days: 365, allow_download: false } }]);
        for (const days of [0, 366, 2.5, Number.NaN]) await expect(createShare(spy, id, { expiresInDays: days }, site)).rejects.toThrow(/1 to 365 days/);
        expect(calls).toHaveLength(1);
        expect(SHARE_MAX_DAYS).toBe(365);
        expect(SHARE_DAY_CHOICES).toEqual([1, 7, 30, 90, 365]);
    });

    it("passes the server's refusals through as CloudApiError codes", async () => {
        const created = await api.request<{ id: string }>("POST", "/v1/projects", { body: { name: "Empty" } });
        const error = await createShare(api, created.body.id, {}, site).catch((e: unknown) => e);
        expect(isCloudApiError(error) && error.code).toBe("share_nothing_to_show");
        await expect(listShares(api, "../evil", site)).rejects.toThrow(/project id/);
        await expect(revokeShare(api, created.body.id, "shr_../x", site)).rejects.toThrow(/share link id/);
    });
});

describe("parseShare and shareUrlOf", () => {
    it("parses defensively: odd fields read as neutral values, an unusable answer as null", () => {
        expect(parseShare({ id: "shr_0123456789abcdef01234567", token: TOKEN, status: "active", views: "9", expires_at: "nope" }, site)).toMatchObject({
            id: "shr_0123456789abcdef01234567", token: TOKEN, status: "active", views: 0, expiresAt: null, allowDownload: false,
        });
        expect(parseShare({ id: "bad", token: TOKEN }, site)).toBeNull();
        expect(parseShare({ id: "shr_0123456789abcdef01234567", token: "short" }, site)).toBeNull();
        expect(parseShare({ id: "shr_0123456789abcdef01234567", token: TOKEN, status: "weird" }, site)?.status).toBe("expired");
        expect(parseShare(null, site)).toBeNull();
        // Only an active link carries a URL, whatever the answer's url says.
        expect(parseShare({ id: "shr_0123456789abcdef01234567", token: TOKEN, status: "revoked", url: `https://opennan.com/s/${TOKEN}` }, site)?.url).toBeNull();
    });

    it("checks share_base_url: https on opennan.com or a subdomain, or loopback, with the path /s and nothing else", () => {
        expect(checkShareBase("https://opennan.com/s")).toBe("https://opennan.com/s");
        expect(checkShareBase("https://opennan.com/s/")).toBe("https://opennan.com/s");
        expect(checkShareBase("https://staging.opennan.com/s")).toBe("https://staging.opennan.com/s");
        // Loopback (the e2e fake) only when the API itself is loopback (review 9c.1).
        expect(checkShareBase("http://127.0.0.1:4100/s", true)).toBe("http://127.0.0.1:4100/s");
        expect(checkShareBase("http://[::1]:4100/s", true)).toBe("http://[::1]:4100/s");
        expect(checkShareBase("http://127.0.0.1:4100/s")).toBeNull();
        for (const bad of [
            "http://opennan.com/s", "https://opennan.com.evil.example/s", "https://evilopennan.com/s", "https://opennan.com:8443/s", "https://opennan.com/share",
            "https://opennan.com/s/x", "https://opennan.com/s?next=1", "https://opennan.com/s#x", "https://user:pw@opennan.com/s", "javascript:alert(1)//opennan.com/s",
            "http://evil.example/s", "", null, 7, `https://opennan.com/s${"x".repeat(300)}`,
        ]) expect(checkShareBase(bad)).toBeNull();
    });

    it("uses the server's url only when it is exactly <share_base_url>/<token> on a checked base, else builds it there", () => {
        const fakeBase = "http://127.0.0.1:4100/s";
        expect(shareUrlOf(TOKEN, `https://opennan.com/s/${TOKEN}`, {})).toBe(`https://opennan.com/s/${TOKEN}`);
        expect(shareUrlOf(TOKEN, `https://evil.example/s/${TOKEN}`, {})).toBe(`https://opennan.com/s/${TOKEN}`);
        expect(shareUrlOf(TOKEN, `https://opennan.com/s/${TOKEN}?next=https://evil.example`, {})).toBe(`https://opennan.com/s/${TOKEN}`);
        expect(shareUrlOf(TOKEN, `https://opennan.com/s/other${TOKEN}`, {})).toBe(`https://opennan.com/s/${TOKEN}`);
        expect(shareUrlOf(TOKEN, `javascript:alert(1)//${TOKEN}`, {})).toBe(`https://opennan.com/s/${TOKEN}`);
        // The share answer's base first, then the account's, then opennan.com.
        expect(shareUrlOf(TOKEN, `${fakeBase}/${TOKEN}`, { allowLoopback: true }, fakeBase)).toBe(`${fakeBase}/${TOKEN}`);
        expect(shareUrlOf(TOKEN, `${fakeBase}/${TOKEN}`, {}, fakeBase)).toBe(`https://opennan.com/s/${TOKEN}`);
        expect(shareUrlOf(TOKEN, null, { shareBaseUrl: "https://staging.opennan.com/s", allowLoopback: true }, fakeBase)).toBe(`${fakeBase}/${TOKEN}`);
        expect(shareUrlOf(TOKEN, null, { shareBaseUrl: "https://staging.opennan.com/s" })).toBe(`https://staging.opennan.com/s/${TOKEN}`);
        // The server's url on another base than the one it names is never shown: the link is built on the base.
        expect(shareUrlOf(TOKEN, `https://opennan.com/s/${TOKEN}`, {}, "https://staging.opennan.com/s")).toBe(`https://staging.opennan.com/s/${TOKEN}`);
        // A base that fails the check is ignored (never builds a link).
        expect(shareUrlOf(TOKEN, `https://evil.example/s/${TOKEN}`, { shareBaseUrl: "https://evil.example/s" }, "https://evil.example/s")).toBe(`https://opennan.com/s/${TOKEN}`);
        expect(shareUrlOf("bad token", `https://opennan.com/s/bad token`, {})).toBeNull();
    });
});
