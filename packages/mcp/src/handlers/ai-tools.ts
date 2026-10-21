// The editor's AI tools over MCP (phase 11): translate_captions, isolate_voice, upscale_video, remove_video_background,
// lipsync_clip, split_vocals, and stabilize_clip build their run with timeline-core's planAiTool, the plan the editor's
// AI tab sends, so an agent's run is the user's run (same ai.run, same placement, one undo step). A paid tool is priced
// first through the session (the provider's own price blocks, the figure the editor shows), and that estimate rides
// along as expectedMaxUsd: the provider stops before sending when the prepared file would cost more. Nothing is retried
// on its own. estimate_cost, check_generation_status, and list_voices answer from the host.
import { capabilityUnavailableMessage, type ToolCapability } from "@opennan/mcp-schema";
import { displayedUsd, type AiJobRecord, type CostEstimate, type PriceUnits } from "@opennan/provider-sdk";
import {
    PAID_AI_TOOLS, planAiTool, type AiToolId, type AiToolParams, type AiToolPlan, type CommandResult, type ControllerSnapshot,
} from "@opennan/timeline-core";
import { round3, type Args } from "../args";
import { failure, success, unavailable, type ToolOutcome } from "../outcome";
import { formatUsd, type PriceReply } from "../prices";
import type { StudioSession } from "../session";
import { generationRequest } from "./generate";
import type { ToolContext, ToolHandler } from "./types";

const str = (value: unknown) => (typeof value === "string" && value.trim() !== "" ? value.trim() : undefined);
const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : undefined);

/** MCP tool name → the editor's AI tool id. */
export const AI_TOOL_OF: Readonly<Record<string, AiToolId>> = {
    auto_captions: "captions",
    transcribe_audio: "captions",
    translate_captions: "caption-translate",
    isolate_voice: "voice-isolation",
    upscale_video: "video-upscale",
    remove_video_background: "remove-background",
    lipsync_clip: "lipsync",
    split_vocals: "stems",
    stabilize_clip: "stabilize",
    remove_silences: "silences",
    remove_filler_words: "fillers",
    detect_beats: "beats",
};

/** The tool's arguments as planAiTool params (first_seconds is the editor's "Use the first N s"). */
export function aiParams(args: Args): AiToolParams {
    const params: AiToolParams = {};
    if (str(args.clip_id)) params.clipId = str(args.clip_id);
    if (str(args.scene_id)) params.sceneId = str(args.scene_id);
    if (Number.isInteger(args.track_index)) params.trackIndex = args.track_index as number;
    if (str(args.language)) params.language = str(args.language);
    if (typeof args.keep_source === "boolean") params.keepSource = args.keep_source;
    if (args.engine === "local" || args.engine === "cloud") params.engine = args.engine;
    if (typeof args.style === "string") params.style = args.style;
    if (typeof args.resolution === "string") params.resolution = args.resolution as AiToolParams["resolution"];
    if (typeof args.background === "string") params.background = args.background as AiToolParams["background"];
    if (str(args.audio_clip_id)) params.audioClipId = str(args.audio_clip_id);
    if (args.stems === "vocals" || args.stems === "all") params.stems = args.stems;
    if (num(args.first_seconds) !== undefined && (args.first_seconds as number) > 0) params.maxSeconds = args.first_seconds as number;
    return params;
}

