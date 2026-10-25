// Shapes shared by the project pipeline client: a pipeline request and a quote, parsed defensively from the server's
// JSON (anything missing or of the wrong type gets a neutral value, never an exception).

export interface Quote {
    priceUsd: number;
    holdUsd: number;
}

export interface PipelineRequest {
    method: "POST";
    path: string;
    body: Record<string, unknown>;
}

type Raw = Record<string, unknown>;

export function isRecord(value: unknown): value is Raw {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function num(value: unknown, fallback = 0): number {
    return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function parseQuote(value: unknown): Quote | undefined {
    if (!isRecord(value)) return undefined;
    const hold = num(value.hold_usd, NaN);
    const price = num(value.price_usd, NaN);
    if (!Number.isFinite(hold) && !Number.isFinite(price)) return undefined;
    // Never shown below what it may cost: a missing number takes the other one.
    return { priceUsd: Number.isFinite(price) ? price : hold, holdUsd: Number.isFinite(hold) ? hold : price };
}
