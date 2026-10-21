import { createOpenNanApi } from "./api";
import { DEVICE_GRANT_TYPE, createDevicePoller, startDeviceSignIn, type DeviceStart } from "./device-flow";
import { DeviceFlowError } from "./errors";

type Answer = { status: number; body?: unknown; headers?: Record<string, string> } | "network";

function scripted(answers: Answer[]) {
    const calls: Array<{ url: string; body: unknown; at: number }> = [];
    const fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
        calls.push({ url: String(input), body: init.body ? JSON.parse(String(init.body)) : undefined, at: Date.now() });
        const next = answers.shift() ?? { status: 400, body: { error: { type: "invalid_request_error", message: "pending", code: "authorization_pending" } } };
        if (next === "network") throw new TypeError("Failed to fetch");
        return new Response(JSON.stringify(next.body ?? {}), { status: next.status, headers: { "content-type": "application/json", ...(next.headers ?? {}) } });
    }) as typeof globalThis.fetch;
    return { api: createOpenNanApi({ baseUrl: "https://api.opennan.com", fetch }), calls };
}

const pending = { status: 400, body: { error: { type: "invalid_request_error", message: "Waiting", code: "authorization_pending" } } };
const errorCode = (code: string, status = 400) => ({ status, body: { error: { type: "invalid_request_error", message: code, code } } });
const TOKEN = { status: 200, body: { object: "api_key", token_type: "Bearer", api_key: "sk-test_abcdefghijklmnopqrstuvwxyz", key_id: "key_1", name: "OpenNan Studio (Mac)", scopes: ["api:opennan"], expires_at: null } };

function start(overrides: Partial<DeviceStart> = {}): DeviceStart {
    return {
        deviceCode: "dev-code", userCode: "BCDF-GHJK", verificationUri: "https://opennan.com/console/device",
        verificationUriComplete: "https://opennan.com/console/device?code=BCDF-GHJK", expiresAt: Date.now() + 600_000, intervalSeconds: 3, ...overrides,
    };
}

beforeEach(() => {
    vi.useFakeTimers({ now: Date.parse("2026-10-19T12:00:00Z") });
});
afterEach(() => {
    vi.useRealTimers();
});

describe("startDeviceSignIn", () => {
    it("posts the device name, client, and signup and maps the answer", async () => {
        const { api, calls } = scripted([{ status: 200, body: {
            device_code: "dc", user_code: "BCDF-GHJK", verification_uri: "https://opennan.com/console/device",
            verification_uri_complete: "https://opennan.com/console/device?code=BCDF-GHJK&signup=1", expires_in: 600, interval: 3,
        } }]);
        const result = await startDeviceSignIn(api, { deviceName: "Ada's Mac", client: "desktop", signup: true });
        expect(calls[0]).toMatchObject({ url: "https://api.opennan.com/v1/auth/device", body: { device_name: "Ada's Mac", client: "desktop", signup: true } });
        expect(result).toEqual({
            deviceCode: "dc", userCode: "BCDF-GHJK", verificationUri: "https://opennan.com/console/device",
            verificationUriComplete: "https://opennan.com/console/device?code=BCDF-GHJK&signup=1", expiresAt: Date.now() + 600_000, intervalSeconds: 3,
        });
    });

    it("leaves signup out unless asked and adds &signup=1 itself when the server did not", async () => {
        const answer = { status: 200, body: { device_code: "dc", user_code: "BCDF-GHJK", verification_uri: "https://opennan.com/console/device", verification_uri_complete: "https://opennan.com/console/device?code=BCDF-GHJK", expires_in: 600, interval: 3 } };
        const { api, calls } = scripted([answer, answer]);
        expect((await startDeviceSignIn(api, { deviceName: "Mac", client: "web" })).verificationUriComplete).toBe("https://opennan.com/console/device?code=BCDF-GHJK");
        expect(calls[0]!.body).toEqual({ device_name: "Mac", client: "web" });
        expect((await startDeviceSignIn(api, { deviceName: "Mac", client: "web", signup: true })).verificationUriComplete).toBe("https://opennan.com/console/device?code=BCDF-GHJK&signup=1");
    });

    it("names rate limits, network failures, and other errors", async () => {
        const { api } = scripted([{ status: 429, body: { error: { type: "rate_limit_error", message: "Too many", code: "rate_limit_exceeded" } }, headers: { "retry-after": "9" } }, "network", errorCode("invalid_request")]);
        await expect(startDeviceSignIn(api, { deviceName: "M", client: "cli" })).rejects.toMatchObject({ kind: "rate-limited", retryAfterSeconds: 9, message: "OpenNan is busy right now. Try again in 9 s." });
        await expect(startDeviceSignIn(api, { deviceName: "M", client: "cli" })).rejects.toMatchObject({ kind: "network" });
        await expect(startDeviceSignIn(api, { deviceName: "M", client: "cli" })).rejects.toMatchObject({ kind: "unknown" });
    });

    it("refuses an answer without a code", async () => {
        const { api } = scripted([{ status: 200, body: { user_code: "X" } }]);
        await expect(startDeviceSignIn(api, { deviceName: "M", client: "cli" })).rejects.toBeInstanceOf(DeviceFlowError);
    });
});

