// Capability-gated UI (spec §5.4) for React: the gate of one capability, re-read whenever the registry changes.
import { useMemo, useSyncExternalStore } from "react";
import { capabilityGate, type CapabilityGate, type ProviderCapability, type ProviderRegistry } from "@opennan/provider-sdk";

export function useCapability(registry: ProviderRegistry, capability: ProviderCapability, feature: string): CapabilityGate {
    const version = useSyncExternalStore(
        (onChange) => registry.subscribe(onChange),
        () => registry.version(),
    );
    return useMemo(() => capabilityGate(registry, capability, feature), [registry, capability, feature, version]);
}
