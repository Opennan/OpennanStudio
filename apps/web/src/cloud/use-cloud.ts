// React access to cloud projects: the runtime's cloud seam, the signed-in account's backend (built on first use, so
// only cloud screens should ask), a project's sync state, and the storage meter.
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { OpenNanCloudBackend, StorageInfo, SyncState } from "@opennan/cloud-backend";
import { useAccount, useAccountStatus } from "../account/account-context";
import { useOptionalStudioRuntime } from "../platform/runtime-context";

/** The cloud backend of the signed-in account (null signed out or without cloud projects on this host). */
export function useCloudBackend(build = true): OpenNanCloudBackend | null {
    const cloud = useOptionalStudioRuntime()?.cloud;
    const { account } = useAccount();
    const status = useAccountStatus(account);
    const subscribe = useCallback((listener: () => void) => cloud?.subscribe(listener) ?? (() => undefined), [cloud]);
    const backend = useSyncExternalStore(subscribe, () => (build ? cloud?.backend() ?? null : cloud?.peek() ?? null));
    return status.state === "signed-in" || backend ? backend : null;
}

export function useSyncState(backend: OpenNanCloudBackend | null, projectId: string): SyncState | null {
    const [state, setState] = useState<SyncState | null>(() => backend?.syncState(projectId) ?? null);
    useEffect(() => (backend ? backend.onSyncState(projectId, setState) : undefined), [backend, projectId]);
    return state;
}

export function useCloudStorage(backend: OpenNanCloudBackend | null, active = true): { storage: StorageInfo | null; error: string | null; refresh(): void } {
    const [storage, setStorage] = useState<StorageInfo | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [tick, setTick] = useState(0);
    useEffect(() => {
        if (!backend || !active) return;
        let live = true;
        backend.storage().then((value) => {
            if (live) {
                setStorage(value);
                setError(null);
            }
        }, () => {
            if (live) setError("Cloud storage couldn't be read right now.");
        });
        return () => {
            live = false;
        };
    }, [backend, active, tick]);
    return { storage, error, refresh: () => setTick((t) => t + 1) };
}
