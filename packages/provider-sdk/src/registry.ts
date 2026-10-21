// ProviderRegistry (spec §5.4): holds installed providers and routes each capability to one of them.
// Routing: the user's override for the capability, then (phase 11) an on-device provider for the on-device-first
// capabilities (audio.transcribe), then "opennan" when it declares the capability, then the first registered
// provider that does. Only provider id "opennan" may declare opennan.* (spec §2.1); opennan never declares the
// local-only capabilities (media.stabilize).
import { isLocalOnlyCapability, isOnDeviceFirstCapability, isOpenNanCapability, isProviderCapability, type ProviderCapability } from "./capabilities";
// With the OpenNan-default switch off (Settings → "Use OpenNan by default"), open capabilities route only to the
// user's override or to a provider other than opennan; opennan.* capabilities always route to opennan.
import { CapabilityUnavailableError, ProviderRegistrationError } from "./errors";
import type { Provider } from "./types";

export const OPENNAN_PROVIDER_ID = "opennan";

export class ProviderRegistry {
    private readonly list: Provider[] = [];
    /** Capabilities as checked at register(): routing never reads a provider's (mutable) info again. */
    private readonly declared = new Map<string, readonly ProviderCapability[]>();
    /** ProviderInfo.onDevice as read at register(). */
    private readonly onDevice = new Map<string, boolean>();
    private readonly routes = new Map<ProviderCapability, string>();
    private readonly listeners = new Set<() => void>();
    private changes = 0;
    private preferOpenNan = true;

    /** Adds a provider; returns its unregister function. Throws ProviderRegistrationError. */
    register(provider: Provider): () => void {
        const { id, capabilities } = provider.info;
        if (typeof id !== "string" || id.trim() === "") throw new ProviderRegistrationError("A provider needs a non-empty id.");
        if (this.list.some((p) => p.info.id === id)) throw new ProviderRegistrationError(`A provider with id "${id}" is already registered.`);
        for (const capability of capabilities) {
            if (!isProviderCapability(capability)) throw new ProviderRegistrationError(`Provider "${id}" declares an unknown capability: ${String(capability)}.`);
            if (isOpenNanCapability(capability) && id !== OPENNAN_PROVIDER_ID) {
                throw new ProviderRegistrationError(`Only the OpenNan provider may offer ${capability} (spec §2.1); provider "${id}" cannot register it.`);
            }
            if (isLocalOnlyCapability(capability) && id === OPENNAN_PROVIDER_ID) {
                throw new ProviderRegistrationError(`${capability} runs only on this device; the OpenNan provider cannot register it.`);
            }
        }
        this.declared.set(id, Object.freeze([...capabilities]));
        this.onDevice.set(id, provider.info.onDevice === true);
        this.list.push(provider);
        this.changed();
        return () => this.unregister(id);
    }

    unregister(id: string): void {
        const index = this.list.findIndex((p) => p.info.id === id);
        if (index < 0) return;
        this.list.splice(index, 1);
        this.declared.delete(id);
        this.onDevice.delete(id);
        this.changed();
    }

    providers(): Provider[] {
        return [...this.list];
    }

    get(id: string): Provider | undefined {
        return this.list.find((p) => p.info.id === id);
    }

    /** The user's choice for one capability; null clears it. */
    setRoute(capability: ProviderCapability, providerId: string | null): void {
        if (providerId === null) this.routes.delete(capability);
        else this.routes.set(capability, providerId);
        this.changed();
    }

    /** On (the default): opennan serves every capability it declares unless overridden. Off: only opennan.* and explicit picks. */
    setOpenNanDefault(on: boolean): void {
        if (this.preferOpenNan === on) return;
        this.preferOpenNan = on;
        this.changed();
    }

    openNanDefault(): boolean {
        return this.preferOpenNan;
    }

    route(capability: ProviderCapability): Provider | null {
        const offers = (p: Provider | undefined): p is Provider => Boolean(p && this.declared.get(p.info.id)?.includes(capability));
        const chosen = this.routes.get(capability);
        const override = chosen === undefined ? undefined : this.get(chosen);
        if (offers(override)) return override;
        if (isOnDeviceFirstCapability(capability)) {
            const device = this.list.find((p) => this.onDevice.get(p.info.id) === true && offers(p));
            if (device) return device;
        }
        const opennan = this.get(OPENNAN_PROVIDER_ID);
        if (this.preferOpenNan || isOpenNanCapability(capability)) {
            if (offers(opennan)) return opennan;
            return this.list.find(offers) ?? null;
        }
        return this.list.find((p) => p.info.id !== OPENNAN_PROVIDER_ID && offers(p)) ?? null;
    }

    /** The first registered provider declaring the capability that runs (or not) on this device: a per-run engine pick. */
    providerFor(capability: ProviderCapability, options: { onDevice: boolean }): Provider | null {
        return this.list.find((p) => (this.onDevice.get(p.info.id) === true) === options.onDevice && Boolean(this.declared.get(p.info.id)?.includes(capability))) ?? null;
    }

    has(capability: ProviderCapability): boolean {
        return this.route(capability) !== null;
    }

    /** The routed provider; throws CapabilityUnavailableError (shown as guidance) when there is none. */
    require(capability: ProviderCapability, feature?: string): Provider {
        const provider = this.route(capability);
        if (!provider) throw new CapabilityUnavailableError(capability, feature);
        return provider;
    }

    /** Called after every register, unregister, and setRoute. */
    subscribe(listener: () => void): () => void {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    /** Increases on every change (a snapshot key for UI stores such as useSyncExternalStore). */
    version(): number {
        return this.changes;
    }

    private changed(): void {
        this.changes += 1;
        for (const listener of [...this.listeners]) listener();
    }
}
