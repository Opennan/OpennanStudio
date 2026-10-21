import { ProviderRegistry } from "./registry";
import { capabilityGate } from "./ui";

describe("capabilityGate (capability-gated UI)", () => {
    it("explains a missing open capability", () => {
        expect(capabilityGate(new ProviderRegistry(), "audio.transcribe", "Auto captions")).toEqual({
            available: false,
            reason: "needs-provider",
            message: "Auto captions requires a provider with the audio.transcribe capability. Connect OpenNan or another provider that offers it.",
        });
        expect(capabilityGate(null, "audio.transcribe")).toMatchObject({ available: false, reason: "needs-provider" });
    });

    it("asks to connect OpenNan for exclusive capabilities", () => {
        expect(capabilityGate(undefined, "opennan.story.storyboard", "Storyboard"))
            .toEqual({ available: false, reason: "connect-opennan", message: "Connect OpenNan to use Storyboard." });
    });

    it("names the routed provider", () => {
        const registry = new ProviderRegistry();
        registry.register({ info: { id: "local", name: "On this device", capabilities: ["audio.transcribe"] } });
        expect(capabilityGate(registry, "audio.transcribe")).toEqual({ available: true, providerId: "local", providerName: "On this device" });
    });
});
