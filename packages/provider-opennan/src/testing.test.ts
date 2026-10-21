// The real session and provider against the fake OpenNan server.
import { createOpenNanApi } from "./api";
import { INSUFFICIENT_CREDITS_MESSAGE, createOpenNanProvider } from "./provider";
import { OpenNanSession, memoryCredentialStore } from "./session";
import { FAKE_ACCOUNT_ID, startFakeOpenNan, type FakeOpenNan } from "./testing";

let fake: FakeOpenNan;
beforeAll(async () => {
    fake = await startFakeOpenNan({ intervalSeconds: 1 });
});
afterAll(() => fake.close());
beforeEach(() => fake.reset());

function session() {
    return new OpenNanSession({ api: createOpenNanApi({ baseUrl: fake.url }), store: memoryCredentialStore(), deviceName: "Test Mac", client: "web", consoleBase: fake.url });
}

describe("fake OpenNan server", () => {
    it("signs in end to end, generates an image, refreshes, and revokes", async () => {
        const s = session();
        await s.restore();
        await s.start({ signup: true });
        const waiting = s.status();
        expect(waiting).toMatchObject({ state: "waiting", verificationUriComplete: expect.stringMatching(/\/console\/device\?code=[A-Z]{4}-[A-Z]{4}&signup=1$/) });
        const page = await fetch((waiting as { verificationUriComplete: string }).verificationUriComplete).then((r) => r.text());
        expect(page).toContain("Create your OpenNan account");
        expect(fake.approve()).toBe(true);
        await vi.waitFor(() => expect(s.status()).toMatchObject({ state: "signed-in", account: { email: "ada@example.com", balanceUsd: 12.4 } }), { timeout: 5000 });
        const state = fake.state();
        expect(state.devices[0]).toMatchObject({ client: "web", signup: true, deviceName: "Test Mac", status: "consumed" });
        expect(state.devices[0]!.pollSpacingsMs.every((ms) => ms >= 900)).toBe(true);
        expect(JSON.stringify(state)).not.toContain("sk-");

        const output = await createOpenNanProvider(s).run!({ capability: "image.generate", input: { description: "a cat" } }).result();
        expect(output).toEqual({ media: [{ kind: "image", url: `${fake.url}/files/generated.png` }], costUsd: 0.039 });
        const png = await fetch(output.media[0]!.url!);
        expect(png.headers.get("content-type")).toBe("image/png");

        await s.signOut();
        expect(fake.state().revokedKeyIds).toEqual(["key_1"]);
    });

    it("answers 402 with zero balance and 401 for revoked keys", async () => {
        const key = fake.mintKey();
        const s = new OpenNanSession({ api: createOpenNanApi({ baseUrl: fake.url }), store: memoryCredentialStore({ apiKey: key, keyId: "key_1" }), deviceName: "x", client: "cli" });
        await s.restore();
        fake.setBalance(0);
        await expect(createOpenNanProvider(s).run!({ capability: "image.generate", input: { description: "a cat" } }).result()).rejects.toThrow(INSUFFICIENT_CREDITS_MESSAGE);
        const api = createOpenNanApi({ baseUrl: fake.url });
        await api.request("DELETE", "/v1/auth/key", { apiKey: key });
        await expect(api.request("GET", "/v1/account", { apiKey: key })).rejects.toMatchObject({ status: 401 });
    });

    it("enforces slow_down, expiry, denial, and on-demand 429s", async () => {
        const strict = await startFakeOpenNan({ intervalSeconds: 3 });
        try {
            const strictApi = createOpenNanApi({ baseUrl: strict.url });
            const start = await strictApi.request<{ device_code: string; interval: number }>("POST", "/v1/auth/device", { body: { device_name: "x" } });
            expect(start.interval).toBe(3);
            const poll = () => strictApi.request("POST", "/v1/auth/device/token", { body: { device_code: start.device_code } }).catch((e: { code: string }) => e.code);
            expect(await poll()).toBe("authorization_pending");
            expect(await poll()).toBe("slow_down");
            expect(strict.state().devices[0]!.pollSpacingsMs[0]).toBeLessThan(2000);
        } finally {
            await strict.close();
        }
        const api = createOpenNanApi({ baseUrl: fake.url });
        const denied = await api.request<{ device_code: string; user_code: string }>("POST", "/v1/auth/device", { body: { device_name: "x" } });
        fake.deny(denied.user_code);
        expect(await api.request("POST", "/v1/auth/device/token", { body: { device_code: denied.device_code } }).catch((e: { code: string }) => e.code)).toBe("access_denied");
        await fetch(`${fake.url}/__test/start-429?retry=4`);
        await expect(api.request("POST", "/v1/auth/device", { body: {} })).rejects.toMatchObject({ status: 429, retryAfterSeconds: 4 });
        await expect(api.request("POST", "/v1/auth/device", { body: { extra: 1 } })).rejects.toMatchObject({ status: 400 });
        const second = await api.request<{ device_code: string; user_code: string }>("POST", "/v1/auth/device", { body: {} });
        await fetch(`${fake.url}/__test/expire/${second.user_code}`, { method: "POST" });
        expect(await api.request("POST", "/v1/auth/device/token", { body: { device_code: second.device_code } }).catch((e: { code: string }) => e.code)).toBe("expired_token");
    });

    it("answers CORS preflights for loopback origins only", async () => {
        const ok = await fetch(`${fake.url}/v1/account`, { method: "OPTIONS", headers: { origin: "http://localhost:4318", "access-control-request-headers": "authorization" } });
        expect(ok.status).toBe(204);
        expect(ok.headers.get("access-control-allow-origin")).toBe("http://localhost:4318");
        const other = await fetch(`${fake.url}/v1/account`, { method: "OPTIONS", headers: { origin: "https://evil.example" } });
        expect(other.headers.get("access-control-allow-origin")).toBeNull();
    });

    it("answers the account's stable id (9a.1); /__test/account hides or changes it", async () => {
        let key = fake.mintKey();
        const account = async () => (await (await fetch(`${fake.url}/v1/account`, { headers: { authorization: `Bearer ${key}` } })).json()) as Record<string, unknown>;
        expect(await account()).toMatchObject({ account_id: FAKE_ACCOUNT_ID });
        await fetch(`${fake.url}/__test/account?id=none`, { method: "POST" });
        expect("account_id" in (await account())).toBe(false);
        await fetch(`${fake.url}/__test/account?id=usr_other`, { method: "POST" });
        expect((await account()).account_id).toBe("usr_other");
        fake.reset();
        key = fake.mintKey();
        expect((await account()).account_id).toBe(FAKE_ACCOUNT_ID);
    });
});
