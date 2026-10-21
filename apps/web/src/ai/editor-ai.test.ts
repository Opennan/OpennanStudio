import { ProviderRegistry, type PriceAnswer, type Provider } from "@opennan/provider-sdk";
import type { AiToolPlan, AiToolPlanResult, CommandResult, EditorCommand, ExecuteOptions, TimelineToast } from "@opennan/timeline-core";
import { createEditorAi, type EditorAiOptions } from "./editor-ai";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function plan(overrides: Partial<AiToolPlan> = {}): AiToolPlan {
    return {
        toolId: "voice-isolation",
        capability: "audio.isolate-voice",
        input: { source: { mediaUrl: "opennan-local://media/a", startSeconds: 0, endSeconds: 20 } },
        placeAt: { kind: "replace-audio", source: { clipId: "c1" }, range: { startSeconds: 0, endSeconds: 20 } },
        units: { seconds: 20 },
        limit: { maxSeconds: 600 },
        target: { clipId: "c1" },
        label: "Isolate voice · interview.wav",
        ...overrides,
    };
}

function provider(id: string, capabilities: Provider["info"]["capabilities"], answer: PriceAnswer | ((request?: unknown) => Promise<PriceAnswer>), name = id): Provider {
    return {
        info: { id, name, capabilities },
        price: typeof answer === "function" ? answer : async () => answer,
    };
}

const ESTIMATE: PriceAnswer = { kind: "estimate", estimate: { microUsd: 130001, usd: 0.130001, label: "≈ $0.131", units: 1, capped: false } };

interface Harness {
    ai: ReturnType<typeof createEditorAi>;
    commands: Array<{ command: EditorCommand; options: ExecuteOptions }>;
    toasts: TimelineToast[];
    activity: Map<string, number | null>;
    signIn: ReturnType<typeof vi.fn>;
    finish(index: number, result: CommandResult): void;
    progress(index: number, update: Parameters<NonNullable<ExecuteOptions["onProgress"]>>[0]): void;
    signedIn: { value: boolean };
}

function harness(options: { providers?: Provider[]; planResult?: AiToolPlanResult; signedIn?: boolean; overrides?: Partial<EditorAiOptions> } = {}): Harness {
    const registry = new ProviderRegistry();
    for (const p of options.providers ?? [provider("opennan", ["audio.isolate-voice", "video.upscale"], ESTIMATE, "OpenNan")]) registry.register(p);
    const commands: Harness["commands"] = [];
    const resolvers: Array<(result: CommandResult) => void> = [];
    const toasts: TimelineToast[] = [];
    const activity = new Map<string, number | null>();
    const signedIn = { value: options.signedIn ?? true };
    const signIn = vi.fn(async () => {
        signedIn.value = true;
        return true;
    });
    const ai = createEditorAi({
        controller: {
            execute: (command, executeOptions = {}) => {
                commands.push({ command, options: executeOptions });
                if (command.type !== "ai.run") return Promise.resolve({ ok: true, changed: {} });
                return new Promise<CommandResult>((resolve) => resolvers.push(resolve));
            },
            snapshot: () => ({ projectId: "p1" } as never),
        },
        providers: registry,
        isSignedIn: () => signedIn.value,
        openSignIn: signIn,
        toast: (t) => {
            toasts.push(t);
        },
        activity: (id, progress) => {
            activity.set(id, progress);
        },
        plan: () => options.planResult ?? { ok: true, plan: plan() },
        priceDebounceMs: 0,
        ...options.overrides,
    });
    return {
        ai, commands, toasts, activity, signIn, signedIn,
        finish: (index, result) => resolvers[index]!(result),
        progress: (index, update) => commands.filter((c) => c.command.type === "ai.run")[index]!.options.onProgress!(update),
    };
}

