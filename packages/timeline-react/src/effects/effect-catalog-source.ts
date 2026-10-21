// Effect catalog from the mounted provider's backend (was the EffectCatalog GraphQL
// query, SRC/lib/effects-api.ts:64-66,167-176). LocalBackend serves its bundled list.
import type { EffectDef } from "@opennan/timeline-core";
import { getActiveRuntime } from "../provider/registry";

export async function fetchEffectCatalog(kind?: "effect" | "transition", options?: { signal?: AbortSignal }): Promise<EffectDef[]> {
    const backend = getActiveRuntime()?.backend;
    if (!backend?.listEffects) return [];
    return backend.listEffects(kind ?? "effect", options);
}
