// "Open the inspector on the AI tab" (phase 11): the timeline's context menu selects an item and asks its inspector to
// switch to the AI tab, optionally scrolled to one tool (Upscale…, Remove silences…). The request waits per editor store
// until the item's inspector takes it: a freshly mounted inspector reads it for its first tab, a mounted one listens.
import { useEffect, useRef } from "react";
import type { AiToolId } from "@opennan/timeline-core";

export interface InspectorAiRequest {
    /** The clip or scene id. */
    itemId: string;
    tool?: AiToolId;
    /** Start the tool's local analysis at once (Detect beats from the menu). */
    autoStart?: boolean;
    nonce: number;
}

const pending = new WeakMap<object, InspectorAiRequest>();
const listeners = new WeakMap<object, Set<(request: InspectorAiRequest) => void>>();
let nonce = 0;

/** Asks the inspector of `itemId` (once selected) to open its AI tab. */
export function requestInspectorAiTab(store: object, request: Omit<InspectorAiRequest, "nonce">): void {
    const next = { ...request, nonce: ++nonce };
    pending.set(store, next);
    for (const listener of [...(listeners.get(store) ?? [])]) listener(next);
}

/** The waiting request for this item, left in place. */
export function peekInspectorAiRequest(store: object, itemId: string): InspectorAiRequest | null {
    const request = pending.get(store);
    return request && request.itemId === itemId ? request : null;
}

/** Takes the waiting request for this item (it will not be seen again). */
export function takeInspectorAiRequest(store: object, itemId: string): InspectorAiRequest | null {
    const request = peekInspectorAiRequest(store, itemId);
    if (request) pending.delete(store);
    return request;
}

/** Calls `onRequest` for requests to this item: the one waiting at mount and later ones. */
export function useInspectorAiRequest(store: object, itemId: string, onRequest: (request: InspectorAiRequest) => void): void {
    const latest = useRef(onRequest);
    latest.current = onRequest;
    useEffect(() => {
        const waiting = takeInspectorAiRequest(store, itemId);
        if (waiting) latest.current(waiting);
        const set = listeners.get(store) ?? new Set();
        listeners.set(store, set);
        const listener = (request: InspectorAiRequest) => {
            if (request.itemId !== itemId) return;
            pending.delete(store);
            latest.current(request);
        };
        set.add(listener);
        return () => {
            set.delete(listener);
        };
    }, [store, itemId]);
}
