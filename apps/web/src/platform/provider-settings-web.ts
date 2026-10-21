// The web build's provider settings: routing in localStorage, bring-your-own keys in the account storage
// (IndexedDB or sessionStorage, like the OpenNan key).
import { DEFAULT_ROUTING, type ProviderKeyId, type ProviderPlatform, type ProviderRouting } from "../account/account-types";
import { parseRouting } from "../settings/routing-groups";
import type { WebAccountStorage } from "./account-storage";

export const ROUTING_KEY = "opennan-studio:provider-routing";

export interface WebProviderSettingsOptions {
    preferences: Pick<Storage, "getItem" | "setItem"> | null;
    storage: Pick<WebAccountStorage, "getSecret" | "setSecret" | "removeSecret">;
    /** Bring-your-own-key providers built into this app (Task 30: fal). */
    keyProviders?: Array<{ id: ProviderKeyId; name: string }>;
}

export function createWebProviderSettings(options: WebProviderSettingsOptions): ProviderPlatform & { ready: Promise<void> } {
    const listeners = new Set<() => void>();
    const notify = () => {
        for (const listener of [...listeners]) listener();
    };
    let routing: ProviderRouting = (() => {
        try {
            const raw = options.preferences?.getItem(ROUTING_KEY);
            return raw ? parseRouting(JSON.parse(raw)) : { ...DEFAULT_ROUTING, overrides: {} };
        } catch {
            return { ...DEFAULT_ROUTING, overrides: {} };
        }
    })();
    const keyProviders = options.keyProviders ?? [];
    const present = new Map<ProviderKeyId, boolean>();
    const ready = Promise.all(keyProviders.map(async ({ id }) => {
        present.set(id, Boolean(await options.storage.getSecret(`provider:${id}`).catch(() => null)));
    })).then(notify);
    return {
        ready,
        routing: () => routing,
        async setRouting(next) {
            routing = parseRouting(next);
            try {
                options.preferences?.setItem(ROUTING_KEY, JSON.stringify(routing));
            } catch {
                // kept for this page only
            }
            notify();
        },
        subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        keys: () => keyProviders.map(({ id, name }) => ({ id, name, set: present.get(id) ?? false })),
        async setKey(id, key) {
            const value = key.trim();
            if (!/^[\x21-\x7e]{8,4096}$/.test(value)) throw new Error("That does not look like an API key.");
            await options.storage.setSecret(`provider:${id}`, value);
            present.set(id, true);
            notify();
        },
        async removeKey(id) {
            await options.storage.removeSecret(`provider:${id}`);
            present.set(id, false);
            notify();
        },
    };
}
