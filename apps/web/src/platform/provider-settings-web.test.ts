import { createWebAccountStorage, memoryKeyValue } from "./account-storage";
import { ROUTING_KEY, createWebProviderSettings } from "./provider-settings-web";

function prefs(initial: Record<string, string> = {}) {
    const data = new Map(Object.entries(initial));
    return { data, getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
}

describe("web provider settings", () => {
    it("persists routing in localStorage and survives damaged JSON", async () => {
        const preferences = prefs();
        const storage = createWebAccountStorage({ persistent: memoryKeyValue(), session: memoryKeyValue(), preferences });
        const settings = createWebProviderSettings({ preferences, storage });
        expect(settings.routing()).toEqual({ overrides: {}, opennanDefault: true });
        const changes = vi.fn();
        settings.subscribe(changes);
        await settings.setRouting({ overrides: { "image.generate": "fal" }, opennanDefault: false });
        expect(changes).toHaveBeenCalled();
        expect(JSON.parse(preferences.data.get(ROUTING_KEY)!)).toEqual({ overrides: { "image.generate": "fal" }, opennanDefault: false });
        expect(createWebProviderSettings({ preferences, storage }).routing()).toEqual({ overrides: { "image.generate": "fal" }, opennanDefault: false });
        expect(createWebProviderSettings({ preferences: prefs({ [ROUTING_KEY]: "{oops" }), storage }).routing()).toEqual({ overrides: {}, opennanDefault: true });
    });

    it("keeps bring-your-own keys in the account storage", async () => {
        const persistent = memoryKeyValue();
        const storage = createWebAccountStorage({ persistent, session: memoryKeyValue(), preferences: prefs() });
        const settings = createWebProviderSettings({ preferences: prefs(), storage, keyProviders: [{ id: "fal", name: "fal.ai" }] });
        await settings.ready;
        expect(settings.keys()).toEqual([{ id: "fal", name: "fal.ai", set: false }]);
        await expect(settings.setKey("fal", "short")).rejects.toThrow(/API key/);
        await settings.setKey("fal", " fal-key-0123456789 ");
        expect(persistent.data.get("provider:fal")).toBe("fal-key-0123456789");
        expect(settings.keys()[0]!.set).toBe(true);
        await settings.removeKey("fal");
        expect(persistent.data.has("provider:fal")).toBe(false);
        expect(createWebProviderSettings({ preferences: prefs(), storage }).keys()).toEqual([]);
    });
});
