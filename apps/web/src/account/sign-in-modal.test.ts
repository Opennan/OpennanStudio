// The Sign in with OpenNan modal over a scripted AccountPlatform: every state of the design's spec.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { SessionStatus } from "@opennan/provider-opennan";
import css from "./account.css?raw";
import { createFakeAccount, TEST_ACCOUNT, type FakeAccount } from "./fake-account";
import { MEMORY_ONLY_WARNING, SignInModal, type SignInRequest } from "./sign-in-modal";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLElement;
const NOW = Date.parse("2026-10-19T12:00:00Z");

beforeEach(() => {
    vi.useFakeTimers({ now: NOW });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    window.location.hash = "#/";
});
afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = "";
    vi.useRealTimers();
});

const waiting = (extra: Partial<Extract<SessionStatus, { state: "waiting" }>> = {}): SessionStatus => ({
    state: "waiting", userCode: "BCDF-GHJK", verificationUri: "https://opennan.com/console/device",
    verificationUriComplete: "https://opennan.com/console/device?code=BCDF-GHJK", expiresAt: NOW + 581_000, reconnecting: false, signup: false, ...extra,
});

function render(account: FakeAccount, request: SignInRequest = {}) {
    const onClose = vi.fn();
    act(() => root.render(createElement(SignInModal, { account, request, onClose })));
    return onClose;
}
const dialog = () => document.querySelector("[role=dialog]") as HTMLElement;
const button = (name: string) => {
    const found = [...document.querySelectorAll("button, a")].find((b) => b.textContent?.trim() === name || b.getAttribute("aria-label") === name);
    if (!found) throw new Error(`no control ${name} in ${dialog()?.textContent}`);
    return found as HTMLElement;
};
const set = (account: FakeAccount, status: SessionStatus) => act(() => account.setStatus(status));
const press = (key: string, target: Element = document.activeElement ?? document.body) =>
    act(() => void target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })));

