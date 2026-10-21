// The most recently mounted provider's runtime, for compat shims and module-level
// code that cannot read React context. Outside any provider a default store is used.
import { createEditorStore, type EditorStore } from "@opennan/timeline-core";
import type { TimelineContextValue } from "./context";

let active: TimelineContextValue[] = [];
let fallbackStore: EditorStore | null = null;

export function registerActiveRuntime(runtime: TimelineContextValue): () => void {
    active.push(runtime);
    return () => {
        active = active.filter((entry) => entry !== runtime);
    };
}

export function getActiveRuntime(): TimelineContextValue | null {
    return active[active.length - 1] ?? null;
}

export function getActiveEditorStore(): EditorStore {
    const runtime = getActiveRuntime();
    if (runtime) return runtime.store;
    fallbackStore ??= createEditorStore();
    return fallbackStore;
}

export function __resetActiveRuntimeForTests(): void {
    active = [];
    fallbackStore = null;
}
