import { CapabilityUnavailableError, ProviderRegistrationError } from "./errors";
import { ProviderRegistry } from "./registry";
import type { Provider } from "./types";
import type { ProviderCapability } from "./capabilities";

const provider = (id: string, capabilities: string[], name = id): Provider => ({ info: { id, name, capabilities: capabilities as ProviderCapability[] } });

describe("ProviderRegistry (spec §5.4)", () => {
    it("refuses opennan.* capabilities from any provider but opennan (spec §2.1)", () => {
        const registry = new ProviderRegistry();
        expect(() => registry.register(provider("fal", ["video.text-to-video", "opennan.qc"]))).toThrow(ProviderRegistrationError);
        expect(() => registry.register(provider("fal", ["opennan.qc"]))).toThrow(/opennan\.qc.*§2\.1/);
        expect(registry.providers()).toEqual([]);
        registry.register(provider("opennan", ["opennan.qc", "audio.tts"]));
        expect(registry.route("opennan.qc")?.info.id).toBe("opennan");
    });

    it("refuses unknown capabilities, runtime features, empty ids, and duplicate ids", () => {
        const registry = new ProviderRegistry();
        expect(() => registry.register(provider("x", ["audio.everything"]))).toThrow(ProviderRegistrationError);
        expect(() => registry.register(provider("x", ["provider.jobs"]))).toThrow(ProviderRegistrationError);
        expect(() => registry.register(provider("", ["audio.tts"]))).toThrow(ProviderRegistrationError);
        registry.register(provider("local", ["audio.transcribe"]));
        expect(() => registry.register(provider("local", ["audio.tts"]))).toThrow(/already registered/);
    });

    it("routes: override, then opennan, then the first registered", () => {
        const registry = new ProviderRegistry();
        registry.register(provider("local", ["audio.transcribe"]));
        registry.register(provider("fal", ["audio.transcribe", "audio.tts"]));
        expect(registry.route("audio.transcribe")?.info.id).toBe("local");
        const unregisterOpenNan = registry.register(provider("opennan", ["audio.transcribe"]));
        expect(registry.route("audio.transcribe")?.info.id).toBe("opennan");
        registry.setRoute("audio.transcribe", "fal");
        expect(registry.route("audio.transcribe")?.info.id).toBe("fal");
        registry.setRoute("audio.transcribe", "missing");
        expect(registry.route("audio.transcribe")?.info.id).toBe("opennan");
        registry.setRoute("audio.transcribe", "fal");
        registry.unregister("fal");
        expect(registry.route("audio.transcribe")?.info.id).toBe("opennan");
        unregisterOpenNan();
        expect(registry.route("audio.transcribe")?.info.id).toBe("local");
        registry.setRoute("audio.transcribe", null);
        expect(registry.get("local")?.info.name).toBe("local");
        expect(registry.route("image.generate")).toBeNull();
        expect(registry.has("audio.transcribe")).toBe(true);
        expect(registry.has("image.generate")).toBe(false);
    });

    it("ignores an override to a provider that does not declare the capability", () => {
        const registry = new ProviderRegistry();
        registry.register(provider("local", ["audio.transcribe"]));
        registry.register(provider("fal", ["audio.tts"]));
        registry.setRoute("audio.transcribe", "fal");
        expect(registry.route("audio.transcribe")?.info.id).toBe("local");
    });

    it("require() throws CapabilityUnavailableError with the §5.4 guidance", () => {
        const registry = new ProviderRegistry();
        expect(() => registry.require("audio.transcribe")).toThrow(CapabilityUnavailableError);
        try {
            registry.require("audio.transcribe");
        } catch (error) {
            expect((error as CapabilityUnavailableError).reason).toBe("needs-provider");
            expect((error as Error).message).toMatch(/requires a provider with the audio\.transcribe capability/);
        }
        try {
            registry.require("opennan.qc");
        } catch (error) {
            expect((error as CapabilityUnavailableError).reason).toBe("connect-opennan");
        }
        registry.register(provider("local", ["audio.transcribe"]));
        expect(registry.require("audio.transcribe").info.id).toBe("local");
    });

    it("notifies subscribers on register, unregister, and setRoute", () => {
        const registry = new ProviderRegistry();
        const listener = vi.fn();
        const stop = registry.subscribe(listener);
        const unregister = registry.register(provider("local", ["audio.transcribe"]));
        registry.setRoute("audio.transcribe", "local");
        unregister();
        unregister();
        expect(listener).toHaveBeenCalledTimes(3);
        expect(registry.version()).toBe(3);
        stop();
        registry.register(provider("fal", ["audio.tts"]));
        expect(listener).toHaveBeenCalledTimes(3);
    });

    it("copies the provider list it returns", () => {
        const registry = new ProviderRegistry();
        registry.register(provider("local", ["audio.transcribe"]));
        registry.providers().pop();
        expect(registry.providers()).toHaveLength(1);
    });

    it("routes on the capabilities checked at register(), not on later changes to info", () => {
        const registry = new ProviderRegistry();
        const sneaky = provider("fal", ["audio.tts"]);
        registry.register(sneaky);
        (sneaky.info.capabilities as string[]).push("opennan.qc", "audio.transcribe");
        expect(registry.route("opennan.qc")).toBeNull();
        expect(registry.route("audio.transcribe")).toBeNull();
        expect(registry.route("audio.tts")?.info.id).toBe("fal");
    });
});

