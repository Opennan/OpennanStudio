// The Auto captions dialog over a real TimelineController (LocalBackend) and a fake provider: capability gating,
// language and model choice, progress, cancel, and the placed captions.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ProviderRegistry, createAiRunner, createJob, type Provider, type TranscribeRequest, type Transcript } from "@opennan/provider-sdk";
import { LocalBackend, TimelineController, createEditorStore, createMemoryPersistence } from "@opennan/timeline-core";
import { AccountProvider } from "../account/account-context";
import { createFakeAccount, TEST_ACCOUNT } from "../account/fake-account";
import { StudioRuntimeProvider } from "../platform/runtime-context";
import type { StudioRuntime } from "../platform/runtime-types";
import { captionStyleJson } from "@opennan/timeline-core/text/captions";
import { AutoCaptionsDialog, DESKTOP_HINT, drawCaptionStyleThumb, modelLabel } from "./auto-captions-dialog";
import css from "./auto-captions.css?raw";

const hoisted = vi.hoisted(() => ({ controller: null as unknown }));
vi.mock("@opennan/timeline-react", () => ({ useTimelineController: () => hoisted.controller }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
let host: HTMLElement | null = null;

const TRANSCRIPT: Transcript = {
    language: "en",
    segments: [{ start: 0, end: 2, text: " Hello there" }, { start: 2, end: 4, text: " general Kenobi" }],
};

function fakeProvider(run: (request: TranscribeRequest, context: { signal: AbortSignal; report(p: number | null, m?: string): void }) => Promise<Transcript>) {
    const requests: TranscribeRequest[] = [];
    const provider: Provider = {
        info: { id: "local", name: "On this device", capabilities: ["audio.transcribe"], onDevice: true },
        audio: {
            transcribe: (request) => {
                requests.push(request);
                return createJob((context) => run(request, context));
            },
            models: async () => [
                { id: "tiny", label: "Tiny (fastest)", sizeBytes: 77_691_713, installed: true },
                { id: "base", label: "Base", sizeBytes: 147_951_465, installed: false, default: true },
            ],
        },
    };
    return { provider, requests };
}

async function setup(provider: Provider | null, runtime: Partial<StudioRuntime> = { platform: "web" }) {
    const store = createEditorStore();
    const registry = new ProviderRegistry();
    if (provider) registry.register(provider);
    const backend = new LocalBackend({ persistence: createMemoryPersistence() });
    const controller = new TimelineController({ backend, store, projectId: "p1", onAiRun: createAiRunner(registry) });
    await controller.load();
    hoisted.controller = controller;
    const onClose = vi.fn();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root!.render(createElement(StudioRuntimeProvider, {
        runtime: { ...runtime, providers: registry } as unknown as StudioRuntime,
        children: createElement(AutoCaptionsDialog, { onClose }),
    })));
    return { store, controller, onClose };
}

const button = (name: string) => {
    const found = [...document.querySelectorAll("button")].find((b) => b.textContent === name);
    if (!found) throw new Error(`no button ${name}`);
    return found as HTMLButtonElement;
};
const selects = () => [...document.querySelectorAll("select")] as HTMLSelectElement[];
const choose = (select: HTMLSelectElement, value: string) => act(() => {
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
});
const textClips = (store: ReturnType<typeof createEditorStore>) => (store.getState().timelineData?.clips ?? []).filter((c) => c.trackType === "text");

afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = null;
    host = null;
});