describe("createEditorAi: tool states and prices", () => {
    it("shows the provider's estimate once it loads, and notifies", async () => {
        const h = harness();
        const listener = vi.fn();
        h.ai.subscribe(listener);
        expect(h.ai.tool("voice-isolation", { clipId: "c1" })).toMatchObject({ state: "ready", price: { kind: "loading" }, providerName: "OpenNan" });
        await tick();
        expect(listener).toHaveBeenCalled();
        expect(h.ai.tool("voice-isolation", { clipId: "c1" })).toMatchObject({ state: "ready", price: { kind: "estimate", label: "≈ $0.131" } });
    });

    it("asks to sign in when OpenNan runs the tool and the account is signed out (the price still shows)", async () => {
        const h = harness({ signedIn: false });
        h.ai.tool("voice-isolation", { clipId: "c1" });
        await tick();
        expect(h.ai.tool("voice-isolation", { clipId: "c1" })).toMatchObject({ state: "sign-in", price: { kind: "estimate" } });
    });

    it("is unavailable with the plan's reason, with no provider, or when the provider says the tool is not live", async () => {
        expect(harness({ planResult: { ok: false, error: "Select a video clip or scene" } }).ai.tool("video-upscale", {}))
            .toMatchObject({ state: "unavailable", reason: "Select a video clip or scene" });
        const none = harness({ providers: [] });
        expect(none.ai.tool("voice-isolation", { clipId: "c1" })).toMatchObject({ state: "unavailable", reason: expect.stringMatching(/Isolate voice/) });
        const down = harness({ providers: [provider("opennan", ["audio.isolate-voice"], { kind: "unavailable", reason: "Isolate voice is unavailable on OpenNan right now." })] });
        down.ai.tool("voice-isolation", { clipId: "c1" });
        await tick();
        expect(down.ai.tool("voice-isolation", { clipId: "c1" })).toMatchObject({ state: "unavailable", reason: "Isolate voice is unavailable on OpenNan right now." });
    });

    it("reports the limit of a clip that is too long, and prices the first N seconds", async () => {
        const requests: unknown[] = [];
        const h = harness({
            providers: [provider("opennan", ["video.upscale"], async (request?: unknown) => {
                requests.push(request);
                return ESTIMATE;
            })],
            planResult: { ok: true, plan: plan({ toolId: "video-upscale", capability: "video.upscale", units: { seconds: 180, resolution: "4k" }, limit: { maxSeconds: 60 }, overLimit: { kind: "seconds", max: 60, actual: 180 } }) },
        });
        expect(h.ai.tool("video-upscale", { clipId: "c1", resolution: "4k" })).toMatchObject({ state: "over-limit", limit: { maxSeconds: 60 } });
        await tick();
        expect(requests[0]).toMatchObject({ capability: "video.upscale", units: { seconds: 60, resolution: "4k" } });
    });

    it("free for local tools, billed elsewhere for fal, desktop-only stabilize on the web", async () => {
        const local = harness({ planResult: { ok: true, plan: plan({ toolId: "silences", capability: "local" }) } });
        expect(local.ai.tool("silences", { clipId: "c1" })).toMatchObject({ state: "ready", price: { kind: "free" } });
        const fal = harness({ providers: [provider("fal", ["audio.isolate-voice"], { kind: "billed-elsewhere", by: "fal.ai" }, "fal.ai")] });
        fal.ai.tool("voice-isolation", { clipId: "c1" });
        await tick();
        expect(fal.ai.tool("voice-isolation", { clipId: "c1" })).toMatchObject({ state: "ready", price: { kind: "billed-elsewhere", by: "fal.ai" } });
        const web = harness({ providers: [], planResult: { ok: true, plan: plan({ toolId: "stabilize", capability: "media.stabilize" }) } });
        expect(web.ai.tool("stabilize", { clipId: "c1" })).toMatchObject({ state: "unavailable", reason: "Desktop app only" });
    });
});

