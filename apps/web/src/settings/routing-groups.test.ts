import { OPEN_CAPABILITIES, OPENNAN_CAPABILITIES, ProviderRegistry, isLocalOnlyCapability } from "@opennan/provider-sdk";
import { memoryProviderSettings } from "../account/account-types";
import { CAPABILITY_LABELS, ROUTING_GROUPS, applyRouting, connectRouting, parseRouting } from "./routing-groups";

describe("routing groups", () => {
    it("puts every routable capability in exactly one group, with a label; story is locked; local-only ones are not listed", () => {
        const all = ROUTING_GROUPS.flatMap((g) => g.capabilities);
        expect([...all].sort()).toEqual([...OPEN_CAPABILITIES.filter((c) => !isLocalOnlyCapability(c)), ...OPENNAN_CAPABILITIES].sort());
        expect(all).not.toContain("media.stabilize");
        expect(new Set(all).size).toBe(all.length);
        for (const capability of all) expect(CAPABILITY_LABELS[capability]).toBeTruthy();
        expect(ROUTING_GROUPS.filter((g) => g.locked).flatMap((g) => g.capabilities)).toEqual([...OPENNAN_CAPABILITIES]);
    });

    it("applies overrides and the OpenNan switch to the registry, following changes", async () => {
        const registry = new ProviderRegistry();
        registry.register({ info: { id: "opennan", name: "OpenNan", capabilities: ["image.generate", "audio.tts", "opennan.qc"] } });
        registry.register({ info: { id: "fal", name: "fal", capabilities: ["image.generate"] } });
        const settings = memoryProviderSettings();
        connectRouting(registry, settings);
        expect(registry.route("image.generate")?.info.id).toBe("opennan");
        await settings.setRouting({ overrides: { "image.generate": "fal" }, opennanDefault: true });
        expect(registry.route("image.generate")?.info.id).toBe("fal");
        await settings.setRouting({ overrides: {}, opennanDefault: false });
        expect(registry.route("image.generate")?.info.id).toBe("fal");
        expect(registry.route("audio.tts")).toBeNull();
        expect(registry.route("opennan.qc")?.info.id).toBe("opennan");
        applyRouting(registry, { overrides: {}, opennanDefault: true });
        expect(registry.route("image.generate")?.info.id).toBe("opennan");
    });

    it("parses saved routing defensively", () => {
        expect(parseRouting(null)).toEqual({ overrides: {}, opennanDefault: true });
        expect(parseRouting({ overrides: { "image.generate": "fal", "opennan.qc": "fal", "nope": "x", "audio.tts": "Bad Id!" }, opennanDefault: false }))
            .toEqual({ overrides: { "image.generate": "fal" }, opennanDefault: false });
    });
});
