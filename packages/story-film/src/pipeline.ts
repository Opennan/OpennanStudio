// The story film pipeline over provider capabilities only: cast (image.generate, one sheet per character), frames
// (image.generate with references: the shot's sheets in cast order, then the previous keyframe), animate
// (video.image-to-video from the keyframe, no sound), music (audio.music, the film's length). The host runs each
// request (the editor's ai.run: the result lands in the project's media library) and prices it (the provider's own
// never-under estimate). Every result is recorded on the story with the request that made it, so a re-run skips what
// exists and never pays twice; "redo" runs one item again and keeps the old asset if the new one fails. Keyframes run
// in order (each anchors on the one before); sheets and clips run two at a time. Cancel stops what has not started and
// cancels what runs. After each keyframe the cast check (check.ts) looks at it once; a character off their sheet gets
// the keyframe redrawn with the look restated (once by default), and a shot still off after that is kept and flagged.
import { formatUsdEstimate, type PriceAnswer, type PriceUnits, type ProviderModel } from "@opennan/provider-sdk";
import { CAST_CHECK_MAX_REDRAWS, CAST_CHECK_REDRAWS, castCheckRequest, parseCastCheck } from "./check";
import { castOf, keyframePrompt, motionPrompt, musicPrompt, redrawPrompt, sheetPrompt } from "./recipe";
import type { StoryAsset, StoryCastCheck, StoryFilm, StoryShot, StoryStep } from "./types";
import { filmSeconds, shotSeconds } from "./validate";

/** The proven defaults: the 2K image model that takes references, and the video model that kept the style best for its price. */
export const STORY_DEFAULTS = Object.freeze({
    imageModel: "nano-banana-pro",
    imageSize: "2K",
    videoModel: "seedance-2-mini",
    quality: "720p",
    aspectRatio: "16:9",
});

/** Video models offered first, in this order (any other image-to-video model the provider lists follows). */
export const STORY_VIDEO_MODELS = ["seedance-2-mini", "kling-o3", "veo-3-1-fast", "hailuo-2-3"] as const;

/** Music lengths the provider takes (seconds). */
const MUSIC_SECONDS = { min: 10, max: 240 };

export interface StoryRunMedia {
    url: string;
    width?: number;
    height?: number;
    durationSeconds?: number;
}

export type StoryRunResult =
    | { ok: true; media: StoryRunMedia[]; costUsd?: number; result?: unknown }
    | { ok: false; error: string; cancelled?: boolean; unavailable?: boolean };

export interface StoryRunOptions {
    signal?: AbortSignal;
    onProgress?(progress: { progress?: number; message?: string }): void;
}

/** What the pipeline needs of its host: run one capability (results stored as project media) and price it. */
export interface StoryFilmHost {
    run(capability: string, input: Record<string, unknown>, options: StoryRunOptions): Promise<StoryRunResult>;
    price(capability: string, input: Record<string, unknown>, units: PriceUnits): Promise<PriceAnswer>;
}

export interface StoryItem {
    step: StoryStep;
    /** Character id (cast), shot id (frames, animate), or "music". */
    id: string;
    label: string;
    capability: "image.generate" | "video.image-to-video" | "audio.music";
    input: Record<string, unknown>;
    units: PriceUnits;
    /** The request's key: an asset made from it has this key. */
    key: string;
    /** The asset it made, when there is one. */
    asset: StoryAsset | null;
    /** Why it cannot run yet (a sheet or keyframe it needs is missing). */
    blocked?: string;
}

export interface StepOptions {
    /** Only these ids (one redraw, a few clips). */
    only?: readonly string[];
    /** Run items that already have an asset again (with `only`: redo those). */
    redo?: boolean;
    /**
     * Frames: how many times a keyframe is redrawn when its cast check finds a character off their sheet (default 1,
     * at most 3; 0 turns the check off). The estimate counts every check and every redraw it may make.
     */
    castCheck?: number;
}

