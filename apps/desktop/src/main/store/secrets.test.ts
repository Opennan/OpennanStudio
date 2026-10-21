import { openDatabase } from "./database";
import { UNAVAILABLE, createSecretStore, type SafeStorageLike } from "./secrets";

const fakeSafeStorage = (overrides: Partial<SafeStorageLike> = {}): SafeStorageLike => ({
    isEncryptionAvailable: () => true,
    encryptString: (s) => Buffer.from([...s].reverse().join(""), "utf8"),
    decryptString: (b) => [...b.toString("utf8")].reverse().join(""),
    getSelectedStorageBackend: () => "gnome_libsecret",
    ...overrides,
});

describe("secret store", () => {
    it("encrypts values, lists only names, and returns values in main", () => {
        const db = openDatabase(":memory:");
        const secrets = createSecretStore({ db, safeStorage: fakeSafeStorage(), platform: "darwin" });
        secrets.set("ANTHROPIC_API_KEY", "sk-ant-123");
        const raw = db.prepare("select cipher from secrets").get() as { cipher: Buffer };
        expect(raw.cipher.toString("utf8")).not.toContain("sk-ant-123");
        expect(secrets.list()).toEqual([
            { name: "ANTHROPIC_API_KEY", set: true }, { name: "OPENAI_API_KEY", set: false },
            { name: "GEMINI_API_KEY", set: false }, { name: "OPENNAN_API_KEY", set: false }, { name: "FAL_KEY", set: false },
        ]);
        expect(JSON.stringify(secrets.list())).not.toContain("sk-ant");
        expect(secrets.get("ANTHROPIC_API_KEY")).toBe("sk-ant-123");
        secrets.remove("ANTHROPIC_API_KEY");
        expect(secrets.get("ANTHROPIC_API_KEY")).toBeNull();
        db.close();
    });

    it("refuses unknown names, bad values, and insecure storage", () => {
        const db = openDatabase(":memory:");
        const secrets = createSecretStore({ db, safeStorage: fakeSafeStorage(), platform: "darwin" });
        expect(() => secrets.set("PATH" as never, "x")).toThrow("Unknown API key name");
        expect(() => secrets.set("OPENAI_API_KEY", "has space")).toThrow();
        expect(() => secrets.set("OPENAI_API_KEY", "")).toThrow();
        const linux = createSecretStore({ db, safeStorage: fakeSafeStorage({ getSelectedStorageBackend: () => "basic_text" }), platform: "linux" });
        expect(() => linux.set("OPENAI_API_KEY", "sk-1")).toThrow(UNAVAILABLE);
        const none = createSecretStore({ db, safeStorage: fakeSafeStorage({ isEncryptionAvailable: () => false }), platform: "win32" });
        expect(() => none.set("OPENAI_API_KEY", "sk-1")).toThrow(UNAVAILABLE);
        db.close();
    });

    it("keeps internal slots out of the list and out of the renderer-facing methods", () => {
        const db = openDatabase(":memory:");
        const secrets = createSecretStore({ db, safeStorage: fakeSafeStorage(), platform: "darwin" });
        secrets.setInternal("OPENNAN_STUDIO_SESSION", '{"apiKey":"sk-x"}');
        expect(secrets.getInternal("OPENNAN_STUDIO_SESSION")).toBe('{"apiKey":"sk-x"}');
        expect(secrets.list().map((s) => s.name)).not.toContain("OPENNAN_STUDIO_SESSION");
        expect(secrets.get("OPENNAN_STUDIO_SESSION" as never)).toBeNull();
        expect(() => secrets.set("OPENNAN_STUDIO_SESSION" as never, "x")).toThrow("Unknown API key name");
        expect(() => secrets.remove("OPENNAN_STUDIO_SESSION" as never)).toThrow("Unknown API key name");
        expect(() => secrets.setInternal("OPENAI_API_KEY" as never, "x")).toThrow("Unknown internal secret");
        const raw = db.prepare("select cipher from secrets where name = ?").get("OPENNAN_STUDIO_SESSION") as { cipher: Buffer };
        expect(raw.cipher.toString("utf8")).not.toContain("sk-x");
        secrets.removeInternal("OPENNAN_STUDIO_SESSION");
        expect(secrets.getInternal("OPENNAN_STUDIO_SESSION")).toBeNull();
        db.close();
    });

    it("reports whether storage is secure (Linux basic_text is not)", () => {
        const db = openDatabase(":memory:");
        expect(createSecretStore({ db, safeStorage: fakeSafeStorage(), platform: "darwin" }).isSecure()).toBe(true);
        const linux = createSecretStore({ db, safeStorage: fakeSafeStorage({ getSelectedStorageBackend: () => "basic_text" }), platform: "linux" });
        expect(linux.isSecure()).toBe(false);
        expect(() => linux.setInternal("OPENNAN_STUDIO_SESSION", "x")).toThrow(UNAVAILABLE);
        db.close();
    });
});