describe("ProviderRegistry OpenNan-default switch (phase 8)", () => {
    it("routes open capabilities away from opennan when the switch is off, but keeps opennan.* and explicit picks", () => {
        const registry = new ProviderRegistry();
        registry.register(provider("opennan", ["image.generate", "opennan.qc"]));
        expect(registry.openNanDefault()).toBe(true);
        expect(registry.route("image.generate")?.info.id).toBe("opennan");
        const before = registry.version();
        const changes = vi.fn();
        registry.subscribe(changes);
        registry.setOpenNanDefault(false);
        expect(registry.openNanDefault()).toBe(false);
        expect(changes).toHaveBeenCalledTimes(1);
        expect(registry.version()).toBeGreaterThan(before);
        expect(registry.route("image.generate")).toBeNull();
        expect(registry.route("opennan.qc")?.info.id).toBe("opennan");
        registry.register(provider("fal", ["image.generate"]));
        expect(registry.route("image.generate")?.info.id).toBe("fal");
        registry.setRoute("image.generate", "opennan");
        expect(registry.route("image.generate")?.info.id).toBe("opennan");
        registry.setRoute("image.generate", null);
        registry.setOpenNanDefault(true);
        expect(registry.route("image.generate")?.info.id).toBe("opennan");
    });

    it("does not notify when the switch does not change", () => {
        const registry = new ProviderRegistry();
        const changes = vi.fn();
        registry.subscribe(changes);
        registry.setOpenNanDefault(true);
        expect(changes).not.toHaveBeenCalled();
    });
});

describe("ProviderRegistry phase 11 routing", () => {
    const device = (id: string, capabilities: string[]): Provider => ({ info: { id, name: id, capabilities: capabilities as ProviderCapability[], onDevice: true } });

    it("routes on-device-first capabilities to an on-device provider over opennan, unless overridden", () => {
        const registry = new ProviderRegistry();
        registry.register(provider("opennan", ["audio.transcribe", "image.generate"]));
        expect(registry.route("audio.transcribe")?.info.id).toBe("opennan");
        registry.register(device("local", ["audio.transcribe", "image.generate"]));
        expect(registry.route("audio.transcribe")?.info.id).toBe("local");
        // Only on-device-first capabilities: image.generate stays on opennan.
        expect(registry.route("image.generate")?.info.id).toBe("opennan");
        registry.setRoute("audio.transcribe", "opennan");
        expect(registry.route("audio.transcribe")?.info.id).toBe("opennan");
        registry.setRoute("audio.transcribe", null);
        registry.setOpenNanDefault(false);
        expect(registry.route("audio.transcribe")?.info.id).toBe("local");
    });

    it("does not treat a provider without onDevice as on-device", () => {
        const registry = new ProviderRegistry();
        registry.register(provider("local", ["audio.transcribe"]));
        registry.register(provider("opennan", ["audio.transcribe"]));
        expect(registry.route("audio.transcribe")?.info.id).toBe("opennan");
    });

    it("refuses local-only capabilities from opennan", () => {
        const registry = new ProviderRegistry();
        expect(() => registry.register(provider("opennan", ["image.generate", "media.stabilize"]))).toThrow(/media\.stabilize/);
        expect(registry.providers()).toEqual([]);
        registry.register(device("local-media", ["media.stabilize"]));
        expect(registry.route("media.stabilize")?.info.id).toBe("local-media");
    });

    it("providerFor picks the first provider declaring a capability with the asked onDevice flag", () => {
        const registry = new ProviderRegistry();
        registry.register(provider("fal", ["audio.transcribe"]));
        registry.register(provider("opennan", ["audio.transcribe"]));
        expect(registry.providerFor("audio.transcribe", { onDevice: true })).toBeNull();
        expect(registry.providerFor("audio.transcribe", { onDevice: false })?.info.id).toBe("fal");
        registry.register(device("local", ["audio.transcribe"]));
        expect(registry.providerFor("audio.transcribe", { onDevice: true })?.info.id).toBe("local");
        expect(registry.providerFor("image.generate", { onDevice: false })).toBeNull();
    });
});