/** The redraws a step's cast check may make (0: no check). */
export function castCheckRedraws(step: StoryStep, options: Pick<StepOptions, "castCheck"> = {}): number {
    if (step !== "frames") return 0;
    const asked = options.castCheck ?? CAST_CHECK_REDRAWS;
    return Number.isFinite(asked) ? Math.max(0, Math.min(CAST_CHECK_MAX_REDRAWS, Math.floor(asked))) : CAST_CHECK_REDRAWS;
}

/** FNV-1a of the request: short, stable, enough to tell two requests apart. */
export function requestKey(value: unknown): string {
    const text = JSON.stringify(value);
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i += 1) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return `${hash.toString(16).padStart(8, "0")}-${text.length.toString(36)}`;
}

const settingsOf = (story: StoryFilm) => ({
    imageModel: story.settings?.imageModel ?? STORY_DEFAULTS.imageModel,
    imageSize: story.settings?.imageSize ?? STORY_DEFAULTS.imageSize,
    videoModel: story.settings?.videoModel ?? STORY_DEFAULTS.videoModel,
    quality: story.settings?.quality ?? STORY_DEFAULTS.quality,
});

const ref = (url: string) => ({ mediaUrl: url });

function sheetItem(story: StoryFilm, id: string): StoryItem | null {
    const character = story.characters.find((c) => c.id === id);
    if (!character) return null;
    const { imageModel, imageSize } = settingsOf(story);
    const input = { description: sheetPrompt(story, character), aspectRatio: STORY_DEFAULTS.aspectRatio, model: imageModel, size: imageSize };
    return { step: "cast", id, label: character.name, capability: "image.generate", input, units: { images: 0 }, key: requestKey(input), asset: character.sheet ?? null };
}

function frameItem(story: StoryFilm, id: string): StoryItem | null {
    const index = story.shots.findIndex((s) => s.id === id);
    if (index < 0) return null;
    const shot = story.shots[index]!;
    const { imageModel, imageSize } = settingsOf(story);
    const cast = castOf(story, shot);
    const missing = cast.filter((c) => !c.sheet);
    const previous = index > 0 ? story.shots[index - 1]! : null;
    // A keyframe drawn before this one in the same run anchors it; the estimate counts that reference already.
    const refs = [...cast.map((c) => c.sheet?.url ?? `pending:${c.id}`), ...(previous ? [previous.keyframe?.url ?? `pending:${previous.id}`] : [])];
    const sent = refs.filter((url) => !url.startsWith("pending:")).map(ref);
    const input: Record<string, unknown> = {
        description: keyframePrompt(story, shot, previous !== null), aspectRatio: STORY_DEFAULTS.aspectRatio, model: imageModel, size: imageSize,
        ...(refs.length > 0 ? { image: refs[0]!.startsWith("pending:") ? `pending` : ref(refs[0]!) } : {}),
        ...(refs.length > 1 ? { images: refs.slice(1).map((url) => (url.startsWith("pending:") ? "pending" : ref(url))) } : {}),
    };
    const item: StoryItem = {
        step: "frames", id, label: `Shot ${index + 1}`, capability: "image.generate", input, units: { images: refs.length },
        key: requestKey({ ...input, refs }), asset: shot.keyframe ?? null,
    };
    if (missing.length > 0) item.blocked = `Draw ${missing.map((c) => c.name).join(" and ")} first.`;
    else if (sent.length !== refs.length) item.blocked = `Draw shot ${index} first.`;
    return item;
}

function clipItem(story: StoryFilm, id: string): StoryItem | null {
    const index = story.shots.findIndex((s) => s.id === id);
    if (index < 0) return null;
    const shot = story.shots[index]!;
    const { videoModel, quality } = settingsOf(story);
    const seconds = shotSeconds(shot);
    const input: Record<string, unknown> = {
        description: motionPrompt(story, shot), ...(shot.keyframe ? { image: ref(shot.keyframe.url) } : {}), durationSeconds: seconds,
        aspectRatio: STORY_DEFAULTS.aspectRatio, model: videoModel, quality, generateAudio: false,
    };
    const item: StoryItem = { step: "animate", id, label: `Shot ${index + 1}`, capability: "video.image-to-video", input, units: { seconds }, key: requestKey(input), asset: shot.clip ?? null };
    if (!shot.keyframe) item.blocked = "Draw the keyframe first.";
    return item;
}

