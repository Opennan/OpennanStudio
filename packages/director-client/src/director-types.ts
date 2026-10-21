// The director's turn as Studio reads it: camelCase objects parsed defensively from the server's JSON (anything
// missing or of the wrong type gets a neutral value, never an exception), so a newer or odd server answer can never
// break the panel. Shapes follow the public director turn object and its server-sent event payloads.

export type TurnStatus = "running" | "completed" | "limit" | "cancelled" | "refused" | "failed";

export interface TurnLimits {
    rounds: number;
    promptTokens: number;
    outputTokens: number;
    toolCalls: number;
    paidCalls: number;
    maxToolUsd: number;
    seconds: number;
}

export interface Quote {
    priceUsd: number;
    holdUsd: number;
}

export interface TurnTask {
    id: string;
    /** The project tool id (storyboard, smart-scene-video, …). */
    tool: string;
    status: string;
    holdUsd: number;
}

export interface TurnError {
    code: string;
    message: string;
}

export interface ToolCard {
    callId: string;
    /** The public tool name (edit_project_timeline, generate_storyboard, …): never shown, only used to pick an icon. */
    tool: string;
    /** What the director is doing, in plain words (the server's label). */
    label: string;
    args: Record<string, unknown>;
}

export interface ToolResult {
    callId: string;
    tool: string;
    ok: boolean;
    summary: string;
    revision?: number;
    task?: TurnTask;
    quote?: Quote;
    proposal?: boolean;
    error?: TurnError;
}

/** A card as the finished turn lists it: what tool.started said plus what tool.finished said. */
export interface TurnCard extends ToolCard {
    ok?: boolean;
    summary?: string;
    revision?: number;
    task?: TurnTask;
    quote?: Quote;
    proposal?: boolean;
    error?: TurnError;
}

export interface PipelineRequest {
    method: "POST";
    path: string;
    body: Record<string, unknown>;
}

export interface Proposal {
    /** prop_<24 hex> (phase 9c servers); null on older servers. */
    id: string | null;
    callId: string;
    tool: string;
    label: string;
    args: Record<string, unknown>;
    quote: Quote;
    /** The step's own route and body (what 9b sends; still used for the quote and on older servers). */
    request: PipelineRequest;
    /** The opaque run request (POST, body {}): the server runs the stored step at most at `quote`. */
    run: PipelineRequest | null;
    /** When the proposal can no longer run (15 minutes after it was made), epoch ms. */
    expiresAt: number | null;
    /** The task it started once run (the turn object says). */
    taskId: string | null;
}

export interface TurnChange {
    revision: number;
    label: string;
    scenes: string[];
    clips: string[];
    tracks: boolean;
    project: boolean;
}

export interface DirectorTurn {
    id: string;
    projectId: string;
    status: TurnStatus;
    message: string;
    reply: string;
    cards: TurnCard[];
    proposals: Proposal[];
    changes: TurnChange[];
    tasks: TurnTask[];
    revisionStart: number;
    revisionEnd: number | null;
    holdUsd: number;
    chargedUsd: number;
    limits: TurnLimits;
    finish: string | null;
    cancelRequested: boolean;
    error: TurnError | null;
    createdAt: string | null;
    finishedAt: string | null;
}

export type DirectorEvent =
    | { type: "turn.started"; turnId: string; holdUsd: number; limits: TurnLimits; revisionStart: number }
    | { type: "turn.thinking"; round: number }
    | { type: "message"; round: number; text: string }
    | { type: "tool.started"; card: ToolCard }
    | { type: "tool.finished"; result: ToolResult }
    | { type: "proposal"; proposal: Proposal }
    | { type: "project.revision"; revision: number; change: TurnChange }
    | { type: "error"; code: string; message: string }
    | { type: "turn.finished"; turn: DirectorTurn };

export const TURN_STATUSES: readonly TurnStatus[] = ["running", "completed", "limit", "cancelled", "refused", "failed"];

/** The server's caps, used until a turn reports its own. */
export const DEFAULT_TURN_LIMITS: TurnLimits = { rounds: 6, promptTokens: 16_000, outputTokens: 1_500, toolCalls: 10, paidCalls: 3, maxToolUsd: 25, seconds: 240 };
/** A message is 1 to 4,000 characters (TurnBody.message). */
export const MAX_MESSAGE_CHARS = 4_000;
export const MAX_SELECTION_SCENES = 50;
export const MAX_SELECTION_CLIPS = 200;

type Raw = Record<string, unknown>;

