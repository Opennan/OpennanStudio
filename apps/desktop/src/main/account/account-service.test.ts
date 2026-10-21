// The desktop account service against the fake OpenNan server with a fake safeStorage.
import { startFakeOpenNan, type FakeOpenNan } from "@opennan/provider-opennan/testing";
import { EVENTS } from "../../shared/channels";
import { openDatabase } from "../store/database";
import { createSecretStore, type SafeStorageLike } from "../store/secrets";
import { MEMORY_ONLY_WARNING, createAccountService, isConsoleDeviceUrl, openNanBases, type AccountServiceOptions } from "./account-service";

let fake: FakeOpenNan;
beforeAll(async () => {
    fake = await startFakeOpenNan({ intervalSeconds: 1 });
});
afterAll(() => fake.close());
beforeEach(() => fake.reset());

const safeStorage = (backend = "keychain"): SafeStorageLike => ({
    isEncryptionAvailable: () => true,
    encryptString: (s) => Buffer.from([...Buffer.from(s, "utf8")].map((b) => b ^ 0x5a)),
    decryptString: (b) => Buffer.from([...b].map((x) => x ^ 0x5a)).toString("utf8"),
    getSelectedStorageBackend: () => backend,
});

function setup(options: { db?: ReturnType<typeof openDatabase>; platform?: NodeJS.Platform; backend?: string; consoleBase?: string } = {}) {
    const db = options.db ?? openDatabase(":memory:");
    const secrets = createSecretStore({ db, safeStorage: safeStorage(options.backend), platform: options.platform ?? "darwin" });
    const opened: string[] = [];
    const sent: Array<{ channel: string; payload: unknown }> = [];
    const warnings: string[] = [];
    const focus = vi.fn();
    const config: AccountServiceOptions = {
        apiBase: fake.url, consoleBase: options.consoleBase ?? fake.url, secrets, deviceName: "Ada's <Mac>\u0007",
        openExternal: (url) => void opened.push(url), focusWindow: focus, send: (channel, payload) => void sent.push({ channel, payload }),
        warn: (m) => void warnings.push(m),
    };
    const service = createAccountService(config);
    return { db, secrets, service, opened, sent, focus, warnings };
}

const noKeys = (values: unknown[]) => {
    for (const value of values) expect(JSON.stringify(value)).not.toMatch(/sk-/);
};

