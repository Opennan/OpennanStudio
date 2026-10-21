import { openDatabase } from "./database";
import { MIN_CACHE_LIMIT_BYTES as SHARED_MIN } from "@opennan/cloud-backend";
import { DEFAULT_CACHE_LIMIT_BYTES, MAX_CACHE_LIMIT_BYTES, MIN_CACHE_LIMIT_BYTES } from "../../shared/settings";
import { createSettingsStore } from "./settings";

describe("settings", () => {
    it("returns defaults and persists validated patches", () => {
        const db = openDatabase(":memory:");
        const settings = createSettingsStore(db);
        expect(settings.get()).toEqual({
            mcpPort: 4319, terminalCustomCommand: "", terminalDefaultProfile: "shell", providerRouting: { overrides: {}, opennanDefault: true }, signInPrompted: false, cloudCacheLimitBytes: null,
            agentSharesWithoutAsking: false,
        });
        expect(settings.update({ mcpPort: 5000, terminalDefaultProfile: "claude" })).toMatchObject({ mcpPort: 5000, terminalDefaultProfile: "claude" });
        expect(createSettingsStore(db).get().mcpPort).toBe(5000);
        expect(() => settings.update({ mcpPort: 80 })).toThrow();
        expect(() => settings.update({ evil: true })).toThrow();
        expect(() => settings.update({ terminalDefaultProfile: "rm -rf /" })).toThrow();
        db.close();
    });

    it("asks before an agent's share link by default; the person can turn asking off (9c.1)", () => {
        const db = openDatabase(":memory:");
        const settings = createSettingsStore(db);
        expect(settings.get().agentSharesWithoutAsking).toBe(false);
        expect(settings.update({ agentSharesWithoutAsking: true }).agentSharesWithoutAsking).toBe(true);
        expect(createSettingsStore(db).get().agentSharesWithoutAsking).toBe(true);
        expect(() => settings.update({ agentSharesWithoutAsking: "yes" })).toThrow();
        db.close();
    });

    it("is read once and changed only through update: a write to the database file behind the app's back is not seen (review 9c.1)", () => {
        const db = openDatabase(":memory:");
        const settings = createSettingsStore(db);
        db.prepare("insert into settings (key, value) values ('agentSharesWithoutAsking', 'true') on conflict(key) do update set value = excluded.value").run();
        expect(settings.get().agentSharesWithoutAsking).toBe(false);
        expect(settings.update({ mcpPort: 5001 }).agentSharesWithoutAsking).toBe(false);
        expect(settings.get()).not.toBe(settings.get());
        db.close();
    });

    it("falls back to defaults for damaged rows", () => {
        const db = openDatabase(":memory:");
        db.prepare("insert into settings values ('mcpPort', 'not json'), ('terminalDefaultProfile', '\"bogus\"')").run();
        expect(createSettingsStore(db).get()).toMatchObject({ mcpPort: 4319, terminalDefaultProfile: "shell" });
        db.close();
    });

    it("keeps provider routing and the sign-in prompt flag", () => {
        const db = openDatabase(":memory:");
        const settings = createSettingsStore(db);
        settings.update({ providerRouting: { overrides: { "image.generate": "fal" }, opennanDefault: false }, signInPrompted: true });
        expect(createSettingsStore(db).get()).toMatchObject({ providerRouting: { overrides: { "image.generate": "fal" }, opennanDefault: false }, signInPrompted: true });
        expect(() => settings.update({ providerRouting: { overrides: { "image.generate": "Bad Id" }, opennanDefault: true } })).toThrow();
        expect(() => settings.update({ providerRouting: { overrides: {}, opennanDefault: true, extra: 1 } })).toThrow();
        db.close();
    });

    it("keeps the cloud media cache limit (null: the default), within 256 MiB .. 1024 GB; databases without it read null", () => {
        const db = openDatabase(":memory:");
        const settings = createSettingsStore(db);
        expect(settings.get().cloudCacheLimitBytes).toBeNull();
        expect(settings.update({ cloudCacheLimitBytes: 5 * 1024 ** 3 }).cloudCacheLimitBytes).toBe(5 * 1024 ** 3);
        expect(createSettingsStore(db).get().cloudCacheLimitBytes).toBe(5 * 1024 ** 3);
        expect(settings.update({ cloudCacheLimitBytes: null }).cloudCacheLimitBytes).toBeNull();
        expect(() => settings.update({ cloudCacheLimitBytes: 1024 })).toThrow();
        expect(() => settings.update({ cloudCacheLimitBytes: 1025 * 1024 ** 3 })).toThrow();
        expect(() => settings.update({ cloudCacheLimitBytes: 1.5 * 1024 ** 3 + 0.5 })).toThrow();
        db.prepare("update settings set value = '\"lots\"' where key = 'cloudCacheLimitBytes'").run();
        expect(createSettingsStore(db).get().cloudCacheLimitBytes).toBeNull();
        db.close();
    });

    it("uses the cloud-backend's smallest cache limit", () => {
        expect(MIN_CACHE_LIMIT_BYTES).toBe(SHARED_MIN);
        expect(DEFAULT_CACHE_LIMIT_BYTES).toBe(10 * 1024 ** 3);
        expect(MAX_CACHE_LIMIT_BYTES).toBe(1024 * 1024 ** 3);
    });
});
