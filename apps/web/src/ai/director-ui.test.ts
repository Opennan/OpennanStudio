// The AI tab's words, theme and guards: copy for every code, prices never shown below what they may cost, no model or
// supplier name in Studio's own copy, every message key the components use exists, tokens only in the CSS, the
// right dock's remembered tab and ⌘J, and a local project's AI tab that sends nothing.
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { en } from "@opennan/timeline-react";
import { ProviderRegistry } from "@opennan/provider-sdk";
import css from "./director.css?raw";
import { AccountProvider } from "../account/account-context";
import { signedOutAccount } from "../account/account-types";
import { StudioRuntimeProvider } from "../platform/runtime-context";
import type { StudioRuntime } from "../platform/runtime-types";
import { directorErrorText, priceLineText, SECRET_WORDS, taskStatusText, turnStatusText, type DirectorT } from "./director-copy";
import { DirectorPanel, shownArgs } from "./director-panel";
import type { TurnView } from "./director-host";
import { isToggleAiKey, loadRightDockTab, RIGHT_DOCK_STORAGE_KEY, saveRightDockTab } from "../editor/right-dock";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SOURCES = import.meta.glob<string>("./*.{ts,tsx}", { query: "?raw", import: "default", eager: true });
const EDITOR_SOURCES = import.meta.glob<string>("../editor/*.{ts,tsx}", { query: "?raw", import: "default", eager: true });

const MESSAGES = (en as unknown as Record<string, Record<string, string>>).aiDirector!;
const t: DirectorT = (key, values) => {
    const raw = MESSAGES[key];
    if (raw === undefined) throw new Error(`missing aiDirector.${key}`);
    return raw.replace(/\{(\w+)\}/g, (_, name: string) => String(values?.[name] ?? `{${name}}`));
};

const turn = (overrides: Partial<TurnView> = {}): TurnView => ({
    key: "k", turnId: "turn_x", message: "m", status: "completed", thinking: false, texts: [], cards: [], proposals: [], holdUsd: 0.429, chargedUsd: 0.026,
    error: null, step: null, stopping: false, past: false, ...overrides,
});

