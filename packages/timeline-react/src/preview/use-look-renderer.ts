// One WebGL2 LookRenderer per document, shared by the main-track look overlay and the compositor (each
// draws the renderer's canvas where it needs it). Created on first use, disposed with its last user.
import { useEffect, useState } from "react";
import { LookRenderer, isWebGl2Available } from "@opennan/timeline-media/looks/look-renderer";

let shared: LookRenderer | null = null;
let users = 0;
let unavailable: boolean | null = null;

export function lookRendererSupported(): boolean {
    if (unavailable === null) unavailable = !isWebGl2Available();
    return !unavailable;
}

export function acquireLookRenderer(): LookRenderer | null {
    if (!lookRendererSupported()) return null;
    if (shared?.isLost) {
        // Users of the lost renderer re-acquire (useLookRenderer); their releases of it are ignored.
        shared.dispose();
        shared = null;
        users = 0;
    }
    if (!shared) {
        try {
            shared = new LookRenderer();
        } catch {
            unavailable = true;
            return null;
        }
    }
    users += 1;
    return shared;
}

export function releaseLookRenderer(renderer: LookRenderer | null): void {
    if (!renderer || renderer !== shared) return;
    users = Math.max(0, users - 1);
    if (users === 0) {
        shared.dispose();
        shared = null;
    }
}

/** The shared renderer while the component is mounted (null without WebGL2). */
export function useLookRenderer(enabled = true): LookRenderer | null {
    const [renderer, setRenderer] = useState<LookRenderer | null>(null);
    // Bumped when the context is lost: the effect re-runs and acquires a new renderer.
    const [generation, setGeneration] = useState(0);
    useEffect(() => {
        if (!enabled) return;
        const acquired = acquireLookRenderer();
        setRenderer(acquired);
        const unsubscribe = acquired?.onContextLost?.(() => setGeneration((n) => n + 1));
        return () => {
            unsubscribe?.();
            releaseLookRenderer(acquired);
            setRenderer(null);
        };
    }, [enabled, generation]);
    return renderer;
}