function musicItem(story: StoryFilm): StoryItem {
    const seconds = Math.min(MUSIC_SECONDS.max, Math.max(MUSIC_SECONDS.min, Math.ceil(filmSeconds(story))));
    const input = { description: musicPrompt(story), durationSeconds: seconds, instrumental: true };
    return { step: "music", id: "music", label: "Music", capability: "audio.music", input, units: { seconds }, key: requestKey(input), asset: story.musicAsset ?? null };
}

/** One item of a step, from the story as it is now (null: no such id). */
export function storyItem(story: StoryFilm, step: StoryStep, id: string): StoryItem | null {
    switch (step) {
        case "cast":
            return sheetItem(story, id);
        case "frames":
            return frameItem(story, id);
        case "animate":
            return clipItem(story, id);
        case "music":
            return id === "music" ? musicItem(story) : null;
    }
}

/** Every item of a step, in order. */
export function storyItems(story: StoryFilm, step: StoryStep): StoryItem[] {
    const ids = step === "cast" ? story.characters.map((c) => c.id) : step === "music" ? ["music"] : story.shots.map((s) => s.id);
    return ids.map((id) => storyItem(story, step, id)).filter((item): item is StoryItem => item !== null);
}

/** The asset was made from another request (its text, model or references changed since). */
export function isStale(item: StoryItem): boolean {
    return item.asset !== null && item.asset.key !== item.key;
}

/** The items a run would make: missing ones (or, with redo, the chosen ones). */
export function itemsToRun(story: StoryFilm, step: StoryStep, options: StepOptions = {}): StoryItem[] {
    const only = options.only ? new Set(options.only) : null;
    return storyItems(story, step).filter((item) => (only ? only.has(item.id) : true) && (options.redo ? true : item.asset === null));
}

export interface StepEstimate {
    items: Array<{ id: string; label: string; answer: PriceAnswer | null; blocked?: string }>;
    /** Sum of the items' estimates (micro-dollars, never under). */
    microUsd: number;
    usd: number;
    /** "≈ $3.12" */
    label: string;
    /** What the run holds while it goes (each item's hold, else its estimate): the balance must cover it. */
    holdUsd: number;
    /** Every item has a price (or is free) and none is blocked. */
    ready: boolean;
    /** Why it is not ready. */
    reason?: string;
    /** Frames with the cast check: the dearest single check of one shot (micro-dollars), counted in the total. */
    checkMicroUsd?: number;
}

