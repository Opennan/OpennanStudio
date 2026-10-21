import { createContext, useContext, type ReactNode } from "react";
import type { StudioRuntime } from "./runtime-types";

const StudioRuntimeContext = createContext<StudioRuntime | null>(null);

export function StudioRuntimeProvider({ runtime, children }: { runtime: StudioRuntime; children: ReactNode }) {
    return <StudioRuntimeContext.Provider value={runtime}>{children}</StudioRuntimeContext.Provider>;
}

export function useStudioRuntime(): StudioRuntime {
    const runtime = useContext(StudioRuntimeContext);
    if (!runtime) throw new Error("useStudioRuntime needs <StudioRuntimeProvider>");
    return runtime;
}

/** The runtime, or null outside <StudioRuntimeProvider> (components rendered on their own in tests). */
export function useOptionalStudioRuntime(): StudioRuntime | null {
    return useContext(StudioRuntimeContext);
}
