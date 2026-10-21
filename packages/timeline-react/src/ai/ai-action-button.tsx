"use client";
// The Run button of one AI tool (phase 11): its label carries the price the host read from the provider ("≈ $0.05 ·
// Run", "Run · free", "Billed by fal.ai · Run"), signed out it reads "Sign in to OpenNan" (the host opens the modal,
// then runs), unavailable it is disabled with the host's reason, and past the tool's limit it offers "Use the first
// N s". Paid runs carry the billing promise under the button. The host does the work: this only calls host.run.
import { useId } from "react";
import { Loader2, Sparkles } from "lucide-react";
import { PAID_AI_TOOLS, type AiToolId, type AiToolParams } from "@opennan/timeline-core";
import { useTimelineMessages } from "../hooks/use-timeline-messages";
import type { AiToolView } from "./ai-host";
import { plainPrice, useAiHost, useAiTool } from "./use-ai";

export interface AiActionButtonProps {
    toolId: AiToolId;
    params: AiToolParams;
    /** Replaces the host's view (a fixed reason the editor knows better, e.g. image clips). */
    view?: AiToolView | null;
    /** Runs instead of host.run (the host's own dialog); gets the params, with maxSeconds when trimmed. */
    onRun?(params: AiToolParams): void;
    /** Shown instead of "Run" (e.g. "Auto captions…" when a dialog opens first). */
    label?: string;
    testId?: string;
}

export function AiActionButton({ toolId, params, view: given, onRun, label, testId }: AiActionButtonProps) {
    const t = useTimelineMessages("studioEditor");
    const host = useAiHost();
    const hostView = useAiTool(toolId, params);
    const view = given === undefined ? hostView : given;
    const noteId = useId();
    const run = (extra: AiToolParams = {}) => {
        const next = { ...params, ...extra };
        if (onRun) onRun(next);
        else host?.run(toolId, next);
    };

    if (!host || !view) {
        return (
            <div className="on-ai-action" data-testid={testId} data-state="no-host">
                <button type="button" className="on-btn on-btn-primary on-ai-run" disabled aria-describedby={noteId} data-testid={testId ? `${testId}-run` : undefined}>
                    <Sparkles aria-hidden="true" />{label ?? t("ai_run")}
                </button>
                <p id={noteId} className="on-ai-reason" data-testid={testId ? `${testId}-reason` : undefined}>{view?.reason ?? t("ai_needsApp")}</p>
            </div>
        );
    }

    const price = view.price;
    const paid = price.kind === "estimate" || (PAID_AI_TOOLS.includes(toolId) && (price.kind === "unknown" || price.kind === "loading"));
    const verb = label ?? t("ai_run");
    const text = label ?? (price.kind === "estimate" ? t("ai_runEstimate", { price: price.label })
        : price.kind === "free" ? t("ai_runFree")
            : price.kind === "billed-elsewhere" ? t("ai_runBilledBy", { by: price.by })
                : t("ai_run"));
    const spoken = price.kind === "estimate" ? t("ai_runAriaEstimate", { verb, price: plainPrice(price.label) })
        : price.kind === "free" ? t("ai_runAriaFree", { verb })
            : price.kind === "billed-elsewhere" ? t("ai_runAriaBilledBy", { verb, by: price.by })
                : price.kind === "unknown" ? t("ai_runAriaUnknown", { verb })
                    : verb;
    const notes = (
        <>
            {price.kind === "unknown" && <p className="on-ai-note" data-testid={testId ? `${testId}-price-unknown` : undefined}>{t("ai_priceUnknown")}</p>}
            {price.kind === "loading" && <p className="on-ai-note" role="status">{t("ai_priceLoading")}</p>}
            {paid && <p className="on-ai-note" data-testid={testId ? `${testId}-billing` : undefined}>{t("ai_chargedNote")}</p>}
        </>
    );

    if (view.state === "unavailable") {
        return (
            <div className="on-ai-action" data-testid={testId} data-state="unavailable">
                <button type="button" className="on-btn on-btn-primary on-ai-run" disabled aria-describedby={noteId} data-testid={testId ? `${testId}-run` : undefined}>
                    <Sparkles aria-hidden="true" />{verb}
                </button>
                {view.reason && <p id={noteId} className="on-ai-reason" data-testid={testId ? `${testId}-reason` : undefined}>{view.reason}</p>}
            </div>
        );
    }

    if (view.state === "over-limit") {
        const seconds = view.limit?.maxSeconds;
        const characters = view.limit?.maxCharacters;
        return (
            <div className="on-ai-action" data-testid={testId} data-state="over-limit">
                <p id={noteId} className="on-ai-reason" data-testid={testId ? `${testId}-limit` : undefined}>
                    {seconds !== undefined ? t("ai_limitSeconds", { seconds }) : characters !== undefined ? t("ai_limitCharacters", { count: characters }) : view.reason}
                </p>
                {seconds !== undefined && (
                    <button
                        type="button" className="on-btn on-btn-primary on-ai-run" aria-describedby={noteId} data-testid={testId ? `${testId}-first` : undefined}
                        aria-label={price.kind === "estimate" ? t("ai_useFirstAria", { seconds, price: plainPrice(price.label) }) : undefined}
                        onClick={() => run({ maxSeconds: seconds })}
                    >
                        <Sparkles aria-hidden="true" />
                        {price.kind === "estimate" ? t("ai_useFirstPrice", { seconds, price: price.label }) : t("ai_useFirst", { seconds })}
                    </button>
                )}
                {seconds !== undefined && notes}
            </div>
        );
    }

    if (view.state === "sign-in") {
        return (
            <div className="on-ai-action" data-testid={testId} data-state="sign-in">
                <button type="button" className="on-btn on-btn-primary on-ai-run" data-testid={testId ? `${testId}-run` : undefined} onClick={() => run()}>
                    <Sparkles aria-hidden="true" />{t("ai_signIn")}
                </button>
                {price.kind === "estimate" && <p className="on-ai-note">{t("ai_signInPrice", { price: price.label })}</p>}
                {paid && <p className="on-ai-note">{t("ai_chargedNote")}</p>}
            </div>
        );
    }

    return (
        <div className="on-ai-action" data-testid={testId} data-state="ready">
            <button
                type="button" className="on-btn on-btn-primary on-ai-run" aria-label={spoken} aria-busy={price.kind === "loading" || undefined}
                // A paid run never starts before its price is shown (the host refuses it too).
                disabled={paid && price.kind !== "estimate"}
                data-testid={testId ? `${testId}-run` : undefined} onClick={() => run()}
            >
                {price.kind === "loading" ? <Loader2 aria-hidden="true" /> : <Sparkles aria-hidden="true" />}
                {text}
            </button>
            {notes}
        </div>
    );
}
