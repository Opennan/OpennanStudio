// Settings → AI providers over a fake account, a registry, and in-memory routing.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ProviderRegistry, type Provider } from "@opennan/provider-sdk";
import { AccountProvider } from "../account/account-context";
import { memoryProviderSettings, type ProviderPlatform } from "../account/account-types";
import { createFakeAccount, TEST_ACCOUNT, type FakeAccount } from "../account/fake-account";
import { StudioRuntimeProvider } from "../platform/runtime-context";
import type { StudioRuntime } from "../platform/runtime-types";
import css from "./settings.css?raw";
import { ProviderSettingsScreen } from "./provider-settings-screen";
import { connectRouting } from "./routing-groups";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLElement;
beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = "";
});

const opennan: Provider = { info: { id: "opennan", name: "OpenNan", capabilities: ["image.generate", "video.text-to-video", "opennan.story.storyboard", "opennan.qc"] } };
const local: Provider = { info: { id: "local", name: "On this device", capabilities: ["audio.transcribe"] }, audio: { models: async () => [{ id: "tiny", label: "Tiny", installed: true }] } };
const fal: Provider = { info: { id: "fal", name: "fal.ai", capabilities: ["image.generate"] } };

function render(account: FakeAccount, options: { providers?: Provider[]; settings?: ProviderPlatform; platform?: "web" | "desktop"; addons?: () => unknown; extra?: Partial<StudioRuntime> } = {}) {
    const registry = new ProviderRegistry();
    for (const p of options.providers ?? [opennan, local]) registry.register(p);
    const settings = options.settings ?? memoryProviderSettings();
    connectRouting(registry, settings);
    const runtime = {
        platform: options.platform ?? "web", providers: registry, providerSettings: settings, account,
        ui: options.addons ? { SettingsAddons: options.addons } : {}, capabilityNote: () => "No whisper.cpp in this build", ...options.extra,
    } as unknown as StudioRuntime;
    act(() => root.render(createElement(StudioRuntimeProvider, { runtime, children: createElement(AccountProvider, { account, providers: registry, children: createElement(ProviderSettingsScreen) }) })));
    return { registry, settings };
}
const button = (name: string) => [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === name || b.getAttribute("aria-label") === name) as HTMLButtonElement;
const row = (capability: string) => document.querySelector(`[data-capability="${capability}"]`) as HTMLElement;
const choose = (select: HTMLSelectElement, value: string) => act(() => {
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
});

