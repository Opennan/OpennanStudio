import { openDatabase } from "./database";
import { createSettingsStore } from "./settings";

describe("settings", () => {
    it("returns defaults and persists validated patches", () => {
        const db = openDatabase(":memory:");
        const settings = createSettingsStore(db);
        expect(settings.get()).toEqual({
            mcpPort: 4319, terminalCustomCommand: "", terminalDefaultProfile: "shell", providerRouting: { overrides: {}, opennanDefault: true }, signInPrompted: false,
        });
        expect(settings.update({ mcpPort: 5000, terminalDefaultProfile: "claude" })).toMatchObject({ mcpPort: 5000, terminalDefaultProfile: "claude" });
        expect(createSettingsStore(db).get().mcpPort).toBe(5000);
        expect(() => settings.update({ mcpPort: 80 })).toThrow();
        expect(() => settings.update({ evil: true })).toThrow();
        expect(() => settings.update({ terminalDefaultProfile: "rm -rf /" })).toThrow();
        db.close();
    });

    it("is read once and changed only through update: a write to the database file behind the app's back is not seen (review 9c.1)", () => {
        const db = openDatabase(":memory:");
        const settings = createSettingsStore(db);
        db.prepare("insert into settings (key, value) values ('signInPrompted', 'true') on conflict(key) do update set value = excluded.value").run();
        expect(settings.get().signInPrompted).toBe(false);
        expect(settings.update({ mcpPort: 5001 }).signInPrompted).toBe(false);
        expect(settings.get()).not.toBe(settings.get());
        db.close();
    });

    it("ignores rows of settings the app no longer has (the removed cloud cache and share settings)", () => {
        const db = openDatabase(":memory:");
        db.prepare("insert into settings values ('cloudCacheLimitBytes', '1073741824'), ('agentSharesWithoutAsking', 'true')").run();
        expect(createSettingsStore(db).get()).not.toHaveProperty("cloudCacheLimitBytes");
        expect(createSettingsStore(db).get()).not.toHaveProperty("agentSharesWithoutAsking");
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

});
