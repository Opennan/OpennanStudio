// The top bar's sync status for a cloud project: Saved · Syncing · Offline (n pending) · Conflict · Sign in to
// sync · Storage full, told apart by icon and words. The popover explains the state; Conflict lists each edit that
// was not applied with Keep my version as a copy and OK. ⌘S / Ctrl+S sends everything at once.
import { useEffect, useRef, useState } from "react";
import type { ProjectSummary } from "@opennan/timeline-core";
import { useAccount } from "../account/account-context";
import { useStudioRuntime } from "../platform/runtime-context";
import { routeHref } from "../routing/routes";
import { errorMessage } from "../ui/format";
import { syncDetail, syncLabel } from "./cloud-copy";
import { CloudIcon } from "./cloud-icons";
import { useCloudBackend, useSyncState } from "./use-cloud";
import "./cloud.css";

/** Live text that changes at most once every `ms` while it keeps changing (screen readers hear a calm chip). */
function useCalmText(text: string, ms: number): string {
    const [shown, setShown] = useState(text);
    const last = useRef(0);
    useEffect(() => {
        const wait = last.current + ms - Date.now();
        if (wait <= 0) {
            last.current = Date.now();
            setShown(text);
            return;
        }
        const timer = setTimeout(() => {
            last.current = Date.now();
            setShown(text);
        }, wait);
        return () => clearTimeout(timer);
    }, [text, ms]);
    return shown;
}

export function SyncChip({ projectId }: { projectId: string }) {
    const backend = useCloudBackend();
    const state = useSyncState(backend, projectId);
    const { openSignIn } = useAccount();
    const { cloud } = useStudioRuntime();
    const [open, setOpen] = useState(false);
    const [kept, setKept] = useState<ProjectSummary | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const wrap = useRef<HTMLDivElement>(null);
    const label = syncLabel(state);
    const announced = useCalmText(label, state?.kind === "syncing" ? 10_000 : 0);

    useEffect(() => {
        if (!backend) return;
        const onKey = (event: KeyboardEvent) => {
            if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "s") {
                event.preventDefault();
                void backend.flush(projectId);
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [backend, projectId]);

    useEffect(() => {
        if (!open) return;
        const onDown = (event: MouseEvent) => {
            if (!wrap.current?.contains(event.target as Node)) setOpen(false);
        };
        const onKey = (event: KeyboardEvent) => {
            if (event.key === "Escape") setOpen(false);
        };
        document.addEventListener("mousedown", onDown);
        document.addEventListener("keydown", onKey);
        return () => {
            document.removeEventListener("mousedown", onDown);
            document.removeEventListener("keydown", onKey);
        };
    }, [open]);

    const kind = state?.kind ?? "opening";
    const keepCopy = async () => {
        if (!backend || !cloud) return;
        setBusy(true);
        setError(null);
        try {
            setKept(await backend.keepConflictCopy(projectId, cloud.local));
        } catch (cause) {
            setError(errorMessage(cause));
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="sync-chip-wrap" ref={wrap}>
            <button
                type="button" className="sync-chip" data-state={kind} data-testid="sync-chip" aria-haspopup="dialog" aria-expanded={open}
                onClick={() => setOpen((value) => !value)}
            >
                <CloudIcon kind={kind} />
                <span aria-hidden="true">{label}</span>
                <span className="visually-hidden" aria-live="polite">{announced}</span>
            </button>
            {open && (
                <div className="sync-popover" role="dialog" aria-label="Sync status">
                    <p className="sync-popover-title"><CloudIcon kind={kind} /> {label}</p>
                    <p className="sync-popover-text">{syncDetail(state)}</p>
                    {state?.kind === "conflict" && (
                        <>
                            <ul className="sync-conflicts" aria-label="Edits not applied">
                                {state.items.map((item, index) => <li key={`${item.id}-${index}`}>{item.message}</li>)}
                            </ul>
                            {kept && (
                                <p className="sync-popover-text" role="status">
                                    Your version is saved as <a href={routeHref({ name: "editor", projectId: kept.id })}>{kept.name}</a> on this device.
                                </p>
                            )}
                            {error && <p className="error-text" role="alert">{error}</p>}
                            <div className="sync-popover-actions">
                                {!kept && <button type="button" className="button ghost small" disabled={busy} onClick={() => void keepCopy()}>Keep my version as a copy</button>}
                                <button type="button" className="button primary small" onClick={() => {
                                    backend?.acknowledgeConflicts(projectId);
                                    setKept(null);
                                    setOpen(false);
                                }}>OK</button>
                            </div>
                        </>
                    )}
                    {state?.kind === "signed-out" && (
                        <div className="sync-popover-actions">
                            <button type="button" className="button primary small" onClick={() => void openSignIn({ reason: "Sync this cloud project" })}>Sign in</button>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