describe("SignInModal", () => {
    it("start: brand, copy, context line, focused primary, create account, other provider", () => {
        const account = createFakeAccount();
        const onClose = render(account, { reason: "Generate image" });
        expect(dialog().getAttribute("aria-modal")).toBe("true");
        expect(dialog().dataset.state).toBe("start");
        expect(document.getElementById(dialog().getAttribute("aria-labelledby")!)!.textContent).toBe("Sign in to OpenNan");
        expect(document.getElementById(dialog().getAttribute("aria-describedby")!)!.textContent).toBe("Use OpenNan AI tools in Studio.");
        expect(dialog().textContent).toContain("Generate image needs an OpenNan account.");
        expect(document.activeElement).toBe(button("Sign in with OpenNan"));
        expect(() => button("Not now")).toThrow();
        act(() => button("Create account").click());
        expect(account.calls).toEqual(["start:signup"]);
        act(() => button("Use another provider").click());
        expect(onClose).toHaveBeenCalledWith(false);
        expect(window.location.hash).toBe("#/settings/providers");
    });

    it("start: no context line without a reason; Not now only for onboarding; keep signed in on the web", () => {
        const account = createFakeAccount({ state: "signed-out" }, { keepSignedIn: true });
        account.pending = true;
        const onClose = render(account, { onboarding: true });
        expect(dialog().textContent).not.toContain("needs an OpenNan account");
        const keep = dialog().querySelector("input[type=checkbox]") as HTMLInputElement;
        expect(keep.checked).toBe(true);
        act(() => keep.click());
        expect(account.keep).toBe(false);
        act(() => button("Not now").click());
        expect(account.calls).toContain("onboarding:dismiss");
        expect(onClose).toHaveBeenCalledWith(false);
    });

    it("start: busy while starting", () => {
        const account = createFakeAccount();
        render(account);
        act(() => button("Sign in with OpenNan").click());
        expect(account.calls).toEqual(["start"]);
        set(account, { state: "starting", signup: false });
        expect(dialog().textContent).toContain("Opening browser…");
        expect((dialog().querySelector(".signin-primary") as HTMLButtonElement).disabled).toBe(true);
    });

    it("waiting: code, copy, live status, countdown, open again, manual hint", async () => {
        const account = createFakeAccount();
        const writeText = vi.fn(async () => undefined);
        Object.assign(navigator, { clipboard: { writeText } });
        render(account);
        act(() => button("Sign in with OpenNan").click());
        set(account, waiting());
        expect(dialog().dataset.state).toBe("waiting");
        expect(dialog().textContent).toContain("Approve in your browser");
        expect(dialog().textContent).toContain("We opened opennan.com. Check that the code matches, then click Approve.");
        expect(dialog().querySelector(".signin-code-text")!.textContent).toBe("BCDF-GHJK");
        const live = dialog().querySelector("[aria-live=polite]")!;
        expect(live.textContent).toBe("Waiting for approval…");
        const timer = dialog().querySelector("[role=timer]")!;
        expect(timer.getAttribute("aria-live")).toBe("off");
        expect(timer.textContent).toBe("Code expires in 9:41");
        await act(async () => vi.advanceTimersByTime(1000));
        expect(timer.textContent).toBe("Code expires in 9:40");
        await act(async () => button("Copy code").click());
        expect(writeText).toHaveBeenCalledWith("BCDF-GHJK");
        expect(button("Copied")).toBeTruthy();
        await act(async () => vi.advanceTimersByTime(1600));
        expect(button("Copy code")).toBeTruthy();
        set(account, waiting({ reconnecting: true }));
        expect(live.textContent).toBe("Reconnecting…");
        act(() => button("Open browser again").click());
        expect(account.calls).toContain("reopen");
        expect(dialog().textContent).toContain("Didn't open? Go to opennan.com/console/device and enter the code.");
    });

    it("waiting: a blocked popup turns the primary into a link to opennan.com", () => {
        const account = createFakeAccount();
        account.blocked = true;
        render(account, { adopt: true });
        set(account, waiting());
        const link = button("Open opennan.com") as HTMLAnchorElement;
        expect(link.tagName).toBe("A");
        expect(link.href).toBe("https://opennan.com/console/device?code=BCDF-GHJK");
        expect(link.target).toBe("_blank");
        expect(link.rel).toBe("noopener noreferrer");
    });

    it("waiting: Escape and Cancel stop the flow and close", () => {
        const account = createFakeAccount();
        const onClose = render(account, { adopt: true });
        set(account, waiting());
        press("Escape");
        expect(account.calls).toEqual(["cancel"]);
        expect(onClose).toHaveBeenCalledWith(false);
        act(() => root.render(createElement("div")));
        const other = createFakeAccount(waiting());
        const onClose2 = render(other, { adopt: true });
        act(() => button("Cancel").click());
        expect(other.calls).toEqual(["cancel"]);
        expect(onClose2).toHaveBeenCalledWith(false);
    });

    it("success: avatar, email, credits, buy credits, announcement, auto-close after 1.5 s", async () => {
        const account = createFakeAccount();
        const onClose = render(account);
        act(() => button("Sign in with OpenNan").click());
        set(account, { state: "signed-in", account: TEST_ACCOUNT, persistence: "persistent" });
        expect(dialog().dataset.state).toBe("success");
        expect(dialog().textContent).toContain("You're signed in");
        expect(dialog().textContent).toContain("ada@example.com");
        expect(dialog().querySelector(".signin-credits")!.textContent).toContain("Credits $12.40");
        expect(dialog().querySelector(".account-avatar")!.textContent).toBe("A");
        expect([...dialog().querySelectorAll("[aria-live=polite]")].map((n) => n.textContent)).toContain("Signed in as ada@example.com");
        act(() => button("Buy credits").click());
        expect(account.consoles).toEqual(["billing"]);
        await act(async () => vi.advanceTimersByTime(1400));
        expect(onClose).not.toHaveBeenCalled();
        await act(async () => vi.advanceTimersByTime(200));
        expect(onClose).toHaveBeenCalledWith(true);
    });

    it("success at $0: no auto-close, Buy credits primary, Done", async () => {
        const account = createFakeAccount();
        const onClose = render(account, { adopt: true });
        set(account, waiting());
        set(account, { state: "signed-in", account: { ...TEST_ACCOUNT, balanceUsd: 0 }, persistence: "persistent" });
        expect(dialog().textContent).toContain("Add credits to start generating.");
        await act(async () => vi.advanceTimersByTime(5000));
        expect(onClose).not.toHaveBeenCalled();
        expect(document.activeElement).toBe(button("Buy credits"));
        act(() => button("Done").click());
        expect(onClose).toHaveBeenCalledWith(true);
    });

    it("success without the account, and the no-secure-storage warning", () => {
        const account = createFakeAccount();
        render(account, { adopt: true });
        set(account, waiting());
        set(account, { state: "signed-in", account: null, persistence: "memory" });
        expect(dialog().textContent).toContain("Signed in");
        expect(dialog().querySelector(".signin-credits")).toBeNull();
        expect(dialog().textContent).toContain(MEMORY_ONLY_WARNING);
    });

    it.each([
        ["expired", "Code expired", "Codes work for 10 minutes. Get a new one to continue."],
        ["denied", "Sign-in was denied", "Deny was clicked on opennan.com. If that wasn't you, you can ignore this."],
        ["network", "Can't reach OpenNan", "Check your internet connection. Editing keeps working offline."],
    ] as const)("error %s: alert, title, body, Try again restarts", (kind, title, body) => {
        const account = createFakeAccount();
        render(account, { adopt: true });
        set(account, { state: "error", kind, message: "x", signup: true });
        const alert = dialog().querySelector("[role=alert]")!;
        expect(alert.textContent).toContain(title);
        expect(alert.textContent).toContain(body);
        act(() => button("Try again").click());
        expect(account.calls).toEqual(["start:signup"]);
    });

    it("error rate-limited: Try again stays disabled until Retry-After passes", async () => {
        const account = createFakeAccount();
        render(account, { adopt: true });
        set(account, { state: "error", kind: "rate-limited", message: "x", retryAt: NOW + 3000, signup: false });
        const retry = dialog().querySelector(".signin-primary") as HTMLButtonElement;
        expect(retry.disabled).toBe(true);
        expect(retry.textContent).toBe("Try again in 3 s");
        expect(dialog().textContent).toContain("Too many sign-in attempts");
        await act(async () => vi.advanceTimersByTime(3100));
        expect(retry.disabled).toBe(false);
        expect(retry.textContent).toBe("Try again");
    });

    it("error origin: Use another provider", () => {
        const account = createFakeAccount();
        const onClose = render(account, { adopt: true });
        set(account, { state: "error", kind: "origin", message: "x", signup: false });
        expect(dialog().textContent).toContain("Sign-in isn't available here");
        act(() => button("Use another provider").click());
        expect(onClose).toHaveBeenCalledWith(false);
        expect(window.location.hash).toBe("#/settings/providers");
    });

    it("Enter on the dialog triggers the primary action", () => {
        const account = createFakeAccount();
        render(account);
        dialog().focus();
        press("Enter", dialog());
        expect(account.calls).toEqual(["start"]);
    });

    it("adopting a flow (switch account) ignores the old signed-in status until the new flow is under way", () => {
        const account = createFakeAccount({ state: "signed-in", account: TEST_ACCOUNT, persistence: "persistent" });
        const onClose = render(account, { adopt: true });
        expect(dialog().dataset.state).toBe("start");
        set(account, { state: "signed-out" });
        set(account, waiting());
        expect(dialog().dataset.state).toBe("waiting");
        set(account, { state: "signed-in", account: { ...TEST_ACCOUNT, email: "grace@example.com" }, persistence: "persistent" });
        expect(dialog().textContent).toContain("grace@example.com");
        expect(onClose).not.toHaveBeenCalled();
    });

    it("uses theme tokens only", () => {
        expect(css).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);
    });
});