test("without a provider it explains what Auto captions needs and offers no Start", async () => {
    const { onClose } = await setup(null);
    expect(document.body.textContent).toContain("Auto captions requires a provider with the audio.transcribe capability.");
    expect(document.body.textContent).toContain(DESKTOP_HINT);
    expect([...document.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Close"]);
    await act(async () => button("Close").click());
    expect(onClose).toHaveBeenCalled();
});

test("on desktop without whisper it shows the host's reason, not the desktop-app hint", async () => {
    await setup(null, { platform: "desktop", capabilityNote: () => "This build has no whisper.cpp for win32-arm64, so auto captions are not available." });
    expect(document.body.textContent).toContain("This build has no whisper.cpp for win32-arm64");
    expect(document.body.textContent).not.toContain(DESKTOP_HINT);
});

test("lists languages and models, runs ai.run with the choices, shows progress, and places captions", async () => {
    let finish!: () => void;
    const { provider, requests } = fakeProvider(async (_request, { report }) => {
        report(0.4, "Transcribing");
        await new Promise<void>((resolve) => { finish = resolve; });
        return TRANSCRIPT;
    });
    const { store } = await setup(provider);
    const [language, model] = selects();
    expect(language.options[0].textContent).toBe("Auto-detect");
    expect(language.options.length).toBe(101);
    await vi.waitFor(() => expect(model.options.length).toBe(2));
    expect(model.value).toBe("base");
    expect([...model.options].map((o) => o.textContent)).toEqual(["Tiny (fastest) · 74 MB · downloaded", "Base · 141 MB"]);
    choose(language, "th");
    choose(model, "tiny");
    await act(async () => button("Start").click());
    await vi.waitFor(() => expect(document.body.textContent).toContain("Transcribing 40%"));
    expect(requests[0]).toMatchObject({ language: "th", model: "tiny", audio: { kind: "timeline" } });
    expect(selects()[0].disabled).toBe(true);
    await act(async () => finish());
    await vi.waitFor(() => expect(document.body.textContent).toContain("Added 2 captions on a new Captions track."));
    expect(textClips(store).map((c) => c.textContent)).toEqual(["Hello there", "general Kenobi"]);
    expect(store.getState().timelineData!.tracks.some((t) => t.type === "text" && t.label === "Captions")).toBe(true);
});

test("Cancel stops the job and leaves the timeline unchanged", async () => {
    let signal: AbortSignal | null = null;
    const { provider } = fakeProvider((_request, context) => {
        signal = context.signal;
        context.report(0.1, "Downloading the Base model (141 MB)");
        return new Promise(() => undefined);
    });
    const { store, onClose } = await setup(provider);
    await vi.waitFor(() => expect(selects()[1].options.length).toBe(2));
    await act(async () => button("Start").click());
    await vi.waitFor(() => expect(document.body.textContent).toContain("Downloading the Base model"));
    await act(async () => button("Cancel").click());
    await vi.waitFor(() => expect(document.body.textContent).toContain("Cancelled."));
    expect(signal!.aborted).toBe(true);
    expect(textClips(store)).toEqual([]);
    expect(onClose).not.toHaveBeenCalled();
});

test("a failed run shows the provider's message and offers Try again", async () => {
    const { provider } = fakeProvider(async () => {
        throw new Error("The timeline has no audio to transcribe.");
    });
    await setup(provider);
    await vi.waitFor(() => expect(selects()[1].options.length).toBe(2));
    await act(async () => button("Start").click());
    await vi.waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent).toBe("The timeline has no audio to transcribe."));
    expect(button("Try again").disabled).toBe(false);
});

const radios = () => [...document.querySelectorAll('[role="radio"]')] as HTMLButtonElement[];