describe("ProviderSettingsScreen", () => {
    it("signed out: the OpenNan card offers Sign in with OpenNan and is the default", () => {
        const account = createFakeAccount();
        render(account);
        const card = document.querySelector(".opennan-card")!;
        expect(card.textContent).toContain("Default for all AI tools");
        act(() => button("Sign in with OpenNan").click());
        expect(document.querySelector(".signin")).not.toBeNull();
    });

    it("signed in: account line, credits, Buy credits, Sign out", () => {
        const account = createFakeAccount({ state: "signed-in", account: TEST_ACCOUNT, persistence: "persistent" });
        render(account);
        const card = document.querySelector(".opennan-card")!;
        expect(card.textContent).toContain("ada@example.com");
        expect(card.textContent).toContain("Credits $12.40");
        act(() => card.querySelectorAll("button")[0]!.click());
        expect(account.consoles).toEqual(["billing"]);
        act(() => button("Sign out").click());
        expect(account.calls).toContain("signOut");
    });

    it("Use OpenNan by default is a persisted switch that re-routes", () => {
        const account = createFakeAccount();
        const { registry, settings } = render(account, { providers: [opennan, fal] });
        const toggle = document.querySelector("[role=switch]") as HTMLButtonElement;
        expect(toggle.getAttribute("aria-checked")).toBe("true");
        expect(registry.route("image.generate")?.info.id).toBe("opennan");
        act(() => toggle.click());
        expect(settings.routing().opennanDefault).toBe(false);
        expect(toggle.getAttribute("aria-checked")).toBe("false");
        expect(registry.route("image.generate")?.info.id).toBe("fal");
        expect(document.querySelector(".opennan-card")!.textContent).not.toContain("Default for all AI tools");
    });

    it("routing: one row per capability, providers that declare it, persisted picks, opennan.* locked", () => {
        const account = createFakeAccount();
        const { registry, settings } = render(account, { providers: [opennan, local, fal] });
        const select = row("image.generate").querySelector("select")!;
        expect(select.getAttribute("aria-label")).toBe("Provider for Image generation");
        expect([...select.options].map((o) => o.textContent)).toEqual(["Automatic · OpenNan", "OpenNan", "fal.ai"]);
        choose(select, "fal");
        expect(settings.routing().overrides).toEqual({ "image.generate": "fal" });
        expect(registry.route("image.generate")?.info.id).toBe("fal");
        choose(select, "");
        expect(settings.routing().overrides).toEqual({});
        expect(row("audio.transcribe").querySelector("select")!.options[0]!.textContent).toBe("Automatic · On this device");
        const none = row("audio.music").querySelector("select")!;
        expect(none.disabled).toBe(true);
        expect(none.options[0]!.textContent).toBe("No provider");
        const locked = row("opennan.story.storyboard");
        expect(locked.querySelector("select")).toBeNull();
        expect(locked.textContent).toContain("OpenNan only");
        expect(locked.querySelector("svg")).not.toBeNull();
    });

    it("lists other providers and adds an OpenNan API key", async () => {
        const account = createFakeAccount();
        render(account, { providers: [opennan, local] });
        expect(document.querySelector('[data-provider="local"]')!.textContent).toContain("Transcription and auto captions");
        act(() => button("Add provider").click());
        expect([...document.querySelectorAll("[role=menuitem]")].map((m) => m.querySelector("strong")!.textContent)).toEqual(["OpenNan API key"]);
        act(() => (document.querySelector("[role=menuitem]") as HTMLButtonElement).click());
        const input = document.querySelector("input[type=password]") as HTMLInputElement;
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
        act(() => {
            setter.call(input, "nope");
            input.dispatchEvent(new Event("input", { bubbles: true }));
        });
        await act(async () => button("Connect").click());
        expect(document.querySelector("[role=alert]")!.textContent).toContain("does not look like an OpenNan API key");
        act(() => {
            setter.call(input, "sk-test_abcdefghijklmnopqrstuvwxyz");
            input.dispatchEvent(new Event("input", { bubbles: true }));
        });
        await act(async () => button("Connect").click());
        expect(account.calls).toContain("key:sk-");
        expect(document.querySelector("input[type=password]")).toBeNull();
    });

    it("desktop: the on-device entry shows its models; bring-your-own keys when the platform holds them", async () => {
        const account = createFakeAccount();
        const settings = memoryProviderSettings();
        const keys = [{ id: "fal" as const, name: "fal.ai", set: false }];
        settings.keys = () => keys;
        settings.setKey = vi.fn(async () => { keys[0]!.set = true; });
        render(account, { providers: [opennan, local], platform: "desktop", settings });
        act(() => button("Add provider").click());
        expect([...document.querySelectorAll("[role=menuitem] strong")].map((m) => m.textContent)).toEqual(["fal.ai", "On this device", "OpenNan API key"]);
        await act(async () => ([...document.querySelectorAll("[role=menuitem]")][1] as HTMLButtonElement).click());
        expect(document.querySelector("[role=dialog]")!.textContent).toContain("Downloaded");
        act(() => button("Done").click());
        act(() => button("Add provider").click());
        act(() => (document.querySelector("[role=menuitem]") as HTMLButtonElement).click());
        expect(document.querySelector("[role=dialog]")!.textContent).toContain("fal.ai bills you directly");
    });

    it("still renders the platform's settings add-ons; tokens only", () => {
        render(createFakeAccount(), { addons: () => createElement("p", { id: "addon" }, "Desktop settings") });
        expect(document.getElementById("addon")).not.toBeNull();
        expect(css).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);
    });
});
