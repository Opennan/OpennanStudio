// Prices before anything runs, from POST /v1/quotes: one project tool step (what a submit would hold now; the run
// settles at most that). Cached 60 s per canonical body, in-flight reads shared. A tool quote the route refuses (400
// and the like) answers `refused` with the reason, so nothing runs unpriced.
import { isProjectApiError, type ProjectApi } from "./api";
import { quoteBodyOf, type CheckedRequest } from "./director-pipelines";
import { isRecord } from "./director-types";

export const TOOL_QUOTE_MS = 60_000;

export type ToolQuote =
    | { kind: "quote"; priceUsd: number; holdUsd: number }
    | { kind: "refused"; code: string; message: string }
    | { kind: "unavailable" };

export interface DirectorQuotes {
    /** `fresh`: read now, never from the cache (a run's last check). */
    tool(request: CheckedRequest, options?: { fresh?: boolean }): Promise<ToolQuote>;
    /** Forgets cached answers (a project changed in a way that changes its prices). */
    clear(): void;
}

function canonical(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    if (isRecord(value)) return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
    return JSON.stringify(value);
}

function money(value: unknown): number | null {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

export function createQuotes(api: ProjectApi, options: { now?(): number } = {}): DirectorQuotes {
    const now = options.now ?? Date.now;
    const tools = new Map<string, { at: number; ttl: number; value: Promise<ToolQuote> }>();

    async function readTool(request: CheckedRequest): Promise<{ value: ToolQuote; ttl: number }> {
        try {
            const answer = await api.request<unknown>("POST", "/v1/quotes", { body: quoteBodyOf(request) });
            const body = isRecord(answer.body) ? answer.body : {};
            const price = money(body.price_usd);
            const hold = money(body.hold_usd);
            if (price === null && hold === null) return { value: { kind: "unavailable" }, ttl: 0 };
            // What is shown and checked is never below what it may hold or settle at.
            return { value: { kind: "quote", priceUsd: price ?? hold!, holdUsd: Math.max(hold ?? 0, price ?? 0) }, ttl: TOOL_QUOTE_MS };
        } catch (error) {
            if (isProjectApiError(error)) {
                if (error.status === 0 || error.status === 404 || error.status === 429 || error.status >= 500) return { value: { kind: "unavailable" }, ttl: 0 };
                return { value: { kind: "refused", code: error.code, message: error.message }, ttl: 0 };
            }
            return { value: { kind: "unavailable" }, ttl: 0 };
        }
    }

    return {
        tool(request, options = {}) {
            const key = canonical(quoteBodyOf(request));
            const cached = tools.get(key);
            if (!options.fresh && cached && now() - cached.at < cached.ttl) return cached.value;
            const entry = { at: now(), ttl: Number.POSITIVE_INFINITY, value: null as unknown as Promise<ToolQuote> };
            entry.value = readTool(request).then(({ value, ttl }) => {
                entry.ttl = ttl;
                if (ttl === 0) tools.delete(key);
                return value;
            });
            tools.set(key, entry);
            return entry.value;
        },
        clear() {
            tools.clear();
        },
    };
}

/** An amount in micro-dollars (the server's numbers are exact to the millionth), never negative. */
function micro(usd: number): number {
    return Number.isFinite(usd) ? Math.max(0, Math.round(usd * 1_000_000)) : 0;
}

/** "$0.43": a price rounded up to the cent (never shown below what it may cost). */
export function formatUsdUp(usd: number): string {
    const cents = Math.ceil(micro(usd) / 10_000);
    return `$${(cents / 100).toFixed(2)}`;
}

/** "$0.08": a typical price, rounded up to the cent like every money figure Studio shows (phase 9c). */
export function formatUsdNear(usd: number): string {
    return formatUsdUp(usd);
}

/** "$0.026": what a task charged, rounded up (3 decimals under $1, a sub-tenth-of-a-cent charge as $0.001; cents from $1). */
export function formatUsdExact(usd: number): string {
    const value = micro(usd);
    if (value === 0) return "$0.00";
    if (value >= 1_000_000) return formatUsdUp(usd);
    const mills = Math.max(1, Math.ceil(value / 1_000));
    if (mills >= 1_000) return "$1.00";
    return `$${(mills / 1_000).toFixed(3)}`;
}
