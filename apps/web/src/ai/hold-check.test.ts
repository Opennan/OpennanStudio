import { accountHold, holdCovered, holdOf, notEnoughCreditsMessage } from "./hold-check";

describe("hold check (phase 11.1)", () => {
    it("the hold is the quote's, else the estimate's amount", () => {
        expect(holdOf({ usd: 0.13, holdUsd: 1.3 })).toBe(1.3);
        expect(holdOf({ usd: 0.13 })).toBe(0.13);
    });

    it("covers when the balance is enough or unknown; a short balance is read again once", async () => {
        const balance = { value: 1 as number | null };
        const refresh = vi.fn(async () => undefined);
        const account = { balance: () => balance.value, refresh };
        expect(await holdCovered(account, 0.5)).toBe(true);
        expect(refresh).not.toHaveBeenCalled();
        expect(await holdCovered(account, 2)).toBe(false);
        expect(refresh).toHaveBeenCalledTimes(1);
        balance.value = null;
        expect(await holdCovered(account, 2)).toBe(true);
        expect(await holdCovered(undefined, 2)).toBe(true);
        refresh.mockRejectedValueOnce(new Error("offline"));
        balance.value = 0;
        expect(await holdCovered(account, 2)).toBe(false);
    });

    it("a refresh that hangs counts as an unknown balance after its timeout (never a dead Run)", async () => {
        const account = { balance: () => 0.1, refresh: () => new Promise<void>(() => undefined) };
        const started = Date.now();
        expect(await holdCovered(account, 2, { timeoutMs: 50 })).toBe(true);
        expect(Date.now() - started).toBeLessThan(2_000);
    });

    it("reads the signed-in balance from the account seam", () => {
        const refresh = async () => undefined;
        expect(accountHold({ status: () => ({ state: "signed-in", account: { balanceUsd: 3 } }), refresh }).balance()).toBe(3);
        expect(accountHold({ status: () => ({ state: "signed-in", account: null }), refresh }).balance()).toBeNull();
        expect(accountHold({ status: () => ({ state: "signed-out" }), refresh }).balance()).toBeNull();
    });

    it("says how much the run holds, rounded up to the cent", () => {
        expect(notEnoughCreditsMessage(1.3)).toBe("Not enough credits: this run holds up to $1.30 while it goes.");
        expect(notEnoughCreditsMessage(0.143049)).toBe("Not enough credits: this run holds up to $0.15 while it goes.");
    });
});