test("offers the 8 caption styles, Classic by default, karaoke marked word by word; arrows move the choice", async () => {
    const { provider } = fakeProvider(async () => TRANSCRIPT);
    await setup(provider);
    expect(radios().map((r) => r.dataset.style)).toEqual(["classic", "pill", "bold_yellow", "boxed", "neon", "minimal", "karaoke_highlight", "karaoke_box"]);
    expect(radios().filter((r) => r.getAttribute("aria-checked") === "true").map((r) => r.dataset.style)).toEqual(["classic"]);
    expect(radios().filter((r) => r.textContent?.includes("Word by word")).map((r) => r.dataset.style)).toEqual(["karaoke_highlight", "karaoke_box"]);
    act(() => radios()[0].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
    expect(radios().find((r) => r.getAttribute("aria-checked") === "true")?.dataset.style).toBe("pill");
});

test("a chosen style lands on the new captions in the same ai.run (one undo step)", async () => {
    const { provider } = fakeProvider(async () => TRANSCRIPT);
    const { store, controller } = await setup(provider);
    const execute = vi.spyOn(controller, "execute");
    await vi.waitFor(() => expect(selects()[1].options.length).toBe(2));
    await act(async () => radios().find((r) => r.dataset.style === "karaoke_box")!.click());
    await act(async () => button("Start").click());
    await vi.waitFor(() => expect(document.body.textContent).toContain("Added 2 captions on a new Captions track."));
    const types = execute.mock.calls.map((c) => c[0].type);
    expect(types).toEqual(["ai.run"]);
    expect(execute.mock.calls[0][0]).toMatchObject({ placeAt: { kind: "captions-track", style: "karaoke_box" } });
    const created = textClips(store);
    for (const clip of created) expect(JSON.parse(clip.textStyle!)).toMatchObject({ karaoke: "box", captionKind: "caption" });
});

test("Classic needs no extra step: placement already writes it", async () => {
    const { provider } = fakeProvider(async () => TRANSCRIPT);
    const { store, controller } = await setup(provider);
    const execute = vi.spyOn(controller, "execute");
    await vi.waitFor(() => expect(selects()[1].options.length).toBe(2));
    await act(async () => button("Start").click());
    await vi.waitFor(() => expect(document.body.textContent).toContain("Added 2 captions"));
    expect(execute.mock.calls.map((c) => c[0].type)).toEqual(["ai.run"]);
    expect(textClips(store)).toHaveLength(2);
    expect(captionStyleJson("classic")).toBeTruthy();
});

test("thumbnail drawing is a no-op without a canvas context", () => {
    expect(drawCaptionStyleThumb(null, 120, 64, "{}", false)).toBe(false);
});

test("model labels and the stylesheet use theme tokens only", () => {
    expect(modelLabel({ id: "small", label: "Small", sizeBytes: 487_601_967 })).toBe("Small · 465 MB");
    expect(modelLabel({ id: "x", label: "X" })).toBe("X");
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|oklch\(/i);
    expect(css).toMatch(/var\(--on-/);
});

test("phase 11: both engines offer a switch — on this device (free) or OpenNan cloud with its price — and the cloud run says so", async () => {
    const { provider } = fakeProvider(async () => TRANSCRIPT);
    const cloud: Provider = {
        info: { id: "opennan", name: "OpenNan", capabilities: ["audio.transcribe"] },
        audio: { transcribe: () => createJob(async () => TRANSCRIPT), models: async () => [{ id: "cloud", label: "OpenNan cloud", default: true }] },
        price: async (request) => {
            expect(request).toMatchObject({ capability: "audio.transcribe", units: { seconds: 6 } });
            return { kind: "estimate", estimate: { microUsd: 4769, usd: 0.004769, label: "≈ $0.005", units: 1, capped: false } };
        },
    };
    const store = createEditorStore();
    const registry = new ProviderRegistry();
    registry.register(provider);
    registry.register(cloud);
    const backend = new LocalBackend({ persistence: createMemoryPersistence() });
    const controller = new TimelineController({ backend, store, projectId: "p1", onAiRun: createAiRunner(registry) });
    await controller.load();
    await controller.execute({ type: "clip.create", input: { trackType: "audio", trackIndex: 1, startTime: 0, endTime: 6, mediaUrl: "a.wav", mediaType: "audio" } });
    const execute = vi.spyOn(controller, "execute").mockResolvedValue({ ok: true, changed: {}, createdClipIds: ["c1"] });
    hoisted.controller = controller;
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root!.render(createElement(StudioRuntimeProvider, {
        runtime: { platform: "desktop", providers: registry } as unknown as StudioRuntime,
        children: createElement(AutoCaptionsDialog, { onClose: vi.fn() }),
    })));
    await act(async () => new Promise((r) => setTimeout(r, 0)));
    const radios = [...document.querySelectorAll("[role=radiogroup][aria-label='Where to transcribe'] [role=radio]")] as HTMLButtonElement[];
    expect(radios.map((r) => r.textContent)).toEqual(["On this device · free", "OpenNan cloud · ≈ $0.005"]);
    await act(async () => radios[1]!.click());
    expect(document.body.textContent).toContain("Sends the timeline audio to OpenNan cloud");
    await act(async () => button("≈ $0.005 · Run").click());
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ type: "ai.run", capability: "audio.transcribe", input: { language: "auto", engine: "cloud", expectedMaxUsd: 0.005 } }), expect.anything());
});

