// The app-level account context: one Sign in with OpenNan modal for the whole shell, the OpenNan gate for AI
// actions (requireOpenNan), account toasts (402 → Buy credits; an agent call while signed out → Sign in), and the
// first-launch prompt.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { OPENNAN_PROVIDER_ID, type ProviderCapability, type ProviderRegistry } from "@opennan/provider-sdk";
import type { SessionNotice, SessionStatus } from "@opennan/provider-opennan";
import type { AccountPlatform } from "./account-types";
import { SignInModal, type SignInRequest } from "./sign-in-modal";
import "./account.css";

export const TOAST_LIFETIME_MS = 8_000;

export interface AccountToast {
    id: number;
    message: string;
    action: { label: string; run(): void };
}

export interface AccountContextValue {
    account: AccountPlatform;
    status: SessionStatus;
    /** Opens the modal; resolves true when it closes signed in. */
    openSignIn(request?: SignInRequest): Promise<boolean>;
    /**
     * The OpenNan gate: resolves true at once when the capability does not route to OpenNan or the account is
     * signed in; otherwise opens the modal with the feature as its context line and resolves when it closes.
     */
    requireOpenNan(capability: ProviderCapability, feature: string): Promise<boolean>;
}

const AccountContext = createContext<AccountContextValue | null>(null);

export function useAccount(): AccountContextValue {
    const value = useContext(AccountContext);
    if (!value) throw new Error("useAccount needs <AccountProvider>");
    return value;
}

/** The account context, or null outside <AccountProvider> (dialogs rendered on their own in tests). */
export function useOptionalAccount(): AccountContextValue | null {
    return useContext(AccountContext);
}

export function useOpenNanGate(): AccountContextValue["requireOpenNan"] {
    return useAccount().requireOpenNan;
}

export function useAccountStatus(account: AccountPlatform): SessionStatus {
    return useSyncExternalStore((listener) => account.subscribe(listener), () => account.status());
}

export function AccountProvider({ account, providers, children }: { account: AccountPlatform; providers: ProviderRegistry; children: ReactNode }) {
    const status = useAccountStatus(account);
    const [request, setRequest] = useState<SignInRequest | null>(null);
    const [modalKey, setModalKey] = useState(0);
    const resolver = useRef<((signedIn: boolean) => void) | null>(null);
    const [toasts, setToasts] = useState<AccountToast[]>([]);
    const toastSerial = useRef(0);

    const openSignIn = useCallback((next: SignInRequest = {}) => new Promise<boolean>((resolve) => {
        resolver.current?.(false);
        resolver.current = resolve;
        setRequest(next);
        setModalKey((key) => key + 1);
    }), []);

    const closeModal = useCallback((signedIn: boolean) => {
        setRequest(null);
        const resolve = resolver.current;
        resolver.current = null;
        resolve?.(signedIn);
    }, []);

    const requireOpenNan = useCallback(async (capability: ProviderCapability, feature: string) => {
        if (providers.route(capability)?.info.id !== OPENNAN_PROVIDER_ID) return true;
        if (account.status().state === "signed-in") return true;
        return openSignIn({ reason: feature });
    }, [account, providers, openSignIn]);

    const dismissToast = useCallback((id: number) => setToasts((list) => list.filter((t) => t.id !== id)), []);
    const pushToast = useCallback((message: string, action: AccountToast["action"]) => {
        const id = ++toastSerial.current;
        // One toast per message: a burst of agent calls shows it once.
        setToasts((list) => [...list.filter((t) => t.message !== message), { id, message, action }].slice(-3));
        window.setTimeout(() => dismissToast(id), TOAST_LIFETIME_MS);
    }, [dismissToast]);

    useEffect(() => account.onNotice((notice: SessionNotice) => {
        if (notice.kind === "insufficient-credits") pushToast("Not enough credits", { label: "Buy credits", run: () => account.openConsole("billing") });
        else if (notice.kind === "sign-in-needed") pushToast("An agent wants to use OpenNan AI", { label: "Sign in", run: () => void openSignIn({}) });
    }), [account, pushToast, openSignIn]);

    // First launch: once the stored session is known, a signed-out person sees the prompt once.
    const settled = status.state !== "restoring";
    useEffect(() => {
        if (!settled || !account.onboarding.pending()) return;
        if (account.status().state === "signed-in") {
            account.onboarding.dismiss();
            return;
        }
        if (account.status().state === "signed-out") {
            account.onboarding.dismiss();
            void openSignIn({ onboarding: true });
        }
    }, [settled, account, openSignIn]);

    const value = useMemo<AccountContextValue>(() => ({ account, status, openSignIn, requireOpenNan }), [account, status, openSignIn, requireOpenNan]);
    return (
        <AccountContext.Provider value={value}>
            {children}
            {request && <SignInModal key={modalKey} account={account} request={request} onClose={closeModal} />}
            <ul className="account-toasts" aria-live="polite" aria-label="Account notices">
                {toasts.map((toast) => (
                    <li key={toast.id} className="account-toast">
                        <span>{toast.message}</span>
                        <button type="button" className="button small" onClick={() => { dismissToast(toast.id); toast.action.run(); }}>{toast.action.label}</button>
                        <button type="button" className="icon-button" aria-label="Dismiss" onClick={() => dismissToast(toast.id)}>×</button>
                    </li>
                ))}
            </ul>
        </AccountContext.Provider>
    );
}
