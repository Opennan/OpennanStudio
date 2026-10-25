// The account chip: Sign in, balance, menu actions and keyboard, refresh on focus and every 60 s.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ProviderRegistry } from "@opennan/provider-sdk";
import { AccountChip, BALANCE_REFRESH_MS } from "./account-chip";
import { AccountProvider } from "./account-context";
import { createFakeAccount, TEST_ACCOUNT, type FakeAccount } from "./fake-account";
import { StudioRuntimeProvider } from "../platform/runtime-context";
import type { StudioRuntime } from "../platform/runtime-types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLElement;

beforeEach(() => {
    vi.useFakeTimers({ now: Date.parse("2026-10-19T12:00:00Z") });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = "";
    vi.useRealTimers();
});

function render(account: FakeAccount) {
    act(() => root.render(createElement(AccountProvider, { account, providers: new ProviderRegistry(), children: createElement(AccountChip) })));
}
const chip = () => host.querySelector(".account-chip") as HTMLButtonElement;
const item = (name: string) => [...document.querySelectorAll("[role=menuitem]")].find((b) => b.textContent === name) as HTMLElement;
const signedIn = (balanceUsd: number) => ({ state: "signed-in" as const, account: { ...TEST_ACCOUNT, balanceUsd }, persistence: "persistent" as const });

describe("AccountChip", () => {
    it("signed out: Sign in opens the modal", () => {
        const account = createFakeAccount();
        render(account);
        expect(chip().textContent).toBe("Sign in");
        act(() => chip().click());
        expect(document.querySelector(".signin")).not.toBeNull();
    });

    it("signed in: avatar and balance with tones", () => {
        const account = createFakeAccount(signedIn(12.4));
        render(account);
        expect(chip().getAttribute("aria-label")).toBe("Account: Ada Lovelace, credits $12.40");
        expect(host.querySelector(".account-chip-balance")!.textContent).toBe("$12.40");
        expect(host.querySelector(".account-avatar")!.textContent).toBe("A");
        act(() => account.setStatus(signedIn(0.5)));
        expect(host.querySelector(".account-chip-balance")!.getAttribute("data-tone")).toBe("low");
        act(() => account.setStatus(signedIn(0)));
        expect(host.querySelector(".account-chip-balance")!.textContent).toBe("Add credits");
        expect(host.querySelector(".account-chip-balance")!.getAttribute("data-tone")).toBe("zero");
    });

    it("menu: identity, credits, actions, keyboard, Escape returns focus", () => {
        const account = createFakeAccount(signedIn(12.4));
        render(account);
        act(() => chip().click());
        const menu = document.querySelector("[role=menu]")!;
        expect(chip().getAttribute("aria-expanded")).toBe("true");
        expect(menu.textContent).toContain("Ada Lovelace");
        expect(menu.textContent).toContain("ada@example.com");
        expect(menu.querySelector(".account-menu-credits")!.textContent).toBe("Credits $12.40");
        expect([...menu.querySelectorAll("[role=menuitem]")].map((m) => m.textContent)).toEqual(["Buy credits", "Usage", "Manage keys", "AI providers", "Switch account", "Sign out"]);
        expect(document.activeElement).toBe(item("Buy credits"));
        act(() => void document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
        expect(document.activeElement).toBe(item("Usage"));
        act(() => void document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true })));
        act(() => void document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true })));
        expect(document.activeElement).toBe(item("Sign out"));
        act(() => void document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
        expect(document.querySelector("[role=menu]")).toBeNull();
        expect(document.activeElement).toBe(chip());
        expect((item as unknown) !== null).toBe(true);
    });

    it("menu actions call the account", () => {
        const account = createFakeAccount(signedIn(12.4));
        render(account);
        for (const [name, page] of [["Buy credits", "billing"], ["Usage", "usage"], ["Manage keys", "keys"]] as const) {
            act(() => chip().click());
            act(() => item(name).click());
            expect(account.consoles.at(-1)).toBe(page);
        }
        act(() => chip().click());
        expect((item("AI providers") as HTMLAnchorElement).getAttribute("href")).toBe("#/settings/providers");
        act(() => item("Switch account").click());
        expect(account.calls).toContain("switch");
        expect(document.querySelector(".signin")).not.toBeNull();
        act(() => (document.querySelector(".signin-close") as HTMLButtonElement).click());
        act(() => chip().click());
        act(() => item("Sign out").click());
        expect(account.calls).toContain("signOut");
    });

    it("refreshes on mount, on focus (not twice within 5 s), and every 60 s while visible", async () => {
        const account = createFakeAccount(signedIn(12.4));
        render(account);
        const refreshes = () => account.calls.filter((c) => c === "refresh").length;
        expect(refreshes()).toBe(1);
        act(() => void window.dispatchEvent(new Event("focus")));
        expect(refreshes()).toBe(1);
        await act(async () => vi.advanceTimersByTime(6000));
        act(() => void window.dispatchEvent(new Event("focus")));
        expect(refreshes()).toBe(2);
        await act(async () => vi.advanceTimersByTime(BALANCE_REFRESH_MS - 10_000));
        expect(refreshes()).toBe(2);
        await act(async () => vi.advanceTimersByTime(15_000));
        expect(refreshes()).toBe(3);
    });

    it("shows a quiet placeholder while restoring", () => {
        render(createFakeAccount({ state: "restoring" }));
        expect(host.querySelector(".account-chip-placeholder")).not.toBeNull();
    });
});
