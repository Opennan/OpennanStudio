import type { SessionStatus } from "@opennan/provider-opennan";
import { COPIED_MS, deriveView, errorCopy, formatCountdown, initialModalState, reduceModal, SUCCESS_AUTO_CLOSE_MS } from "./sign-in-view";

const NOW = Date.parse("2026-10-19T12:00:00Z");
const ACCOUNT = { email: "ada@example.com", displayName: "Ada", photoUrl: null, balanceUsd: 12.4, keyId: "k", keyName: "n", keyExpiresAt: null, billingUrl: null };
const waiting: SessionStatus = {
    state: "waiting", userCode: "BCDF-GHJK", verificationUri: "https://opennan.com/console/device",
    verificationUriComplete: "https://opennan.com/console/device?code=BCDF-GHJK", expiresAt: NOW + 581_000, reconnecting: false, signup: false,
};

describe("reduceModal", () => {
    it("opens with a reason, starts a flow, tracks copy and popup state", () => {
        let state = reduceModal(initialModalState(), { type: "open", reason: "Generate image", onboarding: true });
        expect(state).toEqual({ reason: "Generate image", onboarding: true, flowStarted: false, copiedUntil: null, popupBlocked: false, adopting: false });
        expect(reduceModal(state, { type: "open", adopt: true })).toMatchObject({ adopting: true, flowStarted: false });
        state = reduceModal(state, { type: "start" });
        expect(state.flowStarted).toBe(true);
        state = reduceModal(state, { type: "copied", now: NOW });
        expect(state.copiedUntil).toBe(NOW + COPIED_MS);
        state = reduceModal(state, { type: "popup-blocked", blocked: true });
        expect(state.popupBlocked).toBe(true);
        expect(reduceModal(state, { type: "open" })).toEqual(initialModalState());
    });
});

describe("deriveView", () => {
    const started = reduceModal(initialModalState(), { type: "start" });

    it("shows start for signed-out, busy while starting or restoring", () => {
        expect(deriveView({ state: "signed-out" }, initialModalState(), NOW)).toEqual({ view: "start", busy: false });
        expect(deriveView({ state: "starting", signup: false }, started, NOW)).toEqual({ view: "start", busy: true });
        expect(deriveView({ state: "restoring" }, started, NOW)).toEqual({ view: "start", busy: true });
    });

    it("shows the code, time left, reconnecting, copied, and the blocked popup", () => {
        expect(deriveView(waiting, started, NOW)).toEqual({
            view: "waiting", code: "BCDF-GHJK", uri: "https://opennan.com/console/device?code=BCDF-GHJK", manualUri: "https://opennan.com/console/device",
            secondsLeft: 581, reconnecting: false, copied: false, popupBlocked: false,
        });
        const copied = reduceModal(reduceModal(started, { type: "copied", now: NOW }), { type: "popup-blocked", blocked: true });
        expect(deriveView({ ...waiting, reconnecting: true }, copied, NOW + 1000)).toMatchObject({ reconnecting: true, copied: true, popupBlocked: true });
        expect(deriveView(waiting, copied, NOW + COPIED_MS)).toMatchObject({ copied: false });
        expect(formatCountdown(581)).toBe("9:41");
        expect(formatCountdown(-4)).toBe("0:00");
    });

    it("celebrates a sign-in this modal started, without auto-close at zero balance", () => {
        expect(deriveView({ state: "signed-in", account: ACCOUNT, persistence: "persistent" }, started, NOW)).toEqual({
            view: "success", account: ACCOUNT, zeroBalance: false, memoryOnly: false, autoCloseMs: SUCCESS_AUTO_CLOSE_MS,
        });
        expect(deriveView({ state: "signed-in", account: { ...ACCOUNT, balanceUsd: 0 }, persistence: "memory" }, started, NOW))
            .toMatchObject({ zeroBalance: true, memoryOnly: true, autoCloseMs: null });
        expect(deriveView({ state: "signed-in", account: null, persistence: "persistent" }, started, NOW)).toMatchObject({ view: "success", account: null, autoCloseMs: SUCCESS_AUTO_CLOSE_MS });
        expect(deriveView({ state: "signed-in", account: ACCOUNT, persistence: "persistent" }, initialModalState(), NOW)).toEqual({ view: "start", busy: false });
    });

    it("maps every error kind to the design's copy", () => {
        expect(deriveView({ state: "error", kind: "rate-limited", message: "x", retryAt: NOW + 2500, signup: true }, started, NOW)).toEqual({
            view: "error", kind: "rate-limited", copy: { title: "Too many sign-in attempts", body: "Try again in 3 s.", primary: "retry" }, retryInSeconds: 3, signup: true,
        });
        expect(errorCopy("expired", "").title).toBe("Code expired");
        expect(errorCopy("denied", "").body).toBe("Deny was clicked on opennan.com. If that wasn't you, you can ignore this.");
        expect(errorCopy("network", "").title).toBe("Can't reach OpenNan");
        expect(errorCopy("origin", "")).toEqual({ title: "Sign-in isn't available here", body: "This copy of Studio can't reach opennan.com. Use studio.opennan.com or the desktop app.", primary: "providers" });
        expect(errorCopy("unknown", "The key could not be saved")).toMatchObject({ title: "Sign-in didn't finish", body: "The key could not be saved" });
    });
});
