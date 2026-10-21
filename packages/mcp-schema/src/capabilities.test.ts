import {
    OPENNAN_CAPABILITIES, OPEN_CAPABILITIES, PROVIDER_RUNTIME_CAPABILITIES, capabilityUnavailableMessage, isOpenNanCapability,
    isProviderRuntimeCapability, isToolCapability,
} from "./capabilities";

describe("capabilities", () => {
    it("keeps the spec §5.4 lists, OpenNan-exclusive ids under opennan.*, and runtime ids apart", () => {
        expect(OPEN_CAPABILITIES).toEqual(expect.arrayContaining(["video.text-to-video", "audio.tts", "render.export"]));
        expect(OPENNAN_CAPABILITIES.every((c) => c.startsWith("opennan."))).toBe(true);
        expect(OPEN_CAPABILITIES.some((c) => c.startsWith("opennan.") || c.startsWith("provider."))).toBe(false);
        expect(PROVIDER_RUNTIME_CAPABILITIES).toEqual(["provider.jobs", "provider.estimate"]);
        const all = [...OPEN_CAPABILITIES, ...OPENNAN_CAPABILITIES, ...PROVIDER_RUNTIME_CAPABILITIES];
        expect(new Set(all).size).toBe(all.length);
    });

    it("recognizes capability ids", () => {
        expect(isToolCapability("media.analyze")).toBe(true);
        expect(isToolCapability("opennan.qc")).toBe(true);
        expect(isToolCapability("provider.jobs")).toBe(true);
        expect(isToolCapability("video")).toBe(false);
        expect(isOpenNanCapability("opennan.qc")).toBe(true);
        expect(isOpenNanCapability("audio.tts")).toBe(false);
        expect(isProviderRuntimeCapability("provider.estimate")).toBe(true);
        expect(isProviderRuntimeCapability("audio.tts")).toBe(false);
    });

    it("words the unavailable guidance like the UI (spec §5.4)", () => {
        expect(capabilityUnavailableMessage("qc_check", "opennan.qc")).toBe("Connect OpenNan to use qc_check.");
        expect(capabilityUnavailableMessage("generate_tts", "audio.tts"))
            .toBe("generate_tts requires a provider with the audio.tts capability. Connect OpenNan or another provider that offers it.");
        expect(capabilityUnavailableMessage("estimate_cost", "provider.estimate"))
            .toBe("estimate_cost needs a connected provider. Connect OpenNan or another provider.");
    });
});
