import type { OpenNanCloudBackend } from "@opennan/cloud-backend";
import { LocalBackend, createMemoryPersistence } from "@opennan/timeline-core";
import { signedOutAccount, type SessionStatus } from "../account/account-types";
import { accountKey, accountKeys, createCloudPlatform, STORAGE_MAX_AGE_MS } from "./cloud-platform";
import type { CloudApi } from "@opennan/cloud-backend";

const signedIn = (email: string | null, keyId = "key_1", accountId: string | null = null): SessionStatus => ({
    state: "signed-in", persistence: "persistent",
    account: email ? { email, displayName: "A", photoUrl: null, balanceUsd: 1, keyId, keyName: null, keyExpiresAt: null, billingUrl: null, accountId } : null,
});

function account(initial: SessionStatus) {
    let status = initial;
    const listeners = new Set<() => void>();
    return {
        platform: signedOutAccount({ status: () => status, subscribe: (l) => (listeners.add(l), () => listeners.delete(l)) }),
        set(next: SessionStatus) {
            status = next;
            for (const l of listeners) l();
        },
    };
}

function fakeBackend(name: string) {
    return { name, resume: vi.fn(), dispose: vi.fn(async () => undefined), resolveLocalUrl: () => null } as unknown as OpenNanCloudBackend & { name: string; resume: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> };
}

beforeEach(() => localStorage.clear());