describe("createEditorAi: runs", () => {
    it("runs ai.run with the plan, its displayed estimate, progress, and the result's cost; selects what it placed", async () => {
        const h = harness();
        h.ai.tool("voice-isolation", { clipId: "c1" });
        await tick();
        h.ai.run("voice-isolation", { clipId: "c1" });
        await tick();
        const run = h.commands.find((c) => c.command.type === "ai.run")!;
        expect(run.command).toMatchObject({
            type: "ai.run", capability: "audio.isolate-voice",
            input: { source: { mediaUrl: "opennan-local://media/a" }, expectedMaxUsd: 0.131 },
            placeAt: { kind: "replace-audio" },
        });
        expect(run.options.toastOnError).toBe(false);
        h.progress(0, { jobId: "j1", status: "running", progress: 0.4, message: "Isolating" });
        expect(h.ai.jobs()[0]).toMatchObject({ status: "running", stage: "Isolating", progress: 0.4, cancellable: true, targetId: "c1" });
        expect(h.activity.get("c1")).toBe(0.4);
        h.finish(0, { ok: true, changed: {}, jobId: "j1", createdClipIds: ["n1"], output: { media: [], costUsd: 0.13 } });
        await tick();
        expect(h.ai.jobs()[0]).toMatchObject({ status: "succeeded", costUsd: 0.13 });
        expect(h.activity.get("c1")).toBeNull();
        expect(h.commands.some((c) => c.command.type === "selection.set" && (c.command as { clipIds?: string[] }).clipIds?.[0] === "n1")).toBe(true);
    });

    it("signed out: opens Sign in with OpenNan first and runs after approval; a closed modal runs nothing", async () => {
        const h = harness({ signedIn: false });
        h.ai.run("voice-isolation", { clipId: "c1" });
        await tick();
        expect(h.signIn).toHaveBeenCalledWith("Isolate voice");
        expect(h.commands.filter((c) => c.command.type === "ai.run")).toHaveLength(1);
        const refused = harness({ signedIn: false, overrides: { openSignIn: async () => false } });
        refused.ai.run("voice-isolation", { clipId: "c1" });
        await tick();
        expect(refused.commands).toHaveLength(0);
    });

    it("queues past two running jobs and starts the next when one ends; cancel removes a queued job", async () => {
        const h = harness();
        for (let i = 0; i < 3; i += 1) h.ai.run("voice-isolation", { clipId: "c1" });
        await tick();
        expect(h.commands.filter((c) => c.command.type === "ai.run")).toHaveLength(2);
        expect(h.ai.jobs().map((j) => j.status)).toEqual(["preparing", "preparing", "queued"]);
        const queued = h.ai.jobs()[2]!;
        h.ai.cancel(queued.id);
        expect(h.ai.jobs()[2]).toMatchObject({ status: "cancelled" });
        h.ai.run("voice-isolation", { clipId: "c1" });
        await tick();
        h.finish(0, { ok: true, changed: {} });
        await tick();
        expect(h.commands.filter((c) => c.command.type === "ai.run")).toHaveLength(3);
    });

    it("cancel aborts a running job; a refused cancel shows it will finish and be charged", async () => {
        const h = harness();
        h.ai.run("voice-isolation", { clipId: "c1" });
        await tick();
        const job = h.ai.jobs()[0]!;
        h.ai.cancel(job.id);
        expect(h.commands[0]!.options.signal!.aborted).toBe(true);
        h.progress(0, { jobId: "j", status: "running", cancellable: false, message: "Already running: it will finish and be charged." } as never);
        expect(h.ai.jobs()[0]).toMatchObject({ status: "running", cancellable: false, message: "Already running: it will finish and be charged." });
        h.finish(0, { ok: true, changed: {}, output: { media: [], costUsd: 0.13 } });
        await tick();
        expect(h.ai.jobs()[0]).toMatchObject({ status: "succeeded" });
        const quick = harness();
        quick.ai.run("voice-isolation", { clipId: "c1" });
        await tick();
        quick.ai.cancel(quick.ai.jobs()[0]!.id);
        quick.finish(0, { ok: false, changed: {}, cancelled: true });
        await tick();
        expect(quick.ai.jobs()[0]).toMatchObject({ status: "cancelled", message: "Cancelled. You were not charged." });
    });

    it("a failure shows an error toast with Retry (never retried by itself); Retry runs it again", async () => {
        const h = harness();
        h.ai.run("voice-isolation", { clipId: "c1" });
        await tick();
        h.finish(0, { ok: false, changed: {}, error: "The run failed. You were not charged." });
        await tick();
        expect(h.ai.jobs()[0]).toMatchObject({ status: "failed", error: "The run failed. You were not charged.", refunded: true, canRetry: true });
        expect(h.commands.filter((c) => c.command.type === "ai.run")).toHaveLength(1);
        const toast = h.toasts.find((t) => t.kind === "error")!;
        expect(toast.message).toMatch(/Isolate voice/);
        expect(toast.action?.label).toBe("Retry");
        toast.action!.run();
        await tick();
        expect(h.commands.filter((c) => c.command.type === "ai.run")).toHaveLength(2);
    });

    it("not enough credits: no error toast of its own (the account shows Buy credits), Retry stays on the job", async () => {
        const h = harness();
        h.ai.run("voice-isolation", { clipId: "c1" });
        await tick();
        h.finish(0, { ok: false, changed: {}, error: "Not enough credits. Buy credits on opennan.com to continue." });
        await tick();
        expect(h.toasts.filter((t) => t.kind === "error")).toHaveLength(0);
        expect(h.ai.jobs()[0]).toMatchObject({ status: "failed", canRetry: true });
    });

    it("refuses a run past the limit (the UI offers the first N seconds) and a tool that is not live", async () => {
        const over = harness({ planResult: { ok: true, plan: plan({ overLimit: { kind: "seconds", max: 600, actual: 900 } }) } });
        over.ai.run("voice-isolation", { clipId: "c1" });
        await tick();
        expect(over.commands).toHaveLength(0);
        const down = harness({ providers: [provider("opennan", ["audio.isolate-voice"], { kind: "unavailable", reason: "Isolate voice is unavailable on OpenNan right now." })] });
        down.ai.run("voice-isolation", { clipId: "c1" });
        await tick();
        expect(down.commands).toHaveLength(0);
        expect(down.toasts[0]).toMatchObject({ kind: "error", message: "Isolate voice is unavailable on OpenNan right now." });
    });

    it("dismiss removes a finished job", async () => {
        const h = harness();
        h.ai.run("voice-isolation", { clipId: "c1" });
        await tick();
        h.finish(0, { ok: true, changed: {} });
        await tick();
        h.ai.dismiss(h.ai.jobs()[0]!.id);
        expect(h.ai.jobs()).toEqual([]);
    });
});

