// "Save to OpenNan": moves a local project to the account's cloud projects. It first says what will upload and how
// much storage that leaves, then uploads (per file, with a total), imports, and opens the cloud project. Cancel
// stops before the project is created; the uploads already done are kept, so a second try resumes.
import { useEffect, useRef, useState } from "react";
import type { CloudStorageFullError, SaveProgress, StorageInfo } from "@opennan/cloud-backend";
import { navigate } from "../routing/routes";
import { Dialog } from "../ui/dialog";
import { formatBytes } from "../ui/format";
import { useStudioRuntime } from "../platform/runtime-context";
import { STORAGE_SOON, cloudErrorMessage, share } from "./cloud-copy";
import { useCloudBackend } from "./use-cloud";
import "./cloud.css";

interface Plan {
    files: number;
    bytes: number;
    storage: StorageInfo;
    fits: boolean;
    refused: string[];
}

const STAGES: Record<SaveProgress["stage"], string> = {
    checking: "Checking your cloud storage…",
    uploading: "Uploading media",
    creating: "Creating the cloud project…",
    syncing: "Saving the rest of the project…",
    downloading: "Copying media",
    done: "Saved",
};

export function SaveToCloudDialog({ projectId, projectName, onClose }: { projectId: string; projectName: string; onClose(): void }) {
    const backend = useCloudBackend();
    const { cloud } = useStudioRuntime();
    const [plan, setPlan] = useState<Plan | null>(null);
    const [progress, setProgress] = useState<SaveProgress | null>(null);
    const [error, setError] = useState<string | null>(null);
    const controller = useRef<AbortController | null>(null);

    useEffect(() => {
        if (!backend || !cloud) return;
        let live = true;
        backend.planSave(cloud.local, projectId).then((value) => live && setPlan(value), (cause) => live && setError(cloudErrorMessage(cause)));
        return () => {
            live = false;
        };
    }, [backend, cloud, projectId]);

    const save = async () => {
        if (!backend || !cloud) return;
        controller.current = new AbortController();
        setError(null);
        try {
            const summary = await backend.saveLocalProject(cloud.local, projectId, setProgress, controller.current.signal);
            navigate({ name: "editor", projectId: summary.id });
            onClose();
        } catch (cause) {
            setProgress(null);
            setError((cause as CloudStorageFullError).name === "CloudStorageFullError" ? (cause as Error).message : cloudErrorMessage(cause));
        }
    };

    const working = progress !== null;
    const after = plan ? plan.storage.mediaBytes + plan.bytes : 0;
    return (
        <Dialog title={`Save "${projectName}" to OpenNan`} onClose={() => {
            controller.current?.abort();
            onClose();
        }} className="cloud-dialog">
            <p className="muted cloud-dialog-lead">Open it on any device signed in to OpenNan. Edits sync automatically.</p>
            {!plan && !error && <p className="muted small">Checking what to upload…</p>}
            {plan && !working && (
                <div className="cloud-plan" data-testid="save-plan">
                    <p>{plan.files === 0 ? "No media files" : `${plan.files} media ${plan.files === 1 ? "file" : "files"}`} · {formatBytes(plan.bytes)} to upload at most</p>
                    {plan.storage.mediaLimitBytes > 0 && <p className="muted small">Cloud storage after: {formatBytes(after)} of {formatBytes(plan.storage.mediaLimitBytes)}</p>}
                    {plan.refused.length > 0 && (
                        <div role="alert" className="error-text">
                            <p>These files can't go to OpenNan as they are:</p>
                            <ul>{plan.refused.map((line) => <li key={line}>{line}</li>)}</ul>
                        </div>
                    )}
                    {!plan.fits && plan.refused.length === 0 && plan.storage.state === "pool_full" && <p className="error-text" role="alert">OpenNan cloud storage is busy right now. Try again later.</p>}
                    {!plan.fits && plan.refused.length === 0 && plan.storage.state !== "pool_full" && <p className="error-text" role="alert">Not enough cloud storage: {formatBytes(Math.max(0, plan.storage.mediaLimitBytes - plan.storage.mediaBytes))} left. {STORAGE_SOON}</p>}
                    <p className="muted small">The project moves to your cloud projects. "Download a local copy" brings an offline copy back.</p>
                </div>
            )}
            {working && (
                <div className="cloud-progress" role="status" aria-live="polite" data-testid="save-progress">
                    <p>{STAGES[progress.stage]}{progress.stage === "uploading" && progress.total > 0 ? ` · ${Math.min(progress.done + 1, progress.total)} of ${progress.total}` : ""}</p>
                    {progress.file && <p className="muted small">{progress.file}</p>}
                    <div className="storage-bar"><span className="storage-bar-fill" style={{ width: `${progress.total > 0 ? share(progress.done, progress.total) : progress.stage === "done" ? 100 : 10}%` }} /></div>
                </div>
            )}
            {error && <p className="error-text" role="alert">{error}</p>}
            <div className="dialog-footer">
                <button type="button" className="button ghost" onClick={() => {
                    controller.current?.abort();
                    onClose();
                }}>{working ? "Cancel" : "Close"}</button>
                {!working && <button type="button" className="button primary" data-autofocus disabled={!plan || !plan.fits} onClick={() => void save()}>Save to OpenNan</button>}
            </div>
        </Dialog>
    );
}

/** "Download a local copy" (and its progress): a new project on this device with fresh ids. */
export function DownloadCopyDialog({ projectId, projectName, onClose }: { projectId: string; projectName: string; onClose(): void }) {
    const backend = useCloudBackend();
    const { cloud } = useStudioRuntime();
    const [progress, setProgress] = useState<SaveProgress | null>(null);
    const [error, setError] = useState<string | null>(null);
    const controller = useRef<AbortController | null>(null);
    const start = async () => {
        if (!backend || !cloud) return;
        controller.current = new AbortController();
        setError(null);
        setProgress({ stage: "downloading", done: 0, total: 0 });
        try {
            const summary = await backend.downloadLocalCopy(projectId, cloud.local, setProgress, controller.current.signal);
            navigate({ name: "editor", projectId: summary.id });
            onClose();
        } catch (cause) {
            setProgress(null);
            setError(cloudErrorMessage(cause));
        }
    };
    return (
        <Dialog title={`Download a local copy of "${projectName}"`} onClose={() => {
            controller.current?.abort();
            onClose();
        }} className="cloud-dialog">
            <p className="muted cloud-dialog-lead">A new project on this device, with its media, that works offline. The cloud project stays as it is.</p>
            {progress && (
                <div className="cloud-progress" role="status" aria-live="polite">
                    <p>{STAGES[progress.stage]}{progress.total > 0 ? ` · ${Math.min(progress.done + 1, progress.total)} of ${progress.total}` : ""}</p>
                    <div className="storage-bar"><span className="storage-bar-fill" style={{ width: `${progress.total > 0 ? share(progress.done, progress.total) : 10}%` }} /></div>
                </div>
            )}
            {error && <p className="error-text" role="alert">{error}</p>}
            <div className="dialog-footer">
                <button type="button" className="button ghost" onClick={() => {
                    controller.current?.abort();
                    onClose();
                }}>{progress ? "Cancel" : "Close"}</button>
                {!progress && <button type="button" className="button primary" data-autofocus onClick={() => void start()}>Download a local copy</button>}
            </div>
        </Dialog>
    );
}
