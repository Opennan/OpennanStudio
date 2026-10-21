"use client";
// The AI job tray (phase 11): one row per job the host queued — its label, stage and percent with a thin progress bar,
// Cancel while it can still stop ("Cancel · refunded" before the paid step; "Already running: it will finish and be
// charged." once it cannot), the error with Retry and Dismiss when it failed, "Done" with what it cost when it
// finished. The editor host mounts it once (all jobs); the inspector's AI tab shows the rows of its own item inline.
// Renders nothing without a host or without jobs.
import { Check, RotateCcw, X } from "lucide-react";
import { useTimelineMessages } from "../hooks/use-timeline-messages";
import type { AiJobView } from "./ai-host";
import { formatUsd, useAiHost, useAiJobs } from "./use-ai";

export interface AiJobTrayProps {
    /** Only the jobs on this clip or scene (the inspector's inline rows). */
    targetId?: string;
    className?: string;
}

const ACTIVE = new Set<AiJobView["status"]>(["queued", "preparing", "running"]);

export function AiJobTray({ targetId, className }: AiJobTrayProps) {
    const t = useTimelineMessages("studioEditor");
    const host = useAiHost();
    const jobs = useAiJobs(targetId);
    if (!host || jobs.length === 0) return null;
    return (
        <section className={`on-ai-tray ${className ?? ""}`} aria-label={t("ai_jobsLabel")} data-testid={targetId ? "ai-job-tray-inline" : "ai-job-tray"} data-inline={targetId ? "true" : undefined}>
            <ul className="on-ai-jobs">
                {jobs.map((job) => <AiJobRow key={job.id} job={job} />)}
            </ul>
        </section>
    );
}

function AiJobRow({ job }: { job: AiJobView }) {
    const t = useTimelineMessages("studioEditor");
    const host = useAiHost()!;
    const active = ACTIVE.has(job.status);
    const percent = job.progress !== undefined ? Math.round(Math.max(0, Math.min(1, job.progress)) * 100) : null;
    const stage = job.status === "queued" ? t("ai_jobQueued") : job.stage || (job.status === "preparing" ? t("ai_jobPreparing") : t("ai_jobRunning"));
    const charging = active && !job.cancellable;
    const canCancel = active && job.cancellable;
    const refundedCancel = job.status === "queued" || job.status === "preparing";
    return (
        <li className="on-ai-job" data-status={job.status} data-testid={`ai-job-${job.id}`}>
            <div className="on-ai-job-head">
                <span className="on-ai-job-label">{job.label}</span>
                {job.status === "succeeded" && <span className="on-ai-job-done"><Check aria-hidden="true" />{t("ai_jobDone")}</span>}
            </div>
            {active && (
                <>
                    <p className="on-ai-job-stage" role="status" aria-live="polite">
                        {percent !== null && job.status !== "queued" ? t("ai_jobStagePercent", { stage, percent }) : stage}
                    </p>
                    <div
                        className="on-ai-progress" role="progressbar" aria-label={t("ai_jobProgressLabel", { label: job.label })} aria-valuemin={0} aria-valuemax={100}
                        aria-valuenow={percent ?? undefined} data-indeterminate={percent === null || undefined}
                    >
                        <span style={{ width: `${percent ?? 0}%` }} />
                    </div>
                </>
            )}
            {charging && <p className="on-ai-job-message" data-testid={`ai-job-${job.id}-charging`}>{job.message || t("ai_jobAlreadyRunning")}</p>}
            {job.status === "failed" && (
                <p className="on-ai-job-error" role="alert">
                    {job.error ?? t("ai_jobFailed")}
                    {job.refunded && <span className="on-ai-job-refund"> {t("ai_jobNotCharged")}</span>}
                </p>
            )}
            {job.status === "succeeded" && job.costUsd !== undefined && job.costUsd > 0 && (
                <p className="on-ai-job-message" data-testid={`ai-job-${job.id}-cost`}>{t("ai_jobCharged", { cost: formatUsd(job.costUsd) })}</p>
            )}
            {job.status === "cancelled" && <p className="on-ai-job-message">{job.message || t("ai_jobCancelled")}</p>}
            <div className="on-ai-job-actions">
                {canCancel && (
                    <button type="button" className="on-btn on-btn-ghost on-ai-job-btn" aria-label={t("ai_jobCancelNamed", { label: job.label })} data-testid={`ai-job-${job.id}-cancel`} onClick={() => host.cancel(job.id)}>
                        <X aria-hidden="true" />{refundedCancel ? t("ai_jobCancelRefunded") : t("ai_jobCancel")}
                    </button>
                )}
                {job.status === "failed" && job.canRetry && (
                    <button type="button" className="on-btn on-ai-job-btn" data-testid={`ai-job-${job.id}-retry`} onClick={() => host.retry(job.id)}>
                        <RotateCcw aria-hidden="true" />{t("ai_jobRetry")}
                    </button>
                )}
                {!active && (
                    <button type="button" className="on-btn on-btn-ghost on-ai-job-btn" aria-label={t("ai_jobDismissNamed", { label: job.label })} data-testid={`ai-job-${job.id}-dismiss`} onClick={() => host.dismiss(job.id)}>
                        {t("ai_jobDismiss")}
                    </button>
                )}
            </div>
        </li>
    );
}