describe("createDevicePoller", () => {
    it("waits the interval, polls with the device code, and returns the key", async () => {
        const { api, calls } = scripted([pending, pending, TOKEN]);
        const poller = createDevicePoller(api, start());
        const t0 = Date.now();
        await vi.advanceTimersByTimeAsync(9_000);
        await expect(poller.result).resolves.toEqual({ apiKey: "sk-test_abcdefghijklmnopqrstuvwxyz", keyId: "key_1", keyName: "OpenNan Studio (Mac)", scopes: ["api:opennan"], expiresAt: null });
        expect(calls.map((c) => c.at - t0)).toEqual([3000, 6000, 9000]);
        expect(calls[0]!.body).toEqual({ device_code: "dev-code", grant_type: DEVICE_GRANT_TYPE });
    });

    it("adds 5 s on slow_down", async () => {
        const { api, calls } = scripted([errorCode("slow_down"), pending, TOKEN]);
        const poller = createDevicePoller(api, start());
        const t0 = Date.now();
        await vi.advanceTimersByTimeAsync(3000 + 8000 + 8000);
        await poller.result;
        expect(calls.map((c) => c.at - t0)).toEqual([3000, 11_000, 19_000]);
    });

    it.each([["expired_token", "expired"], ["invalid_grant", "expired"], ["access_denied", "denied"]])("ends on %s as %s", async (code, kind) => {
        const { api } = scripted([errorCode(code)]);
        const poller = createDevicePoller(api, start());
        const outcome = poller.result.catch((e: unknown) => e);
        await vi.advanceTimersByTimeAsync(3000);
        expect(await outcome).toMatchObject({ name: "DeviceFlowError", kind });
    });

    it("expires without another request once the code's time is up", async () => {
        const { api, calls } = scripted([]);
        const poller = createDevicePoller(api, start({ expiresAt: Date.now() + 7_000 }));
        const outcome = poller.result.catch((e: unknown) => e);
        await vi.advanceTimersByTimeAsync(20_000);
        expect(await outcome).toMatchObject({ kind: "expired" });
        expect(calls).toHaveLength(2);
    });

    it("waits Retry-After on 429 and continues", async () => {
        const { api, calls } = scripted([{ status: 429, body: { error: { type: "rate_limit_error", message: "slow", code: "rate_limit_exceeded" } }, headers: { "retry-after": "10" } }, TOKEN]);
        const poller = createDevicePoller(api, start());
        const t0 = Date.now();
        await vi.advanceTimersByTimeAsync(13_000);
        await poller.result;
        expect(calls.map((c) => c.at - t0)).toEqual([3000, 13_000]);
    });

    it("reports reconnecting on network errors and fails after 3 in a row", async () => {
        const { api } = scripted(["network", "network", pending, "network", "network", "network"]);
        const reconnecting: boolean[] = [];
        const poller = createDevicePoller(api, start(), { onReconnecting: (value) => reconnecting.push(value) });
        const outcome = poller.result.catch((e: unknown) => e);
        await vi.advanceTimersByTimeAsync(18_000);
        expect(await outcome).toMatchObject({ kind: "network" });
        expect(reconnecting).toEqual([true, false, true]);
    });

    it("stops on cancel without another request", async () => {
        const { api, calls } = scripted([]);
        const poller = createDevicePoller(api, start());
        const outcome = poller.result.catch((e: unknown) => e);
        await vi.advanceTimersByTimeAsync(3000);
        poller.cancel();
        await vi.advanceTimersByTimeAsync(30_000);
        expect(await outcome).toMatchObject({ name: "AbortError" });
        expect(calls).toHaveLength(1);
    });

    it("pollNow never polls before the interval (or a Retry-After) has passed", async () => {
        const { api, calls } = scripted([{ status: 429, body: { error: { type: "rate_limit_error", message: "slow", code: "rate_limit_exceeded" } }, headers: { "retry-after": "10" } }, pending, TOKEN]);
        const poller = createDevicePoller(api, start({ intervalSeconds: 5 }));
        const t0 = Date.now();
        await vi.advanceTimersByTimeAsync(1000);
        poller.pollNow(); // 1 s: too soon
        await vi.advanceTimersByTimeAsync(3500);
        poller.pollNow(); // 4.5 s: still under the 5 s interval
        await vi.advanceTimersByTimeAsync(0);
        expect(calls).toHaveLength(0);
        await vi.advanceTimersByTimeAsync(500);
        expect(calls.map((c) => c.at - t0)).toEqual([5000]); // regular poll → 429, Retry-After 10 s
        await vi.advanceTimersByTimeAsync(6000);
        poller.pollNow(); // 11 s: past the interval, inside Retry-After
        await vi.advanceTimersByTimeAsync(0);
        expect(calls).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(4000);
        expect(calls.map((c) => c.at - t0)).toEqual([5000, 15000]);
        await vi.advanceTimersByTimeAsync(5000);
        await poller.result;
    });
});
