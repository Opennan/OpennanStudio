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

describe("AccountChip storage meter (9a.1)", () => {
    it("shows every signed-in person's cloud storage, read only when the menu opens", async () => {
        vi.useRealTimers();
        const account = createFakeAccount(signedIn(12.4));
        const storage = vi.fn(async () => ({
            mediaBytes: 512 * 1024 ** 2, mediaLimitBytes: 2 * 1024 ** 3, projectDataBytes: 1024 ** 2, projectDataLimitBytes: 250 * 1024 ** 2,
            tempBytes: 0, tempLimitBytes: 0, uploadsToday: 0, uploadsPerDay: 100, uploadBytesToday: 0, uploadBytesPerDay: 0, state: "ok" as const,
        }));
        const runtime = { cloud: { storage, peek: () => null, backend: () => { throw new Error("the menu never builds the cloud backend"); }, subscribe: () => () => undefined } } as unknown as StudioRuntime;
        act(() => root.render(createElement(StudioRuntimeProvider, { runtime, children: createElement(AccountProvider, { account, providers: new ProviderRegistry(), children: createElement(AccountChip) }) })));
        expect(storage).not.toHaveBeenCalled();
        await act(async () => chip().click());
        await act(async () => {
            for (let i = 0; i < 5; i++) await Promise.resolve();
        });
        expect(storage).toHaveBeenCalledTimes(1);
        const meter = document.querySelector("[data-testid=storage-meter]")!;
        expect(meter.textContent).toContain("512.0 MB of 2.00 GB");
    });

    it("never shows the previous account's storage after switching accounts (review)", async () => {
        vi.useRealTimers();
        const account = createFakeAccount(signedIn(12.4));
        let resolveB!: (value: unknown) => void;
        const info = (mediaBytes: number) => ({
            mediaBytes, mediaLimitBytes: 2 * 1024 ** 3, projectDataBytes: 0, projectDataLimitBytes: 250 * 1024 ** 2,
            tempBytes: 0, tempLimitBytes: 0, uploadsToday: 0, uploadsPerDay: 100, uploadBytesToday: 0, uploadBytesPerDay: 0, state: "ok" as const,
        });
        const storage = vi.fn(() => (account.status().state === "signed-in" && (account.status() as { account: { email: string } }).account.email === "bob@example.com"
            ? new Promise((resolve) => (resolveB = resolve))
            : Promise.resolve(info(512 * 1024 ** 2))));
        const runtime = { cloud: { storage, peek: () => null, backend: () => null, subscribe: () => () => undefined } } as unknown as StudioRuntime;
        act(() => root.render(createElement(StudioRuntimeProvider, { runtime, children: createElement(AccountProvider, { account, providers: new ProviderRegistry(), children: createElement(AccountChip) }) })));
        await act(async () => chip().click());
        const settle = () => act(async () => {
            for (let i = 0; i < 5; i++) await Promise.resolve();
        });
        await settle();
        expect(document.querySelector("[data-testid=storage-meter]")!.textContent).toContain("512.0 MB");
        await act(async () => account.setStatus({ state: "signed-in", account: { ...TEST_ACCOUNT, email: "bob@example.com" }, persistence: "persistent" }));
        await settle();
        expect(document.querySelector("[data-testid=cloud-storage-section]")!.textContent).not.toContain("512.0 MB");
        await act(async () => resolveB(info(10 * 1024 ** 2)));
        await settle();
        expect(document.querySelector("[data-testid=storage-meter]")!.textContent).toContain("10.0 MB");
    });
});
