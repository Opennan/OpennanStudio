// The Share dialog (phase 9c): a cloud project's view-only link on opennan.com — create it (expiry, allow download),
// copy it, make a new one (the old one stops at once), turn it off, and see its views; Export and share when the project
// has nothing to show (or to share a fresh export). A local project gets "Save to OpenNan to share" and sends nothing.
// Monochrome, --on-* tokens only; states by icon and words; progress and errors announced.
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { isCloudProjectId, SHARE_DAY_CHOICES, SHARE_MAX_DAYS, SHARE_MIN_DAYS, type ShareLink } from "@opennan/cloud-backend";
import { useTimelineMessages } from "@opennan/timeline-react";
import { useAccount } from "../account/account-context";
import { SaveToCloudDialog } from "../cloud/save-dialog";
import { useStudioRuntime } from "../platform/runtime-context";
import { Dialog } from "../ui/dialog";
import { AlertIcon, CheckIcon, CopyIcon } from "../ui/icons";
import type { ShareError, ShareHost } from "./share-host";
import "./share.css";

export type ShareT = (key: string, values?: Record<string, string | number>) => string;

const DAY_LABEL: Record<number, string> = { 1: "day1", 7: "days7", 30: "days30", 90: "days90", 365: "days365" };

export function shareErrorText(t: ShareT, error: ShareError): string {
    switch (error.code) {
        case "limit": return t("errLimit");
        case "nothing_to_show": return t("nothingBody");
        case "rate_limited": return error.retryAfterSeconds ? t("errRate", { seconds: error.retryAfterSeconds }) : t("errRateNoTime");
        case "signed_out": return t("errSignedOut");
        case "not_found": return t("errNotFound");
        case "network": return t("errNetwork");
        case "copy_failed": return t("copyFailed");
        case "export_failed": return error.detail ? t("errExport", { detail: error.detail }) : t("errExportNoDetail");
        case "upload_failed": return t("errUpload");
        case "storage_full": return t("errStorage");
        case "final_video_refused": return t("errFinalVideo");
        default: return t("errServer");
    }
}