describe("cloud platform", () => {
    it("builds nothing until asked, and nothing while signed out", () => {
        const acc = account({ state: "signed-out" });
        const build = vi.fn((id: string) => fakeBackend(id));
        const cloud = createCloudPlatform({ account: acc.platform, local: new LocalBackend({ persistence: createMemoryPersistence() }), build });
        expect(build).not.toHaveBeenCalled();
        expect(cloud.peek()).toBeNull();
        expect(cloud.backend()).toBeNull();
        acc.set(signedIn("Ada@Example.com"));
        expect(build).not.toHaveBeenCalled();
        expect((cloud.backend() as unknown as { name: string }).name).toBe("ada@example.com");
        expect(build).toHaveBeenCalledTimes(1);
    });

    it("resumes the same account and replaces the backend for another one", () => {
        const acc = account(signedIn("a@x.com"));
        const cloud = createCloudPlatform({ account: acc.platform, local: new LocalBackend({ persistence: createMemoryPersistence() }), build: fakeBackend });
        const first = cloud.backend() as ReturnType<typeof fakeBackend>;
        acc.set({ state: "signed-out" });
        acc.set(signedIn("a@x.com"));
        expect(first.resume).toHaveBeenCalled();
        acc.set(signedIn("b@x.com", "key_2"));
        expect(first.dispose).toHaveBeenCalled();
        expect((cloud.backend() as unknown as { name: string }).name).toBe("b@x.com");
    });

    it("knows the account offline (before it is read again) from the last time, and forgets it on sign-out", () => {
        expect(accountKey(signedIn(null))).toBeNull();
        expect(accountKey(signedIn("a@x.com"))).toBe("a@x.com");
        expect(accountKey(signedIn(null))).toBe("a@x.com");
        const acc = account(signedIn("a@x.com"));
        createCloudPlatform({ account: acc.platform, local: new LocalBackend({ persistence: createMemoryPersistence() }), build: fakeBackend });
        acc.set({ state: "signed-out" });
        expect(accountKey(signedIn(null))).toBeNull();
    });

    it("a new sign-in never reuses the remembered account before the new one is read", () => {
        const acc = account(signedIn("a@x.com"));
        createCloudPlatform({ account: acc.platform, local: new LocalBackend({ persistence: createMemoryPersistence() }), build: fakeBackend });
        accountKey(signedIn("a@x.com"));
        acc.set({ state: "starting", signup: false });
        expect(accountKey(signedIn(null))).toBeNull();
    });

    it("keys the store by the account's stable id when the server sends one, by email otherwise (9a.1)", () => {
        expect(accountKeys(signedIn("Ada@Example.com", "key_1", "usr_42"))).toEqual({ key: "id:usr_42", legacy: "ada@example.com" });
        expect(accountKeys(signedIn("Ada@Example.com"))).toEqual({ key: "ada@example.com", legacy: null });
        // Offline (no account read yet): the key this same API key had last time — now the id.
        expect(accountKey(signedIn(null))).toBe("ada@example.com");
        accountKey(signedIn("ada@example.com", "key_1", "usr_42"));
        expect(accountKey(signedIn(null))).toBe("id:usr_42");
        // ...with the email it moves from, so an offline start still finishes a move a quit interrupted (review).
        expect(accountKeys(signedIn(null))).toEqual({ key: "id:usr_42", legacy: "ada@example.com" });
    });

    it("builds the id-keyed backend with a migration from the email store, after the email backend let go", async () => {
        const acc = account(signedIn("a@x.com"));
        const builds: Array<{ id: string; migration?: { from: string; waitFor: Promise<unknown> } }> = [];
        let disposeDone!: () => void;
        const first = fakeBackend("a@x.com");
        first.dispose.mockImplementation(() => new Promise<void>((resolve) => (disposeDone = resolve)));
        const cloud = createCloudPlatform({
            account: acc.platform, local: new LocalBackend({ persistence: createMemoryPersistence() }),
            build: (id, migration) => {
                builds.push({ id, ...(migration ? { migration } : {}) });
                return builds.length === 1 ? first : fakeBackend(id);
            },
        });
        cloud.backend();
        expect(builds[0]).toEqual({ id: "a@x.com" });
        // The server now sends the account id: the same person, a new store key.
        acc.set(signedIn("a@x.com", "key_1", "usr_9"));
        expect(first.dispose).toHaveBeenCalled();
        cloud.backend();
        expect(builds[1]!.id).toBe("id:usr_9");
        expect(builds[1]!.migration!.from).toBe("a@x.com");
        let waited = false;
        void builds[1]!.migration!.waitFor.then(() => (waited = true));
        await Promise.resolve();
        expect(waited).toBe(false);
        disposeDone();
        await vi.waitFor(() => expect(waited).toBe(true));
    });

    it("builds a fresh id-keyed backend with a migration too (a device that last ran before 9a.1)", () => {
        const acc = account(signedIn("a@x.com", "key_1", "usr_9"));
        const build = vi.fn((id: string, _migration?: { from: string; waitFor: Promise<unknown> }) => fakeBackend(id));
        const cloud = createCloudPlatform({ account: acc.platform, local: new LocalBackend({ persistence: createMemoryPersistence() }), build });
        cloud.backend();
        expect(build.mock.calls[0]![0]).toBe("id:usr_9");
        expect(build.mock.calls[0]![1]!.from).toBe("a@x.com");
    });

    it("reads the storage meter without building the cloud backend, cached briefly per account", async () => {
        const acc = account({ state: "signed-out" });
        const requests: string[] = [];
        let now = 1_000;
        const api: CloudApi = {
            baseUrl: "https://api.opennan.com",
            async request<T>(method: string, path: string) {
                requests.push(`${method} ${path}`);
                return { status: 200, etag: null, body: { media_bytes: requests.length, limits: { media_bytes: 2 } } as T };
            },
        };
        const build = vi.fn(fakeBackend);
        const cloud = createCloudPlatform({ account: acc.platform, local: new LocalBackend({ persistence: createMemoryPersistence() }), build, api: () => api, now: () => now });
        expect(cloud.storage()).toBeNull();
        acc.set(signedIn("a@x.com"));
        expect((await cloud.storage())!.mediaBytes).toBe(1);
        expect((await cloud.storage())!.mediaBytes).toBe(1);
        expect(requests).toEqual(["GET /v1/storage"]);
        now += STORAGE_MAX_AGE_MS + 1;
        expect((await cloud.storage())!.mediaBytes).toBe(2);
        acc.set(signedIn("b@x.com", "key_2"));
        expect((await cloud.storage())!.mediaBytes).toBe(3);
        expect(build).not.toHaveBeenCalled();
        expect(STORAGE_MAX_AGE_MS).toBe(30_000);
    });

    it("never caches a failed storage read", async () => {
        const acc = account(signedIn("a@x.com"));
        let fail = true;
        const api: CloudApi = {
            baseUrl: "https://api.opennan.com",
            async request<T>() {
                if (fail) throw new Error("offline");
                return { status: 200, etag: null, body: { media_bytes: 5 } as T };
            },
        };
        const cloud = createCloudPlatform({ account: acc.platform, local: new LocalBackend({ persistence: createMemoryPersistence() }), build: fakeBackend, api: () => api });
        await expect(cloud.storage()).rejects.toThrow("offline");
        fail = false;
        expect((await cloud.storage())!.mediaBytes).toBe(5);
    });
});
