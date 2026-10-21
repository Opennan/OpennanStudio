// Sign in with OpenNan (phase 8 design, "Sign in with OpenNan modal"): start → waiting (code, browser opened on
// opennan.com) → success, or one of the error states, each with one primary action. The flow itself runs in the
// AccountPlatform (web page or desktop main); this component only shows its status and calls it.
import { useEffect, useId, useReducer, useRef, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { navigate } from "../routing/routes";
import { BrandMark } from "../ui/brand-mark";
import { useFocusTrap } from "../ui/focus-trap";
import { AlertIcon, CheckIcon, CloseIcon, CopyIcon } from "../ui/icons";
import type { AccountPlatform } from "./account-types";
import { Avatar } from "./avatar";
import { formatCredits } from "./format-credits";
import { deriveView, formatCountdown, initialModalState, reduceModal, type SignInView } from "./sign-in-view";
import "./account.css";

export interface SignInRequest {
    /** The feature that needs OpenNan ("Generate image"): shown as the context line. */
    reason?: string | null;
    onboarding?: boolean;
    /** A flow already started elsewhere (switch account): its success is shown here. */
    adopt?: boolean;
}

export const MEMORY_ONLY_WARNING = "You'll need to sign in again next time: this system has no secure key storage.";

function hostOf(uri: string): string {
    try {
        const url = new URL(uri);
        return `${url.host}${url.pathname}`;
    } catch {
        return uri;
    }
}

export function SignInModal({ account, request, onClose }: {
    account: AccountPlatform;
    request: SignInRequest;
    /** signedIn: the modal closed after a successful sign-in (a gated action continues). */
    onClose(signedIn: boolean): void;
}) {
    const status = useSyncExternalStore((listener) => account.subscribe(listener), () => account.status());
    const [state, dispatch] = useReducer(reduceModal, request, (r) => reduceModal(initialModalState(), { type: "open", reason: r.reason, onboarding: r.onboarding, adopt: r.adopt }));
    const [now, setNow] = useState(() => Date.now());
    const [keep, setKeep] = useState(() => account.keepSignedIn?.get() ?? true);
    const titleId = useId();
    const bodyId = useId();
    const panel = useRef<HTMLDivElement>(null);
    const primary = useRef<HTMLButtonElement | HTMLAnchorElement | null>(null);
    const closed = useRef(false);

    const view: SignInView = (() => {
        const derived = deriveView(status, state, now);
        return derived.view === "waiting" ? { ...derived, popupBlocked: account.popupBlocked?.() ?? false } : derived;
    })();

    const close = (signedIn: boolean) => {
        if (closed.current) return;
        closed.current = true;
        if (!signedIn && (status.state === "starting" || status.state === "waiting" || status.state === "error")) account.cancelSignIn();
        onClose(signedIn);
    };
    const dismiss = () => close(view.view === "success");
    useFocusTrap(panel, dismiss);

    // Countdown, rate-limit timer, and the "Copied" reset tick once a second while they matter.
    const ticking = view.view === "waiting" || (view.view === "error" && view.retryInSeconds > 0);
    useEffect(() => {
        if (!ticking) return;
        const timer = window.setInterval(() => setNow(Date.now()), 250);
        return () => window.clearInterval(timer);
    }, [ticking]);

    // A flow started elsewhere (switch account) becomes this modal's once it is under way.
    const underWay = status.state === "starting" || status.state === "waiting";
    useEffect(() => {
        if (state.adopting && underWay) dispatch({ type: "start" });
    }, [state.adopting, underWay]);

    const autoClose = view.view === "success" ? view.autoCloseMs : null;
    useEffect(() => {
        if (autoClose === null) return;
        const timer = window.setTimeout(() => close(true), autoClose);
        return () => window.clearTimeout(timer);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [autoClose]);

    // A new view moves focus to its primary action unless the person is on another control in the dialog.
    useEffect(() => {
        const active = document.activeElement;
        if (panel.current && (!active || active === document.body || active === panel.current || !panel.current.contains(active))) primary.current?.focus();
    }, [view.view]);

    const start = (signup: boolean) => {
        dispatch({ type: "start" });
        void account.startSignIn({ signup });
    };
    const useAnotherProvider = () => {
        close(false);
        navigate({ name: "providers" });
    };
    const copy = async (code: string) => {
        try {
            await navigator.clipboard.writeText(code);
            dispatch({ type: "copied", now: Date.now() });
            setNow(Date.now());
        } catch {
            // Clipboard refused: the code stays visible to type by hand.
        }
    };
    const onKeyDown = (event: ReactKeyboardEvent) => {
        if (event.key !== "Enter") return;
        const target = event.target as HTMLElement;
        if (target !== panel.current && target.closest("button, a, input, select, textarea")) return;
        event.preventDefault();
        primary.current?.click();
    };
    const setPrimary = (el: HTMLButtonElement | HTMLAnchorElement | null) => {
        primary.current = el;
    };

    return createPortal(
        <div className="dialog-backdrop signin-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) dismiss(); }}>
            <div
                ref={panel}
                className="signin"
                role="dialog"
                aria-modal="true"
                aria-labelledby={titleId}
                aria-describedby={bodyId}
                data-state={view.view === "error" ? `error-${view.kind}` : view.view}
                tabIndex={-1}
                onKeyDown={onKeyDown}
            >
                <button type="button" className="icon-button signin-close" aria-label="Close" onClick={dismiss}><CloseIcon /></button>
                {view.view === "start" && (
                    <>
                        <span className="signin-mark"><BrandMark /></span>
                        <h2 id={titleId} className="signin-title">Sign in to OpenNan</h2>
                        <p id={bodyId} className="signin-body">Use OpenNan AI tools in Studio.</p>
                        {state.reason && <p className="signin-context"><em>{state.reason}</em> needs an OpenNan account.</p>}
                        <button type="button" ref={setPrimary} className="signin-primary" data-autofocus disabled={view.busy} aria-busy={view.busy || undefined} onClick={() => start(false)}>
                            {view.busy ? <><span className="signin-spinner" aria-hidden="true" />Opening browser…</> : "Sign in with OpenNan"}
                        </button>
                        {account.keepSignedIn && (
                            <label className="signin-keep">
                                <input type="checkbox" checked={keep} onChange={(event) => { setKeep(event.target.checked); account.keepSignedIn!.set(event.target.checked); }} />
                                Keep me signed in on this browser
                            </label>
                        )}
                        <p className="signin-body">New to OpenNan? <button type="button" className="signin-link" disabled={view.busy} onClick={() => start(true)}>Create account</button></p>
                        {state.onboarding && <button type="button" className="button ghost signin-secondary-ghost" onClick={() => { account.onboarding.dismiss(); close(false); }}>Not now</button>}
                        <p className="signin-small"><button type="button" className="signin-link" onClick={useAnotherProvider}>Use another provider</button></p>
                    </>
                )}
                {view.view === "waiting" && (
                    <>
                        <h2 id={titleId} className="signin-title">Approve in your browser</h2>
                        <p id={bodyId} className="signin-body">We opened opennan.com. Check that the code matches, then click Approve.</p>
                        <div className="signin-code">
                            <span className="signin-code-text" aria-label={`Code ${view.code.split("").join(" ")}`}>{view.code}</span>
                            <button type="button" className="icon-button signin-copy" aria-label={view.copied ? "Copied" : "Copy code"} onClick={() => void copy(view.code)}>
                                {view.copied ? <><CheckIcon /><span>Copied</span></> : <CopyIcon />}
                            </button>
                        </div>
                        <p className="signin-status" aria-live="polite">
                            <span className="signin-spinner" aria-hidden="true" />
                            {view.reconnecting ? "Reconnecting…" : "Waiting for approval…"}
                        </p>
                        <p className="signin-small" role="timer" aria-live="off">Code expires in {formatCountdown(view.secondsLeft)}</p>
                        {view.popupBlocked ? (
                            <a ref={setPrimary} className="signin-primary" href={view.uri} target="_blank" rel="noopener noreferrer" data-autofocus>Open opennan.com</a>
                        ) : (
                            <button type="button" ref={setPrimary} className="signin-secondary" data-autofocus onClick={() => account.openBrowserAgain()}>Open browser again</button>
                        )}
                        <button type="button" className="signin-link" onClick={() => close(false)}>Cancel</button>
                        <p className="signin-small">Didn't open? Go to {hostOf(view.manualUri)} and enter the code.</p>
                    </>
                )}
                {view.view === "success" && (
                    <>
                        <Avatar account={view.account} size={48} />
                        <h2 id={titleId} className="signin-title">{view.account ? "You're signed in" : "Signed in"}</h2>
                        <p id={bodyId} className="signin-body">{view.account?.email ?? "OpenNan is connected."}</p>
                        <p className="visually-hidden" aria-live="polite">{view.account ? `Signed in as ${view.account.email}` : "Signed in"}</p>
                        {view.account && view.account.balanceUsd !== null && (
                            <p className="signin-credits">
                                Credits <strong>{formatCredits(view.account.balanceUsd)}</strong>
                                {!view.zeroBalance && <button type="button" className="signin-link" onClick={() => account.openConsole("billing")}>Buy credits</button>}
                            </p>
                        )}
                        {view.memoryOnly && <p className="signin-warning" role="note">{MEMORY_ONLY_WARNING}</p>}
                        {view.zeroBalance && (
                            <>
                                <p className="signin-body">Add credits to start generating.</p>
                                <button type="button" ref={setPrimary} className="signin-primary" data-autofocus onClick={() => account.openConsole("billing")}>Buy credits</button>
                                <button type="button" className="signin-secondary" onClick={() => close(true)}>Done</button>
                            </>
                        )}
                    </>
                )}
                {view.view === "error" && (
                    <div className="signin-error" role="alert">
                        <span className="signin-error-icon" data-tone={view.kind === "rate-limited" || view.kind === "origin" ? "warning" : "danger"}><AlertIcon /></span>
                        <h2 id={titleId} className="signin-title">{view.copy.title}</h2>
                        <p id={bodyId} className="signin-body">{view.copy.body}</p>
                        {view.copy.primary === "providers" ? (
                            <button type="button" ref={setPrimary} className="signin-primary" data-autofocus onClick={useAnotherProvider}>Use another provider</button>
                        ) : (
                            <button type="button" ref={setPrimary} className="signin-primary" data-autofocus disabled={view.retryInSeconds > 0} onClick={() => start(view.signup)}>
                                {view.retryInSeconds > 0 ? `Try again in ${view.retryInSeconds} s` : "Try again"}
                            </button>
                        )}
                    </div>
                )}
            </div>
        </div>,
        document.body,
    );
}
