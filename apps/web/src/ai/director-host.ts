// The AI director's host for one open cloud project (phase 9b): it sends a message as a director turn and reads the
// turn's events into a list the panel draws; feeds the cloud sync (faster polls while AI works, a pull on every
// change the turn reports); records each turn's changes, and each finished pipeline task's, as one undo step through
// the controller; marks the items the AI changed; runs proposals, the storyboard board and the script wizard's paid
// steps through the project task runner, each priced first (the larger of the proposal's quote and a fresh one) and
// checked against the balance; and maps every refusal to Studio's own words. Nothing is retried on its own, a paid
// step never runs without a price, and a proposal's request goes out only when it is a pipeline route of this project.
import { isCloudApiError, type CloudApi, type OpenNanCloudBackend, type RemoteStep } from "@opennan/cloud-backend";
import {
    cancelTurn, checkPipelineRequest, createProjectTasks, createQuotes, getTurn, listTurns, streamTurn, STREAM_INTERRUPTED,
    type CheckedRequest, type DirectorEvent, type DirectorQuotes, type DirectorTurn, type ProjectTaskHandle, type ProjectTaskState, type ProjectTasks,
    type Proposal, type Quote, type TurnChange, type TurnQuote, type TurnSelection, type TurnStatus,
} from "@opennan/director-client";
import type { LocalDoc } from "@opennan/cloud-backend";
import { holdCovered, type HoldAccount } from "./hold-check";

/** Paid tools in chat: 0 = ask each time (every paid tool comes back as a proposal). */
export const BUDGET_CHOICES = [0, 1, 5, 25] as const;
export type BudgetUsd = (typeof BUDGET_CHOICES)[number];
export const BUDGET_STORAGE_KEY = "opennan-studio:director-budget";
/** How long the timeline marks the items a turn or task changed. */
export const HIGHLIGHT_MS = 8_000;
/** Stop: when the stream has not finished this long after the cancel, it is closed (the server cancels a dropped turn). */
export const STOP_GRACE_MS = 10_000;
export const HISTORY_PAGE = 20;
/** At most this many paid project tasks of this editor run at once (the server allows 2 heavy runs an account). */
export const MAX_RUNNING_TASKS = 2;
export const MAX_QUOTES_IN_FLIGHT = 2;
/** A stopped turn's final state is read this many times, this far apart. */
export const SETTLE_READS = 10;
export const SETTLE_INTERVAL_MS = 1_000;
/** A turn running on another device is checked this often (the banner clears when it ends). */
export const BUSY_CHECK_MS = 5_000;
/** Prices are compared to the micro-dollar. */
export const PRICE_EPSILON = 0.000001;

export type DirectorErrorCode =
    | "insufficient_balance" | "turn_in_progress" | "director_unavailable" | "rate_limit_exceeded" | "permission_denied" | "not_found"
    | "invalid_request" | "signed_out" | "network" | "stream_interrupted" | "server_error" | "price_unavailable" | "request_refused" | "price_changed"
    | "proposal_expired" | "idempotency_key_reused";

export interface DirectorError {
    code: DirectorErrorCode;
    /** Seconds to wait (rate limits). */
    retryAfterSeconds?: number;
    /** The server's own field message, only for invalid_request and refused quotes (short, one line). */
    detail?: string;
    /** price_changed: what it would hold now. */
    priceUsd?: number;
}

export interface TaskView {
    id: string | null;
    label: string;
    status: "starting" | ProjectTaskState["status"];
    progress?: number;
    priceUsd?: number;
    holdUsd?: number;
    error?: DirectorError | { code: "task_failed"; message: string; refunded: boolean };
    cancelMessage?: string;
    sceneId?: string;
}

export interface CardView {
    callId: string;
    tool: string;
    label: string;
    /** The server's shown arguments (a paid step's scene). */
    args?: Record<string, unknown>;
    done: boolean;
    ok?: boolean;
    summary?: string;
    revision?: number;
    failure?: string;
    /** A paid step the director ran inside the budget. */
    task?: TaskView;
    proposal?: boolean;
}

export interface ProposalView {
    callId: string;
    label: string;
    args: Record<string, unknown>;
    /** What the card shows and checks: the proposal's quote (run by id), or the price a rise showed. */
    quote: Quote;
    request: CheckedRequest | null;
    /** The proposal's opaque run (phase 9c): the server runs it at most at its quote. null on older servers. */
    run: CheckedRequest | null;
    /** When it can no longer run (epoch ms), if the server said. */
    expiresAt: number | null;
    /** The task a run made (a past turn's proposal that ran). */
    taskId: string | null;
    /** The price rose since it was proposed: the next click runs the step's own request at most at `quote` (9b rules). */
    priceChanged?: boolean;
    /** Its run by id ran and failed: a Retry runs the step's own request (9b rules; the server answers a run once). */
    viaRequest?: boolean;
    state: "ready" | "checking" | "running" | "done" | "failed" | "blocked" | "expired" | "ran";
    task?: TaskView;
    error?: DirectorError;
}

export interface TurnView {
    key: string;
    turnId: string | null;
    message: string;
    status: TurnStatus | "sending";
    thinking: boolean;
    texts: string[];
    cards: CardView[];
    proposals: ProposalView[];
    holdUsd: number | null;
    chargedUsd: number | null;
    error: DirectorError | null;
    /** This turn's undo step on this device (null: nothing to undo here). */
    step: { stepId: number; label: string; undone: boolean } | null;
    stopping: boolean;
    /** Read from the history (no undo step: it ran before this editor opened). */
    past: boolean;
}

export interface DirectorState {
    turns: TurnView[];
    loading: boolean;
    hasMore: boolean;
    running: boolean;
    quote: TurnQuote | null;
    quoteLoaded: boolean;
    budgetUsd: BudgetUsd;
    /** A turn of this project runs on another device (409 turn_in_progress). */
    busyElsewhere: string | null;
    error: DirectorError | null;
    /** Pipeline tasks of this editor (board, wizard, proposals), newest last. */
    tasks: TaskView[];
}

export interface ProjectScript {
    scriptText: string | null;
    srtContent: string | null;
    cues: number;
    revision: number;
}

type Snapshot = { tracks: LocalDoc["tracks"]; clips: LocalDoc["clips"]; scenes: LocalDoc["scenes"] };

