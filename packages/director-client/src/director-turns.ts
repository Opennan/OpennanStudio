// Director turns over the cloud projects API client: run one (streamed as typed events), read, list and stop them.
// `streamTurn` posts the turn and reads its server-sent events; a stream that drops or ends before `turn.finished`
// (the server cancels a turn whose client went away, and still settles it) is reported with an `error` event
// (`stream_interrupted`) and followed by the turn as the server finished it, so the panel always ends with the real
// status and charge. An abort (the editor closing) asks the server once to cancel the turn. Hosts whose API client
// cannot stream (no `stream`) get `stream: false`: the finished turn as JSON, its events synthesized.
import { isCloudApiError, type CloudApi } from "@opennan/cloud-backend";
import { readSse } from "./director-sse";
import {
    eventsOfTurn, MAX_MESSAGE_CHARS, MAX_SELECTION_CLIPS, MAX_SELECTION_SCENES, parseEvent, parseTurn, isRecord, type DirectorEvent, type DirectorTurn,
} from "./director-types";

export interface TurnSelection {
    sceneIds?: string[];
    clipIds?: string[];
    timeSeconds?: number;
}

export interface TurnBody {
    message: string;
    /** Paid tools the director may run on its own in this turn (the sum of their holds), 0–25; 0 = proposals only. */
    maxToolUsd?: number;
    selection?: TurnSelection;
    /** The project revision Studio holds. */
    clientRevision?: number;
}

export interface StreamTurnOptions {
    signal?: AbortSignal;
    idempotencyKey?: string;
    /** No byte for this long fails the stream (the server pings every 15 s). */
    idleMs?: number;
    /** How often the final turn is read after a dropped stream (tests shorten it). */
    pollMs?: number;
}

export const MAX_TOOL_USD = 25;
export const STREAM_INTERRUPTED = "stream_interrupted";
/** Reads of the final turn after a dropped stream (the server finishes a dropped turn within seconds). */
export const FINAL_TURN_READS = 20;

const SERVER_ID = /^[A-Za-z0-9_-]{1,36}$/;
const TURN_ID = /^turn_[0-9a-f]{24}$/;

function projectPath(projectId: string): string {
    if (!SERVER_ID.test(projectId)) throw new Error("Not an OpenNan project id.");
    return `/v1/projects/${projectId}/director/turns`;
}

function turnPath(projectId: string, turnId: string): string {
    if (!TURN_ID.test(turnId)) throw new Error("Not a director turn id.");
    return `${projectPath(projectId)}/${turnId}`;
}

function randomKey(): string {
    return globalThis.crypto.randomUUID();
}

/** The server's body (TurnBody, strict): snake_case, the selection capped to what it takes. */
export function turnBody(body: TurnBody, stream: boolean): Record<string, unknown> {
    const message = body.message;
    if (typeof message !== "string" || !message.trim()) throw new Error("Write a message first.");
    if (message.length > MAX_MESSAGE_CHARS) throw new Error(`A message is at most ${MAX_MESSAGE_CHARS.toLocaleString("en-US")} characters.`);
    const budget = body.maxToolUsd ?? 0;
    if (!(budget >= 0 && budget <= MAX_TOOL_USD)) throw new Error(`The paid tools budget is $0 to $${MAX_TOOL_USD}.`);
    const out: Record<string, unknown> = { message, max_tool_usd: budget, stream };
    const selection = body.selection;
    if (selection) {
        const picked: Record<string, unknown> = {};
        if (selection.sceneIds?.length) picked.scene_ids = selection.sceneIds.slice(0, MAX_SELECTION_SCENES);
        if (selection.clipIds?.length) picked.clip_ids = selection.clipIds.slice(0, MAX_SELECTION_CLIPS);
        if (typeof selection.timeSeconds === "number" && Number.isFinite(selection.timeSeconds) && selection.timeSeconds >= 0) picked.time_seconds = selection.timeSeconds;
        if (Object.keys(picked).length > 0) out.selection = picked;
    }
    if (typeof body.clientRevision === "number" && Number.isInteger(body.clientRevision) && body.clientRevision >= 0) out.client_revision = body.clientRevision;
    return out;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(abortError());
            return;
        }
        const timer = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
        }, ms);
        const onAbort = () => {
            clearTimeout(timer);
            reject(abortError());
        };
        signal?.addEventListener("abort", onAbort, { once: true });
    });
}

function abortError(): Error {
    const error = new Error("The turn was stopped.");
    error.name = "AbortError";
    return error;
}

function isAbort(error: unknown, signal?: AbortSignal): boolean {
    return Boolean(signal?.aborted) || (typeof error === "object" && error !== null && (error as { name?: string }).name === "AbortError");
}

