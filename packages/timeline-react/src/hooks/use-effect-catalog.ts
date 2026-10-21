// src/hooks/use-effect-catalog.ts
// Loads GL effect/transition catalog slices and caches them across the session.

import { useEffect, useMemo, useState } from "react";
import type { EffectDef } from "@opennan/timeline-core";
import { fetchEffectCatalog } from "../effects/effect-catalog-source";
import { useDocumentVisible } from "./use-document-visible";

type EffectCatalogKind = "effect" | "transition";
type EffectCatalogFetchEntry = {
    controller: AbortController;
    consumers: number;
    promise: Promise<EffectDef[]>;
};

const _cache = new Map<EffectCatalogKind, EffectDef[]>();
const _inflight = new Map<EffectCatalogKind, EffectCatalogFetchEntry>();

type UseEffectCatalogOptions = {
    enabled?: boolean;
};

function createAbortError(): DOMException {
    return new DOMException("Aborted", "AbortError");
}

async function loadCatalog(kind: EffectCatalogKind, signal: AbortSignal): Promise<EffectDef[]> {
    const cached = _cache.get(kind);
    if (cached) return cached;

    let entry = _inflight.get(kind);
    if (!entry) {
        const controller = new AbortController();
        entry = {
            controller,
            consumers: 0,
            promise: fetchEffectCatalog(kind, { signal: controller.signal })
                .then((items) => {
                    _cache.set(kind, items);
                    return items;
                })
                .finally(() => {
                    if (_inflight.get(kind) === entry) _inflight.delete(kind);
                }),
        };
        _inflight.set(kind, entry);
    }

    entry.consumers += 1;
    const release = () => {
        entry!.consumers -= 1;
        if (entry!.consumers <= 0 && _inflight.get(kind) === entry) {
            _inflight.delete(kind);
            entry!.controller.abort();
        }
    };

    if (signal.aborted) {
        release();
        return Promise.reject(createAbortError());
    }
    let abortListener: (() => void) | null = null;
    const abortPromise = new Promise<never>((_, reject) => {
        abortListener = () => {
            release();
            reject(createAbortError());
        };
        signal.addEventListener("abort", abortListener, { once: true });
    });
    return Promise.race([entry.promise, abortPromise]).finally(() => {
        if (abortListener) {
            signal.removeEventListener("abort", abortListener);
        }
    });
}

/** Returns registry entries of the given kind (effect | transition). */
export function useEffectCatalog(kind: EffectCatalogKind, options?: UseEffectCatalogOptions) {
    const enabled = options?.enabled ?? true;
    const docVisible = useDocumentVisible();
    const [all, setAll] = useState<EffectDef[]>(_cache.get(kind) ?? []);
    const [loading, setLoading] = useState(enabled && docVisible && !_cache.has(kind));
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let alive = true;
        if (!enabled) {
            return;
        }
        if (!docVisible) {
            return;
        }
        const controller = new AbortController();
        loadCatalog(kind, controller.signal)
            .then((items) => {
                if (alive) {
                    setAll(items);
                    setLoading(false);
                }
            })
            .catch((e) => {
                if ((e as { name?: string })?.name === "AbortError") return;
                if (alive) {
                    setError(e?.message || "Failed to load effects");
                    setLoading(false);
                }
            });
        return () => {
            alive = false;
            controller.abort();
        };
    }, [kind, enabled, docVisible]);

    const items = useMemo(() => all.filter((e) => e.kind === kind), [all, kind]);
    return { items, loading: enabled && docVisible && loading, error };
}

export function preloadEffectCatalog(kind: EffectCatalogKind): Promise<EffectDef[]> {
    const controller = new AbortController();
    return loadCatalog(kind, controller.signal);
}

/** Look up a single registry entry by id (from the loaded cache). */
export function getEffectDef(effectId: string): EffectDef | undefined {
    for (const entries of _cache.values()) {
        const found = entries.find((e) => e.id === effectId);
        if (found) return found;
    }
    return undefined;
}

export function __clearEffectCatalogCacheForTests() {
    _cache.clear();
    _inflight.clear();
}
