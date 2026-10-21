// The account chip (top bar and project list): "Sign in" when signed out; avatar + credit balance when signed in,
// with a menu for Buy credits, usage, keys, AI providers, Switch account, and Sign out. The balance refreshes on
// window focus and every 60 s while the page is visible.
import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { routeHref } from "../routing/routes";
import { BrandMark } from "../ui/brand-mark";
import { useAccount } from "./account-context";
import { Avatar } from "./avatar";
import { chipCreditsLabel, creditsTone, formatCredits } from "./format-credits";
import { CloudStorageSection } from "../cloud/cloud-storage-section";

export const BALANCE_REFRESH_MS = 60_000;
/** A focus right after the last refresh does not refresh again. */
export const FOCUS_REFRESH_MIN_MS = 5_000;

export function AccountChip() {
    const { account, status, openSignIn } = useAccount();
    const [open, setOpen] = useState(false);
    const trigger = useRef<HTMLButtonElement>(null);
    const menu = useRef<HTMLDivElement>(null);
    const lastRefresh = useRef(0);
    const menuId = useId();
    const signedIn = status.state === "signed-in";

    useEffect(() => {
        if (!signedIn) return;
        const refresh = (minGap: number) => {
            if (Date.now() - lastRefresh.current < minGap) return;
            lastRefresh.current = Date.now();
            void account.refresh();
        };
        refresh(0);
        const onFocus = () => refresh(FOCUS_REFRESH_MIN_MS);
        const timer = window.setInterval(() => {
            if (document.visibilityState === "visible") refresh(BALANCE_REFRESH_MS);
        }, 10_000);
        window.addEventListener("focus", onFocus);
        return () => {
            window.clearInterval(timer);
            window.removeEventListener("focus", onFocus);
        };
    }, [signedIn, account]);

    useEffect(() => {
        if (!open) return;
        menu.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus();
        const onDown = (event: MouseEvent) => {
            if (!menu.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setOpen(false);
        };
        document.addEventListener("mousedown", onDown);
        return () => document.removeEventListener("mousedown", onDown);
    }, [open]);

    if (status.state === "restoring") return <span className="account-chip account-chip-placeholder" aria-hidden="true" />;
    if (!signedIn) {
        return (
            <button type="button" className="account-chip account-chip-signin" onClick={() => void openSignIn({})}>
                <BrandMark className="account-chip-mark" />Sign in
            </button>
        );
    }

    const info = status.account;
    const balance = info?.balanceUsd ?? null;
    const tone = creditsTone(balance);
    const closeMenu = (focusTrigger = true) => {
        setOpen(false);
        if (focusTrigger) trigger.current?.focus();
    };
    const run = (action: () => void) => () => {
        closeMenu(false);
        action();
    };
    const onMenuKey = (event: ReactKeyboardEvent) => {
        const items = [...(menu.current?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? [])];
        const index = items.indexOf(document.activeElement as HTMLElement);
        if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            closeMenu();
        } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            const next = event.key === "ArrowDown" ? (index + 1) % items.length : (index - 1 + items.length) % items.length;
            items[next]?.focus();
        } else if (event.key === "Home" || event.key === "End") {
            event.preventDefault();
            items[event.key === "Home" ? 0 : items.length - 1]?.focus();
        } else if (event.key === "Tab") {
            closeMenu(false);
        }
    };

    return (
        <div className="account-chip-wrap">
            <button
                ref={trigger}
                type="button"
                className="account-chip account-chip-signed-in"
                aria-haspopup="menu"
                aria-expanded={open}
                aria-controls={open ? menuId : undefined}
                aria-label={`Account: ${info?.displayName ?? "OpenNan"}${balance !== null ? `, credits ${formatCredits(balance)}` : ""}`}
                onClick={() => setOpen((value) => !value)}
            >
                <Avatar account={info} size={22} />
                {balance !== null && <span className="account-chip-balance" data-tone={tone}>{chipCreditsLabel(balance)}</span>}
            </button>
            {open && (
                <div ref={menu} id={menuId} className="account-menu" role="menu" aria-label="Account" onKeyDown={onMenuKey}>
                    <div className="account-menu-head" role="presentation">
                        <Avatar account={info} size={32} />
                        <span>
                            <strong>{info?.displayName ?? "Signed in"}</strong>
                            {info && <span className="muted small">{info.email}</span>}
                        </span>
                    </div>
                    {balance !== null && (
                        <div className="account-menu-credits" role="presentation" data-tone={tone}>
                            Credits <strong>{formatCredits(balance)}</strong>
                        </div>
                    )}
                    <CloudStorageSection compact active={open} />
                    <button type="button" role="menuitem" className="account-menu-item account-menu-primary" onClick={run(() => account.openConsole("billing"))}>Buy credits</button>
                    <button type="button" role="menuitem" className="account-menu-item" onClick={run(() => account.openConsole("usage"))}>Usage</button>
                    <button type="button" role="menuitem" className="account-menu-item" onClick={run(() => account.openConsole("keys"))}>Manage keys</button>
                    <a role="menuitem" className="account-menu-item" href={routeHref({ name: "providers" })} onClick={() => closeMenu(false)}>AI providers</a>
                    <div className="account-menu-sep" role="separator" />
                    <button type="button" role="menuitem" className="account-menu-item" onClick={run(() => {
                        void account.switchAccount();
                        void openSignIn({ adopt: true });
                    })}>Switch account</button>
                    <button type="button" role="menuitem" className="account-menu-item" onClick={run(() => void account.signOut())}>Sign out</button>
                </div>
            )}
        </div>
    );
}