/** What a run of the step would cost: each item priced by the provider, summed (an unknown price blocks the run). */
export async function estimateStep(host: StoryFilmHost, story: StoryFilm, step: StoryStep, options: StepOptions = {}): Promise<StepEstimate> {
    const items = itemsToRun(story, step, options);
    const rows: StepEstimate["items"] = [];
    let microUsd = 0;
    let holdUsd = 0;
    let reason: string | undefined;
    // A keyframe not drawn yet still counts as the next one's reference when this run draws it first.
    const running = new Set(items.map((item) => item.id));
    const redraws = castCheckRedraws(step, options);
    let checkMicroUsd = 0;
    for (const item of items) {
        const index = story.shots.findIndex((s) => s.id === item.id);
        const previous = step === "frames" && index > 0 ? story.shots[index - 1]!.id : null;
        const soft = previous !== null && running.has(previous) && item.blocked === `Draw shot ${index} first.`;
        const blocked = item.blocked && !soft ? item.blocked : undefined;
        if (blocked) {
            rows.push({ id: item.id, label: item.label, answer: null, blocked });
            reason ??= `${item.label}: ${blocked}`;
            continue;
        }
        const answer = await host.price(item.capability, pricedInput(item), item.units).catch((): PriceAnswer => ({ kind: "unknown" }));
        rows.push({ id: item.id, label: item.label, answer });
        if (answer.kind === "estimate") {
            microUsd += answer.estimate.microUsd;
            holdUsd += Math.max(answer.estimate.holdUsd ?? 0, answer.estimate.usd);
        }
        else if (answer.kind !== "free" && answer.kind !== "billed-elsewhere") reason ??= priceProblem(item.label, answer);
        // The cast check, worst case: every look it may take, and every redraw at the keyframe's own price.
        const check = redraws > 0 ? castCheckRequest(story, story.shots[index]!, QUOTE_PLACEHOLDER) : null;
        if (!check) continue;
        const checked = await host.price(check.capability, check.input, { images: check.input.images.length }).catch((): PriceAnswer => ({ kind: "unknown" }));
        if (checked.kind === "estimate") {
            checkMicroUsd = Math.max(checkMicroUsd, checked.estimate.microUsd);
            microUsd += checked.estimate.microUsd * (1 + redraws);
            holdUsd += Math.max(checked.estimate.holdUsd ?? 0, checked.estimate.usd) * (1 + redraws);
        }
        else if (checked.kind !== "free" && checked.kind !== "billed-elsewhere") reason ??= `Cast check: ${priceProblem(item.label, checked)} Turn the check off to draw without it.`;
        if (answer.kind === "estimate") {
            microUsd += answer.estimate.microUsd * redraws;
            holdUsd += Math.max(answer.estimate.holdUsd ?? 0, answer.estimate.usd) * redraws;
        }
    }
    if (items.length === 0) reason ??= "Nothing to make: everything is made.";
    return {
        items: rows, microUsd, usd: microUsd / 1_000_000, label: formatUsdEstimate(microUsd), holdUsd: Math.round(holdUsd * 1e6) / 1e6, ready: reason === undefined,
        ...(reason ? { reason } : {}), ...(checkMicroUsd > 0 ? { checkMicroUsd } : {}),
    };
}

function priceProblem(label: string, answer: PriceAnswer): string {
    if (answer.kind === "unavailable") return answer.reason;
    if (answer.kind === "over-limit") return `${label} is over the limit.`;
    return "The price could not be read. Try again in a moment.";
}

/**
 * What one cast check costs at most for this story (its shot with the most characters; sheets not drawn yet count),
 * for "Check characters match (+$x per shot)". Null: no shot has a cast.
 */
export async function estimateCastCheck(host: StoryFilmHost, story: StoryFilm): Promise<PriceAnswer | null> {
    const sheeted = { ...story, characters: story.characters.map((c) => (c.sheet ? c : { ...c, sheet: { url: QUOTE_PLACEHOLDER, key: "quote" } })) };
    const widest = [...story.shots].sort((a, b) => castOf(story, b).length - castOf(story, a).length)[0];
    const check = widest ? castCheckRequest(sheeted, widest, QUOTE_PLACEHOLDER) : null;
    if (!check) return null;
    return host.price(check.capability, check.input, { images: check.input.images.length }).catch((): PriceAnswer => ({ kind: "unknown" }));
}

/** An input image that is not made yet, priced as one (the quote counts images; it never fetches this link). */
const QUOTE_PLACEHOLDER = "https://opennan.com/studio/quote-input.png";

/** The input a price is asked for: references not drawn yet count as references (a placeholder link). */
function pricedInput(item: StoryItem): Record<string, unknown> {
    const swap = (value: unknown) => (value === "pending" ? QUOTE_PLACEHOLDER : value);
    const input = { ...item.input };
    if (input.image !== undefined) input.image = swap(input.image);
    if (Array.isArray(input.images)) input.images = input.images.map(swap);
    return input;
}

