// Settings → Cloud media on this device (phase 9a.1): how much downloaded cloud media this device keeps, the size
// limit (Default or a choice up to what the device offers), and Clear cache, which keeps files open projects use.
import { useCallback, useEffect, useId, useState } from "react";
import { CACHE_LIMIT_CHOICES, type CacheUsage, type MediaCacheControl } from "@opennan/cloud-backend";
import { formatBytes } from "../ui/format";
import { share } from "./cloud-copy";
import "./cloud.css";

const GB = 1024 ** 3;

/** "10 GB" for whole gigabytes, the usual size otherwise. */
export function limitLabel(bytes: number): string {
    return bytes % GB === 0 ? `${bytes / GB} GB` : formatBytes(bytes);
}

export function MediaCacheSection({ cache }: { cache: MediaCacheControl }) {
    const titleId = useId();
    const [usage, setUsage] = useState<CacheUsage | null>(null);
    const [busy, setBusy] = useState(false);
    const [note, setNote] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const refresh = useCallback(() => {
        cache.usage().then(setUsage, () => setError("The cache on this device couldn't be read."));
    }, [cache]);
    useEffect(refresh, [refresh]);
    const choices = CACHE_LIMIT_CHOICES.filter((bytes) => usage?.maxLimitBytes == null || bytes <= usage.maxLimitBytes);
    const run = async (work: () => Promise<void>) => {
        setBusy(true);
        setError(null);
        try {
            await work();
        } catch (failure) {
            setError(failure instanceof Error ? failure.message : String(failure));
        } finally {
            setBusy(false);
        }
    };
    const choose = (value: string) => void run(async () => {
        setNote(null);
        setUsage(await cache.setLimit(value === "default" ? null : Number(value)));
    });
    const clear = () => void run(async () => {
        const result = await cache.clear();
        setNote(result.keptBytes > 0
            ? `Freed ${formatBytes(result.freedBytes)}. ${formatBytes(result.keptBytes)} stayed because open projects use it.`
            : `Freed ${formatBytes(result.freedBytes)}.`);
        setUsage(await cache.usage());
    });
    const value = usage && usage.custom && CACHE_LIMIT_CHOICES.includes(usage.limitBytes) ? String(usage.limitBytes) : "default";
    return (
        <section className="provider-section media-cache-section" aria-labelledby={titleId} data-testid="media-cache-section">
            <div className="provider-section-head">
                <h2 id={titleId}>Cloud media on this device</h2>
            </div>
            <p className="muted small">
                Files of OpenNan cloud projects are downloaded once and kept here, so they play without a connection. When the cache is full the
                files used longest ago are removed; files an open project uses always stay, and they download again when needed.
            </p>
            {usage && (
                <div className="storage-row">
                    <div className="storage-row-head">
                        <span>Downloaded</span>
                        <span className="storage-row-value">{formatBytes(usage.usedBytes)} of {limitLabel(usage.limitBytes)}</span>
                    </div>
                    <div
                        className="storage-bar" role="meter" aria-label="Downloaded cloud media" aria-valuemin={0} aria-valuemax={100}
                        aria-valuenow={share(usage.usedBytes, usage.limitBytes)} aria-valuetext={`${formatBytes(usage.usedBytes)} of ${limitLabel(usage.limitBytes)}`}
                    >
                        <span className="storage-bar-fill" style={{ width: `${share(usage.usedBytes, usage.limitBytes)}%` }} />
                    </div>
                </div>
            )}
            <div className="media-cache-actions">
                <label className="media-cache-limit">
                    <span>Cache size</span>
                    <select value={value} disabled={!usage || busy} onChange={(event) => choose(event.target.value)}>
                        <option value="default">Default ({usage ? limitLabel(usage.defaultLimitBytes) : "…"})</option>
                        {choices.map((bytes) => <option key={bytes} value={String(bytes)}>{limitLabel(bytes)}</option>)}
                    </select>
                </label>
                <button type="button" className="button small" disabled={!usage || busy || usage.usedBytes === 0} onClick={clear}>Clear cache</button>
            </div>
            {note && <p className="muted small" role="status">{note}</p>}
            {error && <p className="error-text small" role="alert">{error}</p>}
        </section>
    );
}