/** The finished turn after its stream dropped: read until it is no longer running (bounded). */
async function finalTurn(api: CloudApi, projectId: string, turnId: string, pollMs: number, signal?: AbortSignal): Promise<DirectorTurn | null> {
    for (let i = 0; i < FINAL_TURN_READS; i++) {
        try {
            const turn = await getTurn(api, projectId, turnId, signal);
            if (turn.status !== "running") return turn;
        } catch (error) {
            if (isAbort(error, signal)) throw error;
        }
        await sleep(pollMs, signal);
    }
    return null;
}

export async function* streamTurn(api: CloudApi, projectId: string, body: TurnBody, options: StreamTurnOptions = {}): AsyncGenerator<DirectorEvent> {
    const path = projectPath(projectId);
    const headers = { "Idempotency-Key": options.idempotencyKey ?? randomKey() };
    const signal = options.signal;
    if (!api.stream) {
        const answer = await api.request<unknown>("POST", path, { body: turnBody(body, false), headers, ...(signal ? { signal } : {}) });
        for (const event of eventsOfTurn(parseTurn(answer.body))) yield event;
        return;
    }
    const answer = await api.stream("POST", path, { body: turnBody(body, true), headers, ...(signal ? { signal } : {}) });
    let turnId: string | null = null;
    let finished = false;
    let cancelAsked = false;
    const askCancel = () => {
        if (cancelAsked || !turnId || finished) return;
        cancelAsked = true;
        void cancelTurn(api, projectId, turnId).catch(() => undefined);
    };
    signal?.addEventListener("abort", askCancel, { once: true });
    let dropped: unknown = null;
    try {
        for await (const raw of readSse(answer.body, { ...(signal ? { signal } : {}), ...(options.idleMs !== undefined ? { idleMs: options.idleMs } : {}) })) {
            const event = parseEvent(raw.event, raw.data);
            if (!event) continue;
            if (event.type === "turn.started") turnId = event.turnId;
            if (event.type === "turn.finished") {
                finished = true;
                turnId ??= event.turn.id;
            }
            yield event;
            if (finished) return;
        }
    } catch (error) {
        if (isAbort(error, signal)) {
            askCancel();
            throw error;
        }
        dropped = error;
    } finally {
        signal?.removeEventListener("abort", askCancel);
        if (signal?.aborted) askCancel();
    }
    if (finished) return;
    if (!turnId) throw dropped ?? new Error("OpenNan ended the turn without an answer.");
    yield { type: "error", code: STREAM_INTERRUPTED, message: "The connection to OpenNan dropped, so the director stopped." };
    const turn = await finalTurn(api, projectId, turnId, options.pollMs ?? 1_000, signal);
    if (!turn) throw dropped ?? new Error("OpenNan did not say how the turn ended.");
    yield { type: "turn.finished", turn };
}

export interface TurnPage {
    turns: DirectorTurn[];
    hasMore: boolean;
    nextCursor: string | null;
}

export async function listTurns(api: CloudApi, projectId: string, options: { limit?: number; cursor?: string | null; signal?: AbortSignal } = {}): Promise<TurnPage> {
    const limit = Math.max(1, Math.min(50, Math.floor(options.limit ?? 20)));
    const query: Record<string, string | number> = { limit };
    if (options.cursor && TURN_ID.test(options.cursor)) query.cursor = options.cursor;
    const answer = await api.request<unknown>("GET", projectPath(projectId), { query, ...(options.signal ? { signal: options.signal } : {}) });
    const body = isRecord(answer.body) ? answer.body : {};
    return {
        turns: Array.isArray(body.data) ? body.data.map(parseTurn) : [],
        hasMore: body.has_more === true,
        nextCursor: typeof body.next_cursor === "string" ? body.next_cursor : null,
    };
}

export async function getTurn(api: CloudApi, projectId: string, turnId: string, signal?: AbortSignal): Promise<DirectorTurn> {
    const answer = await api.request<unknown>("GET", turnPath(projectId, turnId), signal ? { signal } : {});
    return parseTurn(answer.body);
}

/** Asks a running turn to stop; null when it had already finished (409 turn_already_finished). */
export async function cancelTurn(api: CloudApi, projectId: string, turnId: string): Promise<DirectorTurn | null> {
    try {
        const answer = await api.request<unknown>("POST", `${turnPath(projectId, turnId)}/cancel`);
        return parseTurn(answer.body);
    } catch (error) {
        if (isCloudApiError(error) && (error.code === "turn_already_finished" || error.status === 409)) return null;
        throw error;
    }
}
