// AccountProvider: the gate, the modal's resolution, account toasts, and the first-launch prompt.
import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ProviderRegistry, type Provider } from "@opennan/provider-sdk";
import { AccountProvider, TOAST_LIFETIME_MS, useAccount, type AccountContextValue } from "./account-context";
import { createFakeAccount, TEST_ACCOUNT, type FakeAccount } from "./fake-account";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLElement;
let context: AccountContextValue;

beforeEach(() => {
    vi.useFakeTimers();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = "";
    vi.useRealTimers();
});

const opennan: Provider = { info: { id: "opennan", name: "OpenNan", capabilities: ["image.generate", "opennan.qc"] } };
const local: Provider = { info: { id: "local", name: "On this device", capabilities: ["audio.transcribe"] } };

function Probe() {
    const value = useAccount();
    useEffect(() => {
        context = value;
    });
    return createElement("button", { type: "button" }, "probe");
}

function render(account: FakeAccount, providers = [opennan, local]) {
    const registry = new ProviderRegistry();
    for (const p of providers) registry.register(p);
    act(() => root.render(createElement(AccountProvider, { account, providers: registry, children: createElement(Probe) })));
    return registry;
}
const modal = () => document.querySelector(".signin");
const button = (name: string) => [...document.querySelectorAll("button")].find((b) => b.textContent === name || b.getAttribute("aria-label") === name) as HTMLButtonElement;

describe("AccountProvider", () => {
    it("lets actions through when the capability is not OpenNan's or the account is signed in", async () => {
        const account = createFakeAccount();
        render(account);
        await expect(act(() => context.requireOpenNan("audio.transcribe", "Auto captions"))).resolves.toBe(true);
        expect(modal()).toBeNull();
        act(() => account.setStatus({ state: "signed-in", account: TEST_ACCOUNT, persistence: "persistent" }));
        await expect(act(() => context.requireOpenNan("image.generate", "Generate image"))).resolves.toBe(true);
        expect(modal()).toBeNull();
    });

    it("opens the modal with the context line and resolves true after sign-in", async () => {
        const account = createFakeAccount();
        render(account);
        let result: boolean | undefined;
        act(() => void context.requireOpenNan("image.generate", "Generate image").then((r) => { result = r; }));
        expect(modal()!.textContent).toContain("Generate image needs an OpenNan account.");
        act(() => button("Sign in with OpenNan").click());
        act(() => account.setStatus({ state: "signed-in", account: TEST_ACCOUNT, persistence: "persistent" }));
        await act(async () => vi.advanceTimersByTime(1600));
        expect(modal()).toBeNull();
        expect(result).toBe(true);
    });

    it("resolves false when the modal is closed", async () => {
        const account = createFakeAccount();
        render(account);
        let result: boolean | undefined;
        act(() => void context.requireOpenNan("opennan.qc", "Quality check").then((r) => { result = r; }));
        await act(async () => button("Close").click());
        expect(result).toBe(false);
        expect(modal()).toBeNull();
    });

    it("shows a non-modal toast when an agent needs OpenNan, and Sign in opens the modal", () => {
        const account = createFakeAccount();
        render(account);
        const focused = button("probe");
        focused.focus();
        act(() => account.notice({ kind: "sign-in-needed", feature: "image.generate" }));
        act(() => account.notice({ kind: "sign-in-needed", feature: "image.generate" }));
        const toasts = document.querySelectorAll(".account-toast");
        expect(toasts).toHaveLength(1);
        expect(toasts[0]!.textContent).toContain("An agent wants to use OpenNan AI");
        expect(document.activeElement).toBe(focused);
        expect(modal()).toBeNull();
        act(() => button("Sign in").click());
        expect(modal()).not.toBeNull();
        expect(document.querySelectorAll(".account-toast")).toHaveLength(0);
    });

    it("shows Not enough credits with Buy credits, and toasts expire", async () => {
        const account = createFakeAccount();
        render(account);
        act(() => account.notice({ kind: "insufficient-credits", billingUrl: "https://opennan.com/console/billing" }));
        expect(document.querySelector(".account-toast")!.textContent).toContain("Not enough credits");
        act(() => button("Buy credits").click());
        expect(account.consoles).toEqual(["billing"]);
        act(() => account.notice({ kind: "insufficient-credits", billingUrl: "x" }));
        await act(async () => vi.advanceTimersByTime(TOAST_LIFETIME_MS + 10));
        expect(document.querySelectorAll(".account-toast")).toHaveLength(0);
    });

    it("prompts once on first launch after restoring, never when signed in", async () => {
        const account = createFakeAccount({ state: "restoring" });
        account.pending = true;
        render(account);
        expect(modal()).toBeNull();
        act(() => account.setStatus({ state: "signed-out" }));
        expect(modal()).not.toBeNull();
        expect(button("Not now")).toBeTruthy();
        expect(account.pending).toBe(false);
        act(() => button("Not now").click());
        expect(modal()).toBeNull();

        act(() => root.unmount());
        root = createRoot(host);
        const signedIn = createFakeAccount({ state: "signed-in", account: TEST_ACCOUNT, persistence: "persistent" });
        signedIn.pending = true;
        render(signedIn);
        expect(modal()).toBeNull();
        expect(signedIn.pending).toBe(false);
    });
});