/** The story with one item's new asset (and its cost added to what the story has spent). */
export function withAsset(story: StoryFilm, step: StoryStep, id: string, asset: StoryAsset): StoryFilm {
    const spentUsd = Math.round(((story.spentUsd ?? 0) + (asset.costUsd ?? 0)) * 1_000_000) / 1_000_000;
    switch (step) {
        case "cast":
            return { ...story, spentUsd, characters: story.characters.map((c) => (c.id === id ? { ...c, sheet: asset } : c)) };
        case "frames":
            // A new keyframe is unchecked: the old one's check goes with it.
            return { ...story, spentUsd, shots: story.shots.map((s) => (s.id === id ? { ...withoutCheck(s), keyframe: asset } : s)) };
        case "animate":
            return { ...story, spentUsd, shots: story.shots.map((s) => (s.id === id ? { ...s, clip: asset } : s)) };
        case "music":
            return { ...story, spentUsd, musicAsset: asset };
    }
}

function withoutCheck(shot: StoryShot): StoryShot {
    const next = { ...shot };
    delete next.check;
    return next;
}

/** The story with a shot's cast check (and what this look cost added to what the story has spent). */
export function withCheck(story: StoryFilm, id: string, check: StoryCastCheck, costUsd = 0): StoryFilm {
    const spentUsd = Math.round(((story.spentUsd ?? 0) + costUsd) * 1_000_000) / 1_000_000;
    return { ...story, ...(spentUsd > 0 ? { spentUsd } : {}), shots: story.shots.map((s) => (s.id === id ? { ...s, check } : s)) };
}

/** The shot's check is about its current keyframe and found a character off their sheet (or could not tell). */
export function isFlagged(shot: StoryShot): boolean {
    return Boolean(shot.check && shot.keyframe && shot.check.keyframeUrl === shot.keyframe.url && !shot.check.ok);
}

export type ItemStatus = "queued" | "running" | "done" | "failed" | "cancelled";

export interface ItemUpdate {
    step: StoryStep;
    id: string;
    status: ItemStatus;
    progress?: number;
    message?: string;
    error?: string;
    costUsd?: number;
}

export interface RunStepOptions extends StepOptions {
    signal?: AbortSignal;
    /** Items made at once (keyframes always one at a time). Default 2. */
    concurrency?: number;
    onItem?(update: ItemUpdate): void;
    /** The story after each new asset (the host stores it on the project). Calls never overlap; the last one is the newest story. */
    onStory?(story: StoryFilm): void | Promise<void>;
    now?(): Date;
}

export interface StepOutcome {
    story: StoryFilm;
    made: string[];
    failed: Array<{ id: string; error: string }>;
    cancelled: boolean;
    /** What this run was charged (dollars), cast checks and redraws included. */
    spentUsd: number;
    /** Frames: shots redrawn after their cast check found a character off their sheet. */
    redrawn: string[];
    /** Frames: shots kept after their last try still off (or not readable): "check this shot". */
    flagged: Array<{ id: string; misses: StoryCastCheck["misses"]; unread?: boolean }>;
}

