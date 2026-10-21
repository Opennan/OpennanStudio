// The editor's AI host (phase 11): the TimelineAiHost that timeline-react's AI surface (inspector AI tab, AI library,
// context menu rows, job tray) draws from. It plans each run with timeline-core's planAiTool (the same plan MCP uses),
// prices it with the routed provider's price() ("≈ $x", never below the settle), opens Sign in with OpenNan when the
// account is signed out, queues up to two cloud jobs, runs ai.run on the controller (each result one undo step, saved to
// Media by the runner's importMedia), and shows failures with Retry. Nothing retries by itself. Phase 11.1: prices are
// the server's quotes when it gives them; price reads while the surface changes (a trim drag, option clicks) are
// debounced per tool and item, and a paid run checks the account's balance against what the run holds.
import {
    capabilityUnavailableMessage, displayedUsd, isProviderCapability, OPENNAN_PROVIDER_ID,
    type PriceAnswer, type Provider, type ProviderCapability, type ProviderRegistry,
} from "@opennan/provider-sdk";
import {
    planAiTool, type AiRunProgress, type AiToolId, type AiToolParams, type AiToolPlan, type AiToolPlanResult, type CommandResult,
    type ControllerSnapshot, type EditorCommand, type ExecuteOptions, type TimelineToast,
} from "@opennan/timeline-core";
import type { AiJobView, AiPriceView, AiToolView, GenerateKind, TimelineAiHost } from "@opennan/timeline-react";
import { holdCovered, holdOf, type HoldAccount } from "./hold-check";

/** What people call each tool (job rows, toasts, the sign-in modal's context line). */
export const AI_TOOL_NAMES: Record<AiToolId, string> = {
    captions: "Auto captions",
    "caption-translate": "Translate captions",
    "voice-isolation": "Isolate voice",
    "video-upscale": "Upscale video",
    "remove-background": "Remove background",
    lipsync: "Lip sync",
    stems: "Split vocals",
    silences: "Remove silences",
    fillers: "Remove filler words",
    beats: "Detect beats",
    stabilize: "Stabilize",
};

export const MAX_RUNNING_AI_JOBS = 2;
/** Price reads for one tool on one item wait this long for the surface to settle (never a run's own read). */
export const PRICE_DEBOUNCE_MS = 250;
export const PRICE_UNREADABLE = "The price could not be read. Try again in a moment.";
/** An unreadable price is asked again after this long (never on every render). */
const PRICE_RETRY_MS = 10_000;
const PRICE_CHANGED = /^The price changed: ≈ \$([0-9]+(?:\.[0-9]+)?)/;
export const DESKTOP_ONLY = "Desktop app only";
const CREDITS_PREFIX = "Not enough credits";
const NOT_CHARGED = /not charged|refunded/i;

export interface EditorAiOptions {
    controller: {
        execute(command: EditorCommand, options?: ExecuteOptions): Promise<CommandResult>;
        snapshot(): ControllerSnapshot;
    };
    providers: ProviderRegistry;
    isSignedIn(): boolean;
    /** Opens Sign in with OpenNan with the feature as its context line; resolves true when it closes signed in. */
    openSignIn(feature: string): Promise<boolean>;
    toast(toast: TimelineToast): void;
    /** The thin progress line on the clip or scene a job runs on (null removes it). */
    activity?(itemId: string, progress: number | null): void;
    /** Called after a paid run settles (the balance in the account chip). */
    refreshAccount?(): void;
    openGenerate?(kind: GenerateKind, options?: { fromFrame?: boolean }): void;
    openAutoCaptions?: TimelineAiHost["openAutoCaptions"];
    /** The OpenNan balance (null: unknown) and a fresh read of it, checked against what a paid run holds. */
    account?: HoldAccount;
    /** The balance does not cover what the run holds (after a fresh read): nothing is sent. */
    notEnoughCredits?(holdUsd: number): void;
    /** Tests: 0 reads prices at once. */
    priceDebounceMs?: number;
    /** Tests inject plans; the editor uses planAiTool. */
    plan?(snapshot: ControllerSnapshot, toolId: AiToolId, params: AiToolParams): AiToolPlanResult;
    maxRunning?: number;
    now?(): number;
}

interface Job {
    view: AiJobView;
    toolId: AiToolId;
    params: AiToolParams;
    plan: AiToolPlan;
    expectedMaxUsd?: number;
    abort: AbortController;
    providerId: string | null;
}