describe("createEditorAi: no paid run without a price (review finding 2, 4)", () => {
    it("an unreadable price disables the tool with a reason, is read again later, and blocks the run", async () => {
        let answer: PriceAnswer = { kind: "unknown" };
        let calls = 0;
        const now = { value: 1_000 };
        const h = harness({
            providers: [provider("opennan", ["audio.isolate-voice"], async () => {
                calls += 1;
                return answer;
            }, "OpenNan")],
            overrides: { now: () => now.value },
        });
        h.ai.tool("voice-isolation", { clipId: "c1" });
        await tick();
        expect(h.ai.tool("voice-isolation", { clipId: "c1" })).toMatchObject({ state: "unavailable", reason: "The price could not be read. Try again in a moment." });
        h.ai.run("voice-isolation", { clipId: "c1" });
        await tick();
        expect(h.commands.filter((c) => c.command.type === "ai.run")).toHaveLength(0);
        // Read again after a while (not on every render).
        h.ai.tool("voice-isolation", { clipId: "c1" });
        expect(calls).toBe(1);
        answer = ESTIMATE;
        now.value += 15_000;
        h.ai.tool("voice-isolation", { clipId: "c1" });
        await tick();
        expect(calls).toBe(2);
        expect(h.ai.tool("voice-isolation", { clipId: "c1" })).toMatchObject({ state: "ready", price: { kind: "estimate" } });
    });

    it("a run while the price loads waits for it and runs with it", async () => {
        let release!: (answer: PriceAnswer) => void;
        const h = harness({ providers: [provider("opennan", ["audio.isolate-voice"], () => new Promise<PriceAnswer>((resolve) => { release = resolve; }), "OpenNan")] });
        h.ai.run("voice-isolation", { clipId: "c1" });
        await tick();
        expect(h.commands).toHaveLength(0);
        release(ESTIMATE);
        await tick();
        await tick();
        expect(h.commands.find((c) => c.command.type === "ai.run")!.command).toMatchObject({ input: { expectedMaxUsd: 0.131 } });
    });

    it("after 'The price changed', Retry runs at the new amount the toast shows", async () => {
        const h = harness();
        h.ai.run("voice-isolation", { clipId: "c1" });
        await tick();
        h.finish(0, { ok: false, changed: {}, error: "The price changed: ≈ $0.262. Run again to accept." });
        await tick();
        const toast = h.toasts.find((t) => t.kind === "error")!;
        expect(toast.action!.label).toBe("Run at ≈ $0.262");
        toast.action!.run();
        await tick();
        await tick();
        const runs = h.commands.filter((c) => c.command.type === "ai.run");
        expect(runs).toHaveLength(2);
        expect(runs[1]!.command).toMatchObject({ input: { expectedMaxUsd: 0.262 } });
        // The tray's Retry on that job accepts the same amount.
        h.ai.retry(h.ai.jobs()[0]!.id);
        await tick();
        await tick();
        expect(h.commands.filter((c) => c.command.type === "ai.run")[2]!.command).toMatchObject({ input: { expectedMaxUsd: 0.262 } });
    });
});