/** Runs a step's items (missing ones, or the chosen ones with redo), storing each result on the story as it lands. */
export async function runStep(host: StoryFilmHost, story: StoryFilm, step: StoryStep, options: RunStepOptions = {}): Promise<StepOutcome> {
    let current = story;
    const queue = itemsToRun(story, step, options).map((item) => item.id);
    const outcome: StepOutcome = { story, made: [], failed: [], cancelled: false, spentUsd: 0, redrawn: [], flagged: [] };
    const redraws = castCheckRedraws(step, options);
    for (const id of queue) options.onItem?.({ step, id, status: "queued" });
    let saving: Promise<void> = Promise.resolve();
    const save = () => {
        saving = saving.then(() => options.onStory?.(current)).catch(() => undefined);
        return saving;
    };
    const sequential = step === "frames";
    let stop = false;
    const worker = async () => {
        while (queue.length > 0 && !stop) {
            if (options.signal?.aborted) {
                outcome.cancelled = true;
                return;
            }
            const id = queue.shift()!;
            // Built from the story as it is now: a keyframe drawn a moment ago anchors the next one.
            const item = storyItem(current, step, id);
            if (!item) continue;
            if (item.blocked) {
                outcome.failed.push({ id, error: item.blocked });
                options.onItem?.({ step, id, status: "failed", error: item.blocked });
                if (sequential) stop = true;
                continue;
            }
            options.onItem?.({ step, id, status: "running" });
            const result = await host.run(item.capability, item.input, {
                signal: options.signal,
                onProgress: (p) => options.onItem?.({ step, id, status: "running", ...(p.progress !== undefined ? { progress: p.progress } : {}), ...(p.message ? { message: p.message } : {}) }),
            });
            if (!result.ok) {
                if (result.cancelled || options.signal?.aborted) {
                    outcome.cancelled = true;
                    options.onItem?.({ step, id, status: "cancelled" });
                    return;
                }
                outcome.failed.push({ id, error: result.error });
                options.onItem?.({ step, id, status: "failed", error: result.error });
                // Later keyframes anchor on this one: the step stops here.
                if (sequential || result.unavailable) stop = true;
                continue;
            }
            const media = result.media[0];
            if (!media) {
                outcome.failed.push({ id, error: "The provider returned nothing." });
                options.onItem?.({ step, id, status: "failed", error: "The provider returned nothing." });
                if (sequential) stop = true;
                continue;
            }
            current = withAsset(current, step, id, assetOf(item, media, result.costUsd, options));
            outcome.made.push(id);
            outcome.spentUsd = addUsd(outcome.spentUsd, result.costUsd);
            let cancelled = false;
            if (redraws > 0) {
                // The keyframe is stored before it is checked: a check that fails or is cancelled never loses it.
                void save();
                cancelled = await castCheck(item);
            }
            options.onItem?.({ step, id, status: "done", ...(result.costUsd !== undefined ? { costUsd: result.costUsd } : {}) });
            void save();
            if (cancelled) {
                outcome.cancelled = true;
                return;
            }
        }
    };
    /** Looks at a new keyframe and redraws it while a character is off their sheet; true: cancelled meanwhile. */
    const castCheck = async (item: StoryItem): Promise<boolean> => {
        const id = item.id;
        const progress = (message: string) => options.onItem?.({ step, id, status: "running", message });
        let tries = 1;
        let costUsd = 0;
        for (;;) {
            const shot = current.shots.find((s) => s.id === id)!;
            const request = castCheckRequest(current, shot, ref(shot.keyframe!.url));
            if (!request) return false;
            progress(tries === 1 ? "Checking the cast" : "Checking the redraw");
            const looked = await host.run(request.capability, request.input, { signal: options.signal });
            if (!looked.ok && (looked.cancelled || options.signal?.aborted)) return true;
            const lookCost = looked.ok ? (looked.costUsd ?? 0) : 0;
            costUsd = addUsd(costUsd, lookCost);
            outcome.spentUsd = addUsd(outcome.spentUsd, lookCost);
            const reply = looked.ok ? (looked.result as { text?: unknown } | undefined)?.text : undefined;
            const verdict = typeof reply === "string" ? parseCastCheck(reply, request.ids) : { read: false as const };
            // The look's verdict on the shot (`add`: what this look cost, when the story has not counted it yet).
            const record = (misses: StoryCastCheck["misses"], unread: boolean, add = lookCost): StoryCastCheck => {
                const check: StoryCastCheck = { keyframeUrl: shot.keyframe!.url, ok: !unread && misses.length === 0, tries, misses, at: (options.now?.() ?? new Date()).toISOString() };
                if (unread) check.unread = true;
                if (costUsd > 0) check.costUsd = costUsd;
                current = withCheck(current, id, check, add);
                return check;
            };
            // The last word on the shot: kept, and flagged when a character is still off (or nobody could tell).
            const settle = (check: StoryCastCheck) => {
                if (!check.ok) outcome.flagged.push({ id, misses: check.misses, ...(check.unread ? { unread: true } : {}) });
            };
            // An answer that does not read never pays for a redraw: the shot is kept for the person to look at.
            if (!verdict.read) {
                settle(record([], true));
                return false;
            }
            if (verdict.misses.length === 0 || tries > redraws) {
                settle(record(verdict.misses, false));
                return false;
            }
            const names = verdict.misses.map((m) => current.characters.find((c) => c.id === m.id)?.name ?? m.id).join(" and ");
            const redrawing = `Redrawing: ${names} did not match the sheet`;
            progress(redrawing);
            record(verdict.misses, false);
            const index = current.shots.findIndex((s) => s.id === id);
            const description = redrawPrompt(current, shot, index > 0, verdict.misses);
            const redrawn = await host.run(item.capability, { ...item.input, description }, {
                signal: options.signal,
                onProgress: (p) => options.onItem?.({ step, id, status: "running", ...(p.progress !== undefined ? { progress: p.progress } : {}), message: redrawing }),
            });
            const media = redrawn.ok ? redrawn.media[0] : undefined;
            if (!media) {
                // A failed redraw keeps the keyframe there is, flagged with what the check saw (its cost is counted).
                settle(record(verdict.misses, false, 0));
                return !redrawn.ok && Boolean(redrawn.cancelled || options.signal?.aborted);
            }
            const cost = redrawn.ok ? redrawn.costUsd : undefined;
            current = withAsset(current, step, id, assetOf(item, media, cost, options));
            outcome.spentUsd = addUsd(outcome.spentUsd, cost);
            if (!outcome.redrawn.includes(id)) outcome.redrawn.push(id);
            void save();
            tries += 1;
        }
    };
    const workers = sequential ? 1 : Math.max(1, Math.min(options.concurrency ?? 2, 4));
    await Promise.all(Array.from({ length: workers }, worker));
    if (options.signal?.aborted) outcome.cancelled = true;
    // What never started is cancelled too.
    if (outcome.cancelled) for (const id of queue) options.onItem?.({ step, id, status: "cancelled" });
    await saving;
    outcome.story = current;
    return outcome;
}

