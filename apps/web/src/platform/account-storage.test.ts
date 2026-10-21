import { KEEP_SIGNED_IN_KEY, createWebAccountStorage, memoryKeyValue, sessionKeyValue, type KeyValueStore } from "./account-storage";

const CREDENTIAL = { apiKey: "sk-test_abcdefghijklmnopqrstuvwxyz", keyId: "key_1", expiresAt: "2026-11-18T00:00:00Z" };

function prefs(initial: Record<string, string> = {}) {
    const data = new Map(Object.entries(initial));
    return { data, getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
}

describe("web account storage", () => {
    it("keeps the key in IndexedDB by default", async () => {
        const persistent = memoryKeyValue();
        const session = memoryKeyValue();
        const storage = createWebAccountStorage({ persistent, session, preferences: prefs() });
        expect(storage.keepSignedIn()).toBe(true);
        expect(storage.credentials.persistence()).toBe("persistent");
        await storage.credentials.set(CREDENTIAL);
        expect(JSON.parse(persistent.data.get("opennan")!)).toEqual(CREDENTIAL);
        expect(session.data.size).toBe(0);
        expect(await storage.credentials.get()).toEqual(CREDENTIAL);
        await storage.credentials.clear();
        expect(await storage.credentials.get()).toBeNull();
    });

    it("uses sessionStorage when Keep me signed in is off, and moves the key when it changes", async () => {
        const persistent = memoryKeyValue();
        const session = memoryKeyValue();
        const preferences = prefs();
        const storage = createWebAccountStorage({ persistent, session, preferences });
        await storage.credentials.set(CREDENTIAL);
        await storage.setSecret("fal", "fal-key-123");
        await storage.setKeepSignedIn(false);
        expect(preferences.data.get(KEEP_SIGNED_IN_KEY)).toBe("0");
        expect(storage.credentials.persistence()).toBe("session");
        expect(persistent.data.size).toBe(0);
        expect(JSON.parse(session.data.get("opennan")!)).toEqual(CREDENTIAL);
        expect(await storage.getSecret("fal")).toBe("fal-key-123");
        await storage.setKeepSignedIn(true);
        expect(session.data.size).toBe(0);
        expect(await storage.credentials.get()).toEqual(CREDENTIAL);
        const reloaded = createWebAccountStorage({ persistent, session: memoryKeyValue(), preferences: prefs({ [KEEP_SIGNED_IN_KEY]: "0" }) });
        expect(reloaded.keepSignedIn()).toBe(false);
    });

    it("falls back to sessionStorage when IndexedDB fails or is missing", async () => {
        const broken: KeyValueStore = { get: async () => { throw new Error("blocked"); }, set: async () => { throw new Error("blocked"); }, delete: async () => { throw new Error("blocked"); } };
        const session = memoryKeyValue();
        const storage = createWebAccountStorage({ persistent: broken, session, preferences: prefs() });
        await storage.credentials.set(CREDENTIAL);
        expect(storage.credentials.persistence()).toBe("session");
        expect(await storage.credentials.get()).toEqual(CREDENTIAL);
        const none = createWebAccountStorage({ persistent: null, session: memoryKeyValue(), preferences: null });
        expect(none.credentials.persistence()).toBe("session");
    });

    it("ignores damaged values and reads sessionStorage through a prefix", async () => {
        const raw = new Map<string, string>();
        const fakeStorage = { getItem: (k: string) => raw.get(k) ?? null, setItem: (k: string, v: string) => void raw.set(k, v), removeItem: (k: string) => void raw.delete(k) } as unknown as Storage;
        const session = sessionKeyValue(fakeStorage);
        await session.set("opennan", "{nope");
        expect([...raw.keys()]).toEqual(["opennan-studio:secret:opennan"]);
        const storage = createWebAccountStorage({ persistent: null, session, preferences: null });
        expect(await storage.credentials.get()).toBeNull();
    });
});