describe("account service", () => {
    it("signs in: opens only the device page, stores the key in the internal slot, focuses the window", async () => {
        const { db, secrets, service, opened, sent, focus } = setup();
        await service.ready;
        await service.start(false);
        const status = service.status();
        expect(status.state).toBe("waiting");
        expect(opened).toEqual([(status as { verificationUriComplete: string }).verificationUriComplete]);
        expect(opened[0]).toMatch(new RegExp(`^${fake.url}/console/device\\?code=`));
        expect(fake.state().devices[0]).toMatchObject({ client: "desktop", deviceName: "Ada's Mac" });
        fake.approve();
        await vi.waitFor(() => expect(service.status()).toMatchObject({ state: "signed-in", account: { email: "ada@example.com" }, persistence: "persistent" }), { timeout: 5000 });
        expect(focus).toHaveBeenCalledTimes(1);
        expect(secrets.getInternal("OPENNAN_STUDIO_SESSION")).toMatch(/"apiKey":"sk-fake_/);
        expect(secrets.list().some((s) => (s.name as string) === "OPENNAN_STUDIO_SESSION")).toBe(false);
        expect(sent.every((s) => s.channel === EVENTS.accountChanged || s.channel === EVENTS.accountNotice)).toBe(true);
        noKeys(sent.map((s) => s.payload));
        noKeys([service.status()]);

        // A restart with the same database is still signed in.
        const again = setup({ db });
        await again.service.ready;
        expect(again.service.status()).toMatchObject({ state: "signed-in" });
        await vi.waitFor(() => expect(again.service.status()).toMatchObject({ account: { email: "ada@example.com" } }));

        await again.service.signOut();
        expect(fake.state().revokedKeyIds).toHaveLength(1);
        expect(again.secrets.getInternal("OPENNAN_STUDIO_SESSION")).toBeNull();
        expect(again.service.status()).toEqual({ state: "signed-out" });
    });

    it("refuses to open a sign-in page on another origin", async () => {
        const { service, opened } = setup({ consoleBase: "https://opennan.com" });
        await service.ready;
        await service.start(false);
        expect(opened).toEqual([]);
        expect(service.status()).toMatchObject({ state: "error", kind: "unknown" });
        expect(isConsoleDeviceUrl("https://opennan.com/console/device?code=X", "https://opennan.com")).toBe(true);
        expect(isConsoleDeviceUrl("https://opennan.com.evil.example/console/device", "https://opennan.com")).toBe(false);
        expect(isConsoleDeviceUrl("https://opennan.com/console/keys", "https://opennan.com")).toBe(false);
        expect(isConsoleDeviceUrl("http://opennan.com/console/device", "https://opennan.com")).toBe(false);
        expect(isConsoleDeviceUrl("https://u:p@opennan.com/console/device", "https://opennan.com")).toBe(false);
    });

    it("reopens the same page, opens console pages, and ignores unknown pages", async () => {
        const { service, opened } = setup();
        await service.ready;
        await service.start(true);
        service.reopen();
        expect(opened).toHaveLength(2);
        expect(opened[1]).toBe(opened[0]);
        expect(opened[0]).toMatch(/&signup=1$/);
        service.openConsole("billing");
        service.openConsole("../evil" as never);
        expect(opened[2]).toBe(`${fake.url}/console/billing`);
        expect(opened).toHaveLength(3);
        service.cancel();
        expect(service.status()).toEqual({ state: "signed-out" });
    });

    it("keeps the key in memory only on Linux without a keyring, with a warning", async () => {
        const { db, service, secrets, warnings } = setup({ platform: "linux", backend: "basic_text" });
        await service.ready;
        await service.connectKey(fake.mintKey());
        expect(service.status()).toMatchObject({ state: "signed-in", persistence: "memory" });
        expect(warnings).toEqual([MEMORY_ONLY_WARNING]);
        expect(secrets.getInternal("OPENNAN_STUDIO_SESSION")).toBeNull();
        expect(db.prepare("select count(*) as n from secrets").get()).toEqual({ n: 0 });
        expect(service.session.apiKey()).toMatch(/^sk-fake_/);
    });

    it("forwards notices to the renderer without keys", async () => {
        const { service, sent } = setup();
        service.session.notify({ kind: "insufficient-credits", billingUrl: `${fake.url}/console/billing` });
        expect(sent.at(-1)).toEqual({ channel: EVENTS.accountNotice, payload: { kind: "insufficient-credits", billingUrl: `${fake.url}/console/billing` } });
    });

    it("uses opennan.com unless an unpackaged e2e run points elsewhere", () => {
        const production = { apiBase: "https://api.opennan.com", consoleBase: "https://opennan.com", overridden: false };
        const fakeEnv = { OPENNAN_STUDIO_E2E: "1", OPENNAN_STUDIO_API_BASE: "http://127.0.0.1:4321" };
        expect(openNanBases({}, false)).toEqual(production);
        expect(openNanBases(fakeEnv, true)).toEqual(production);
        expect(openNanBases({ OPENNAN_STUDIO_API_BASE: "http://127.0.0.1:4321" }, false)).toEqual(production);
        expect(openNanBases({ ...fakeEnv, OPENNAN_STUDIO_API_BASE: "http://evil.example" }, false)).toEqual(production);
        expect(openNanBases(fakeEnv, false)).toEqual({ apiBase: "http://127.0.0.1:4321", consoleBase: "http://127.0.0.1:4321", overridden: true });
    });
});