function day(ms: number | null): string {
    if (ms === null) return "";
    return new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function moment(ms: number): string {
    return new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function useShareState(host: ShareHost | null) {
    return useSyncExternalStore(
        (listener) => host?.subscribe(listener) ?? (() => undefined),
        () => host?.snapshot() ?? null,
    );
}

export function ShareDialog({ projectId, projectName, host, onClose }: { projectId: string; projectName: string; host: ShareHost | null; onClose(): void }) {
    const t = useTimelineMessages("share") as ShareT;
    if (!isCloudProjectId(projectId)) return <LocalShare projectId={projectId} projectName={projectName} onClose={onClose} t={t} />;
    // A cloud project without its backend (signed out): sign in, never "Save to OpenNan".
    if (!host) return <SignInShare onClose={onClose} t={t} />;
    return <CloudShare host={host} onClose={onClose} t={t} />;
}

function SignInShare({ onClose, t }: { onClose(): void; t: ShareT }) {
    const { openSignIn } = useAccount();
    return (
        <Dialog title={t("title")} onClose={onClose} className="share-dialog">
            <div className="share-local" data-testid="share-signin">
                <h3 className="share-heading">{t("signInTitle")}</h3>
                <p className="muted share-text">{t("errSignedOut")}</p>
            </div>
            <div className="dialog-footer">
                <button type="button" className="button ghost" onClick={onClose}>{t("close")}</button>
                <button type="button" className="button primary" data-autofocus onClick={() => void openSignIn({ reason: t("signInTitle") })}>{t("signIn")}</button>
            </div>
        </Dialog>
    );
}

function LocalShare({ projectId, projectName, onClose, t }: { projectId: string; projectName: string; onClose(): void; t: ShareT }) {
    const { account, openSignIn } = useAccount();
    const { cloud } = useStudioRuntime();
    const [saving, setSaving] = useState(false);
    if (saving) return <SaveToCloudDialog projectId={projectId} projectName={projectName} onClose={onClose} />;
    return (
        <Dialog title={t("title")} onClose={onClose} className="share-dialog">
            <div className="share-local" data-testid="share-local">
                <h3 className="share-heading">{t("localTitle")}</h3>
                <p className="muted share-text">{t("localBody")}</p>
            </div>
            <div className="dialog-footer">
                <button type="button" className="button ghost" onClick={onClose}>{t("close")}</button>
                {cloud && (
                    <button
                        type="button" className="button primary" data-autofocus
                        onClick={async () => {
                            if (account.status().state !== "signed-in" && !(await openSignIn({ reason: t("localSave") }))) return;
                            setSaving(true);
                        }}
                    >
                        {t("localSave")}
                    </button>
                )}
            </div>
        </Dialog>
    );
}

const keepOpen = () => {};

function CloudShare({ host, onClose, t }: { host: ShareHost; onClose(): void; t: ShareT }) {
    const state = useShareState(host)!;
    const [confirm, setConfirm] = useState<null | "rotate" | "turn-off">(null);
    const confirmButton = useRef<HTMLButtonElement>(null);
    useEffect(() => {
        void host.load();
    }, [host]);
    // The inline confirmation takes the focus (the button that opened it is gone).
    useEffect(() => {
        if (confirm) confirmButton.current?.focus();
    }, [confirm]);
    const exporting = state.exporting;
    const busy = state.busy !== null || exporting !== null;
    const earlier = state.links.filter((link) => link.status !== "active");
    const close = () => {
        host.cancelExport();
        onClose();
    };
    return (
        <Dialog title={t("title")} onClose={exporting?.cancellable ? keepOpen : close} className="share-dialog">
            <div className="share-body" data-testid="share-dialog" data-state={state.active ? "active" : state.status === "ready" ? "none" : state.status}>
                {state.status === "loading" && <p className="muted share-text" role="status">{t("loading")}</p>}
                {state.active && (
                    <ActiveLink link={state.active} copied={state.copied} t={t} onCopy={() => void host.copy()} />
                )}
                {state.status !== "loading" && !exporting && (
                    <ShareOptions host={host} days={state.options.days} allowDownload={state.options.allowDownload} disabled={busy} t={t} />
                )}
                {state.status === "ready" && !state.active && !exporting && state.nothingToShow && host.canExportAndShare() && (
                    <div className="share-callout" data-testid="share-nothing" role="note">
                        <AlertIcon />
                        <div>
                            <p className="share-heading">{t("nothingTitle")}</p>
                            <p className="muted share-text">{t("nothingBody")}</p>
                        </div>
                    </div>
                )}
                {exporting && <ExportProgress step={exporting.step} ratio={exporting.ratio} t={t} />}
                {exporting && !exporting.cancellable && <p className="muted share-text" data-testid="share-saving-note">{t("savingNote")}</p>}
                {confirm && (
                    <div className="share-confirm" role="alertdialog" aria-label={t(confirm === "rotate" ? "newLink" : "turnOff")}>
                        <p className="share-text">{t(confirm === "rotate" ? "newLinkConfirm" : "turnOffConfirm")}</p>
                        <div className="share-actions">
                            <button type="button" className="button ghost small" onClick={() => setConfirm(null)}>{t("keep")}</button>
                            <button
                                ref={confirmButton} type="button" className={confirm === "turn-off" ? "button danger small" : "button primary small"}
                                onClick={async () => {
                                    const kind = confirm;
                                    setConfirm(null);
                                    if (kind === "rotate") await host.rotate();
                                    else await host.turnOff();
                                }}
                            >
                                {t(confirm === "rotate" ? "newLinkYes" : "turnOffYes")}
                            </button>
                        </div>
                    </div>
                )}
                {state.error && state.error.code !== "nothing_to_show" && <p className="share-error" role="alert"><AlertIcon /> {shareErrorText(t, state.error)}</p>}
                {earlier.length > 0 && !exporting && <EarlierLinks links={earlier} t={t} />}
            </div>
            <div className="dialog-footer share-footer">
                {exporting ? (
                    exporting.cancellable
                        ? <button type="button" className="button ghost" onClick={() => host.cancelExport()}>{t("cancel")}</button>
                        // The export is OpenNan's now: Close leaves it to be set (sent later if offline); no link is made.
                        : <button type="button" className="button ghost" onClick={close}>{t("close")}</button>
                ) : (
                    <>
                        <button type="button" className="button ghost" onClick={close}>{t("close")}</button>
                        {state.status === "error" && <button type="button" className="button primary" onClick={() => void host.retry()}>{state.error?.code === "signed_out" ? t("signIn") : t("retry")}</button>}
                        {state.active && !confirm && (
                            <>
                                <button type="button" className="button ghost" disabled={busy} onClick={() => setConfirm("turn-off")}>{t("turnOff")}</button>
                                <button type="button" className="button ghost" disabled={busy} onClick={() => setConfirm("rotate")}>{t("newLink")}</button>
                            </>
                        )}
                        {host.canExportAndShare() && state.status === "ready" && (state.active || !state.nothingToShow) && (
                            <button type="button" className="button ghost" disabled={busy} title={t("freshExportHint")} onClick={() => void host.exportAndShare()}>{t("freshExport")}</button>
                        )}
                        {state.status === "ready" && !state.active && (
                            state.nothingToShow && host.canExportAndShare()
                                ? <button type="button" className="button primary" disabled={busy} data-autofocus onClick={() => void host.exportAndShare()}>{t("exportShare")}</button>
                                : <button type="button" className="button primary" disabled={busy} data-autofocus onClick={() => void host.create()}>{state.busy === "create" ? t("creating") : t("create")}</button>
                        )}
                    </>
                )}
            </div>
        </Dialog>
    );
}

function ActiveLink({ link, copied, onCopy, t }: { link: ShareLink; copied: boolean; onCopy(): void; t: ShareT }) {
    return (
        <div className="share-link" data-testid="share-link">
            <label className="share-label" htmlFor="share-link-url">{t("linkLabel")}</label>
            <div className="share-link-row">
                <input id="share-link-url" className="share-url" readOnly value={link.url ?? ""} onFocus={(event) => event.currentTarget.select()} spellCheck={false} />
                <button type="button" className="button primary small" onClick={onCopy} data-testid="share-copy">
                    {copied ? <CheckIcon /> : <CopyIcon />} {copied ? t("copied") : t("copy")}
                </button>
            </div>
            <span className="share-live" role="status" aria-live="polite">{copied ? t("copied") : ""}</span>
            <p className="share-meta">
                <span>{t("viewOnly")}</span>
                <span>{link.allowDownload ? t("downloadOn") : t("downloadOff")}</span>
                {link.expiresAt !== null && <span>{t("expiresOn", { date: day(link.expiresAt) })}</span>}
            </p>
            <p className="share-meta" data-testid="share-views">
                <span>{link.views === 1 ? t("viewsOne") : t("views", { count: link.views })}</span>
                <span>{link.lastViewedAt !== null ? t("lastViewed", { date: moment(link.lastViewedAt) }) : t("notViewed")}</span>
            </p>
        </div>
    );
}

function ShareOptions({ host, days, allowDownload, disabled, t }: { host: ShareHost; days: number; allowDownload: boolean; disabled: boolean; t: ShareT }) {
    const choices = useMemo(() => (SHARE_DAY_CHOICES.includes(days) ? SHARE_DAY_CHOICES : [...SHARE_DAY_CHOICES, days].sort((a, b) => a - b)), [days]);
    return (
        <fieldset className="share-options" disabled={disabled}>
            <label className="share-option">
                <span className="share-label">{t("expiresIn")}</span>
                <select className="share-select" value={days} onChange={(event) => host.setOptions({ days: Number(event.target.value) })} aria-describedby="share-expiry-hint">
                    {choices.map((value) => <option key={value} value={value}>{DAY_LABEL[value] ? t(DAY_LABEL[value]!) : t("daysN", { count: value })}</option>)}
                </select>
                <span id="share-expiry-hint" className="muted small">{t("expiresHint", { min: SHARE_MIN_DAYS, max: SHARE_MAX_DAYS })}</span>
            </label>
            <label className="share-check">
                <input type="checkbox" checked={allowDownload} onChange={(event) => host.setOptions({ allowDownload: event.target.checked })} />
                <span>
                    <span className="share-label">{t("allowDownload")}</span>
                    <span className="muted small share-block">{t("allowDownloadHint")}</span>
                </span>
            </label>
        </fieldset>
    );
}

const STEPS = ["export", "upload", "saving", "link"] as const;
const STEP_LABEL: Record<(typeof STEPS)[number], string> = { export: "stepExport", upload: "stepUpload", saving: "stepSaving", link: "stepLink" };

function ExportProgress({ step, ratio, t }: { step: (typeof STEPS)[number]; ratio: number | null; t: ShareT }) {
    const at = STEPS.indexOf(step);
    return (
        <div className="share-progress" data-testid="share-progress" data-step={step}>
            <ol className="share-steps">
                {STEPS.map((name, i) => (
                    <li key={name} className="share-step" data-state={i < at ? "done" : i === at ? "now" : "next"}>
                        <span className="share-step-mark" aria-hidden="true">{i < at ? <CheckIcon /> : i + 1}</span>
                        <span>{t(STEP_LABEL[name])}</span>
                        {i === at && ratio !== null && <span className="share-step-percent">{t("percent", { percent: Math.round(ratio * 100) })}</span>}
                    </li>
                ))}
            </ol>
            <progress max={1} value={ratio ?? undefined} aria-label={t(STEP_LABEL[step])} />
            <span className="share-live" role="status" aria-live="polite">{t(STEP_LABEL[step])}</span>
        </div>
    );
}

function EarlierLinks({ links, t }: { links: ShareLink[]; t: ShareT }) {
    return (
        <details className="share-earlier">
            <summary>{t("earlier")} ({links.length})</summary>
            <ul>
                {links.map((link) => (
                    <li key={link.id}>
                        <span>{link.status === "revoked" ? t("revokedOn", { date: day(link.revokedAt ?? link.createdAt) }) : t("expiredOn", { date: day(link.expiresAt) })}</span>
                        <span className="muted">{link.views === 1 ? t("viewsOne") : t("views", { count: link.views })}</span>
                    </li>
                ))}
            </ul>
        </details>
    );
}
