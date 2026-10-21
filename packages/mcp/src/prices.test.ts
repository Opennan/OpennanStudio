import { ProviderRegistry, type Provider, type ProviderCapability } from "@opennan/provider-sdk";
import { formatBalance, formatUsd, priceOnRegistry, voicesOnRegistry } from "./prices";

function provider(id: string, capabilities: ProviderCapability[], extra: Partial<Provider> = {}, onDevice = false): Provider {
    return { info: { id, name: id.toUpperCase(), capabilities, ...(onDevice ? { onDevice: true } : {}) }, ...extra };
}

describe("priceOnRegistry", () => {
    it("asks the routed provider and names it", async () => {
        const registry = new ProviderRegistry();
        const asked: unknown[] = [];
        registry.register(provider("opennan", ["audio.isolate-voice", "audio.transcribe"], {
            price: async (request) => {
                asked.push(request);
                return { kind: "estimate", estimate: { microUsd: 130001, usd: 0.130001, label: "≈ $0.131", units: 1, capped: false } };
            },
        }));
        const reply = await priceOnRegistry(registry, { capability: "audio.isolate-voice", input: { source: { mediaUrl: "https://x/a.wav" } }, units: { seconds: 15 } });
        expect(reply).toMatchObject({ kind: "estimate", providerName: "OPENNAN", priced: true });
        expect(asked).toEqual([{ capability: "audio.isolate-voice", input: { source: { mediaUrl: "https://x/a.wav" } }, units: { seconds: 15 } }]);
    });

    it("answers free on the device, unknown without prices or on errors, unavailable without a provider", async () => {
        const registry = new ProviderRegistry();
        registry.register(provider("local", ["audio.transcribe"], {}, true));
        registry.register(provider("opennan", ["audio.transcribe", "audio.tts"], { price: async () => { throw new Error("offline"); } }));
        registry.register(provider("fal", ["video.upscale"]));
        expect(await priceOnRegistry(registry, { capability: "audio.transcribe", input: {}, units: {}, engine: "local" })).toEqual({ kind: "free", providerName: "LOCAL" });
        expect(await priceOnRegistry(registry, { capability: "audio.transcribe", input: {}, units: {}, engine: "cloud" })).toEqual({ kind: "unknown", reason: "offline", providerName: "OPENNAN", priced: true });
        expect(await priceOnRegistry(registry, { capability: "video.upscale", input: {}, units: {} })).toEqual({ kind: "unknown", providerName: "FAL" });
        expect((await priceOnRegistry(registry, { capability: "audio.isolate-voice", input: {}, units: {} })).kind).toBe("unavailable");
        expect((await priceOnRegistry(registry, { capability: "nope", input: {}, units: {} })).kind).toBe("unknown");
    });
});

describe("voicesOnRegistry and formatUsd", () => {
    it("lists the speech provider's voices, null without one", async () => {
        const registry = new ProviderRegistry();
        expect(await voicesOnRegistry(registry)).toBeNull();
        registry.register(provider("opennan", ["audio.tts"], { voices: async () => [{ id: "heart", name: "Heart", language: "en-US" }] }));
        expect(await voicesOnRegistry(registry)).toEqual([{ id: "heart", name: "Heart", language: "en-US" }]);
    });

    it("prints charges without trailing zeros", () => {
        expect(formatUsd(0.13)).toBe("$0.13");
        expect(formatUsd(0.00936)).toBe("$0.00936");
        expect(formatUsd(2)).toBe("$2.00");
        expect(formatUsd(0)).toBe("$0.00");
    });

    it("rounds a charge up to the micro-dollar and a balance down to the cent (phase 9c)", () => {
        expect(formatUsd(0.0000001)).toBe("$0.000001");
        expect(formatUsd(0.1300004)).toBe("$0.130001");
        expect(formatUsd(-1)).toBe("$0.00");
        for (let i = 1; i < 3_000; i++) {
            const usd = (i * 104_729) / 1_000_000_000;
            expect(Number(formatUsd(usd).slice(1)) + 1e-12).toBeGreaterThanOrEqual(usd);
        }
        expect(formatBalance(12.459)).toBe("$12.45");
        expect(formatBalance(12.4)).toBe("$12.40");
        expect(formatBalance(-2)).toBe("$0.00");
    });
});
