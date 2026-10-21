// The AI director's words for states and refusals (aiDirector messages): every error code the server or Studio
// produces maps to Studio's own copy (never raw server text, except a short field message the server writes for a
// refused request, which safeDetail already filtered).
import { formatUsdExact, formatUsdNear, formatUsdUp } from "@opennan/director-client";
import type { DirectorError, TaskView, TurnView } from "./director-host";

export type DirectorT = (key: string, values?: Record<string, string | number>) => string;

export function directorErrorText(t: DirectorT, error: DirectorError | { code: "task_failed"; message: string; refunded: boolean }): string {
    switch (error.code) {
        case "insufficient_balance": return t("errInsufficient");
        case "turn_in_progress": return t("errBusy");
        case "director_unavailable": return t("errUnavailable");
        case "rate_limit_exceeded": return error.retryAfterSeconds ? t("errRate", { seconds: error.retryAfterSeconds }) : t("errRateNoTime");
        case "permission_denied": return t("errPermission");
        case "not_found": return t("errNotFound");
        case "invalid_request": return error.detail ? t("errInvalidDetail", { detail: error.detail }) : t("errInvalid");
        case "signed_out": return t("errSignedOut");
        case "network": return t("errNetwork");
        case "stream_interrupted": return t("errDropped");
        case "price_unavailable": return t("errPrice");
        case "request_refused": return t("errRefused");
        case "price_changed": return error.priceUsd === undefined ? t("errPriceRose") : t("errPriceChanged", { usd: formatUsdUp(error.priceUsd) });
        case "proposal_expired": return t("proposalExpired");
        case "idempotency_key_reused": return t("errKeyReused");
        case "task_failed": return error.refunded ? t("taskFailedRefunded") : t("taskFailed");
        default: return t("errServer");
    }
}

/** The line under a finished turn: what it charged, or how it ended. */
export function turnStatusText(t: DirectorT, turn: TurnView): string | null {
    if (turn.status === "sending" || turn.status === "running") return null;
    const charged = turn.chargedUsd ?? 0;
    if (turn.status === "cancelled") return t("stoppedCharged", { usd: formatUsdExact(charged) });
    const parts: string[] = [];
    if (turn.status === "limit") parts.push(t("statusLimit"));
    if (turn.status === "refused") parts.push(t("statusRefused"));
    if (turn.status === "failed" && !turn.error) parts.push(t("statusFailed"));
    if (turn.chargedUsd !== null) parts.push(t("charged", { usd: formatUsdExact(charged) }));
    return parts.length ? parts.join(" · ") : null;
}

export function taskStatusText(t: DirectorT, task: TaskView): string {
    switch (task.status) {
        case "starting": return t("taskStarting");
        case "queued": return t("taskQueued");
        case "running": return typeof task.progress === "number" ? t("taskRunning", { percent: Math.round(task.progress * 100) }) : t("taskRunningNoPercent");
        case "succeeded": return task.priceUsd !== undefined ? t("taskSucceeded", { usd: formatUsdExact(task.priceUsd) }) : t("taskSucceededNoPrice");
        case "cancelled": return t("taskCancelled");
        case "failed": return task.error ? directorErrorText(t, task.error) : t("taskFailed");
    }
}

export function isTaskLive(task: TaskView): boolean {
    return task.status === "starting" || task.status === "queued" || task.status === "running";
}

/** "≈ $0.08 typical · holds up to $0.43", or the hold alone, or "Priced per message". */
export function priceLineText(t: DirectorT, quote: { holdUsd: number; typicalUsd: number | null } | null): string {
    if (!quote) return t("pricePerMessage");
    if (quote.typicalUsd === null) return t("priceHoldOnly", { hold: formatUsdUp(quote.holdUsd) });
    // Rounded up like every money figure Studio shows; never "$0.00" for a typical turn.
    return t("priceLine", { typical: formatUsdNear(Math.max(0.01, quote.typicalUsd)), hold: formatUsdUp(quote.holdUsd) });
}

/** Words that must never appear in the director UI's own copy (model and supplier names). */
export const SECRET_WORDS = /\b(claude|sonnet|haiku|opus|anthropic|openai|gpt|gemini|grok|glm|llama|mistral|deepseek|qwen|poyo|seedream|kling|seedance|veo|sora|fal\.ai|replicate)\b/i;
