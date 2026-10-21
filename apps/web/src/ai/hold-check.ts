// The balance check before a paid OpenNan run (phase 11.1): the server holds a run's hold_usd while it goes (a
// per-unit tool holds its longest input), so a balance below it gets a 402. Studio checks first with the balance it
// knows; a short balance is read again once before anything is refused (a top-up may not be seen yet), and an
// unknown balance never blocks (the server's 402 stays the authority).
import type { CostEstimate } from "@opennan/provider-sdk";

export interface HoldAccount {
    /** The signed-in account's balance in dollars, or null when it is not known. */
    balance(): number | null;
    /** Reads the balance again. */
    refresh(): Promise<void>;
}

/** What a run holds: the quote's hold, else (no quote) the estimate's own amount. */
export function holdOf(estimate: Pick<CostEstimate, "usd" | "holdUsd">): number {
    return Math.max(estimate.holdUsd ?? 0, estimate.usd);
}

/** A fresh balance read waits at most this long; past it the balance counts as unknown (the server decides). */
export const BALANCE_REFRESH_TIMEOUT_MS = 5_000;

/**
 * Whether the balance covers the hold (or is unknown). A short balance is read again once before saying no; a read
 * that takes too long counts as unknown, so Run never sits dead behind a hanging refresh.
 */
export async function holdCovered(account: HoldAccount | undefined, holdUsd: number, options: { timeoutMs?: number } = {}): Promise<boolean> {
    if (!account || !(holdUsd > 0)) return true;
    const covers = () => {
        const balance = account.balance();
        return balance === null || !Number.isFinite(balance) || balance >= holdUsd;
    };
    if (covers()) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), options.timeoutMs ?? BALANCE_REFRESH_TIMEOUT_MS);
    });
    const outcome = await Promise.race([account.refresh().then(() => "read" as const, () => "read" as const), timedOut]);
    clearTimeout(timer);
    if (outcome === "timeout") return true;
    return covers();
}

/** "Not enough credits: this run holds up to $1.30 while it goes." */
export function notEnoughCreditsMessage(holdUsd: number): string {
    return `Not enough credits: this run holds up to $${(Math.ceil(holdUsd * 100 - 1e-9) / 100).toFixed(2)} while it goes.`;
}

/** The account seam as a HoldAccount: the signed-in balance, read again through refresh(). */
export function accountHold(account: { status(): { state: string; account?: { balanceUsd: number | null } | null }; refresh(): Promise<void> }): HoldAccount {
    return {
        balance: () => {
            const status = account.status();
            return status.state === "signed-in" ? (status.account?.balanceUsd ?? null) : null;
        },
        refresh: () => account.refresh(),
    };
}
