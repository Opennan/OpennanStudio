// The Sign in with OpenNan modal's view model: a pure reducer for the modal's own UI state (copied, popup blocked,
// whether this modal started the flow) and a pure function from (session status, that state, now) to what the
// modal shows. The texts follow the phase 8 design's modal spec.
import type { AccountInfo, SessionErrorKind, SessionStatus } from "@opennan/provider-opennan";

export const SUCCESS_AUTO_CLOSE_MS = 1500;
export const COPIED_MS = 1500;

export interface ModalState {
    /** Shown on the start view: "<reason> needs an OpenNan account." */
    reason: string | null;
    onboarding: boolean;
    /** This modal started (or adopted) a flow: a later signed-in status is a success to celebrate. */
    flowStarted: boolean;
    copiedUntil: number | null;
    popupBlocked: boolean;
    /** Opened for a flow started elsewhere (switch account): it becomes this modal's flow once it is starting/waiting. */
    adopting: boolean;
}

export type ModalEvent =
    | { type: "open"; reason?: string | null; onboarding?: boolean; adopt?: boolean }
    | { type: "start" }
    | { type: "copied"; now: number }
    | { type: "popup-blocked"; blocked: boolean };

export function initialModalState(): ModalState {
    return { reason: null, onboarding: false, flowStarted: false, copiedUntil: null, popupBlocked: false, adopting: false };
}

export function reduceModal(state: ModalState, event: ModalEvent): ModalState {
    switch (event.type) {
        case "open":
            return { ...initialModalState(), reason: event.reason ?? null, onboarding: event.onboarding ?? false, adopting: event.adopt ?? false };
        case "start":
            return { ...state, flowStarted: true, adopting: false, copiedUntil: null, popupBlocked: false };
        case "copied":
            return { ...state, copiedUntil: event.now + COPIED_MS };
        case "popup-blocked":
            return { ...state, popupBlocked: event.blocked };
    }
}

export interface ErrorCopy {
    title: string;
    body: string;
    primary: "retry" | "providers";
}

export function errorCopy(kind: SessionErrorKind, message: string, retryInSeconds = 0): ErrorCopy {
    switch (kind) {
        case "expired":
            return { title: "Code expired", body: "Codes work for 10 minutes. Get a new one to continue.", primary: "retry" };
        case "denied":
            return { title: "Sign-in was denied", body: "Deny was clicked on opennan.com. If that wasn't you, you can ignore this.", primary: "retry" };
        case "network":
            return { title: "Can't reach OpenNan", body: "Check your internet connection. Editing keeps working offline.", primary: "retry" };
        case "rate-limited":
            return { title: "Too many sign-in attempts", body: `Try again in ${Math.max(0, retryInSeconds)} s.`, primary: "retry" };
        case "origin":
            return { title: "Sign-in isn't available here", body: "This copy of Studio can't reach opennan.com. Use studio.opennan.com or the desktop app.", primary: "providers" };
        default:
            return { title: "Sign-in didn't finish", body: message || "Something went wrong. Try again.", primary: "retry" };
    }
}

export type SignInView =
    | { view: "start"; busy: boolean }
    | { view: "waiting"; code: string; uri: string; manualUri: string; secondsLeft: number; reconnecting: boolean; copied: boolean; popupBlocked: boolean }
    | { view: "success"; account: AccountInfo | null; zeroBalance: boolean; memoryOnly: boolean; autoCloseMs: number | null }
    | { view: "error"; kind: SessionErrorKind; copy: ErrorCopy; retryInSeconds: number; signup: boolean };

export function deriveView(status: SessionStatus, state: ModalState, now: number): SignInView {
    switch (status.state) {
        case "starting":
            return { view: "start", busy: true };
        case "waiting":
            return {
                view: "waiting", code: status.userCode, uri: status.verificationUriComplete, manualUri: status.verificationUri,
                secondsLeft: Math.max(0, Math.ceil((status.expiresAt - now) / 1000)), reconnecting: status.reconnecting,
                copied: state.copiedUntil !== null && now < state.copiedUntil, popupBlocked: state.popupBlocked,
            };
        case "signed-in": {
            if (!state.flowStarted) return { view: "start", busy: false };
            const zeroBalance = status.account !== null && status.account.balanceUsd !== null && status.account.balanceUsd <= 0;
            return { view: "success", account: status.account, zeroBalance, memoryOnly: status.persistence === "memory", autoCloseMs: zeroBalance ? null : SUCCESS_AUTO_CLOSE_MS };
        }
        case "error": {
            const retryInSeconds = status.retryAt ? Math.max(0, Math.ceil((status.retryAt - now) / 1000)) : 0;
            return { view: "error", kind: status.kind, copy: errorCopy(status.kind, status.message, retryInSeconds), retryInSeconds, signup: status.signup };
        }
        default:
            return { view: "start", busy: status.state === "restoring" };
    }
}

/** "9:41" */
export function formatCountdown(seconds: number): string {
    const s = Math.max(0, Math.floor(seconds));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
