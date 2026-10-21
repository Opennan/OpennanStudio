// Cloud storage use against the account's allowance (GET /v1/storage): media vs 2 GB, project data vs 250 MB.
// Over the media quota, uploads are blocked and the meter says so; more storage is coming in 9a.2.
import type { StorageInfo } from "@opennan/cloud-backend";
import { formatBytes } from "../ui/format";
import { STORAGE_SOON, share, storageFull, storageFullMessage } from "./cloud-copy";
import "./cloud.css";

function Bar({ label, used, limit }: { label: string; used: number; limit: number }) {
    const percent = share(used, limit);
    return (
        <div className="storage-row">
            <div className="storage-row-head">
                <span>{label}</span>
                <span className="storage-row-value">{formatBytes(used)} of {formatBytes(limit)}</span>
            </div>
            <div className="storage-bar" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-valuetext={`${formatBytes(used)} of ${formatBytes(limit)}`}>
                <span className="storage-bar-fill" data-full={percent >= 100 ? "true" : undefined} style={{ width: `${percent}%` }} />
            </div>
        </div>
    );
}

export function StorageMeter({ storage, error, compact }: { storage: StorageInfo | null; error?: string | null; compact?: boolean }) {
    if (error) return <p className="storage-meter-note muted small">{error}</p>;
    if (!storage) return <p className="storage-meter-note muted small">Reading cloud storage…</p>;
    const full = storageFull(storage);
    return (
        <div className={compact ? "storage-meter compact" : "storage-meter"} data-testid="storage-meter" data-full={full ? "true" : undefined}>
            <Bar label="Cloud media" used={storage.mediaBytes} limit={storage.mediaLimitBytes} />
            <Bar label="Project data" used={storage.projectDataBytes} limit={storage.projectDataLimitBytes} />
            {full ? <p className="storage-meter-note" role="note">{storageFullMessage(storage)}</p> : !compact && <p className="storage-meter-note muted small">Free: 2 GB of media and 250 MB of project data. {STORAGE_SOON}</p>}
        </div>
    );
}
