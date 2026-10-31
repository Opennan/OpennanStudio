// Story film in the editor (AI library → Story film): the window's host. It reads and stores the project's story film
// (ProjectMeta.storyFilmJson, no undo step), prices each step with the routed providers (never under; a step without a
// price never runs), opens Sign in with OpenNan before a paid step, checks the balance covers what the step holds,
// runs the step through ai.run on the controller (every result saved to Media and recorded on the story as it lands,
// so a re-run never pays twice; the keyframes' cast checks too), and lays the result out as a reel. One step runs at a
// time; Cancel stops it.
import {
    OPENNAN_PROVIDER_ID, isProviderCapability, type PriceAnswer, type ProviderModel, type ProviderRegistry,
} from "@opennan/provider-sdk";
import {
    estimateCastCheck, estimateStep, parseDraftReply, readStoryJson, reelInputOf, runStep, storyJson, withAssembled, withNewerAssets,
    type DraftRequest, type ItemUpdate, type StepEstimate, type StepOptions, type StoryFilm, type StoryFilmHost, type StoryRunResult, type StoryStep,
} from "@opennan/story-film";
import { applyReelLayout, type CommandResult, type ControllerSnapshot, type EditorCommand, type ExecuteOptions } from "@opennan/timeline-core";
import { holdCovered, notEnoughCreditsMessage, type HoldAccount } from "./hold-check";

export interface StoryFilmHostOptions {
    controller: {
        execute(command: EditorCommand, options?: ExecuteOptions): Promise<CommandResult>;
        snapshot(): ControllerSnapshot;
    };
    providers: ProviderRegistry;
    /** Sign in with OpenNan first when the step runs on OpenNan signed out; resolves false when it does not happen. */
    requireOpenNan(capability: StoryCapability, feature: string): Promise<boolean>;
    account?: HoldAccount;
    notEnoughCredits?(holdUsd: number): void;
    refreshAccount?(): void;
}

export type StoryCapability = "image.generate" | "video.image-to-video" | "audio.music" | "text.generate" | "web.fetch";

export const STEP_CAPABILITY: Record<StoryStep, StoryCapability> = { cast: "image.generate", frames: "image.generate", animate: "video.image-to-video", music: "audio.music" };

export interface StoryFilmState {
    running: { step: StoryStep | "draft" | "assemble"; label: string } | null;
    /** The latest update of every item of the step that ran last (by id). */
    items: Record<string, ItemUpdate>;
    /** The last failure in words (the step's, the draft's). */
    error: string | null;
    /** A draft that did not read as a story: its problems. */
    draftErrors: string[];
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** ai.run's result as the pipeline's result (media URLs in the project, the cost, a tool's result). */
export function storyRunResult(result: CommandResult): StoryRunResult {
    if (!result.ok) return { ok: false, error: result.error ?? "The run failed.", ...(result.cancelled ? { cancelled: true } : {}), ...(result.unavailable ? { unavailable: true } : {}) };
    const output = (result.output ?? {}) as { media?: Array<Record<string, unknown>>; costUsd?: unknown; result?: unknown };
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined);
    const media = (output.media ?? []).filter((m) => typeof m?.url === "string").map((m) => ({
        url: m.url as string,
        ...(num(m.width) && num(m.height) ? { width: m.width as number, height: m.height as number } : {}),
        ...(num(m.durationSeconds) ? { durationSeconds: m.durationSeconds as number } : {}),
    }));
    return { ok: true, media, ...(typeof output.costUsd === "number" ? { costUsd: output.costUsd } : {}), ...(output.result !== undefined ? { result: output.result } : {}) };
}

export class StoryFilmSession {
    private listeners = new Set<() => void>();
    private changes = 0;
    private abort: AbortController | null = null;
    private stateValue: StoryFilmState = { running: null, items: {}, error: null, draftErrors: [] };
    readonly host: StoryFilmHost;

    constructor(private readonly options: StoryFilmHostOptions) {
        this.host = {
            run: async (capability, input, run) => storyRunResult(await options.controller.execute(
                { type: "ai.run", capability, input },
                { ...(run.signal ? { signal: run.signal } : {}), toastOnError: false, onProgress: (p) => run.onProgress?.({ ...(p.progress !== undefined ? { progress: p.progress } : {}), ...(p.message ? { message: p.message } : {}) }) },
            )),
            price: (capability, input, units) => this.price(capability, input, units),
        };
    }

