"use client";
// Returns whether document.visibilityState is "visible". Polls/timers
// across the editor that hit the GraphQL API should gate on this so they
// pause when the user switches to another browser tab — otherwise every
// active editor session keeps hammering the API in the background.

import { useSyncExternalStore } from "react";

const subscribers = new Set<() => void>();
let isListening = false;

function getDocumentVisibleSnapshot(): boolean {
    if (typeof document === "undefined") return true;
    return document.visibilityState !== "hidden";
}

function notifyVisibilitySubscribers() {
    for (const subscriber of subscribers) {
        subscriber();
    }
}

function subscribeDocumentVisible(subscriber: () => void): () => void {
    if (typeof document === "undefined") return () => {};
    subscribers.add(subscriber);
    if (!isListening) {
        document.addEventListener("visibilitychange", notifyVisibilitySubscribers);
        isListening = true;
    }

    return () => {
        subscribers.delete(subscriber);
        if (isListening && subscribers.size === 0) {
            document.removeEventListener("visibilitychange", notifyVisibilitySubscribers);
            isListening = false;
        }
    };
}

export function useDocumentVisible(): boolean {
    return useSyncExternalStore(
        subscribeDocumentVisible,
        getDocumentVisibleSnapshot,
        () => true,
    );
}
