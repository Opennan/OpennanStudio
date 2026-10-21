// Credit balance text and tone for the account chip, the modal, and the Providers screen.

export type CreditsTone = "normal" | "low" | "zero" | "unknown";

export function formatCredits(balanceUsd: number | null | undefined): string {
    if (balanceUsd === null || balanceUsd === undefined || !Number.isFinite(balanceUsd)) return "—";
    // Rounded down: a balance never shows credit that isn't there (prices round up).
    const cents = Math.max(0, Math.floor(Math.round(balanceUsd * 1_000_000) / 10_000));
    return `$${(cents / 100).toFixed(2)}`;
}

/** Below $1 the pill warns; at $0 it asks for credits. */
export function creditsTone(balanceUsd: number | null | undefined): CreditsTone {
    if (balanceUsd === null || balanceUsd === undefined || !Number.isFinite(balanceUsd)) return "unknown";
    if (balanceUsd <= 0) return "zero";
    return balanceUsd < 1 ? "low" : "normal";
}

export function chipCreditsLabel(balanceUsd: number | null | undefined): string {
    return creditsTone(balanceUsd) === "zero" ? "Add credits" : formatCredits(balanceUsd);
}
