// The Generate dialog over a real controller (LocalBackend) and a fake OpenNan provider: the sign-in gate,
// ai.run with the description and model, progress, import into the media library, 402, cancel.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JobFailedError, ProviderRegistry, createAiRunner, createJob, type CapabilityOutput, type CapabilityRequest, type JobContext, type Provider } from "@opennan/provider-sdk";
import { LocalBackend, TimelineController, createEditorStore, createMemoryPersistence } from "@opennan/timeline-core";
import { AccountProvider } from "../account/account-context";
import { createFakeAccount, TEST_ACCOUNT, type FakeAccount } from "../account/fake-account";
import { StudioRuntimeProvider } from "../platform/runtime-context";
import type { StudioRuntime } from "../platform/runtime-types";
import { GenerateDialog } from "./generate-dialog";
import { createMediaImporter } from "./import-generated";
import css from "./generate.css?raw";

const hoisted = vi.hoisted(() => ({ controller: null as unknown, aspect: "9:16" }));
vi.mock("@opennan/timeline-react", () => ({
    useTimelineController: () => hoisted.controller,
    useEditorStore: (select: (s: { projectMeta: { aspectRatio: string } }) => unknown) => select({ projectMeta: { aspectRatio: hoisted.aspect } }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    document.body.innerHTML = "";
});

function opennanProvider(run: (request: CapabilityRequest, context: JobContext) => Promise<CapabilityOutput>) {
    const requests: CapabilityRequest[] = [];
    const provider: Provider = {
        info: { id: "opennan", name: "OpenNan", capabilities: ["image.generate", "video.text-to-video"] },
        models: async (capability) => (capability === "image.generate" ? [{ id: "nano-banana-2", label: "Nano Banana 2", default: true }, { id: "seedream-4", label: "Seedream 4" }] : [{ id: "kling-3", label: "Kling 3" }]),
        run: (request) => {
            requests.push(request);
            return createJob((context) => run(request, context));
        },
    };
    return { provider, requests };
}

async function setup(provider: Provider | null, account: FakeAccount) {
    const registry = new ProviderRegistry();
    if (provider) registry.register(provider);
    const backend = new LocalBackend({ persistence: createMemoryPersistence(), createObjectUrl: () => "blob:x" });
    const project = await backend.createProject({ name: "P", aspectRatio: "9:16" });
    const store = createEditorStore();
    const controller = new TimelineController({ backend, store, projectId: project.id, onAiRun: createAiRunner(registry, { importMedia: createMediaImporter(backend) }) });
    await controller.load();
    hoisted.controller = controller;
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    const onClose = vi.fn();
    await act(async () => root!.render(createElement(StudioRuntimeProvider, {
        runtime: { platform: "web", providers: registry, account } as unknown as StudioRuntime,
        children: createElement(AccountProvider, { account, providers: registry, children: createElement(GenerateDialog, { onClose }) }),
    })));
    return { backend, projectId: project.id, onClose };
}

const button = (name: string) => [...document.querySelectorAll("button")].find((b) => b.textContent === name || b.getAttribute("aria-label") === name) as HTMLButtonElement;
const type = (text: string) => act(() => {
    const field = document.querySelector("textarea")!;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    setter.call(field, text);
    field.dispatchEvent(new Event("input", { bubbles: true }));
});
const signedIn = () => createFakeAccount({ state: "signed-in", account: TEST_ACCOUNT, persistence: "persistent" });
const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

describe("GenerateDialog", () => {
    it("generates an image with the description, model, and project aspect, and adds it to Media", async () => {
        const { provider, requests } = opennanProvider(async (_r, { report }) => {
            report(0.5, "generating");
            return { media: [{ kind: "image", bytes: PNG, mimeType: "image/png" }], costUsd: 0.04 };
        });
        const account = signedIn();
        const { backend, projectId } = await setup(provider, account);
        expect(document.querySelector("[role=dialog]")!.textContent).toContain("Describe the image");
        await act(async () => undefined);
        expect([...document.querySelectorAll("select option")].map((o) => o.textContent)).toEqual(["Nano Banana 2", "Seedream 4"]);
        expect(document.querySelector(".generate-meta")!.textContent).toBe("9:16 · OpenNan · charged when it finishes, refunded if it fails");
        expect(button("Generate").disabled).toBe(true);
        type("a lighthouse at dawn");
        await act(async () => button("Generate").click());
        await vi.waitFor(() => expect(document.querySelector("[role=status]")?.textContent).toBe("Added to Media and the timeline."));
        expect(requests).toEqual([{ capability: "image.generate", input: { description: "a lighthouse at dawn", aspectRatio: "9:16", model: "nano-banana-2" }, projectId }]);
        const library = await backend.listLibrary(projectId);
        expect(library).toHaveLength(1);
        expect(library[0]!.mimeType).toBe("image/png");
        expect(account.calls).toContain("refresh");
    });

    it("signed out: opens Sign in with OpenNan with the context line, and runs after approval", async () => {
        const { provider, requests } = opennanProvider(async () => ({ media: [{ kind: "image", bytes: PNG, mimeType: "image/png" }] }));
        const account = createFakeAccount();
        await setup(provider, account);
        type("a cat");
        await act(async () => button("Generate").click());
        expect(document.querySelector(".signin")!.textContent).toContain("Generate image needs an OpenNan account.");
        expect(requests).toEqual([]);
        act(() => button("Sign in with OpenNan").click());
        act(() => account.setStatus({ state: "signed-in", account: TEST_ACCOUNT, persistence: "persistent" }));
        await act(async () => new Promise((r) => setTimeout(r, 1600)));
        await vi.waitFor(() => expect(requests).toHaveLength(1));
    });

    it("closing the sign-in modal runs nothing", async () => {
        const { provider, requests } = opennanProvider(async () => ({ media: [] }));
        await setup(provider, createFakeAccount());
        type("a cat");
        await act(async () => button("Generate").click());
        await act(async () => (document.querySelector(".signin-close") as HTMLButtonElement).click());
        expect(requests).toEqual([]);
        expect(document.querySelector(".signin")).toBeNull();
    });

    it("shows Not enough credits with Buy credits", async () => {
        const { provider } = opennanProvider(async () => {
            throw new JobFailedError("Not enough credits. Buy credits on opennan.com to continue.");
        });
        const account = signedIn();
        await setup(provider, account);
        type("a cat");
        await act(async () => button("Generate").click());
        await vi.waitFor(() => expect(document.querySelector("[role=alert]")?.textContent).toContain("Not enough credits."));
        act(() => button("Buy credits").click());
        expect(account.consoles).toEqual(["billing"]);
    });

    it("cancels a running job; switches to video", async () => {
        let seen: AbortSignal | null = null;
        const { provider, requests } = opennanProvider((_r, { signal }) => new Promise((_, reject) => {
            seen = signal;
            signal.addEventListener("abort", () => reject(new Error("aborted")));
        }));
        await setup(provider, signedIn());
        act(() => button("Video").click());
        expect(document.querySelector("[role=dialog]")!.textContent).toContain("Describe the video");
        type("waves");
        await act(async () => button("Generate").click());
        await vi.waitFor(() => expect(seen).not.toBeNull());
        await act(async () => button("Cancel").click());
        await vi.waitFor(() => expect(document.querySelector("[role=status]")?.textContent).toBe("Cancelled."));
        expect(requests[0]!.capability).toBe("video.text-to-video");
    });

    it("shows the price on the button, lists voices for text to speech, and places the result at the playhead", async () => {
        const { provider, requests } = opennanProvider(async () => ({ media: [{ kind: "audio", bytes: PNG, mimeType: "audio/mpeg" }] }));
        provider.info.capabilities.push("audio.tts");
        const prices: unknown[] = [];
        provider.price = async (request) => {
            prices.push(request);
            return { kind: "estimate", estimate: { microUsd: 26001, usd: 0.026001, label: "≈ $0.027", units: 1, capped: false } };
        };
        provider.voices = async () => [{ id: "af_heart", name: "Heart", language: "en-US", gender: "female" }, { id: "am_adam", name: "Adam", language: "en-US", gender: "male" }];
        await setup(provider, signedIn());
        act(() => button("Voice").click());
        await act(async () => new Promise((r) => setTimeout(r, 0)));
        expect([...document.querySelectorAll("select[aria-label=Voice] option")].map((o) => o.textContent)).toEqual(["Heart · en-US · female", "Adam · en-US · male"]);
        type("Hello there");
        await act(async () => new Promise((r) => setTimeout(r, 450)));
        const run = document.querySelector<HTMLButtonElement>("[data-testid=generate-run]")!;
        expect(run.textContent).toBe("≈ $0.027 · Generate");
        expect(prices.at(-1)).toMatchObject({ capability: "audio.tts", units: { characters: 11 } });
        await act(async () => run.click());
        await vi.waitFor(() => expect(requests).toHaveLength(1));
        expect(requests[0]!.input).toMatchObject({ text: "Hello there", voice: "af_heart" });
    });

    it("does not run while the price cannot be read (a provider with prices must show one first)", async () => {
        const { provider, requests } = opennanProvider(async () => ({ media: [] }));
        provider.price = async () => ({ kind: "unknown" });
        await setup(provider, signedIn());
        type("a lighthouse");
        await act(async () => new Promise((r) => setTimeout(r, 450)));
        const run = document.querySelector<HTMLButtonElement>("[data-testid=generate-run]")!;
        expect(run.disabled).toBe(true);
        expect(document.body.textContent).toContain("The price could not be read.");
        await act(async () => run.click());
        expect(requests).toEqual([]);
    });

    it("checks the balance against what the run holds: short, nothing runs and Buy credits shows (phase 11.1)", async () => {
        const { provider, requests } = opennanProvider(async () => ({ media: [] }));
        provider.price = async () => ({ kind: "estimate", estimate: { microUsd: 400_000, usd: 0.4, label: "≈ $0.400", units: 1, capped: false, source: "quote", holdUsd: 50 } });
        const account = signedIn();
        await setup(provider, account);
        type("a lighthouse");
        await act(async () => new Promise((r) => setTimeout(r, 450)));
        await act(async () => document.querySelector<HTMLButtonElement>("[data-testid=generate-run]")!.click());
        await vi.waitFor(() => expect(document.querySelector("[role=alert]")?.textContent).toContain("Not enough credits: this run holds up to $50.00 while it goes."));
        expect(requests).toEqual([]);
        act(() => button("Buy credits").click());
        expect(account.consoles).toEqual(["billing"]);
    });

    it("waits for typing to settle before asking the price (400 ms)", async () => {
        const { provider } = opennanProvider(async () => ({ media: [] }));
        const prices: unknown[] = [];
        provider.price = async (request) => {
            prices.push(request);
            return { kind: "estimate", estimate: { microUsd: 39_000, usd: 0.039, label: "≈ $0.039", units: 1, capped: false, source: "quote", holdUsd: 0.039 } };
        };
        await setup(provider, signedIn());
        await act(async () => new Promise((r) => setTimeout(r, 450)));
        const before = prices.length;
        for (const text of ["a", "a l", "a li", "a lig"]) {
            type(text);
            await act(async () => new Promise((r) => setTimeout(r, 100)));
        }
        expect(prices.length).toBe(before);
        await act(async () => new Promise((r) => setTimeout(r, 450)));
        expect(prices.length).toBe(before + 1);
    });

    it("explains the capability without a provider", async () => {
        await setup(null, createFakeAccount());
        expect(document.querySelector("[role=note]")!.textContent).toMatch(/requires a provider with the image\.generate capability/);
        expect(button("Generate")).toBeUndefined();
    });

    it("uses theme tokens only", () => {
        expect(css).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);
    });
});
