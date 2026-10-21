// Prices and voices for agents (phase 11): the same figure the editor shows, asked of the provider that would run the
// job (Provider.price, provider-sdk's never-under rule). Hosts with a ProviderRegistry in reach (headless, the web
// controller session, desktop main) answer StudioSession.estimate / voices through these helpers.
import {
    capabilityUnavailableMessage, isProviderCapability, type PriceAnswer, type PriceUnits, type Provider, type ProviderCapability, type ProviderVoice,
} from "@opennan/provider-sdk";

/** One price question: the run as it would be sent (ai.run capability and input) and the units Studio knows. */
export interface PriceQuestion {
    capability: string;
    input: Record<string, unknown>;
    units: PriceUnits;
    /** audio.transcribe: the engine the run asks for (local = an on-device provider, cloud = another one). */
    engine?: "local" | "cloud";
}

/**
 * The provider's answer and the name of the provider that would run the job. `priced`: that provider publishes
 * prices (Provider.price), so an "unknown" answer means its price could not be checked, not that it has none.
 */
export type PriceReply = PriceAnswer & { providerName?: string; priced?: boolean };

/** What the helpers need of a ProviderRegistry. */
export interface PriceRegistry {
    route(capability: ProviderCapability): Provider | null;
    providerFor(capability: ProviderCapability, options: { onDevice: boolean }): Provider | null;
}

function providerOf(registry: PriceRegistry, capability: ProviderCapability, engine: PriceQuestion["engine"]): Provider | null {
    if (capability === "audio.transcribe" && engine) return registry.providerFor(capability, { onDevice: engine === "local" });
    return registry.route(capability);
}

/** Asks the routed provider what a run costs. On-device providers answer free; a provider without prices, unknown. Never rejects. */
export async function priceOnRegistry(registry: PriceRegistry, question: PriceQuestion): Promise<PriceReply> {
    if (!isProviderCapability(question.capability)) return { kind: "unknown", reason: `Unknown capability: ${question.capability}` };
    const capability = question.capability;
    const provider = providerOf(registry, capability, question.engine);
    if (!provider) return { kind: "unavailable", reason: capabilityUnavailableMessage(question.capability, capability) };
    const providerName = provider.info.name;
    if (provider.info.onDevice) return { kind: "free", providerName };
    if (!provider.price) return { kind: "unknown", providerName };
    try {
        return { ...(await provider.price({ capability, input: question.input, units: question.units })), providerName, priced: true };
    } catch (error) {
        return { kind: "unknown", reason: error instanceof Error ? error.message : String(error), providerName, priced: true };
    }
}

/** The routed text-to-speech provider's voices; null when no provider offers speech. */
export async function voicesOnRegistry(registry: Pick<PriceRegistry, "route">): Promise<ProviderVoice[] | null> {
    const provider = registry.route("audio.tts");
    if (!provider) return null;
    if (!provider.voices) return [];
    try {
        return await provider.voices();
    } catch {
        return [];
    }
}

/** "$0.13", "$0.00936": a charge in dollars without trailing zeros, rounded up to the micro-dollar (never shown under it). */
export function formatUsd(usd: number): string {
    const micro = Number.isFinite(usd) ? Math.max(0, Math.ceil(usd * 1_000_000 - 1e-6)) : 0;
    const fixed = (micro / 1_000_000).toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
    const [whole, decimals = ""] = fixed.split(".");
    return `$${whole}.${decimals.padEnd(2, "0")}`;
}

/** "$12.45": a credit balance, rounded down to the cent (never shows credit that isn't there). */
export function formatBalance(usd: number): string {
    const cents = Number.isFinite(usd) ? Math.max(0, Math.floor(Math.round(usd * 1_000_000) / 10_000)) : 0;
    return `$${(cents / 100).toFixed(2)}`;
}