/** "clip_id or scene_id, one of them" (the schema has both as optional properties). */
export function itemArgsError(tool: string, args: Args): string | null {
    const clip = args.clip_id !== undefined;
    const scene = args.scene_id !== undefined;
    return clip === scene ? `${tool} needs clip_id or scene_id (one of them).` : null;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Why a plan is past its tool's limit, and what to pass instead. */
export function overLimitText(tool: string, plan: Pick<AiToolPlan, "overLimit">): string {
    const over = plan.overLimit!;
    if (over.kind === "seconds") {
        return `The used range is ${round3(over.actual)} s; ${tool} takes at most ${over.max} s. Pass first_seconds (at most ${over.max}) to send only the beginning. Nothing was sent.`;
    }
    const what = over.kind === "segments" ? "caption lines" : "characters";
    return `The captions have ${over.actual} ${what}; ${tool} takes at most ${over.max}. Translate a shorter track. Nothing was sent.`;
}

/** What the provider's estimate counts, in words: "1 started minute of voice isolation". */
export function unitsText(toolId: AiToolId | string, units: number): string {
    const n = round3(units);
    switch (toolId) {
        case "captions":
            return `${plural(n, "started minute")} of cloud captions`;
        case "voice-isolation":
            return `${plural(n, "started minute")} of voice isolation`;
        case "video-upscale":
            return `${plural(n, "started second")} of upscaling`;
        case "remove-background":
            return `${plural(n, "started second")} of background removal`;
        case "lipsync":
            return `${plural(n, "started second")} of lip sync audio`;
        case "caption-translate":
            return `${plural(n, "started block")} of 1,000 characters of translation`;
        case "stems":
            return `about ${Math.round(units * 100) / 100} minutes of stem splitting`;
        case "image":
            return plural(n, "image");
        case "video":
        case "music":
            return `${plural(n, "second")} of ${toolId}`;
        case "sfx":
            return `${plural(n, "started second")} of sound`;
        case "voice":
            return `${plural(n, "started block")} of speech text`;
        default:
            return plural(n, "unit");
    }
}

export interface EstimateView {
    label: string;
    /** The label's amount (rounded up): what the agent is told, and the expectedMaxUsd the provider re-checks against. */
    usd: number;
    units: number;
    /** The amount is the provider's own quote of the run (OpenNan's POST /v1/quotes), not the local upper bound. */
    quoted: boolean;
    /** What the run holds while it goes (a quote's hold), when the provider says. */
    holdUsd?: number;
}

/** The session's price answer for a plan, or null when the host cannot price runs. */
export async function priceOf(session: StudioSession, capability: string, input: Record<string, unknown>, units: PriceUnits, engine?: "local" | "cloud"): Promise<PriceReply | null> {
    if (!session.estimate) return null;
    return session.estimate({ capability, input, units, ...(engine ? { engine } : {}) });
}

export function estimateView(reply: PriceReply | null): EstimateView | null {
    if (reply?.kind !== "estimate") return null;
    return viewOf(reply.estimate);
}

function viewOf(estimate: CostEstimate): EstimateView {
    const view: EstimateView = { label: estimate.label, usd: displayedUsd(estimate.microUsd), units: estimate.units, quoted: estimate.source === "quote" };
    if (estimate.holdUsd !== undefined) view.holdUsd = estimate.holdUsd;
    return view;
}

/** What a run's data says about its price: the label, its amount, and whether it was the provider's quote. */
export function estimateData(estimate: EstimateView | null): { label: string; usd: number; quoted: boolean } | null {
    return estimate ? { label: estimate.label, usd: estimate.usd, quoted: estimate.quoted } : null;
}

/** The run's job record, when the host keeps a job book (refund wording on failures). */
async function jobRecord(session: StudioSession, jobId: string | undefined): Promise<AiJobRecord | undefined> {
    if (!jobId || !session.aiJobs) return undefined;
    return (await session.aiJobs().catch(() => [])).find((record) => record.jobId === jobId);
}

/** A failed or unavailable ai.run in words: the provider's own guidance (sign in to OpenNan), 402, refunds. */
export async function aiRunNotDone(tool: string, capability: ToolCapability, result: CommandResult, session: StudioSession, extra: Record<string, unknown> = {}): Promise<ToolOutcome> {
    if (result.unavailable) {
        const reason = result.error ?? "";
        return unavailable(/^(ai\.run (needs|requires) a provider|ai\.run requires)/.test(reason) || !reason ? capabilityUnavailableMessage(tool, capability) : reason, capability);
    }
    const jobId = result.jobId ?? null;
    if (result.cancelled) return failure(`${tool} was cancelled. Nothing more runs on its own.`, { ...extra, jobId });
    const error = result.error ?? "unknown error";
    const record = await jobRecord(session, result.jobId);
    const refunded = record?.refunded === true;
    const data = { ...extra, jobId, refunded, ...(/^Not enough credits/.test(error) ? { insufficientCredits: true } : {}) };
    if (/^Not enough credits/.test(error)) return failure(`${tool} did not run: ${error}`, data);
    // The prepared file costs more than the estimate: nothing was sent; the agent may accept the new amount.
    const rose = /^The price changed: ≈ \$([0-9]+(?:\.[0-9]+)?)/.exec(error);
    if (rose) {
        return failure(`${tool} did not run: the prepared file costs ≈ $${rose[1]}, more than the estimate. Nothing was sent. Call it again with accept_max_usd: ${rose[1]} to run at that price.`, { ...data, newMaxUsd: Number(rose[1]) });
    }
    // A refusal before anything ran already says nothing was charged; "refunded" would repeat it wrongly.
    const refundNote = refunded && !/not (been )?charged/i.test(error) ? " The run was refunded." : "";
    return failure(`${tool} failed: ${error}${refundNote} It was not retried; call the tool again to retry.`, data);
}

/** "(charged $0.13; quoted ≈ $0.130)" — "estimated" when the amount is the local upper bound. */
export function costText(costUsd: number | undefined, estimate: EstimateView | null, billedBy?: string): string {
    const parts: string[] = [];
    if (costUsd !== undefined) parts.push(`charged ${formatUsd(costUsd)}`);
    if (estimate) parts.push(`${estimate.quoted ? "quoted" : "estimated"} ${estimate.label}`);
    if (billedBy) parts.push(`billed by ${billedBy}`);
    return parts.length > 0 ? ` (${parts.join("; ")})` : "";
}

const costOf = (result: CommandResult): number | undefined => {
    const cost = (result.output as { costUsd?: unknown } | undefined)?.costUsd;
    return typeof cost === "number" && Number.isFinite(cost) ? cost : undefined;
};

export type PricedPlan =
    | { ok: true; plan: AiToolPlan; estimate: EstimateView | null; billedBy?: string; providerName?: string }
    | { ok: false; outcome: ToolOutcome };

/**
 * Plans one tool on the current timeline and prices it the editor's way: over-limit plans are refused with the
 * limit and the first_seconds hint; a paid tool whose provider says it is not live (or that is missing) is refused,
 * and so is a run whose provider publishes prices but could not price it.
 */
export async function planAndPrice(tool: string, toolId: AiToolId, params: AiToolParams, session: StudioSession, snapshot?: ControllerSnapshot): Promise<PricedPlan> {
    const planned = planAiTool(snapshot ?? await session.snapshot(), toolId, params);
    if (!planned.ok) return { ok: false, outcome: failure(`${tool}: ${planned.error}.`) };
    const plan = planned.plan;
    const paid = PAID_AI_TOOLS.includes(toolId);
    // The captions limit is the cloud's: on-device whisper takes any length.
    if (plan.overLimit && (paid || params.engine === "cloud")) return { ok: false, outcome: failure(overLimitText(tool, plan), { overLimit: plan.overLimit }) };
    if (toolId === "stabilize" || plan.capability === "local") return { ok: true, plan, estimate: null };
    if (toolId === "captions" && params.engine === "local") return { ok: true, plan, estimate: null };
    const reply = await priceOf(session, plan.capability, plan.input, plan.units, params.engine);
    if (reply?.kind === "over-limit") {
        return { ok: false, outcome: failure(overLimitText(tool, { overLimit: reply.limit }), { overLimit: reply.limit }) };
    }
    if (reply?.kind === "unavailable" && (paid || params.engine === "cloud")) return { ok: false, outcome: unavailable(reply.reason, plan.capability) };
    // A provider that publishes prices but could not price this run: without an estimate nothing guards the charge.
    if (reply?.kind === "unknown" && reply.priced) {
        return { ok: false, outcome: failure(`${tool}: the price could not be checked${reply.reason ? ` (${reply.reason})` : ""}. Nothing was sent; try again.`, { priceUnknown: true }) };
    }
    if (plan.overLimit && toolId === "captions" && reply && reply.kind !== "free") {
        return { ok: false, outcome: failure(overLimitText(tool, plan), { overLimit: plan.overLimit }) };
    }
    return {
        ok: true, plan, estimate: estimateView(reply),
        ...(reply?.kind === "billed-elsewhere" ? { billedBy: reply.by } : {}),
        ...(reply?.providerName ? { providerName: reply.providerName } : {}),
    };
}

/** Runs a priced plan's ai.run with the call's signal; the estimate rides along as expectedMaxUsd. */
export async function runPlan(plan: AiToolPlan, estimate: EstimateView | null, context: ToolContext, acceptMaxUsd?: number): Promise<CommandResult> {
    // accept_max_usd: the agent accepting a higher price an earlier call reported once the file was prepared.
    const ceiling = Math.max(estimate?.usd ?? 0, acceptMaxUsd ?? 0);
    const input = { ...plan.input, ...(ceiling > 0 ? { expectedMaxUsd: ceiling } : {}) };
    return context.session.execute({ type: "ai.run", capability: plan.capability, input, ...(plan.placeAt ? { placeAt: plan.placeAt } : {}) }, { signal: context.signal });
}

/** What landed on the timeline, per tool: the sentence before the cost, and any note after it. */
function placedText(tool: string, args: Args, snapshot: ControllerSnapshot, created: string[], result: CommandResult): { main: string; note: string } {
    const clips = created.map((id) => snapshot.clips.find((c) => c.id === id)).filter((c) => c !== undefined);
    const tracks = [...new Set(clips.map((c) => `${c.trackType === "audio" ? "A" : c.trackType === "text" ? "T" : "V"}${c.trackIndex}`))].join(", ");
    const on = tracks ? ` (${tracks})` : "";
    const output = (result.output ?? {}) as { media?: Array<{ role?: unknown }>; result?: { untranslated?: unknown } };
    switch (tool) {
        case "translate_captions": {
            const untranslated = output.result?.untranslated;
            const kept = Array.isArray(untranslated) && untranslated.length > 0 ? ` ${plural(untranslated.length, "line")} kept the source text (not translated).` : "";
            return { main: `Translated ${plural(created.length, "caption")} into ${String(args.language)} on a new captions track${on}`, note: kept };
        }
        case "isolate_voice":
            return { main: `Isolated the voice onto a new audio track${on}; the original sound is muted`, note: "" };
        case "split_vocals": {
            const roles = (output.media ?? []).map((m) => (typeof m.role === "string" ? m.role : "")).filter(Boolean).join(", ");
            return { main: `Split the sound into ${plural(created.length, "stem")}${roles ? ` (${roles})` : ""} on new audio tracks${on}; the original sound is muted`, note: "" };
        }
        case "upscale_video":
            return { main: `Upscaled to ${String(args.resolution ?? "1080p").toUpperCase()} on a new video track${on} above the original, which is hidden`, note: "" };
        case "remove_video_background":
            return { main: `Removed the background (${String(args.background ?? "transparent")}) on a new video track${on} above the original, which is hidden`, note: "" };
        case "lipsync_clip":
            return { main: `Lip-synced the video to audio clip ${String(args.audio_clip_id)} on a new video track${on} above the original`, note: "" };
        case "stabilize_clip":
            return { main: `Stabilized the video on a new video track${on} above the original, which is hidden`, note: "" };
        default:
            return { main: `${tool} placed ${plural(created.length, "clip")}${on}`, note: "" };
    }
}

function mediaTool(tool: string): ToolHandler {
    return async (args, context) => {
        const toolId = AI_TOOL_OF[tool]!;
        if (tool === "translate_captions") {
            if (args.track_index === undefined && args.clip_id === undefined) return failure("translate_captions needs track_index or clip_id (a caption clip of the track).");
        } else {
            const itemError = itemArgsError(tool, args);
            if (itemError) return failure(itemError);
        }
        const priced = await planAndPrice(tool, toolId, aiParams(args), context.session);
        if (!priced.ok) return priced.outcome;
        const { plan, estimate, billedBy } = priced;
        const accept = typeof args.accept_max_usd === "number" && Number.isFinite(args.accept_max_usd) && args.accept_max_usd > 0 ? args.accept_max_usd : undefined;
        const result = await runPlan(plan, estimate, context, accept);
        const capability = plan.capability as ToolCapability;
        const priceData = estimateData(estimate);
        if (!result.ok) return aiRunNotDone(tool, capability, result, context.session, { estimate: priceData });
        const created = result.createdClipIds ?? [];
        const costUsd = costOf(result);
        const data = { createdClipIds: created, costUsd: costUsd ?? null, estimate: priceData, jobId: result.jobId ?? null, ...(billedBy ? { billedBy } : {}) };
        if (created.length === 0) return success(`${tool} finished but placed nothing${costText(costUsd, estimate, billedBy)}.`, data);
        const snapshot = await context.session.snapshot();
        const placed = placedText(tool, args, snapshot, created, result);
        return success(`${placed.main}${costText(costUsd, estimate, billedBy)}.${placed.note} undo_last_edit takes it back in one step.`, data);
    };
}

// ── estimate_cost ─────────────────────────────────────────────────────────────

/**
 * A generator's price question: the very request the generator sends (generationRequest), from estimate_cost's
 * arguments (duration_seconds is generate_video_h3's seconds and generate_sfx's length; add_music always makes the
 * provider's default length). The units follow that request, never an argument the call would not send.
 */
function generatorQuestion(tool: string, args: Args): { capability: string; input: Record<string, unknown>; units: PriceUnits; unitKind: string } | null {
    const seconds = num(args.duration_seconds);
    switch (tool) {
        case "generate_quick_image":
            return { ...generationRequest(tool, {}), units: { images: 0 }, unitKind: "image" };
        case "generate_video_h3": {
            const request = generationRequest(tool, { ...(seconds ? { seconds } : {}), first_frame_url: args.first_frame_url, last_frame_url: args.last_frame_url });
            const length = request.input.durationSeconds as number | undefined;
            return { ...request, units: length ? { seconds: length } : {}, unitKind: "video" };
        }
        case "generate_tts": {
            const request = generationRequest(tool, { text: args.text });
            const characters = [...String(request.input.text ?? "")].length;
            // No text, no units: the price says speech needs its text instead of a one-block minimum.
            return { ...request, units: characters > 0 ? { characters } : {}, unitKind: "voice" };
        }
        case "add_music":
            return { ...generationRequest(tool, {}), units: {}, unitKind: "music" };
        case "generate_sfx": {
            const request = generationRequest(tool, { duration_seconds: seconds });
            const length = request.input.durationSeconds as number | undefined;
            return { ...request, units: length ? { seconds: length } : {}, unitKind: "sfx" };
        }
        default:
            return null;
    }
}

const LOCAL_TOOLS = new Set(["remove_silences", "remove_filler_words", "detect_beats", "auto_cut_to_beat", "stabilize_clip"]);

function answerEstimate(tool: string, unitKind: string, reply: PriceReply | null, extra: Record<string, unknown> = {}): ToolOutcome {
    const base = { tool, ...extra, ...(reply?.providerName ? { provider: reply.providerName } : {}) };
    if (!reply) return unavailable(capabilityUnavailableMessage("estimate_cost", "provider.estimate"), "provider.estimate");
    switch (reply.kind) {
        case "estimate": {
            const estimate = viewOf(reply.estimate);
            const capped = reply.estimate.capped ? " It is the tool's maximum charge (its hold)." : "";
            const hold = estimate.holdUsd !== undefined && estimate.holdUsd > estimate.usd + 1e-9 ? ` It holds up to $${(Math.ceil(estimate.holdUsd * 100 - 1e-9) / 100).toFixed(2)} of credits while it runs.` : "";
            const what = estimate.quoted ? `OpenNan's quote; ${unitsText(unitKind, estimate.units)}` : unitsText(unitKind, estimate.units);
            return success(`${estimate.label} (${what}). Charged when it finishes, never above this.${capped}${hold}`, { ...base, estimate });
        }
        case "free":
            return success(`${tool} runs on this device${reply.providerName ? ` (${reply.providerName})` : ""}: no charge.`, { ...base, estimate: null, free: true });
        case "billed-elsewhere":
            return success(`Billed by ${reply.by} on the account the key belongs to; OpenNan Studio has no price for it.`, { ...base, estimate: null, billedBy: reply.by });
        case "over-limit":
            return failure(overLimitText(tool, { overLimit: reply.limit }), { ...base, estimate: null, overLimit: reply.limit });
        case "unavailable":
            return success(`${tool} cannot run right now: ${reply.reason}`, { ...base, estimate: null, unavailable: reply.reason });
        default:
            return success(`No price is known for ${tool} right now${reply.reason ? `: ${reply.reason}` : ""}. The run itself may still be priced by the provider.`, { ...base, estimate: null, unknown: reply.reason ?? true });
    }
}

const estimateCost: ToolHandler = async (args, { session }) => {
    const tool = String(args.tool ?? "");
    if (LOCAL_TOOLS.has(tool)) return success(`${tool} runs on this device: no charge.`, { tool, estimate: null, free: true });
    const generator = generatorQuestion(tool, args);
    if (generator) {
        if (!session.estimate) return answerEstimate(tool, generator.unitKind, null);
        return answerEstimate(tool, generator.unitKind, await session.estimate({ capability: generator.capability, input: generator.input, units: generator.units }));
    }
    const toolId = AI_TOOL_OF[tool];
    if (!toolId) return failure(`estimate_cost cannot price ${tool}.`);
    const params = aiParams(args);
    if (toolId === "captions" && params.engine === "local") return success(`${tool} runs on this device: no charge.`, { tool, estimate: null, free: true });
    const planned = planAiTool(await session.snapshot(), toolId, params);
    if (!planned.ok) return failure(`estimate_cost: ${planned.error}.`, { tool });
    const plan = planned.plan;
    const overLimit = plan.overLimit && (PAID_AI_TOOLS.includes(toolId) || params.engine === "cloud") ? plan.overLimit : undefined;
    if (overLimit) return failure(overLimitText(tool, plan), { tool, estimate: null, overLimit, ...(plan.limit ? { limit: plan.limit } : {}) });
    if (!session.estimate) return answerEstimate(tool, toolId, null);
    const reply = await session.estimate({ capability: plan.capability, input: plan.input, units: plan.units, ...(params.engine ? { engine: params.engine } : {}) });
    return answerEstimate(tool, toolId, reply, { units: plan.units, ...(plan.limit ? { limit: plan.limit } : {}) });
};

// ── check_generation_status ───────────────────────────────────────────────────

const RECENT_JOBS = 10;

function jobView(record: AiJobRecord): Record<string, unknown> {
    return {
        jobId: record.jobId, capability: record.capability, status: record.status,
        progress: record.progress ?? null, message: record.message ?? null, costUsd: record.costUsd ?? null,
        error: record.error ?? null, refunded: record.refunded ?? null, cancellable: record.cancellable,
        startedAt: new Date(record.startedAt).toISOString(), finishedAt: record.finishedAt ? new Date(record.finishedAt).toISOString() : null,
    };
}

function jobLine(record: AiJobRecord): string {
    const progress = record.progress !== undefined && record.status === "running" ? ` ${Math.round(record.progress * 100)}%` : "";
    const stage = record.message ? ` (${record.message})` : "";
    const cost = record.costUsd !== undefined ? `, charged ${formatUsd(record.costUsd)}` : "";
    const error = record.error ? `: ${record.error}${record.refunded ? " (refunded)" : ""}` : "";
    const cancel = (record.status === "running" || record.status === "queued") && !record.cancellable ? "; already charged work started, so cancel no longer stops it" : "";
    return `${record.jobId} ${record.capability}: ${record.status}${progress}${stage}${cost}${error}${cancel}`;
}

const checkGenerationStatus: ToolHandler = async (args, { session }) => {
    if (!session.aiJobs) return unavailable(capabilityUnavailableMessage("check_generation_status", "provider.jobs"), "provider.jobs");
    const records = await session.aiJobs();
    const id = str(args.job_id);
    if (id) {
        const record = records.find((r) => r.jobId === id);
        if (!record) return failure(`No AI job ${id} in this editor session.`, { jobs: [] });
        return success(jobLine(record), { job: jobView(record) });
    }
    const recent = records.slice(0, RECENT_JOBS);
    if (recent.length === 0) return success("No AI jobs have run in this editor session.", { jobs: [] });
    return success(recent.map(jobLine).join("\n"), { jobs: recent.map(jobView) });
};

// ── list_voices ───────────────────────────────────────────────────────────────

const listVoices: ToolHandler = async (args, { session }) => {
    const voices = session.voices ? await session.voices() : null;
    if (voices === null) return unavailable(capabilityUnavailableMessage("list_voices", "audio.tts"), "audio.tts");
    const language = str(args.language)?.toLowerCase();
    const list = language ? voices.filter((v) => v.language.toLowerCase() === language || v.language.toLowerCase().startsWith(`${language}-`)) : voices;
    if (list.length === 0) return success(language ? `No voices for ${language}.` : "The speech provider lists no voices right now.", { voices: [] });
    const lines = list.map((v) => `${v.id}: ${v.name} (${[v.language, v.gender].filter(Boolean).join(", ")})`);
    return success(`${plural(list.length, "voice")} for generate_tts voice_id:\n${lines.join("\n")}`, { voices: list });
};

export const AI_TOOL_HANDLERS: Readonly<Record<string, ToolHandler>> = {
    translate_captions: mediaTool("translate_captions"),
    isolate_voice: mediaTool("isolate_voice"),
    upscale_video: mediaTool("upscale_video"),
    remove_video_background: mediaTool("remove_video_background"),
    lipsync_clip: mediaTool("lipsync_clip"),
    split_vocals: mediaTool("split_vocals"),
    stabilize_clip: mediaTool("stabilize_clip"),
    estimate_cost: estimateCost,
    check_generation_status: checkGenerationStatus,
    list_voices: listVoices,
};
