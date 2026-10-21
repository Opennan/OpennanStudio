// Capability-gated UI (spec §5.4): features stay visible and explain what they need instead of hiding.
// Framework-free: hosts wrap capabilityGate in their own store hook.
import { capabilityUnavailableMessage, isOpenNanCapability, type ProviderCapability } from "./capabilities";
import type { UnavailableReason } from "./errors";
import type { ProviderRegistry } from "./registry";

export type CapabilityGate =
    | { available: true; providerId: string; providerName: string }
    | { available: false; reason: UnavailableReason; message: string };

export function capabilityGate(registry: ProviderRegistry | null | undefined, capability: ProviderCapability, feature: string = capability): CapabilityGate {
    const provider = registry?.route(capability) ?? null;
    if (provider) return { available: true, providerId: provider.info.id, providerName: provider.info.name };
    return {
        available: false,
        reason: isOpenNanCapability(capability) ? "connect-opennan" : "needs-provider",
        message: capabilityUnavailableMessage(feature, capability),
    };
}