    subscribe = (listener: () => void): (() => void) => {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    };

    version = (): number => this.changes;

    state(): StoryFilmState {
        return this.stateValue;
    }

    private set(patch: Partial<StoryFilmState>): void {
        this.stateValue = { ...this.stateValue, ...patch };
        this.changes += 1;
        for (const listener of [...this.listeners]) listener();
    }

    /** The project's story film as stored now. */
    story(): StoryFilm | null {
        return readStoryJson(this.options.controller.snapshot().project?.storyFilmJson ?? null);
    }

    async save(story: StoryFilm | null): Promise<void> {
        const result = await this.options.controller.execute({ type: "project.update", patch: { storyFilmJson: story ? storyJson(story) : null } }, { recordHistory: false, toastOnError: false });
        if (!result.ok) throw new Error(result.error ?? "The story film could not be saved.");
    }

    /** Whether some provider runs the capability (else the step shows why it cannot run). */
    available(capability: StoryCapability): boolean {
        return this.options.providers.route(capability) !== null;
    }

    providerName(capability: StoryCapability): string | null {
        return this.options.providers.route(capability)?.info.name ?? null;
    }

    async models(capability: StoryCapability): Promise<ProviderModel[]> {
        const provider = this.options.providers.route(capability);
        return (await provider?.models?.(capability).catch(() => [])) ?? [];
    }

    async price(capability: string, input: Record<string, unknown>, units: Parameters<StoryFilmHost["price"]>[2]): Promise<PriceAnswer> {
        if (!isProviderCapability(capability)) return { kind: "unavailable", reason: `Unknown capability ${capability}.` };
        const provider = this.options.providers.route(capability);
        if (!provider) return { kind: "unavailable", reason: "No connected provider makes this. Connect OpenNan." };
        // A provider without published prices bills its own account (a stored key).
        if (!provider.price) return { kind: "billed-elsewhere", by: provider.info.name };
        return provider.price({ capability, input, units }).catch((): PriceAnswer => ({ kind: "unknown" }));
    }

    estimate(story: StoryFilm, step: StoryStep, options: StepOptions = {}): Promise<StepEstimate> {
        return estimateStep(this.host, story, step, options);
    }

    /** The dearest single cast check of the story's shots (null: no shot has a cast). */
    castCheckPrice(story: StoryFilm): Promise<PriceAnswer | null> {
        return estimateCastCheck(this.host, story);
    }

    /** Signs in when needed and checks the balance covers the hold; false: nothing runs. */
    private async ready(capability: StoryCapability, feature: string, holdUsd: number): Promise<boolean> {
        if (!(await this.options.requireOpenNan(capability, feature))) return false;
        if (this.options.providers.route(capability)?.info.id !== OPENNAN_PROVIDER_ID) return true;
        if (await holdCovered(this.options.account, holdUsd)) return true;
        this.set({ error: notEnoughCreditsMessage(holdUsd) });
        this.options.notEnoughCredits?.(holdUsd);
        return false;
    }

    /** Runs one step (its missing items, or the chosen ones with redo) at the price the person saw. */
    async run(step: StoryStep, label: string, options: StepOptions = {}): Promise<void> {
        if (this.stateValue.running) return;
        const story = this.story();
        if (!story) return;
        const capability = STEP_CAPABILITY[step];
        const estimate = await this.estimate(story, step, options);
        if (!estimate.ready) {
            this.set({ error: estimate.reason ?? "This step could not be priced." });
            return;
        }
        if (!(await this.ready(capability, label, estimate.holdUsd))) return;
        const abort = new AbortController();
        this.abort = abort;
        const items: Record<string, ItemUpdate> = { ...this.stateValue.items };
        this.set({ running: { step, label }, error: null, items });
        try {
            const outcome = await runStep(this.host, story, step, {
                ...options, signal: abort.signal,
                onItem: (update) => {
                    this.set({ items: { ...this.stateValue.items, [update.id]: update } });
                },
                // The story as stored now (its text may have been edited meanwhile) with the run's newer files.
                onStory: (made) => this.save(withNewerAssets(this.story() ?? made, made)),
            });
            const failed = outcome.failed.map((f) => f.error);
            this.set({ error: failed.length > 0 ? failed[0]! : null });
        } catch (error) {
            this.set({ error: errorText(error) });
        } finally {
            this.abort = null;
            this.set({ running: null });
            this.options.refreshAccount?.();
        }
    }