describe("AI director copy", () => {
    it("has Studio's own words for every error code", () => {
        const codes = ["insufficient_balance", "turn_in_progress", "director_unavailable", "rate_limit_exceeded", "permission_denied", "not_found", "invalid_request", "signed_out", "network", "stream_interrupted", "server_error", "price_unavailable", "request_refused", "proposal_expired", "idempotency_key_reused"] as const;
        const texts = codes.map((code) => directorErrorText(t, { code }));
        expect(new Set(texts).size).toBe(codes.length);
        expect(directorErrorText(t, { code: "rate_limit_exceeded", retryAfterSeconds: 30 })).toBe("Too many messages at once: try again in 30 s.");
        expect(directorErrorText(t, { code: "invalid_request", detail: "message: too long" })).toBe("OpenNan couldn't take that request: message: too long");
        expect(directorErrorText(t, { code: "task_failed", message: "x", refunded: true })).toBe("Failed · not charged");
        expect(directorErrorText(t, { code: "proposal_expired" })).toBe("This proposal expired: ask the director again to see the price now.");
        expect(directorErrorText(t, { code: "idempotency_key_reused" })).toBe("OpenNan had this request under another run, so nothing ran. Run it again.");
        expect(directorErrorText(t, { code: "price_changed", priceUsd: 0.3601 })).toBe("The price went up to ≈ $0.37, so nothing ran. Run it again to accept it.");
        // No figure when OpenNan did not say the new price (never "$0.00").
        expect(directorErrorText(t, { code: "price_changed" })).not.toMatch(/\$/);
    });

    it("shows the typical price and the hold rounded up; the charge exactly", () => {
        expect(priceLineText(t, { holdUsd: 0.429, typicalUsd: 0.078 })).toBe("≈ $0.08 typical · holds up to $0.43");
        expect(priceLineText(t, { holdUsd: 0.4291, typicalUsd: null })).toBe("Holds up to $0.43 a message");
        expect(priceLineText(t, null)).toBe("Priced per message");
        // Rounded up like every money figure (phase 9c): a $0.071 typical turn reads $0.08.
        expect(priceLineText(t, { holdUsd: 0.429, typicalUsd: 0.071 })).toBe("≈ $0.08 typical · holds up to $0.43");
        expect(priceLineText(t, { holdUsd: 0.429, typicalUsd: 0.001 })).toBe("≈ $0.01 typical · holds up to $0.43");
        expect(turnStatusText(t, turn())).toBe("Charged $0.026");
        expect(turnStatusText(t, turn({ status: "cancelled", chargedUsd: 0.01 }))).toBe("Stopped · charged $0.010");
        expect(turnStatusText(t, turn({ status: "limit" }))).toBe("Stopped at the most one message can do · Charged $0.026");
        expect(turnStatusText(t, turn({ status: "running" }))).toBeNull();
        expect(taskStatusText(t, { id: "t", label: "", status: "running", progress: 0.42 })).toBe("Running 42%");
        expect(taskStatusText(t, { id: "t", label: "", status: "succeeded", priceUsd: 0.31 })).toBe("Done · charged $0.310");
    });

    it("never names a model or supplier", () => {
        for (const [key, text] of Object.entries(MESSAGES)) expect(`${key}: ${text}`).not.toMatch(SECRET_WORDS);
        for (const file of ["./director-panel.tsx", "./director-host.ts", "./director-copy.ts", "./storyboard-board.tsx", "./script-wizard.tsx"]) {
            const source = SOURCES[file]!.replace(/SECRET_WORDS = .*$/m, "");
            expect(source.match(/"[^"]*"/g)?.filter((literal) => SECRET_WORDS.test(literal)) ?? []).toEqual([]);
        }
    });

    it("every aiDirector key the components use exists", () => {
        const missing: string[] = [];
        for (const [name, code] of Object.entries({ ...SOURCES, ...EDITOR_SOURCES })) {
            if (name.endsWith(".test.ts")) continue;
            for (const [, fn] of code.matchAll(/const\s+(\w+)\s*=\s*useTimelineMessages\(\s*"aiDirector"\s*\)/g)) {
                for (const [, key] of code.matchAll(new RegExp(`\\b${fn}\\(\\s*"([A-Za-z0-9_]+)"`, "g"))) if (!(key! in MESSAGES)) missing.push(`${name}: ${key}`);
            }
        }
        expect(Object.keys(SOURCES).length).toBeGreaterThan(5);
        expect(missing).toEqual([]);
    });
});

describe("proposal arguments", () => {
    it("shows short plain values and never ids or links", () => {
        expect(shownArgs({ scene_id: "5b0f7f8e-3f0e-4a8f-9d65-2f1f1d3c0a11", scene: 2, regenerate: true, style: "noir", video_url: "https://x.test/a.mp4", other: "6a1f7f8e-3f0e-4a8f-9d65-2f1f1d3c0a01" }))
            .toEqual([["scene", "2"], ["regenerate", "true"], ["style", "noir"]]);
    });
});

describe("director.css", () => {
    it("uses theme tokens only (no colour literals)", () => {
        expect(css.length).toBeGreaterThan(500);
        expect(css).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);
    });
});

describe("right dock", () => {
    it("remembers the tab and toggles the AI tab with ⌘J / Ctrl+J only", () => {
        const store = new Map<string, string>();
        const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
        expect(loadRightDockTab(storage)).toBe("inspector");
        saveRightDockTab("ai", storage);
        expect(store.get(RIGHT_DOCK_STORAGE_KEY)).toBe("ai");
        expect(loadRightDockTab(storage)).toBe("ai");
        const key = (k: string, mods: Partial<KeyboardEvent> = {}) => ({ key: k, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods });
        expect(isToggleAiKey(key("j", { metaKey: true }))).toBe(true);
        expect(isToggleAiKey(key("J", { ctrlKey: true }))).toBe(true);
        expect(isToggleAiKey(key("j"))).toBe(false);
        expect(isToggleAiKey(key("j", { metaKey: true, shiftKey: true }))).toBe(false);
    });
});

describe("a local project's AI tab", () => {
    it("asks to save to OpenNan and sends nothing", async () => {
        const fetchSpy = vi.spyOn(globalThis, "fetch");
        const host = document.createElement("div");
        document.body.append(host);
        const root = createRoot(host);
        const runtime = { cloud: { backend: () => null, peek: () => null, subscribe: () => () => undefined }, account: signedOutAccount() } as unknown as StudioRuntime;
        const panel = createElement(DirectorPanel, { projectId: "local-1", projectName: "Trip", host: null });
        const account = createElement(AccountProvider, { account: signedOutAccount(), providers: new ProviderRegistry(), children: panel });
        await act(async () => root.render(createElement(StudioRuntimeProvider, { runtime, children: account })));
        expect(host.querySelector("[data-testid=director-local]")?.textContent).toContain("The AI director works on cloud projects");
        expect([...host.querySelectorAll("button")].map((b) => b.textContent)).toContain("Save to OpenNan");
        expect(fetchSpy).not.toHaveBeenCalled();
        act(() => root.unmount());
        fetchSpy.mockRestore();
        host.remove();
    });
});