export type EditorAi = TimelineAiHost & { dispose(): void };

function priceKey(providerId: string, plan: AiToolPlan, units: AiToolPlan["units"]): string {
    const input = plan.input;
    return JSON.stringify([providerId, plan.capability, units, input.model ?? null, input.resolution ?? null, input.stems ?? null, input.engine ?? null]);
}

/** The units a price is asked for: past the limit, the first N seconds the run would send. */
function pricedUnits(plan: AiToolPlan): AiToolPlan["units"] {
    if (plan.overLimit?.kind === "seconds") return { ...plan.units, seconds: plan.overLimit.max };
    return plan.units;
}

export function createEditorAi(options: EditorAiOptions): EditorAi {
    const listeners = new Set<() => void>();
    const prices = new Map<string, { answer: PriceAnswer | "loading"; at: number }>();
    const now = options.now ?? Date.now;
    const jobs: Job[] = [];
    let changes = 0;
    let serial = 0;
    let disposed = false;
    const maxRunning = options.maxRunning ?? MAX_RUNNING_AI_JOBS;
    const debounceMs = options.priceDebounceMs ?? PRICE_DEBOUNCE_MS;
    /** Debounced price reads: one pending key per tool, item, and provider. */
    const pendingReads = new Map<string, { key: string; timer: ReturnType<typeof setTimeout>; item: string | null }>();
    const plan = options.plan ?? planAiTool;

    const changed = () => {
        changes += 1;
        for (const listener of [...listeners]) listener();
    };
    const stopRegistry = options.providers.subscribe(() => {
        prices.clear();
        // Reads waiting on the old providers are dropped; the next render asks the new ones.
        for (const pending of pendingReads.values()) clearTimeout(pending.timer);
        pendingReads.clear();
        changed();
    });

    /** The provider a plan runs on: the captions engine pick, else the registry's route. */
    function providerOf(planned: AiToolPlan): Provider | null {
        if (!isProviderCapability(planned.capability)) return null;
        const capability = planned.capability as ProviderCapability;
        const engine = planned.input.engine;
        if (engine === "local" || engine === "cloud") {
            const onDevice = engine === "local";
            return options.providers.providers().find((p) => p.info.capabilities.includes(capability) && Boolean(p.info.onDevice) === onDevice) ?? null;
        }
        return options.providers.route(capability);
    }

    function loadPrice(key: string, provider: Provider, planned: AiToolPlan, units: AiToolPlan["units"]): Promise<PriceAnswer> | null {
        const cached = prices.get(key);
        // A known answer is kept; an unreadable one is asked again after a while, never on every render.
        if (cached && (cached.answer === "loading" || cached.answer.kind !== "unknown" || now() - cached.at < PRICE_RETRY_MS)) return null;
        if (!provider.price) return null;
        const entry = { answer: "loading" as PriceAnswer | "loading", at: now() };
        prices.set(key, entry);
        return provider.price({ capability: planned.capability as ProviderCapability, input: planned.input, units })
            .catch((): PriceAnswer => ({ kind: "unknown" }))
            .then((answer) => {
                if (!disposed && prices.get(key) === entry) {
                    prices.set(key, { answer, at: now() });
                    changed();
                    // An unreadable price is asked again on its own: the next read after the wait refetches it.
                    if (answer.kind === "unknown") setTimeout(() => {
                        if (!disposed) changed();
                    }, PRICE_RETRY_MS);
                }
                return answer;
            });
    }

    /**
     * The price answer for a plan (loading kicks off a fetch), or null when the provider has no prices. A price not
     * read yet waits PRICE_DEBOUNCE_MS: a newer one for the same tool and item replaces it (one read where it stopped).
     */
    function priceOf(provider: Provider, planned: AiToolPlan, params: AiToolParams): PriceAnswer | "loading" | null {
        if (!provider.price) return null;
        const units = pricedUnits(planned);
        const key = priceKey(provider.info.id, planned, units);
        if (prices.has(key) || debounceMs <= 0) {
            loadPrice(key, provider, planned, units);
            return prices.get(key)?.answer ?? "loading";
        }
        // One slot per tool and item as the surface names it (its params): a trim drag keeps the slot, two tracks don't share one.
        const slot = JSON.stringify([provider.info.id, planned.toolId, params]);
        const pending = pendingReads.get(slot);
        if (pending?.key === key) return "loading";
        if (pending) clearTimeout(pending.timer);
        // A named item (clip or scene) has one surface: a read still waiting for its old options is dropped.
        const item = planned.target.clipId || planned.target.sceneId ? JSON.stringify([provider.info.id, planned.toolId, planned.target.clipId ?? null, planned.target.sceneId ?? null]) : null;
        if (item) {
            for (const [other, entry] of pendingReads) {
                if (other !== slot && entry.item === item) {
                    clearTimeout(entry.timer);
                    pendingReads.delete(other);
                }
            }
        }
        const timer = setTimeout(() => {
            if (pendingReads.get(slot)?.key !== key) return;
            pendingReads.delete(slot);
            if (disposed) return;
            loadPrice(key, provider, planned, units);
            changed();
        }, debounceMs);
        pendingReads.set(slot, { key, timer, item });
        return "loading";
    }

    /** The price answer for a plan, waiting for it when it is still loading. */
    async function settledPrice(provider: Provider, planned: AiToolPlan): Promise<PriceAnswer | null> {
        if (!provider.price) return null;
        const units = pricedUnits(planned);
        const key = priceKey(provider.info.id, planned, units);
        const cached = prices.get(key);
        if (cached && cached.answer !== "loading" && (cached.answer.kind !== "unknown" || now() - cached.at < PRICE_RETRY_MS)) return cached.answer;
        const pending = loadPrice(key, provider, planned, units);
        if (pending) return pending;
        return provider.price({ capability: planned.capability as ProviderCapability, input: planned.input, units }).catch((): PriceAnswer => ({ kind: "unknown" }));
    }

    function priceView(answer: PriceAnswer | "loading" | null): AiPriceView {
        if (answer === "loading") return { kind: "loading" };
        if (answer === null) return { kind: "unknown" };
        switch (answer.kind) {
            case "estimate":
                return { kind: "estimate", label: answer.estimate.label, usd: answer.estimate.usd };
            case "free":
                return { kind: "free" };
            case "billed-elsewhere":
                return { kind: "billed-elsewhere", by: answer.by };
            default:
                return { kind: "unknown" };
        }
    }

    function view(toolId: AiToolId, params: AiToolParams): { tool: AiToolView; plan?: AiToolPlan; provider?: Provider | null; answer?: PriceAnswer | "loading" | null } {
        const name = AI_TOOL_NAMES[toolId];
        const result = plan(options.controller.snapshot(), toolId, params);
        if (!result.ok) return { tool: { id: toolId, state: "unavailable", reason: result.error, price: { kind: "unknown" } } };
        const planned = result.plan;
        if (planned.capability === "local") return { tool: { id: toolId, state: "ready", price: { kind: "free" } }, plan: planned, provider: null };
        const provider = providerOf(planned);
        if (!provider) {
            const reason = planned.capability === "media.stabilize"
                ? DESKTOP_ONLY
                : isProviderCapability(planned.capability) ? capabilityUnavailableMessage(name, planned.capability) : `${name} is not available here.`;
            return { tool: { id: toolId, state: "unavailable", reason, price: { kind: "unknown" } }, plan: planned, provider: null };
        }
        const answer = priceOf(provider, planned, params);
        const base = { id: toolId, providerName: provider.info.name, price: priceView(answer) };
        if (answer !== "loading" && answer !== null) {
            if (answer.kind === "unavailable") return { tool: { ...base, state: "unavailable", reason: answer.reason }, plan: planned, provider, answer };
            // A paid run never starts without a price (Decision 1).
            if (answer.kind === "unknown") return { tool: { ...base, state: "unavailable", reason: PRICE_UNREADABLE }, plan: planned, provider, answer };
            if (answer.kind === "over-limit" && answer.limit.kind === "seconds") {
                return { tool: { ...base, state: "over-limit", limit: { maxSeconds: answer.limit.max } }, plan: planned, provider, answer };
            }
        }
        if (planned.overLimit) {
            const limit = planned.overLimit.kind === "seconds" ? { maxSeconds: planned.overLimit.max } : { maxCharacters: planned.overLimit.max };
            const state = planned.overLimit.kind === "seconds" ? "over-limit" : "unavailable";
            const reason = planned.overLimit.kind === "seconds" ? undefined : `${name} takes at most ${planned.overLimit.max.toLocaleString("en-US")} ${planned.overLimit.kind} at once.`;
            return { tool: { ...base, state, limit, ...(reason ? { reason } : {}) }, plan: planned, provider, answer };
        }
        const needsSignIn = provider.info.id === OPENNAN_PROVIDER_ID && !options.isSignedIn();
        return { tool: { ...base, state: needsSignIn ? "sign-in" : "ready" }, plan: planned, provider, answer };
    }

    function running(): number {
        return jobs.filter((job) => job.view.status === "preparing" || job.view.status === "running").length;
    }

    function update(job: Job, patch: Partial<AiJobView>): void {
        job.view = { ...job.view, ...patch };
        changed();
    }

    function pump(): void {
        while (!disposed && running() < maxRunning) {
            const next = jobs.find((job) => job.view.status === "queued");
            if (!next) return;
            void start(next);
        }
    }

    async function start(job: Job): Promise<void> {
        update(job, { status: "preparing", stage: "Preparing" });
        const target = job.plan.target.clipId ?? job.plan.target.sceneId;
        const onProgress = (progress: AiRunProgress & { cancellable?: boolean }) => {
            if (job.view.status !== "preparing" && job.view.status !== "running") return;
            const patch: Partial<AiJobView> = { status: progress.status === "queued" ? "preparing" : "running" };
            if (progress.message !== undefined) patch.stage = progress.message;
            if (progress.progress !== undefined) patch.progress = progress.progress;
            if (progress.cancellable === false) {
                patch.cancellable = false;
                if (progress.message) patch.message = progress.message;
            }
            update(job, patch);
            if (target && progress.progress !== undefined) options.activity?.(target, progress.progress);
        };
        if (target) options.activity?.(target, 0);
        const input = job.expectedMaxUsd !== undefined ? { ...job.plan.input, expectedMaxUsd: job.expectedMaxUsd } : job.plan.input;
        let result: CommandResult;
        try {
            result = await options.controller.execute(
                { type: "ai.run", capability: job.plan.capability, input, ...(job.plan.placeAt ? { placeAt: job.plan.placeAt } : {}) },
                { signal: job.abort.signal, onProgress, toastOnError: false },
            );
        } catch (error) {
            result = { ok: false, changed: {}, error: error instanceof Error ? error.message : String(error) };
        }
        if (target) options.activity?.(target, null);
        finish(job, result);
        pump();
    }

    function finish(job: Job, result: CommandResult): void {
        const name = AI_TOOL_NAMES[job.toolId];
        if (result.ok) {
            const output = result.output as { costUsd?: unknown } | undefined;
            const cost = typeof output?.costUsd === "number" ? output.costUsd : undefined;
            update(job, { status: "succeeded", progress: 1, stage: undefined, cancellable: false, ...(cost !== undefined ? { costUsd: cost } : {}) });
            if (result.createdClipIds && result.createdClipIds.length > 0) void options.controller.execute({ type: "selection.set", clipIds: result.createdClipIds });
            if (job.providerId === OPENNAN_PROVIDER_ID) options.refreshAccount?.();
            return;
        }
        if (result.cancelled) {
            update(job, { status: "cancelled", stage: undefined, cancellable: false, message: "Cancelled. You were not charged.", refunded: true, canRetry: true });
            return;
        }
        const error = result.error ?? `${name} failed.`;
        const refunded = NOT_CHARGED.test(error) || result.unavailable === true || error.startsWith(CREDITS_PREFIX);
        update(job, { status: "failed", stage: undefined, cancellable: false, error, refunded, canRetry: true });
        if (job.providerId === OPENNAN_PROVIDER_ID) options.refreshAccount?.();
        // Not enough credits: the account's own toast says it, with Buy credits.
        if (error.startsWith(CREDITS_PREFIX)) return;
        // The price went up once the file was prepared: Retry is the user accepting the new amount, which the toast names.
        const changedTo = PRICE_CHANGED.exec(error);
        if (changedTo) {
            const accepted = Number(changedTo[1]);
            options.toast({ id: `ai-${job.view.id}`, kind: "error", message: `${name}: ${error}`, action: { label: `Run at ≈ $${changedTo[1]}`, run: () => void run(job.toolId, job.params, accepted) } });
            return;
        }
        options.toast({ id: `ai-${job.view.id}`, kind: "error", message: `${name}: ${error}`, action: { label: "Retry", run: () => host.retry(job.view.id) } });
    }

    async function run(toolId: AiToolId, params: AiToolParams, acceptedUsd?: number): Promise<void> {
        const name = AI_TOOL_NAMES[toolId];
        let current = view(toolId, params);
        const unreadable = current.tool.state === "unavailable" && current.tool.reason === PRICE_UNREADABLE;
        if (!current.plan || (current.tool.state === "unavailable" && !unreadable)) {
            if (current.tool.reason) options.toast({ kind: "error", message: current.tool.reason });
            return;
        }
        if (current.tool.state === "over-limit" || current.plan.overLimit) return;
        if (current.plan.capability === "local") return;
        if (current.tool.state === "sign-in") {
            const signedIn = await options.openSignIn(name);
            if (!signedIn || disposed) return;
            current = view(toolId, params);
            if (!current.plan || current.tool.state !== "ready") return;
        }
        // The price the button showed: the provider re-checks it against the prepared file and refuses a higher one.
        // A provider with prices must give one before a paid run starts.
        const answer = current.provider ? await settledPrice(current.provider, current.plan) : null;
        if (disposed) return;
        if (answer && answer.kind === "unavailable") {
            options.toast({ kind: "error", message: answer.reason });
            return;
        }
        if (current.provider?.price && (!answer || answer.kind === "unknown" || answer.kind === "over-limit")) {
            options.toast({ kind: "error", message: answer?.kind === "over-limit" ? `${name} is over its limit: use the first ${answer.limit.max} s.` : PRICE_UNREADABLE });
            changed();
            return;
        }
        // The balance must cover what the run holds (a quote's hold; else the estimate's amount): nothing is sent otherwise.
        const hold = current.provider?.info.id === OPENNAN_PROVIDER_ID && answer?.kind === "estimate" ? holdOf(answer.estimate) : undefined;
        if (hold !== undefined && !(await holdCovered(options.account, hold))) {
            if (!disposed) options.notEnoughCredits?.(hold);
            return;
        }
        if (disposed) return;
        const planned = current.plan;
        const id = `ai-${++serial}`;
        const job: Job = {
            toolId, params, plan: planned, abort: new AbortController(), providerId: current.provider?.info.id ?? null,
            // The amount on the label (rounded up): the provider refuses a run whose prepared file would cost more.
            ...(answer && answer.kind === "estimate"
                ? { expectedMaxUsd: Math.max(displayedUsd(answer.estimate.microUsd), acceptedUsd ?? 0) }
                : acceptedUsd !== undefined ? { expectedMaxUsd: acceptedUsd } : {}),
            view: {
                id, toolId, label: planned.label, status: "queued", cancellable: true, canRetry: false,
                ...((planned.target.clipId ?? planned.target.sceneId) ? { targetId: planned.target.clipId ?? planned.target.sceneId } : {}),
            },
        };
        jobs.push(job);
        changed();
        pump();
    }

    const host: EditorAi = {
        subscribe(listener) {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
        version: () => changes,
        tool: (toolId, params) => view(toolId, params).tool,
        run(toolId, params) {
            void run(toolId, params);
        },
        jobs: () => jobs.map((job) => job.view),
        cancel(jobId) {
            const job = jobs.find((j) => j.view.id === jobId);
            if (!job || !job.view.cancellable) return;
            if (job.view.status === "queued") {
                update(job, { status: "cancelled", cancellable: false, message: "Cancelled.", canRetry: true });
                return;
            }
            if (job.view.status === "preparing" || job.view.status === "running") job.abort.abort();
        },
        retry(jobId) {
            const job = jobs.find((j) => j.view.id === jobId);
            if (!job) return;
            // A job stopped by a price rise shows the new amount; retrying it is accepting that amount.
            const changedTo = PRICE_CHANGED.exec(job.view.error ?? "");
            void run(job.toolId, job.params, changedTo ? Number(changedTo[1]) : undefined);
        },
        dismiss(jobId) {
            const index = jobs.findIndex((j) => j.view.id === jobId);
            if (index < 0) return;
            const status = jobs[index]!.view.status;
            if (status === "preparing" || status === "running") return;
            jobs.splice(index, 1);
            changed();
        },
        ...(options.openGenerate ? { openGenerate: options.openGenerate } : {}),
        ...(options.openAutoCaptions ? { openAutoCaptions: options.openAutoCaptions } : {}),
        dispose() {
            disposed = true;
            stopRegistry();
            for (const pending of pendingReads.values()) clearTimeout(pending.timer);
            pendingReads.clear();
            for (const job of jobs) if (job.view.status === "preparing" || job.view.status === "running") job.abort.abort();
            listeners.clear();
        },
    };
    return host;
}