    cancel(): void {
        this.abort?.abort();
    }

    /** Prices a draft request (the story writer's call). */
    priceDraft(request: DraftRequest): Promise<PriceAnswer> {
        return this.price(request.capability, request.input, {});
    }

    /**
     * Drafts the story with the story writer and stores it (it replaces the story: a new draft's shots are other
     * shots). The draft's problems, when it does not read as a story, are kept for the person to see.
     */
    async draft(request: DraftRequest, source: Parameters<typeof parseDraftReply>[1], holdUsd: number, before?: (signal: AbortSignal) => Promise<DraftRequest | null>): Promise<boolean> {
        if (this.stateValue.running) return false;
        if (!(await this.ready("text.generate", "Story writer", holdUsd))) return false;
        const abort = new AbortController();
        this.abort = abort;
        this.set({ running: { step: "draft", label: "Story writer" }, error: null, draftErrors: [] });
        try {
            const sent = before ? await before(abort.signal) : request;
            if (!sent) return false;
            const ran = storyRunResult(await this.options.controller.execute({ type: "ai.run", capability: sent.capability, input: sent.input }, { signal: abort.signal, toastOnError: false }));
            if (!ran.ok) {
                if (!ran.cancelled) this.set({ error: ran.error });
                return false;
            }
            const text = (ran.result as { text?: unknown } | undefined)?.text;
            const parsed = typeof text === "string" ? parseDraftReply(text, source) : { ok: false as const, errors: ["the story writer returned no text"] };
            if (!parsed.ok) {
                this.set({ draftErrors: parsed.errors });
                return false;
            }
            const spent = (this.story()?.spentUsd ?? 0) + (ran.costUsd ?? 0);
            await this.save({ ...parsed.story, ...(spent > 0 ? { spentUsd: Math.round(spent * 1e6) / 1e6 } : {}) });
            return true;
        } catch (error) {
            this.set({ error: errorText(error) });
            return false;
        } finally {
            this.abort = null;
            this.set({ running: null });
            this.options.refreshAccount?.();
        }
    }

    /** Runs one capability for the wizard (the link download) under the running state. */
    async fetchLink(url: string, signal: AbortSignal): Promise<string> {
        const ran = storyRunResult(await this.options.controller.execute({ type: "ai.run", capability: "web.fetch", input: { url } }, { signal, toastOnError: false }));
        if (!ran.ok) throw new Error(ran.error);
        const media = ran.media[0]?.url;
        if (!media) throw new Error("The download returned no video.");
        return media;
    }

    /** "Put on timeline": the reel layout, replacing what the story placed before. */
    async assemble(): Promise<boolean> {
        const story = this.story();
        if (!story || this.stateValue.running) return false;
        const reel = reelInputOf(story);
        if (!reel.ok) {
            this.set({ error: reel.error });
            return false;
        }
        this.set({ running: { step: "assemble", label: "Put on timeline" }, error: null });
        try {
            const execute = this.options.controller.execute.bind(this.options.controller);
            const outcome = await applyReelLayout((command) => execute(command, { toastOnError: false }), this.options.controller.snapshot(), reel.input);
            if (!outcome.ok) {
                this.set({ error: outcome.error ?? "The layout failed." });
                return false;
            }
            await this.save(withAssembled(this.story() ?? story, outcome));
            return true;
        } catch (error) {
            this.set({ error: errorText(error) });
            return false;
        } finally {
            this.set({ running: null });
        }
    }

    clearError(): void {
        this.set({ error: null, draftErrors: [] });
    }

    dispose(): void {
        this.abort?.abort();
        this.listeners.clear();
    }
}
