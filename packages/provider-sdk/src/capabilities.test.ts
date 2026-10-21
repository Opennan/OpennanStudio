import {
    OPEN_CAPABILITIES, OPENNAN_CAPABILITIES, PROVIDER_RUNTIME_CAPABILITIES, capabilityUnavailableMessage,
    isOpenNanCapability, isProviderCapability, isProviderRuntimeCapability, isToolCapability,
} from "./capabilities";
import { CapabilityUnavailableError } from "./errors";

describe("capabilities (spec §5.4)", () => {
    it("lists the §5.4 open capabilities first, then phase 5's provisional ones", () => {
        expect(OPEN_CAPABILITIES.slice(0, 12)).toEqual([
            "video.text-to-video", "video.image-to-video", "video.lipsync", "image.generate", "image.edit", "image.remove-background",
            "audio.tts", "audio.voice-clone", "audio.music", "audio.sfx", "audio.transcribe", "render.export",
        ]);
        expect(OPEN_CAPABILITIES).toContain("graphics.templates");
        expect(OPENNAN_CAPABILITIES.every((c) => c.startsWith("opennan."))).toBe(true);
        const all = [...OPEN_CAPABILITIES, ...OPENNAN_CAPABILITIES, ...PROVIDER_RUNTIME_CAPABILITIES];
        expect(new Set(all).size).toBe(all.length);
    });

    it("separates routing capabilities from runtime features", () => {
        expect(isProviderCapability("audio.transcribe")).toBe(true);
        expect(isProviderCapability("opennan.qc")).toBe(true);
        expect(isProviderCapability("provider.jobs")).toBe(false);
        expect(isToolCapability("provider.jobs")).toBe(true);
        expect(isProviderRuntimeCapability("provider.estimate")).toBe(true);
        expect(isOpenNanCapability("opennan.qc")).toBe(true);
        expect(isOpenNanCapability("audio.tts")).toBe(false);
        expect(isToolCapability("audio")).toBe(false);
        expect(PROVIDER_RUNTIME_CAPABILITIES).toEqual(["provider.jobs", "provider.estimate"]);
    });

    it("words the guidance like phase 5", () => {
        expect(capabilityUnavailableMessage("qc_check", "opennan.qc")).toBe("Connect OpenNan to use qc_check.");
        expect(capabilityUnavailableMessage("Auto captions", "audio.transcribe"))
            .toBe("Auto captions requires a provider with the audio.transcribe capability. Connect OpenNan or another provider that offers it.");
        expect(capabilityUnavailableMessage("estimate_cost", "provider.estimate"))
            .toBe("estimate_cost needs a connected provider. Connect OpenNan or another provider.");
    });
});

describe("CapabilityUnavailableError", () => {
    it("carries the capability, the reason, and the guidance", () => {
        const open = new CapabilityUnavailableError("audio.transcribe");
        expect(open).toBeInstanceOf(Error);
        expect(open.name).toBe("CapabilityUnavailableError");
        expect(open.capability).toBe("audio.transcribe");
        expect(open.reason).toBe("needs-provider");
        expect(open.message).toBe(capabilityUnavailableMessage("audio.transcribe", "audio.transcribe"));
        const exclusive = new CapabilityUnavailableError("opennan.qc", "QC");
        expect(exclusive.reason).toBe("connect-opennan");
        expect(exclusive.message).toBe("Connect OpenNan to use QC.");
    });
});