export interface DirectorHostDeps {
    api: CloudApi;
    backend: Pick<OpenNanCloudBackend, "setAiActive" | "pullSoon" | "waitForRevision" | "beginRemoteGroup" | "endRemoteGroup" | "recordRemoteGroup" | "isNewestRemoteStep" | "undoRemoteStep" | "revision">;
    /** Studio's id of the project ("cloud-<id>") and the server's. */
    projectId: string;
    serverId: string;
    controller: {
        recordExternalStep(record: () => Promise<{ before: Snapshot; after?: Snapshot } | null>): Promise<boolean>;
        execute(command: { type: "history.undo" }): Promise<{ ok: boolean }>;
    };
    /** What the person has selected (read as context by the director). */
    selection?(): TurnSelection | undefined;
    /** Marks items as changed by the AI (null clears the mark). */
    highlight?(ids: { scenes: string[]; clips: string[] }, on: boolean): void;
    account?: HoldAccount;
    /** The balance doesn't cover what a message or a step holds: nothing was sent. */
    notEnoughCredits(holdUsd: number, what: "message" | "step"): void;
    /** A paid step failed (or OpenNan refused it): the failure toast with Retry. Nothing is retried on its own. */
    failed?(task: TaskView, retry: () => void): void;
    isSignedIn(): boolean;
    openSignIn(): Promise<boolean>;
    /** Labels for undo steps ("AI: …"). */
    label?(text: string): string;
    storage?: Pick<Storage, "getItem" | "setItem"> | null;
    quotes?: DirectorQuotes;
    tasks?: ProjectTasks;
    now?(): number;
    setTimeout?(callback: () => void, ms: number): unknown;
    clearTimeout?(handle: unknown): void;
}

function snapshotOf(doc: LocalDoc): Snapshot {
    return { tracks: doc.tracks, clips: doc.clips, scenes: doc.scenes };
}

function errorOf(error: unknown): DirectorError {
    if (!isCloudApiError(error)) return { code: "server_error" };
    switch (error.code) {
        case "insufficient_balance": return { code: "insufficient_balance" };
        case "turn_in_progress": return { code: "turn_in_progress" };
        case "director_unavailable": return { code: "director_unavailable" };
        case "rate_limit_exceeded": case "rate_limited":
            return { code: "rate_limit_exceeded", ...(error.retryAfterSeconds !== undefined ? { retryAfterSeconds: error.retryAfterSeconds } : {}) };
        case "permission_denied": case "forbidden": return { code: "permission_denied" };
        case "not_found": case "project_not_found": return { code: "not_found" };
        case "signed_out": case "invalid_api_key": case "unauthorized": return { code: "signed_out" };
        case "network": return { code: "network" };
        case "proposal_expired": return { code: "proposal_expired" };
        // The click's Idempotency-Key was already used for another request (9c.1): nothing ran under it.
        case "idempotency_key_reused": return { code: "idempotency_key_reused" };
        case "proposal_price_changed": {
            const price = error.details?.price_usd;
            return { code: "price_changed", ...(typeof price === "number" && Number.isFinite(price) && price >= 0 ? { priceUsd: price } : {}) };
        }
        case "invalid_request": {
            const detail = safeDetail(error.message, error.fromServer);
            return { code: "invalid_request", ...(detail ? { detail } : {}) };
        }
        default:
            if (error.status === 402) return { code: "insufficient_balance" };
            if (error.status === 401) return { code: "signed_out" };
            if (error.status === 0) return { code: "network" };
            if (error.status === 503) return { code: "director_unavailable" };
            return { code: "server_error" };
    }
}