describe("createEditorAi: unreadable prices are read again on their own (review finding C1)", () => {
    it("notifies after the retry wait so an idle surface asks again", async () => {
        vi.useFakeTimers();
        try {
            const now = { value: 0 };
            const h = harness({ providers: [provider("opennan", ["audio.isolate-voice"], async () => ({ kind: "unknown" }), "OpenNan")], overrides: { now: () => now.value } });
            const listener = vi.fn();
            h.ai.subscribe(listener);
            h.ai.tool("voice-isolation", { clipId: "c1" });
            await vi.advanceTimersByTimeAsync(0);
            const before = listener.mock.calls.length;
            now.value = 10_000;
            await vi.advanceTimersByTimeAsync(10_000);
            expect(listener.mock.calls.length).toBeGreaterThan(before);
        } finally {
            vi.useRealTimers();
        }
    });
});

describe("createEditorAi: quotes (phase 11.1)", () => {
    it("debounces price reads per tool and item: a trim drag asks once, for where it stopped", async () => {
        vi.useFakeTimers();
        try {
            const asked: number[] = [];
            let seconds = 10;
            const h = harness({
                providers: [provider("opennan", ["audio.isolate-voice"], async (request?: unknown) => {
                    asked.push((request as { units: { seconds: number } }).units.seconds);
                    return ESTIMATE;
                }, "OpenNan")],
                overrides: { priceDebounceMs: 250, plan: () => ({ ok: true, plan: plan({ units: { seconds } }) }) },
            });
            for (seconds = 10; seconds < 15; seconds += 1) {
                expect(h.ai.tool("voice-isolation", { clipId: "c1" }).price).toEqual({ kind: "loading" });
                await vi.advanceTimersByTimeAsync(50);
            }
            seconds = 14;
            await vi.advanceTimersByTimeAsync(300);
            expect(asked).toEqual([14]);
            expect(h.ai.tool("voice-isolation", { clipId: "c1" }).price).toMatchObject({ kind: "estimate" });
        } finally {
            vi.useRealTimers();
        }
    });

    it("two items of one tool without ids (captions tracks) never starve each other's debounce", async () => {
        vi.useFakeTimers();
        try {
            const asked: unknown[] = [];
            const h = harness({
                providers: [provider("opennan", ["captions.translate"], async (request?: unknown) => {
                    asked.push((request as { input: { track: number } }).input.track);
                    return ESTIMATE;
                }, "OpenNan")],
                overrides: {
                    priceDebounceMs: 250,
                    plan: (_snapshot, _tool, params) => ({ ok: true, plan: plan({ toolId: "caption-translate", capability: "captions.translate", input: { track: (params as { trackIndex: number }).trackIndex }, units: { characters: 100 * (params as { trackIndex: number }).trackIndex }, target: {} }) }),
                },
            });
            for (let i = 0; i < 10; i += 1) {
                h.ai.tool("caption-translate", { trackIndex: 1 });
                h.ai.tool("caption-translate", { trackIndex: 2 });
                await vi.advanceTimersByTimeAsync(100);
            }
            await vi.advanceTimersByTimeAsync(300);
            expect(asked.sort()).toEqual([1, 2]);
        } finally {
            vi.useRealTimers();
        }
    });

    it("changing an option of one item drops the read still waiting for the old option (no wasted quote)", async () => {
        vi.useFakeTimers();
        try {
            const asked: unknown[] = [];
            const h = harness({
                providers: [provider("opennan", ["video.upscale"], async (request?: unknown) => {
                    asked.push((request as { units: { resolution: string } }).units.resolution);
                    return ESTIMATE;
                }, "OpenNan")],
                overrides: {
                    priceDebounceMs: 250,
                    plan: (_snapshot, _tool, params) => ({ ok: true, plan: plan({ toolId: "video-upscale", capability: "video.upscale", units: { seconds: 5, resolution: (params as { resolution: string }).resolution } }) }),
                },
            });
            h.ai.tool("video-upscale", { clipId: "c1", resolution: "1080p" });
            await vi.advanceTimersByTimeAsync(100);
            h.ai.tool("video-upscale", { clipId: "c1", resolution: "4k" });
            await vi.advanceTimersByTimeAsync(300);
            expect(asked).toEqual(["4k"]);
        } finally {
            vi.useRealTimers();
        }
    });

    it("a run never waits for the debounce", async () => {
        const asked: number[] = [];
        const h = harness({
            providers: [provider("opennan", ["audio.isolate-voice"], async () => {
                asked.push(1);
                return ESTIMATE;
            }, "OpenNan")],
            overrides: { priceDebounceMs: 60_000 },
        });
        h.ai.run("voice-isolation", { clipId: "c1" });
        await tick();
        await tick();
        expect(asked).toHaveLength(1);
        expect(h.commands.some((c) => c.command.type === "ai.run")).toBe(true);
    });

    const QUOTE: PriceAnswer = { kind: "estimate", estimate: { microUsd: 130_000, usd: 0.13, label: "≈ $0.130", units: 1, capped: false, source: "quote", holdUsd: 1.3 } };

    it("checks the balance against the quote's hold: short after a refresh, nothing runs and Buy credits shows", async () => {
        const balance = { value: 0.5 as number | null };
        const refresh = vi.fn(async () => undefined);
        const short = vi.fn();
        const h = harness({
            providers: [provider("opennan", ["audio.isolate-voice"], QUOTE, "OpenNan")],
            overrides: { account: { balance: () => balance.value, refresh }, notEnoughCredits: short },
        });
        h.ai.run("voice-isolation", { clipId: "c1" });
        await vi.waitFor(() => expect(short).toHaveBeenCalledWith(1.3));
        expect(refresh).toHaveBeenCalledTimes(1);
        expect(h.commands.some((c) => c.command.type === "ai.run")).toBe(false);
        // A top-up seen by the refresh lets it run; an unknown balance never blocks.
        refresh.mockImplementation(async () => {
            balance.value = 2;
        });
        h.ai.run("voice-isolation", { clipId: "c1" });
        await vi.waitFor(() => expect(h.commands.some((c) => c.command.type === "ai.run")).toBe(true));
        balance.value = null;
        h.ai.run("voice-isolation", { clipId: "c1" });
        await vi.waitFor(() => expect(h.commands.filter((c) => c.command.type === "ai.run")).toHaveLength(2));
    });

    it("without a quote the estimate's amount is the hold; a balance that covers it runs at once", async () => {
        const refresh = vi.fn(async () => undefined);
        const h = harness({ overrides: { account: { balance: () => 5, refresh }, notEnoughCredits: vi.fn() } });
        h.ai.run("voice-isolation", { clipId: "c1" });
        await vi.waitFor(() => expect(h.commands.some((c) => c.command.type === "ai.run")).toBe(true));
        expect(refresh).not.toHaveBeenCalled();
    });
});
