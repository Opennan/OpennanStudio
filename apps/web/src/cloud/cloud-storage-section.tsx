// The storage meter where the account lives: the account chip's menu and Settings' OpenNan card. Every signed-in
// person sees it (phase 9a.1): GET /v1/storage is read through the cloud seam only while it is shown (the menu
// open), cached briefly there, without building the cloud backend.
import { useEffect, useState } from "react";
import type { StorageInfo } from "@opennan/cloud-backend";
import { useAccount } from "../account/account-context";
import { useOptionalStudioRuntime } from "../platform/runtime-context";
import { StorageMeter } from "./storage-meter";
import "./cloud.css";

/** The signed-in account's cloud storage while `active`; refreshed each time it becomes active (the cache keeps it 30 s). */
export function useAccountStorage(active: boolean): { storage: StorageInfo | null; error: string | null; available: boolean } {
    const cloud = useOptionalStudioRuntime()?.cloud;
    const { status } = useAccount();
    const signedIn = status.state === "signed-in";
    const accountName = signedIn ? status.account?.email ?? "" : "";
    // Kept with the account it belongs to: another account's numbers are never shown, even for a moment.
    const [read, setRead] = useState<{ account: string; storage: StorageInfo | null; error: string | null } | null>(null);
    useEffect(() => {
        if (!cloud || !signedIn || !active) return;
        const pending = cloud.storage();
        if (!pending) return;
        let live = true;
        pending.then((value) => {
            if (live) setRead({ account: accountName, storage: value, error: null });
        }, () => {
            if (live) setRead({ account: accountName, storage: null, error: "Cloud storage couldn't be read right now." });
        });
        return () => {
            live = false;
        };
    }, [cloud, signedIn, active, accountName]);
    const current = read && read.account === accountName ? read : null;
    return { storage: current?.storage ?? null, error: current?.error ?? null, available: Boolean(cloud && signedIn) };
}

export function CloudStorageSection({ compact, active = true }: { compact?: boolean; active?: boolean }) {
    const { storage, error, available } = useAccountStorage(active);
    if (!available) return null;
    return (
        <div className={compact ? "account-menu-storage" : "cloud-storage"} role="presentation" data-testid="cloud-storage-section">
            <p className={compact ? "account-menu-storage-title" : "cloud-storage-title"}>Cloud storage</p>
            <StorageMeter storage={storage} error={error} compact={compact} />
        </div>
    );
}