export function isRecord(value: unknown): value is Raw {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown, fallback = ""): string {
    return typeof value === "string" ? value : fallback;
}

function num(value: unknown, fallback = 0): number {
    return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function int(value: unknown): number | undefined {
    return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function strings(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function record(value: unknown): Record<string, unknown> {
    return isRecord(value) ? value : {};
}

export function parseLimits(value: unknown): TurnLimits {
    const raw = record(value);
    return {
        rounds: num(raw.rounds, DEFAULT_TURN_LIMITS.rounds),
        promptTokens: num(raw.prompt_tokens, DEFAULT_TURN_LIMITS.promptTokens),
        outputTokens: num(raw.output_tokens, DEFAULT_TURN_LIMITS.outputTokens),
        toolCalls: num(raw.tool_calls, DEFAULT_TURN_LIMITS.toolCalls),
        paidCalls: num(raw.paid_calls, DEFAULT_TURN_LIMITS.paidCalls),
        maxToolUsd: num(raw.max_tool_usd, DEFAULT_TURN_LIMITS.maxToolUsd),
        seconds: num(raw.seconds, DEFAULT_TURN_LIMITS.seconds),
    };
}

export function parseQuote(value: unknown): Quote | undefined {
    if (!isRecord(value)) return undefined;
    const hold = num(value.hold_usd, NaN);
    const price = num(value.price_usd, NaN);
    if (!Number.isFinite(hold) && !Number.isFinite(price)) return undefined;
    // Never shown below what it may cost: a missing number takes the other one.
    return { priceUsd: Number.isFinite(price) ? price : hold, holdUsd: Number.isFinite(hold) ? hold : price };
}

export function parseTask(value: unknown): TurnTask | undefined {
    if (!isRecord(value) || typeof value.id !== "string" || !value.id) return undefined;
    return { id: value.id, tool: str(value.tool), status: str(value.status, "queued"), holdUsd: num(value.hold_usd) };
}

export function parseError(value: unknown): TurnError | undefined {
    if (!isRecord(value)) return undefined;
    return { code: str(value.code, "server_error"), message: str(value.message) };
}

export function parseToolCard(value: unknown): ToolCard {
    const raw = record(value);
    return { callId: str(raw.call_id), tool: str(raw.tool), label: str(raw.label), args: record(raw.args) };
}

export function parseToolResult(value: unknown): ToolResult {
    const raw = record(value);
    const result: ToolResult = { callId: str(raw.call_id), tool: str(raw.tool), ok: raw.ok === true, summary: str(raw.summary) };
    const revision = int(raw.revision);
    if (revision !== undefined) result.revision = revision;
    const task = parseTask(raw.task);
    if (task) result.task = task;
    const quote = parseQuote(raw.quote);
    if (quote) result.quote = quote;
    if (raw.proposal === true || isRecord(raw.proposal)) result.proposal = true;
    const error = parseError(raw.error);
    if (error) result.error = error;
    return result;
}

function parseCard(value: unknown): TurnCard {
    const raw = record(value);
    const card: TurnCard = parseToolCard(raw);
    if (typeof raw.ok === "boolean") card.ok = raw.ok;
    if (typeof raw.summary === "string") card.summary = raw.summary;
    const result = parseToolResult(raw);
    if (result.revision !== undefined) card.revision = result.revision;
    if (result.task) card.task = result.task;
    if (result.quote) card.quote = result.quote;
    if (result.proposal) card.proposal = true;
    if (result.error) card.error = result.error;
    return card;
}

export function parseRequest(value: unknown): PipelineRequest | null {
    if (!isRecord(value) || value.method !== "POST" || typeof value.path !== "string") return null;
    return { method: "POST", path: value.path, body: record(value.body) };
}

const PROPOSAL_ID = /^prop_[0-9a-f]{24}$/;
const TASK_ID = /^[A-Za-z0-9_-]{1,64}$/;

function time(value: unknown): number | null {
    if (typeof value !== "string") return null;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
}

export function parseProposal(value: unknown): Proposal | null {
    const raw = record(value);
    const quote = parseQuote(raw.quote);
    const request = parseRequest(raw.request);
    if (!quote || !request) return null;
    return {
        id: typeof raw.id === "string" && PROPOSAL_ID.test(raw.id) ? raw.id : null,
        callId: str(raw.call_id), tool: str(raw.tool), label: str(raw.label), args: record(raw.args), quote, request,
        run: parseRequest(raw.run), expiresAt: time(raw.expires_at),
        taskId: typeof raw.task_id === "string" && TASK_ID.test(raw.task_id) ? raw.task_id : null,
    };
}

export function parseChange(value: unknown, revision?: number): TurnChange {
    const raw = record(value);
    return {
        revision: int(raw.revision) ?? revision ?? 0, label: str(raw.label), scenes: strings(raw.scenes), clips: strings(raw.clips),
        tracks: raw.tracks === true, project: raw.project === true,
    };
}

export function parseTurn(value: unknown): DirectorTurn {
    const raw = record(value);
    const status = TURN_STATUSES.includes(raw.status as TurnStatus) ? (raw.status as TurnStatus) : "failed";
    return {
        id: str(raw.id), projectId: str(raw.project_id), status, message: str(raw.message), reply: str(raw.reply),
        cards: Array.isArray(raw.cards) ? raw.cards.map(parseCard) : [],
        proposals: Array.isArray(raw.proposals) ? raw.proposals.map(parseProposal).filter((p): p is Proposal => p !== null) : [],
        changes: Array.isArray(raw.changes) ? raw.changes.map((c) => parseChange(c)) : [],
        tasks: Array.isArray(raw.tasks) ? raw.tasks.map(parseTask).filter((t): t is TurnTask => t !== undefined) : [],
        revisionStart: num(raw.revision_start), revisionEnd: int(raw.revision_end) ?? null, holdUsd: num(raw.hold_usd), chargedUsd: num(raw.charged_usd),
        limits: parseLimits(raw.limits), finish: typeof raw.finish === "string" ? raw.finish : null, cancelRequested: raw.cancel_requested === true,
        error: parseError(raw.error) ?? null, createdAt: typeof raw.created_at === "string" ? raw.created_at : null,
        finishedAt: typeof raw.finished_at === "string" ? raw.finished_at : null,
    };
}

/** One SSE event (name + JSON data) as a typed event; null for an unknown name or unreadable data. */
export function parseEvent(name: string, data: string): DirectorEvent | null {
    let raw: unknown;
    try {
        raw = JSON.parse(data);
    } catch {
        return null;
    }
    const body = record(raw);
    switch (name) {
        case "turn.started":
            return { type: name, turnId: str(body.turn_id), holdUsd: num(body.hold_usd), limits: parseLimits(body.limits), revisionStart: num(body.revision_start) };
        case "turn.thinking":
            return { type: name, round: num(body.round) };
        case "message":
            return { type: name, round: num(body.round), text: str(body.text) };
        case "tool.started":
            return { type: name, card: parseToolCard(body) };
        case "tool.finished":
            return { type: name, result: parseToolResult(body) };
        case "proposal": {
            const proposal = parseProposal(body);
            return proposal ? { type: name, proposal } : null;
        }
        case "project.revision": {
            const revision = num(body.revision);
            return { type: name, revision, change: parseChange(body.change, revision) };
        }
        case "error":
            return { type: name, code: str(body.code, "server_error"), message: str(body.message) };
        case "turn.finished":
            return { type: name, turn: parseTurn(body) };
        default:
            return null;
    }
}

/** A finished turn as the events a stream would have sent (hosts without streaming, and replays). */
export function eventsOfTurn(turn: DirectorTurn): DirectorEvent[] {
    const events: DirectorEvent[] = [{ type: "turn.started", turnId: turn.id, holdUsd: turn.holdUsd, limits: turn.limits, revisionStart: turn.revisionStart }];
    for (const card of turn.cards) {
        events.push({ type: "tool.started", card: { callId: card.callId, tool: card.tool, label: card.label, args: card.args } });
        const result: ToolResult = { callId: card.callId, tool: card.tool, ok: card.ok ?? false, summary: card.summary ?? "" };
        if (card.revision !== undefined) result.revision = card.revision;
        if (card.task) result.task = card.task;
        if (card.quote) result.quote = card.quote;
        if (card.proposal) result.proposal = true;
        if (card.error) result.error = card.error;
        events.push({ type: "tool.finished", result });
    }
    for (const proposal of turn.proposals) events.push({ type: "proposal", proposal });
    for (const change of turn.changes) events.push({ type: "project.revision", revision: change.revision, change });
    if (turn.reply) events.push({ type: "message", round: 1, text: turn.reply });
    if (turn.error) events.push({ type: "error", code: turn.error.code, message: turn.error.message });
    events.push({ type: "turn.finished", turn });
    return events;
}
