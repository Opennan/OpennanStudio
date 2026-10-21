// Hooks over the editor host's AI (phase 11, ai-host.ts). The host is optional: without it every hook answers null /
// [] and the AI surface shows local tools only. Snapshots follow host.version() through useSyncExternalStore, so a
// price that finishes loading or a job that moves re-renders the buttons and the tray.
import { useContext, useSyncExternalStore } from "react";
import type { AiToolId, AiToolParams } from "@opennan/timeline-core";
import { TimelineContext } from "../provider/context";
import type { AiJobView, AiToolView, TimelineAiHost } from "./ai-host";

const noSubscribe = () => () => undefined;
const zero = () => 0;
const EMPTY_JOBS: AiJobView[] = [];

/** The host's AI, or null (local tools only). */
export function useAiHost(): TimelineAiHost | null {
    return useContext(TimelineContext)?.ai ?? null;
}

/** Re-renders on every host change; returns the host's version (0 without a host). */
export function useAiVersion(host: TimelineAiHost | null): number {
    return useSyncExternalStore(host ? host.subscribe : noSubscribe, host ? host.version : zero, host ? host.version : zero);
}

/** The tool's state for these params, read on every host change; null without a host. */
export function useAiTool(toolId: AiToolId, params: AiToolParams): AiToolView | null {
    const host = useAiHost();
    useAiVersion(host);
    return host ? host.tool(toolId, params) : null;
}

/** The host's jobs (all, or those on one clip or scene). */
export function useAiJobs(targetId?: string): AiJobView[] {
    const host = useAiHost();
    useAiVersion(host);
    if (!host) return EMPTY_JOBS;
    const jobs = host.jobs();
    return targetId === undefined ? jobs : jobs.filter((job) => job.targetId === targetId);
}

/** "$0.13", "$0.005", "$1.30": what a finished run cost, rounded up (never shown under it). */
export function formatUsd(usd: number): string {
    if (!Number.isFinite(usd) || usd <= 0) return "$0";
    const micro = Math.round(usd * 1_000_000);
    if (micro >= 100_000) return `$${(Math.ceil(micro / 10_000) / 100).toFixed(2)}`;
    // Up to three decimals, trailing zeros dropped (0.050 → $0.05); never "$0" for a real charge.
    const mills = Math.max(1, Math.ceil(micro / 1_000));
    return `$${(mills / 1_000).toFixed(mills % 10 === 0 ? 2 : 3)}`;
}

/** The price figure without the "≈ " prefix, for spoken names ("Run, about $0.05"). */
export function plainPrice(label: string): string {
    return label.replace(/^≈\s*/, "").trim();
}