test("phase 11: captions for one clip send its used range and land at its timeline position", async () => {
    const { provider, requests } = fakeProvider(async () => TRANSCRIPT);
    const store = createEditorStore();
    const registry = new ProviderRegistry();
    registry.register(provider);
    const backend = new LocalBackend({ persistence: createMemoryPersistence() });
    const controller = new TimelineController({ backend, store, projectId: "p1", onAiRun: createAiRunner(registry) });
    await controller.load();
    const created = await controller.execute({ type: "clip.create", input: { trackType: "audio", trackIndex: 1, startTime: 10, endTime: 14, mediaUrl: "opennan-local://media/a", mediaType: "audio", trimStart: 2, trimEnd: 6 } });
    const clipId = created.createdClipIds![0]!;
    hoisted.controller = controller;
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root!.render(createElement(StudioRuntimeProvider, {
        runtime: { platform: "desktop", providers: registry } as unknown as StudioRuntime,
        children: createElement(AutoCaptionsDialog, { onClose: vi.fn(), target: { clipId } }),
    })));
    await vi.waitFor(() => expect(selects()[1]!.options.length).toBe(2));
    await act(async () => button("Start").click());
    await vi.waitFor(() => expect(textClips(store)).toHaveLength(2));
    expect(requests[0]!.audio).toEqual({ kind: "media", url: "opennan-local://media/a", startSeconds: 2, endSeconds: 6 });
    expect(textClips(store).map((c) => c.startTime).sort((a, b) => a - b)).toEqual([10, 12]);
});

test("phase 11.1: the cloud run checks the balance against what it holds; short, nothing runs", async () => {
    const { provider } = fakeProvider(async () => TRANSCRIPT);
    const cloud: Provider = {
        info: { id: "opennan", name: "OpenNan", capabilities: ["audio.transcribe"] },
        audio: { transcribe: () => createJob(async () => TRANSCRIPT), models: async () => [{ id: "cloud", label: "OpenNan cloud", default: true }] },
        price: async () => ({ kind: "estimate", estimate: { microUsd: 4768, usd: 0.004768, label: "≈ $0.005", units: 1, capped: false, source: "quote", holdUsd: 40 } }),
    };
    const store = createEditorStore();
    const registry = new ProviderRegistry();
    registry.register(provider);
    registry.register(cloud);
    const backend = new LocalBackend({ persistence: createMemoryPersistence() });
    const controller = new TimelineController({ backend, store, projectId: "p1", onAiRun: createAiRunner(registry) });
    await controller.load();
    await controller.execute({ type: "clip.create", input: { trackType: "audio", trackIndex: 1, startTime: 0, endTime: 6, mediaUrl: "a.wav", mediaType: "audio" } });
    const execute = vi.spyOn(controller, "execute").mockResolvedValue({ ok: true, changed: {}, createdClipIds: ["c1"] });
    hoisted.controller = controller;
    const account = createFakeAccount({ state: "signed-in", account: TEST_ACCOUNT, persistence: "persistent" });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root!.render(createElement(StudioRuntimeProvider, {
        runtime: { platform: "desktop", providers: registry, account } as unknown as StudioRuntime,
        children: createElement(AccountProvider, { account, providers: registry, children: createElement(AutoCaptionsDialog, { onClose: vi.fn() }) }),
    })));
    await act(async () => new Promise((r) => setTimeout(r, 0)));
    const radios = [...document.querySelectorAll("[role=radiogroup][aria-label='Where to transcribe'] [role=radio]")] as HTMLButtonElement[];
    await act(async () => radios[1]!.click());
    await act(async () => button("≈ $0.005 · Run").click());
    await vi.waitFor(() => expect(document.body.textContent).toContain("Not enough credits: this run holds up to $40.00 while it goes."));
    expect(execute).not.toHaveBeenCalledWith(expect.objectContaining({ type: "ai.run" }), expect.anything());
    expect(account.calls).toContain("refresh");
});
