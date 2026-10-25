// Typed settings in the `settings` table (one JSON value per key, defaults for missing keys). Read once when the app
// starts and changed only through update (9c.1 review): a write to the database file behind the app's back (an agent
// with a shell) is not seen while the app runs. Rows of keys the app no longer has are ignored.
import { DEFAULT_SETTINGS, SettingsPatchSchema, SettingsSchema, type DesktopSettings } from "../../shared/settings";
import type { DesktopDatabase } from "./database";

export interface SettingsStore {
    get(): DesktopSettings;
    update(patch: unknown): DesktopSettings;
}

export function createSettingsStore(db: DesktopDatabase): SettingsStore {
    const all = db.prepare("select key, value from settings");
    const put = db.prepare("insert into settings (key, value) values (?, ?) on conflict(key) do update set value = excluded.value");
    const read = (): DesktopSettings => {
        const stored: Record<string, unknown> = {};
        for (const row of all.all() as Array<{ key: string; value: string }>) {
            if (!(row.key in DEFAULT_SETTINGS)) continue;
            try {
                stored[row.key] = JSON.parse(row.value);
            } catch {
                // a damaged value falls back to its default
            }
        }
        const merged = { ...DEFAULT_SETTINGS };
        for (const key of Object.keys(DEFAULT_SETTINGS) as Array<keyof DesktopSettings>) {
            const candidate = { ...merged, [key]: stored[key] ?? merged[key] };
            if (SettingsSchema.safeParse(candidate).success) Object.assign(merged, { [key]: candidate[key] });
        }
        return merged;
    };
    let current = read();
    const copy = (): DesktopSettings => structuredClone(current);
    return {
        get: copy,
        update(patch) {
            const parsed = SettingsPatchSchema.parse(patch);
            db.transaction(() => {
                for (const [key, value] of Object.entries(parsed)) put.run(key, JSON.stringify(value));
            })();
            current = SettingsSchema.parse({ ...current, ...parsed });
            return copy();
        },
    };
}
