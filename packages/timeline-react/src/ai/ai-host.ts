// What the editor host provides for AI in the editor (phase 11) through <TimelineProvider ai={...}>. timeline-react
// draws the AI surface (inspector AI tab, AI library tab, context menu rows, job tray) and knows no provider: the host
// (apps/web's editor AI) prices runs from its providers, opens Sign in with OpenNan, queues jobs, runs ai.run on the
// controller (one undo step per result), and shows failures with Retry. A host without AI passes nothing: the surface
// then shows local tools only.
import type { AiTargetRef, AiToolId, AiToolParams } from "@opennan/timeline-core";

export type AiPriceView =
    /** "≈ $0.005": never below what the run settles at. */
    | { kind: "estimate"; label: string; usd: number }
    | { kind: "free" }
    /** Paid to another service with the user's own key (fal.ai). */
    | { kind: "billed-elsewhere"; by: string }
    | { kind: "loading" }
    /** No price could be read (offline): the button still runs and the server answers. */
    | { kind: "unknown" };

export interface AiToolView {
    id: AiToolId;
    /**
     * ready: Run. sign-in: the button reads "Sign in to OpenNan" and opens the modal. unavailable: disabled with `reason`
     * (desktop only, not live, no provider, nothing to work on). over-limit: offers "Use the first N s" (`limit`).
     */
    state: "ready" | "sign-in" | "unavailable" | "over-limit";
    reason?: string;
    price: AiPriceView;
    limit?: { maxSeconds?: number; maxCharacters?: number };
    providerName?: string;
}

export type AiJobStatus = "queued" | "preparing" | "running" | "succeeded" | "failed" | "cancelled";

export interface AiJobView {
    id: string;
    toolId: AiToolId;
    label: string;
    /** The clip or scene it runs on (its thin progress line on the timeline). */
    targetId?: string;
    status: AiJobStatus;
    /** The server's stage name ("Reading", "Isolating") or a local one ("Uploading"). */
    stage?: string;
    /** 0..1 */
    progress?: number;
    /** false after the paid step started: it will finish and be charged. */
    cancellable: boolean;
    message?: string;
    error?: string;
    /** The provider said nothing was charged. */
    refunded?: boolean;
    costUsd?: number;
    canRetry: boolean;
}

export type GenerateKind = "image" | "video" | "voice" | "music" | "sfx";

export interface TimelineAiHost {
    subscribe(listener: () => void): () => void;
    /** Increases on every change (prices loaded, jobs moved, sign-in): a snapshot key for useSyncExternalStore. */
    version(): number;
    /** The tool's state for this run, read synchronously; prices load in the background and notify. */
    tool(toolId: AiToolId, params: AiToolParams): AiToolView;
    /** Gates (sign-in), queues, runs, places (one undo step), and toasts failures with Retry. */
    run(toolId: AiToolId, params: AiToolParams): void;
    jobs(): AiJobView[];
    cancel(jobId: string): void;
    retry(jobId: string): void;
    dismiss(jobId: string): void;
    /** The AI library's tiles: the host's generate dialog in this mode. */
    openGenerate?(kind: GenerateKind, options?: { fromFrame?: boolean }): void;
    /** The host's auto-captions dialog (engine switch), on the whole timeline or one item. */
    openAutoCaptions?(target?: AiTargetRef): void;
    /** The host's Story film wizard (the AI library's Story film tile). */
    openStoryFilm?(): void;
}