/** A server field message shown only when it is one short plain line (11.1's rule). */
export function safeDetail(message: string, fromServer: boolean): string | null {
    if (!fromServer) return null;
    const text = message.trim();
    if (!text || text.length > 200 || /[\n\r<>]|https?:|\/v1\/|sk-|Traceback|\bat [\w.]+ \(/.test(text)) return null;
    return text;
}

function readBudget(storage: DirectorHostDeps["storage"]): BudgetUsd {
    try {
        const value = Number(storage?.getItem(BUDGET_STORAGE_KEY));
        return (BUDGET_CHOICES as readonly number[]).includes(value) ? (value as BudgetUsd) : 0;
    } catch {
        return 0;
    }
}

function firstLine(text: string, max = 60): string {
    const line = text.split(/\n/).map((l) => l.trim()).find(Boolean) ?? "";
    return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

function mergeQuotes(a: Quote, b: Quote | null): Quote {
    if (!b) return a;
    return { priceUsd: Math.max(a.priceUsd, b.priceUsd), holdUsd: Math.max(a.holdUsd, b.holdUsd, a.priceUsd, b.priceUsd) };
}

function entitiesOf(changes: TurnChange[]): { scenes: string[]; clips: string[]; tracks: boolean; project: boolean } {
    const scenes = new Set<string>();
    const clips = new Set<string>();
    let tracks = false;
    let project = false;
    for (const change of changes) {
        for (const id of change.scenes) scenes.add(id);
        for (const id of change.clips) clips.add(id);
        tracks ||= change.tracks;
        project ||= change.project;
    }
    return { scenes: [...scenes], clips: [...clips], tracks, project };
}

export class DirectorHost {
    private state: DirectorState;
    private readonly listeners = new Set<() => void>();
    private readonly quotes: DirectorQuotes;
    private readonly tasks: ProjectTasks;
    private readonly now: () => number;
    private readonly setTimer: (callback: () => void, ms: number) => unknown;
    private readonly clearTimer: (handle: unknown) => void;
    private abort: AbortController | null = null;
    private serial = 0;
    private nextCursor: string | null = null;
    private disposed = false;
    private readonly handles = new Map<string, ProjectTaskHandle>();
    private readonly highlightTimers: unknown[] = [];
    private runningTasks = 0;
    private busyTimer: unknown = null;
    private quotesInFlight = 0;
    private readonly quoteWaiters: Array<() => void> = [];
    private readonly runningSteps = new Set<string>();
    /** Idempotency-Keys of steps whose POST got no answer (reused by their Retry). */
    private readonly retryKeys = new Map<string, string>();
    private readonly waitingTasks: Array<() => void> = [];

    constructor(private readonly deps: DirectorHostDeps) {
        this.quotes = deps.quotes ?? createQuotes(deps.api);
        this.tasks = deps.tasks ?? createProjectTasks(deps.api);
        this.now = deps.now ?? Date.now;
        this.setTimer = deps.setTimeout ?? ((callback, ms) => setTimeout(callback, ms));
        this.clearTimer = deps.clearTimeout ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
        this.state = {
            turns: [], loading: false, hasMore: false, running: false, quote: null, quoteLoaded: false, budgetUsd: readBudget(deps.storage),
            busyElsewhere: null, error: null, tasks: [],
        };
    }

    /** The server's id of the project (pipeline routes and quotes name it). */
    get serverId(): string {
        return this.deps.serverId;
    }

    // ── state ─────────────────────────────────────────────

    snapshot(): DirectorState {
        return this.state;
    }

    subscribe(listener: () => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    private set(patch: Partial<DirectorState>): void {
        if (this.disposed) return;
        this.state = { ...this.state, ...patch };
        for (const listener of this.listeners) listener();
    }

    private updateTurn(key: string, update: (turn: TurnView) => TurnView): void {
        this.set({ turns: this.state.turns.map((turn) => (turn.key === key ? update(turn) : turn)) });
    }

    private updateTask(view: TaskView, patch: Partial<TaskView>): TaskView {
        const next = { ...view, ...patch };
        this.set({ tasks: this.state.tasks.map((t) => (t === view ? next : t)) });
        return next;
    }

    // ── opening ───────────────────────────────────────────

    /** Reads the price of a message and the newest turns. */
    async open(): Promise<void> {
        void this.refreshQuote();
        await this.loadHistory();
    }

    async refreshQuote(): Promise<void> {
        const quote = await this.quotes.turn().catch(() => null);
        this.set({ quote, quoteLoaded: true });
    }

    private async loadHistory(cursor: string | null = null): Promise<void> {
        if (this.state.loading) return;
        this.set({ loading: true });
        try {
            const page = await listTurns(this.deps.api, this.deps.serverId, { limit: HISTORY_PAGE, cursor });
            this.nextCursor = page.nextCursor;
            const known = new Set(this.state.turns.map((t) => t.turnId).filter(Boolean));
            const past = page.turns.filter((turn) => !known.has(turn.id)).reverse().map((turn) => this.pastTurn(turn));
            this.set({ turns: [...past, ...this.state.turns], hasMore: page.hasMore && page.nextCursor !== null, loading: false });
            // A turn still running (this project, another device or a reload): Send waits for it.
            const running = page.turns.find((turn) => turn.status === "running");
            if (running && !this.state.running && cursor === null) this.setBusy(running.id);
        } catch (error) {
            this.set({ loading: false, ...(cursor === null ? { error: errorOf(error) } : {}) });
        }
    }

    loadOlder(): Promise<void> {
        return this.state.hasMore ? this.loadHistory(this.nextCursor) : Promise.resolve();
    }

    private pastTurn(turn: DirectorTurn): TurnView {
        return {
            key: `past-${turn.id}`, turnId: turn.id, message: turn.message, status: turn.status, thinking: false,
            texts: turn.reply ? [turn.reply] : [],
            cards: turn.cards.map((card) => ({
                callId: card.callId, tool: card.tool, label: card.label, done: true, ok: card.ok ?? false, summary: card.summary ?? "",
                ...(card.revision !== undefined ? { revision: card.revision } : {}), ...(card.proposal ? { proposal: true } : {}),
                ...(card.error ? { failure: card.error.message } : {}),
            })),
            proposals: turn.proposals.map((proposal) => this.proposalView(proposal)),
            holdUsd: turn.holdUsd, chargedUsd: turn.status === "running" ? null : turn.chargedUsd,
            error: turn.error ? { code: turn.error.code === STREAM_INTERRUPTED ? "stream_interrupted" : "server_error" } : null,
            step: null, stopping: false, past: true,
        };
    }

    private proposalView(proposal: Proposal, turnKey?: string): ProposalView {
        const request = checkPipelineRequest(this.deps.serverId, proposal.request);
        // The opaque run is used only beside a request that passes the allowlist (its tool, scene and quote come from it).
        const checkedRun = request && proposal.run && proposal.id ? checkPipelineRequest(this.deps.serverId, proposal.run, { tool: request.tool }) : null;
        // Only this proposal's own run (a run naming another proposal would charge that one's price).
        const run = checkedRun?.run?.proposalId === proposal.id ? checkedRun : null;
        const expired = proposal.expiresAt !== null && this.now() >= proposal.expiresAt;
        const state: ProposalView["state"] = !request ? "blocked" : proposal.taskId ? "ran" : expired ? "expired" : "ready";
        if (state === "ready" && proposal.expiresAt !== null && turnKey) this.expireLater(turnKey, proposal.callId, proposal.expiresAt);
        return {
            callId: proposal.callId, label: proposal.label, args: proposal.args, quote: proposal.quote, request, run, expiresAt: proposal.expiresAt, taskId: proposal.taskId,
            state, ...(request ? {} : { error: { code: "request_refused" as const } }),
        };
    }

    /** A ready proposal turns "expired" at its expiry (nothing is sent after it). */
    private expireLater(turnKey: string, callId: string, at: number): void {
        const timer = this.setTimer(() => {
            this.updateTurn(turnKey, (view) => ({
                ...view, proposals: view.proposals.map((p) => (p.callId === callId && (p.state === "ready" || p.state === "failed") ? { ...p, state: "expired" as const } : p)),
            }));
        }, Math.max(0, Math.min(at - this.now(), 2 ** 31 - 1)));
        this.highlightTimers.push(timer);
    }

    // ── settings ──────────────────────────────────────────

    setBudget(value: BudgetUsd): void {
        if (!(BUDGET_CHOICES as readonly number[]).includes(value)) return;
        try {
            this.deps.storage?.setItem(BUDGET_STORAGE_KEY, String(value));
        } catch {
            // not remembered
        }
        this.set({ budgetUsd: value });
    }

    dismissError(): void {
        this.set({ error: null });
    }

    // ── a turn ────────────────────────────────────────────

    /** Sends a message; false when nothing was sent (checks failed, signed out, already running). */
    async send(message: string): Promise<boolean> {
        const text = message.trim();
        if (!text || this.state.running || this.disposed) return false;
        if (!this.deps.isSignedIn() && !(await this.deps.openSignIn())) return false;
        const quote = this.state.quote ?? (await this.quotes.turn().catch(() => null));
        if (quote && !(await holdCovered(this.deps.account, quote.holdUsd))) {
            this.deps.notEnoughCredits(quote.holdUsd, "message");
            return false;
        }
        const key = `turn-${++this.serial}`;
        const view: TurnView = {
            key, turnId: null, message: text, status: "sending", thinking: true, texts: [], cards: [], proposals: [], holdUsd: quote?.holdUsd ?? null,
            chargedUsd: null, error: null, step: null, stopping: false, past: false,
        };
        this.set({ turns: [...this.state.turns, view], running: true, error: null, busyElsewhere: null });
        const abort = new AbortController();
        this.abort = abort;
        let group: number | null = null;
        let active = false;
        let finished: DirectorTurn | null = null;
        const changes: TurnChange[] = [];
        try {
            group = await this.deps.backend.beginRemoteGroup(this.deps.projectId).catch(() => null);
            const revision = await this.deps.backend.revision(this.deps.projectId).catch(() => null);
            const selection = this.deps.selection?.();
            const events = streamTurn(this.deps.api, this.deps.serverId, {
                message: text, maxToolUsd: this.state.budgetUsd, ...(selection ? { selection } : {}), ...(revision !== null ? { clientRevision: revision } : {}),
            }, { signal: abort.signal });
            for await (const event of events) {
                if (!active && event.type !== "turn.finished") {
                    active = true;
                    this.deps.backend.setAiActive(this.deps.projectId, 1);
                }
                if (event.type === "project.revision") changes.push(event.change);
                if (event.type === "turn.finished") finished = event.turn;
                this.apply(key, event);
            }
        } catch (error) {
            if (!abort.signal.aborted) {
                const failure = errorOf(error);
                this.updateTurn(key, (turn) => ({ ...turn, status: turn.turnId ? turn.status : "failed", thinking: false, error: failure }));
                this.onRefusal(failure, error);
            }
        } finally {
            if (active) this.deps.backend.setAiActive(this.deps.projectId, -1);
            if (this.abort === abort) this.abort = null;
            this.set({ running: false });
        }
        const ended = this.state.turns.find((t) => t.key === key);
        // Stopped before its end arrived (the stream was closed): read how the server finished it, and what it charged.
        if (!finished && ended?.turnId && !this.disposed) {
            finished = await this.settleTurn(ended.turnId);
            if (finished) this.apply(key, { type: "turn.finished", turn: finished });
            else this.updateTurn(key, (turn) => ({ ...turn, status: turn.status === "running" || turn.status === "sending" ? "cancelled" : turn.status, thinking: false, stopping: false }));
        } else if (!finished && ended && (ended.status === "sending" || ended.status === "running") && !ended.error) {
            this.updateTurn(key, (turn) => ({ ...turn, status: "cancelled", thinking: false, stopping: false, chargedUsd: 0 }));
        }
        const all = finished?.changes.length ? finished.changes : changes;
        if (group !== null) await this.recordStep(key, group, all, finished);
        // false: refused before it started (the composer keeps the text).
        return Boolean(this.state.turns.find((t) => t.key === key)?.turnId);
    }

    /** The turn as the server finished it (read a few times, a second apart); null when it doesn't say. */
    private async settleTurn(turnId: string): Promise<DirectorTurn | null> {
        for (let i = 0; i < SETTLE_READS && !this.disposed; i++) {
            try {
                const turn = await getTurn(this.deps.api, this.deps.serverId, turnId);
                if (turn.status !== "running") return turn;
            } catch {
                // try again
            }
            await new Promise<void>((resolve) => this.setTimer(resolve, SETTLE_INTERVAL_MS));
        }
        return null;
    }

    private onRefusal(failure: DirectorError, error: unknown): void {
        if (failure.code === "insufficient_balance") {
            this.deps.notEnoughCredits(this.state.quote?.holdUsd ?? 0, "message");
            // The balance this page knew was stale: read it again, so the next check is right.
            void this.deps.account?.refresh().catch(() => undefined);
        }
        if (failure.code === "turn_in_progress") {
            const other = isCloudApiError(error) && typeof error.details?.turn_id === "string" ? error.details.turn_id : null;
            this.setBusy(other ?? "unknown");
        }
        if (failure.code === "signed_out") void this.deps.openSignIn();
    }

    private apply(key: string, event: DirectorEvent): void {
        switch (event.type) {
            case "turn.started":
                this.updateTurn(key, (turn) => ({ ...turn, turnId: event.turnId, status: "running", holdUsd: event.holdUsd }));
                return;
            case "turn.thinking":
                this.updateTurn(key, (turn) => ({ ...turn, thinking: true }));
                return;
            case "message":
                this.updateTurn(key, (turn) => ({ ...turn, thinking: false, texts: event.text ? [...turn.texts, event.text] : turn.texts }));
                return;
            case "tool.started":
                this.updateTurn(key, (turn) => ({ ...turn, thinking: false, cards: [...turn.cards, { callId: event.card.callId, tool: event.card.tool, label: event.card.label, args: event.card.args, done: false }] }));
                return;
            case "tool.finished": {
                const result = event.result;
                let task: TaskView | undefined;
                if (result.task) {
                    const card = this.state.turns.find((t) => t.key === key)?.cards.find((c) => c.callId === result.callId);
                    task = this.followBudgetTask(key, result.callId, result.task.id, result.task.holdUsd, card?.args ?? {}, result.tool);
                }
                this.updateTurn(key, (turn) => ({
                    ...turn,
                    cards: turn.cards.map((card) => (card.callId === result.callId ? {
                        ...card, done: true, ok: result.ok, summary: result.summary, ...(result.revision !== undefined ? { revision: result.revision } : {}),
                        ...(result.error ? { failure: result.error.message } : {}), ...(result.proposal ? { proposal: true } : {}), ...(task ? { task } : {}),
                    } : card)),
                }));
                return;
            }
            case "proposal":
                this.updateTurn(key, (turn) => ({ ...turn, proposals: [...turn.proposals.filter((p) => p.callId !== event.proposal.callId), this.proposalView(event.proposal, key)] }));
                return;
            case "project.revision":
                this.deps.backend.pullSoon(this.deps.projectId);
                return;
            case "error":
                this.updateTurn(key, (turn) => ({ ...turn, error: event.code === STREAM_INTERRUPTED ? { code: "stream_interrupted" } : turn.error ?? { code: "server_error" } }));
                return;
            case "turn.finished": {
                const turn = event.turn;
                this.updateTurn(key, (view) => ({
                    ...view, turnId: turn.id || view.turnId, status: turn.status, thinking: false, stopping: false, chargedUsd: turn.chargedUsd, holdUsd: turn.holdUsd || view.holdUsd,
                    // A replay or a JSON turn has no message events: its reply stands in for them.
                    texts: view.texts.length > 0 || !turn.reply ? view.texts : [turn.reply],
                    cards: view.cards.length > 0 ? view.cards : this.pastTurn(turn).cards,
                    proposals: view.proposals.length > 0 ? view.proposals : turn.proposals.map((p) => this.proposalView(p)),
                    error: view.error ?? (turn.error ? { code: turn.error.code === STREAM_INTERRUPTED ? "stream_interrupted" : "server_error" } : null),
                }));
                return;
            }
        }
    }

    /** Stop: asks the server to cancel the running turn; the stream then brings its end and its charge. */
    async stop(): Promise<void> {
        const turn = this.state.turns.at(-1);
        if (!this.state.running || !turn) return;
        this.updateTurn(turn.key, (t) => ({ ...t, stopping: true }));
        const abort = this.abort;
        if (!turn.turnId) {
            abort?.abort();
            return;
        }
        try {
            await cancelTurn(this.deps.api, this.deps.serverId, turn.turnId);
        } catch {
            // The stream closing below cancels it as well.
        }
        const timer = this.setTimer(() => {
            if (this.abort === abort) abort?.abort();
        }, STOP_GRACE_MS);
        const unsubscribe = this.subscribe(() => {
            if (!this.state.running) {
                this.clearTimer(timer);
                unsubscribe();
            }
        });
    }

    /** Another device's turn runs on this project: checked every few seconds; the banner clears when it ends. */
    private setBusy(turnId: string): void {
        this.set({ busyElsewhere: turnId });
        if (this.busyTimer !== null) this.clearTimer(this.busyTimer);
        this.busyTimer = null;
        if (turnId === "unknown") return;
        const check = () => {
            this.busyTimer = this.setTimer(async () => {
                this.busyTimer = null;
                if (this.disposed || this.state.busyElsewhere !== turnId) return;
                const turn = await getTurn(this.deps.api, this.deps.serverId, turnId).catch(() => null);
                if (this.state.busyElsewhere !== turnId) return;
                if (turn && turn.status !== "running") this.set({ busyElsewhere: null });
                else check();
            }, BUSY_CHECK_MS);
        };
        check();
    }

    /** Stops the turn another device runs on this project (409 turn_in_progress → "Stop it"). */
    async stopOther(): Promise<void> {
        const id = this.state.busyElsewhere;
        if (!id || id === "unknown") {
            this.set({ busyElsewhere: null });
            return;
        }
        try {
            await cancelTurn(this.deps.api, this.deps.serverId, id);
        } catch {
            // it may have finished: Send works again either way
        }
        this.set({ busyElsewhere: null });
    }

    // ── undo ──────────────────────────────────────────────

    private async recordStep(key: string, group: number, changes: TurnChange[], turn: DirectorTurn | null): Promise<void> {
        if (changes.length === 0) {
            await this.deps.backend.endRemoteGroup(this.deps.projectId, group).catch(() => undefined);
            return;
        }
        const toRevision = Math.max(...changes.map((c) => c.revision), turn?.revisionEnd ?? 0);
        const reply = turn?.reply ? firstLine(turn.reply) : "";
        const text = reply || firstLine(changes[0]!.label.replace(/^AI:\s*/, "")) || "Edit";
        const label = this.deps.label?.(text) ?? `AI: ${text}`;
        const step = await this.recordGroup(group, label, toRevision, entitiesOf(changes));
        if (step) this.updateTurn(key, (view) => ({ ...view, step: { stepId: step.stepId, label, undone: false } }));
    }

    private async recordGroup(group: number, label: string, toRevision: number, entities: Parameters<DirectorHostDeps["backend"]["recordRemoteGroup"]>[2]["entities"]): Promise<RemoteStep | null> {
        let step: RemoteStep | null = null;
        let own = false;
        try {
            // The change reaches this device first (pulling at the 1.5 s floor), then the step is recorded in one go, so
            // no edit of the person's can slip between the backend's history entry and the controller's.
            await this.deps.backend.waitForRevision(this.deps.projectId, toRevision).catch(() => false);
            own = await this.deps.controller.recordExternalStep(async () => {
                // The revision has arrived (waited for above) or the step is given up now: never a wait in here, where
                // the controller holds its writes in order.
                step = await this.deps.backend.recordRemoteGroup(this.deps.projectId, group, { label, toRevision, entities }, { timeoutMs: 0 });
                return step ? { before: snapshotOf(step.before), after: snapshotOf(step.after) } : null;
            });
        } catch {
            step = null;
        }
        const recorded = step as RemoteStep | null;
        if (recorded) this.mark(recorded.changed);
        // A step with no undo entry of its own (nothing changed on screen) offers no Undo AI.
        return own ? recorded : null;
    }

    private mark(changed: { scenes: string[]; clips: string[] }): void {
        if (!this.deps.highlight || (changed.scenes.length === 0 && changed.clips.length === 0)) return;
        this.deps.highlight(changed, true);
        this.highlightTimers.push(this.setTimer(() => this.deps.highlight?.(changed, false), HIGHLIGHT_MS));
    }

    /** The turn card's Undo: the newest step is undone like ⌘Z; an older one is undone as a new step of its own. */
    async undoTurn(key: string): Promise<boolean> {
        const turn = this.state.turns.find((t) => t.key === key);
        const step = turn?.step;
        if (!turn || !step || step.undone) return false;
        let ok = false;
        if (await this.deps.backend.isNewestRemoteStep(this.deps.projectId, step.stepId).catch(() => false)) {
            ok = (await this.deps.controller.execute({ type: "history.undo" })).ok;
        } else {
            const label = `Undo ${step.label}`;
            ok = await this.deps.controller.recordExternalStep(async () => {
                const undone = await this.deps.backend.undoRemoteStep(this.deps.projectId, step.stepId, label);
                return undone ? { before: snapshotOf(undone.before), after: snapshotOf(undone.after) } : null;
            }).catch(() => false);
        }
        if (ok) this.updateTurn(key, (view) => ({ ...view, step: view.step ? { ...view.step, undone: true } : null }));
        return ok;
    }

    // ── paid project steps ────────────────────────────────

    /**
     * A proposal's Run. With its opaque run (phase 9c): the proposal's own price (the server never runs it above that),
     * the hold check, then POST run {}. A price that rose is shown (nothing runs) and the next click runs the step's own
     * request through the fresh-quote rule at most at the price shown; an expired proposal sends nothing. Without a run
     * (older servers): the exact request, priced again first (9b).
     */
    async runProposal(turnKey: string, callId: string): Promise<boolean> {
        const turn = this.state.turns.find((t) => t.key === turnKey);
        const proposal = turn?.proposals.find((p) => p.callId === callId);
        if (!turn || !proposal || !proposal.request || proposal.state === "running" || proposal.state === "checking" || proposal.state === "ran" || proposal.state === "done") return false;
        const setProposal = (patch: Partial<ProposalView>) => this.updateTurn(turnKey, (view) => ({
            ...view, proposals: view.proposals.map((p) => (p.callId === callId ? { ...p, ...patch } : p)),
        }));
        // Past its expiry nothing is sent, whichever way it would run.
        if (proposal.state === "expired" || (proposal.expiresAt !== null && this.now() >= proposal.expiresAt)) {
            setProposal({ state: "expired", error: undefined });
            return false;
        }
        const byRun = proposal.run !== null && !proposal.priceChanged && !proposal.viaRequest;
        setProposal({ state: "checking", error: undefined });
        const onTask = (task: TaskView) => setProposal({ task, state: task.status === "succeeded" ? "done" : task.status === "failed" || task.status === "cancelled" ? "failed" : "running" });
        const outcome = await this.runStep(proposal.request, proposal.label, proposal.quote, onTask, byRun ? { via: proposal.run! } : undefined);
        if (outcome.error?.code === "price_changed") {
            // The new price when the server said it; without it the card says the price rose and the next click is priced first.
            const price = outcome.quote ?? (outcome.error.priceUsd !== undefined ? { priceUsd: outcome.error.priceUsd, holdUsd: outcome.error.priceUsd } : null);
            setProposal({ state: "ready", ...(price ? { quote: price } : {}), error: outcome.error, priceChanged: true, task: undefined });
        } else if (outcome.error?.code === "proposal_expired") setProposal({ state: "expired", error: undefined, task: undefined });
        // Nothing ran under that key: the card stays runnable and the next click sends a fresh one.
        else if (outcome.error?.code === "idempotency_key_reused") setProposal({ state: "ready", error: outcome.error, task: undefined });
        else if (outcome.error) setProposal({ state: outcome.error.code === "price_unavailable" ? "ready" : "failed", error: outcome.error });
        else if (!outcome.started) setProposal({ state: "ready" });
        if (byRun && outcome.started && outcome.task?.status === "failed") setProposal({ viaRequest: true });
        return outcome.started;
    }

    /** Several steps run together (Draw all, Render all): their total hold checked against the balance first. */
    async checkHold(totalHoldUsd: number): Promise<boolean> {
        if (await holdCovered(this.deps.account, totalHoldUsd)) return true;
        this.deps.notEnoughCredits(totalHoldUsd, "step");
        return false;
    }

    /** Prices a pipeline step (the board, the wizard): the quote, or why it can't run. */
    async priceStep(request: CheckedRequest): Promise<{ quote: Quote } | { error: DirectorError }> {
        // At most two quotes in flight (they count against the account's project requests, which sync uses too).
        while (this.quotesInFlight >= MAX_QUOTES_IN_FLIGHT) await new Promise<void>((resolve) => this.quoteWaiters.push(resolve));
        this.quotesInFlight += 1;
        let answer: Awaited<ReturnType<DirectorQuotes["tool"]>>;
        try {
            answer = await this.quotes.tool(request);
        } finally {
            this.quotesInFlight -= 1;
            this.quoteWaiters.shift()?.();
        }
        if (answer.kind === "quote") return { quote: { priceUsd: answer.priceUsd, holdUsd: answer.holdUsd } };
        if (answer.kind === "refused") {
            const detail = safeDetail(answer.message, true);
            return { error: { code: answer.code === "insufficient_balance" ? "insufficient_balance" : "invalid_request", ...(detail ? { detail } : {}) } };
        }
        return { error: { code: "price_unavailable" } };
    }

    /**
     * Runs one paid pipeline step: a fresh quote (never below `known`), the hold check, the POST, then the task until it
     * ends; its result arrives through sync and becomes one undo step. `onTask` follows its card.
     */
    async runStep(request: CheckedRequest, label: string, known: Quote | null, onTask?: (task: TaskView) => void, options: { via?: CheckedRequest } = {}): Promise<{ started: boolean; error?: DirectorError; task?: TaskView; quote?: Quote }> {
        const stepKey = `${request.path} ${JSON.stringify(request.body)}`;
        // One run of a step at a time: a second click never starts a second paid task.
        if (this.runningSteps.has(stepKey)) return { started: false };
        this.runningSteps.add(stepKey);
        try {
            return await this.runStepOnce(request, label, known, onTask, options.via ?? null);
        } finally {
            this.runningSteps.delete(stepKey);
        }
    }

    /**
     * `via`: a director proposal's opaque run (phase 9c), sent instead of `request` at the proposal's own price `known`
     * (the server runs it at most at that price, or refuses with the price now); `request` still names the step.
     */
    private async runStepOnce(request: CheckedRequest, label: string, known: Quote | null, onTask: ((task: TaskView) => void) | undefined, via: CheckedRequest | null): Promise<{ started: boolean; error?: DirectorError; task?: TaskView; quote?: Quote }> {
        if (!this.deps.isSignedIn() && !(await this.deps.openSignIn())) return { started: false };
        if (via && !known) return { started: false, error: { code: "price_unavailable" } };
        if (!via) {
            // A fresh price (never the cache): the step runs only at the price the person saw, or below it.
            const answer = await this.quotes.tool(request, { fresh: true });
            if (answer.kind === "refused") {
                const detail = safeDetail(answer.message, true);
                return { started: false, error: { code: answer.code === "insufficient_balance" ? "insufficient_balance" : "invalid_request", ...(detail ? { detail } : {}) } };
            }
            const fresh = answer.kind === "quote" ? { priceUsd: answer.priceUsd, holdUsd: Math.max(answer.holdUsd, answer.priceUsd) } : null;
            if (!known && !fresh) return { started: false, error: { code: "price_unavailable" } };
            if (fresh && (!known || fresh.holdUsd > known.holdUsd + PRICE_EPSILON)) {
                // Went up (or was never shown): show the new price; the next click runs it.
                return { started: false, error: { code: "price_changed", priceUsd: fresh.holdUsd }, quote: fresh };
            }
        }
        const shown = known!;
        if (!(await holdCovered(this.deps.account, shown.holdUsd))) {
            this.deps.notEnoughCredits(shown.holdUsd, "step");
            return { started: false };
        }
        let view: TaskView = { id: null, label, status: "starting", holdUsd: shown.holdUsd, ...(request.sceneId ? { sceneId: request.sceneId } : {}) };
        this.set({ tasks: [...this.state.tasks, view] });
        onTask?.(view);
        await this.slot();
        const group = await this.deps.backend.beginRemoteGroup(this.deps.projectId).catch(() => null);
        this.deps.backend.setAiActive(this.deps.projectId, 1);
        let repriced: number | null = null;
        // A task that ran and failed is retried by the step's own request (fresh quote; a run by id is answered once);
        // a POST whose answer was lost is sent again as it was (a run by id answers the same task).
        const retry = () => void this.runStep(request, label, shown, onTask);
        const resend = () => void this.runStep(request, label, shown, onTask, via ? { via } : {});
        // One Idempotency-Key per click (9c.1), kept only for resending the very request whose answer was lost: keyed by
        // what is sent (a proposal's run, else the step), so another proposal of the same step never inherits it.
        const sent = via ?? request;
        const keyOf = `${sent.path} ${JSON.stringify(sent.body)}`;
        const idempotencyKey = this.retryKeys.get(keyOf) ?? globalThis.crypto.randomUUID();
        const handle = this.tasks.start(via ?? request, {
            idempotencyKey,
            onUpdate: (state) => {
                // The server prices the step again when it is sent: above what was shown, it is taken back at once
                // (refunded in full before its paid step).
                if (repriced === null && state.priceUsd !== undefined && state.priceUsd > shown.holdUsd + PRICE_EPSILON && state.status !== "succeeded") {
                    repriced = state.priceUsd;
                    void Promise.resolve().then(() => handle.cancel());
                }
                view = this.updateTask(view, { id: state.id, status: state.status, ...(state.progress !== undefined ? { progress: state.progress } : {}), ...(state.priceUsd !== undefined ? { priceUsd: state.priceUsd } : {}) });
                onTask?.(view);
            },
        });
        handle.id.then((id) => {
            this.handles.set(id, handle);
            this.retryKeys.delete(keyOf);
        }, () => undefined);
        try {
            const outcome = await handle.done;
            view = this.finishTask(view, outcome);
            if (repriced !== null && outcome.status !== "succeeded") view = this.updateTask(view, { status: "failed", error: { code: "price_changed", priceUsd: repriced } });
            onTask?.(view);
            if (view.status === "failed") this.deps.failed?.(view, retry);
            if (outcome.status === "succeeded" && group !== null && outcome.projectRevision !== undefined) {
                await this.recordGroup(group, this.deps.label?.(label) ?? `AI: ${label}`, outcome.projectRevision, {
                    scenes: request.tool === "story-scenes" ? "all" : request.sceneId ? [request.sceneId] : "all", clips: [], tracks: false, project: request.tool === "story-scenes",
                });
            } else if (group !== null) {
                await this.deps.backend.endRemoteGroup(this.deps.projectId, group).catch(() => undefined);
            }
            return { started: true, task: view };
        } catch (error) {
            const failure = errorOf(error);
            // The POST's answer was lost: the server may hold the task, so a Retry sends the same Idempotency-Key.
            if (failure.code === "network") this.retryKeys.set(keyOf, idempotencyKey);
            else this.retryKeys.delete(keyOf);
            if (failure.code === "price_changed" || failure.code === "proposal_expired" || failure.code === "idempotency_key_reused") {
                // Refused before anything was held (a run by id's price or expiry, or a key already used for another
                // request): nothing ran, the card says why.
                this.set({ tasks: this.state.tasks.filter((t) => t !== view) });
                if (group !== null) await this.deps.backend.endRemoteGroup(this.deps.projectId, group).catch(() => undefined);
                return { started: false, error: failure };
            }
            view = this.updateTask(view, { status: "failed", error: failure });
            onTask?.(view);
            if (failure.code !== "insufficient_balance" && failure.code !== "signed_out") this.deps.failed?.(view, failure.code === "network" ? resend : retry);
            if (failure.code === "insufficient_balance") {
                this.deps.notEnoughCredits(shown.holdUsd, "step");
                void this.deps.account?.refresh().catch(() => undefined);
            }
            if (failure.code === "signed_out") void this.deps.openSignIn();
            if (group !== null) await this.deps.backend.endRemoteGroup(this.deps.projectId, group).catch(() => undefined);
            return { started: false, error: failure, task: view };
        } finally {
            this.deps.backend.setAiActive(this.deps.projectId, -1);
            this.release();
        }
    }

    private finishTask(view: TaskView, outcome: ProjectTaskState): TaskView {
        return this.updateTask(view, {
            id: outcome.id, status: outcome.status, ...(outcome.priceUsd !== undefined ? { priceUsd: outcome.priceUsd } : {}),
            ...(outcome.status === "failed" ? { error: { code: "task_failed" as const, message: outcome.error?.message ?? "", refunded: outcome.error?.refunded ?? false } } : {}),
        });
    }

    /** A paid step the director ran inside the budget: its card follows the task; its result is its own undo step. */
    private followBudgetTask(turnKey: string, callId: string, taskId: string, holdUsd: number, args: Record<string, unknown>, tool: string): TaskView {
        // Its undo step covers what it works on: its scene, or (a story plan) every scene and the project.
        const sceneId = typeof args.scene_id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(args.scene_id) ? args.scene_id : null;
        const entities = tool === "plan_scenes"
            ? { scenes: "all" as const, clips: [], tracks: false, project: true }
            : { scenes: sceneId ? [sceneId] : ("all" as const), clips: [], tracks: false, project: false };
        let view: TaskView = { id: taskId, label: "", status: "queued", holdUsd };
        this.set({ tasks: [...this.state.tasks, view] });
        const setCard = (task: TaskView) => this.updateTurn(turnKey, (turn) => ({ ...turn, cards: turn.cards.map((c) => (c.callId === callId ? { ...c, task } : c)) }));
        let handle: ProjectTaskHandle;
        try {
            handle = this.tasks.follow(taskId, {
                onUpdate: (state) => {
                    view = this.updateTask(view, { status: state.status, ...(state.progress !== undefined ? { progress: state.progress } : {}), ...(state.priceUsd !== undefined ? { priceUsd: state.priceUsd } : {}) });
                    setCard(view);
                },
            });
        } catch {
            return view;
        }
        this.handles.set(taskId, handle);
        this.deps.backend.setAiActive(this.deps.projectId, 1);
        void (async () => {
            const group = await this.deps.backend.beginRemoteGroup(this.deps.projectId).catch(() => null);
            try {
                const outcome = await handle.done;
                view = this.finishTask(view, outcome);
                setCard(view);
                const card = this.state.turns.find((t) => t.key === turnKey)?.cards.find((c) => c.callId === callId);
                if (outcome.status === "succeeded" && group !== null && outcome.projectRevision !== undefined) {
                    await this.recordGroup(group, this.deps.label?.(card?.label ?? "Step") ?? `AI: ${card?.label ?? "Step"}`, outcome.projectRevision, entities);
                } else if (group !== null) {
                    await this.deps.backend.endRemoteGroup(this.deps.projectId, group).catch(() => undefined);
                }
            } catch {
                if (group !== null) await this.deps.backend.endRemoteGroup(this.deps.projectId, group).catch(() => undefined);
            } finally {
                this.deps.backend.setAiActive(this.deps.projectId, -1);
            }
        })();
        return view;
    }

    /** Cancels a running pipeline task (refunded before its paid step; after it, it finishes and is charged). */
    async cancelTask(taskId: string): Promise<void> {
        const handle = this.handles.get(taskId);
        if (!handle) return;
        const answer = await handle.cancel();
        if (!answer.accepted) {
            const view = this.state.tasks.find((t) => t.id === taskId);
            if (view) this.updateTask(view, { cancelMessage: answer.message });
            this.set({ turns: this.state.turns.map((turn) => ({
                ...turn,
                cards: turn.cards.map((c) => (c.task?.id === taskId ? { ...c, task: { ...c.task, cancelMessage: answer.message } } : c)),
                proposals: turn.proposals.map((p) => (p.task?.id === taskId ? { ...p, task: { ...p.task, cancelMessage: answer.message } } : p)),
            })) });
        }
    }

    // ── the script (Script to video) ──────────────────────

    /** The project's script and subtitles as OpenNan holds them (GET /v1/projects/{id}/script). */
    async readScript(): Promise<ProjectScript> {
        const answer = await this.deps.api.request<Record<string, unknown>>("GET", `/v1/projects/${encodeURIComponent(this.deps.serverId)}/script`);
        const body = answer.body ?? {};
        return {
            scriptText: typeof body.script_text === "string" ? body.script_text : null,
            srtContent: typeof body.srt_content === "string" ? body.srt_content : null,
            cues: typeof body.cues === "number" ? body.cues : 0,
            revision: typeof body.revision === "number" ? body.revision : 0,
        };
    }

    /**
     * Stores the script and its subtitles (stored only: no scene is made or deleted), If-Match the revision `read` was
     * read at. A 412 (any edit moves the project's revision) reads the script again: when it is still what was read,
     * it is saved over at the new revision; when someone else changed it, nothing is saved and `conflict` holds theirs.
     */
    async saveScript(texts: { scriptText: string | null; srtContent: string | null }, read: ProjectScript | null): Promise<{ saved: true } | { saved: false; conflict: ProjectScript }> {
        const path = `/v1/projects/${encodeURIComponent(this.deps.serverId)}`;
        const body = { script_text: texts.scriptText, srt_content: texts.srtContent };
        const send = (rev: number | null) => this.deps.api.request("PATCH", path, { body, ...(rev !== null ? { headers: { "If-Match": `"r${rev}"` } } : {}) });
        try {
            await send(read?.revision ?? null);
            return { saved: true };
        } catch (error) {
            if (!isCloudApiError(error) || error.status !== 412) throw error;
        }
        const fresh = await this.readScript();
        if (read && (fresh.scriptText !== read.scriptText || fresh.srtContent !== read.srtContent)) return { saved: false, conflict: fresh };
        await send(fresh.revision);
        return { saved: true };
    }

    /** Scenes with a storyboard task running now (the board shows them "drawing"). */
    drawingScenes(): Set<string> {
        return new Set(this.state.tasks.filter((t) => t.sceneId && (t.status === "starting" || t.status === "queued" || t.status === "running")).map((t) => t.sceneId!));
    }

    private slot(): Promise<void> {
        if (this.runningTasks < MAX_RUNNING_TASKS) {
            this.runningTasks += 1;
            return Promise.resolve();
        }
        return new Promise((resolve) => this.waitingTasks.push(() => {
            this.runningTasks += 1;
            resolve();
        }));
    }

    private release(): void {
        this.runningTasks = Math.max(0, this.runningTasks - 1);
        this.waitingTasks.shift()?.();
    }

    dispose(): void {
        this.disposed = true;
        this.abort?.abort();
        for (const handle of this.handles.values()) handle.detach();
        for (const timer of this.highlightTimers) this.clearTimer(timer);
        if (this.busyTimer !== null) this.clearTimer(this.busyTimer);
        this.listeners.clear();
    }
}