const addUsd = (a: number, b: number | undefined) => Math.round((a + (b ?? 0)) * 1_000_000) / 1_000_000;

/** The asset a run made for an item (its request's key, model, cost, size and length). */
function assetOf(item: StoryItem, media: StoryRunMedia, costUsd: number | undefined, options: Pick<RunStepOptions, "now">): StoryAsset {
    const asset: StoryAsset = { url: media.url, key: item.key, at: (options.now?.() ?? new Date()).toISOString() };
    if (typeof item.input.model === "string") asset.model = item.input.model;
    if (costUsd !== undefined) asset.costUsd = costUsd;
    if (media.width && media.height) {
        asset.width = media.width;
        asset.height = media.height;
    }
    const seconds = media.durationSeconds ?? (typeof item.input.durationSeconds === "number" ? item.input.durationSeconds : undefined);
    if (seconds && item.capability !== "image.generate") asset.durationSeconds = seconds;
    return asset;
}

/** Image-to-video models for the picker: the proven ones first (in order), then any other the provider lists. Never a model it does not sell. */
export function videoModelChoices(models: readonly ProviderModel[]): ProviderModel[] {
    const listed = new Map(models.map((m) => [m.id, m]));
    const first = STORY_VIDEO_MODELS.map((id) => listed.get(id)).filter((m): m is ProviderModel => m !== undefined);
    return [...first, ...models.filter((m) => !(STORY_VIDEO_MODELS as readonly string[]).includes(m.id))];
}

/** The default video model: seedance-2-mini when the provider sells it, else the first of the choices. */
export function defaultVideoModel(models: readonly ProviderModel[]): string | null {
    return videoModelChoices(models)[0]?.id ?? null;
}

/** The image model: nano-banana-pro when listed, else the provider's default. */
export function defaultImageModel(models: readonly ProviderModel[]): string | null {
    return models.find((m) => m.id === STORY_DEFAULTS.imageModel)?.id ?? models.find((m) => m.default)?.id ?? models[0]?.id ?? null;
}

/** A text model for a draft: one that sees images when the draft sends a contact sheet. */
export function draftTextModel(models: readonly ProviderModel[], withImages: boolean): string | null {
    return (withImages ? models.find((m) => m.vision) : models[0])?.id ?? null;
}
