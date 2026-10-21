// transcribe_audio and auto_captions (spec §5.9, §5.11): both run the editor's ai.run command, so they work
// wherever the host's controller routes audio.transcribe to a provider (desktop: whisper.cpp on the device; phase 11:
// OpenNan cloud captions) and answer "unavailable" with the §5.4 guidance everywhere else. `engine` picks the device
// or the cloud for one run; a clip or scene is planned with planAiTool("captions") like the editor's AI tab, and a
// run that is not on the device (the whole timeline too) is priced first (the estimate rides along as expectedMaxUsd).
import { capabilityUnavailableMessage } from "@opennan/mcp-schema";
import { transcriptText, type Transcript } from "@opennan/provider-sdk";
import type { CommandResult, EditorCommand } from "@opennan/timeline-core";
import { round3, type Args } from "../args";
import { failure, success, unavailable, type ToolOutcome } from "../outcome";
import { aiParams, costText, estimateData, planAndPrice, type EstimateView } from "./ai-tools";
import type { ToolContext, ToolHandler } from "./types";

const CAPABILITY = "audio.transcribe";

function asTranscript(value: unknown): Transcript | null {
    if (typeof value !== "object" || value === null) return null;
    const t = value as Partial<Transcript>;
    if (typeof t.language !== "string" || !Array.isArray(t.segments)) return null;
    const segments = t.segments.filter((s) => s && typeof s.text === "string" && Number.isFinite(s.start) && Number.isFinite(s.end));
    return { ...t, language: t.language, segments } as Transcript;
}

function input(args: Args): Record<string, unknown> {
    return {
        ...(typeof args.language === "string" ? { language: args.language } : {}),
        ...(typeof args.model === "string" ? { model: args.model } : {}),
        ...(args.engine === "local" || args.engine === "cloud" ? { engine: args.engine } : {}),
    };
}

interface Planned {
    command: Extract<EditorCommand, { type: "ai.run" }>;
    estimate: EstimateView | null;
    /** Clip or scene runs: transcript seconds → timeline seconds. */
    timeOffset: number;
    timeScale: number;
    what: string;
}

/**
 * The run of one call. The whole timeline keeps its phase 7 command (the timeline mix); a clip or scene is planned
 * like the editor's AI tab. Runs that are not on the device are priced first.
 */
async function plan(tool: string, args: Args, context: ToolContext, placed: boolean): Promise<{ ok: true; planned: Planned } | { ok: false; outcome: ToolOutcome }> {
    const item = args.clip_id !== undefined || args.scene_id !== undefined;
    if (args.clip_id !== undefined && args.scene_id !== undefined) return { ok: false, outcome: failure(`${tool} takes clip_id or scene_id, not both.`) };
    const params = { ...aiParams(args), ...(placed && args.style === "subtitle" ? { style: "subtitle" } : placed ? { style: "caption" } : {}) };
    let priceIt = item || args.engine === "cloud";
    const estimateOf = context.session.estimate;
    if (!priceIt && args.engine !== "local" && estimateOf) {
        // The whole timeline on whichever provider the host routes it to: on the device (free) it runs as before;
        // anywhere else it is priced on the timeline's length like a clip.
        priceIt = (await estimateOf({ capability: CAPABILITY, input: input(args), units: {} })).kind !== "free";
    }
    const priced = priceIt ? await planAndPrice(tool, "captions", params, context.session) : null;
    if (priced && !priced.ok) return priced;
    const estimate = priced?.ok ? priced.estimate : null;
    const expected = estimate ? { expectedMaxUsd: estimate.usd } : {};
    if (!item) {
        const command: Planned["command"] = { type: "ai.run", capability: CAPABILITY, input: { ...input(args), ...expected } };
        if (placed) command.placeAt = { kind: "captions-track", style: args.style === "subtitle" ? "subtitle" : "caption" };
        return { ok: true, planned: { command, estimate, timeOffset: 0, timeScale: 1, what: "the timeline audio" } };
    }
    const aiPlan = priced!.ok ? priced!.plan : null!;
    const model = typeof args.model === "string" ? { model: args.model } : {};
    const command: Planned["command"] = { type: "ai.run", capability: CAPABILITY, input: { ...aiPlan.input, ...model, ...expected } };
    const placeAt = aiPlan.placeAt as { timeOffset?: number; timeScale?: number } | undefined;
    if (placed && aiPlan.placeAt) command.placeAt = aiPlan.placeAt;
    const what = args.clip_id !== undefined ? `clip ${String(args.clip_id)}` : `scene ${String(args.scene_id)}`;
    return { ok: true, planned: { command, estimate, timeOffset: placeAt?.timeOffset ?? 0, timeScale: placeAt?.timeScale ?? 1, what } };
}

const costOf = (output: unknown): number | undefined => {
    const cost = (output as { costUsd?: unknown } | null)?.costUsd;
    return typeof cost === "number" && Number.isFinite(cost) ? cost : undefined;
};

function notDone(tool: string, result: CommandResult): ToolOutcome {
    if (result.unavailable) {
        // The controller's own "needs a provider" text repeats the guidance; a host's reason (no whisper.cpp in this build) is kept.
        const cause = result.error && !/^ai\.run (needs|requires) a provider/.test(result.error) ? ` ${result.error}` : "";
        return unavailable(`${capabilityUnavailableMessage(tool, CAPABILITY)}${cause}`, CAPABILITY);
    }
    if (result.cancelled) return failure(`${tool} was cancelled.`);
    return failure(`Transcription failed: ${result.error ?? "unknown error"}`);
}

const transcribeAudio: ToolHandler = async (args, context) => {
    const planning = await plan("transcribe_audio", args, context, false);
    if (!planning.ok) return planning.outcome;
    const { command, estimate, timeOffset, timeScale, what } = planning.planned;
    // The call's signal (timeout, client cancel) cancels the provider job too.
    const result = await context.session.execute(command, { signal: context.signal });
    if (!result.ok) return notDone("transcribe_audio", result);
    const transcript = asTranscript(result.output);
    if (!transcript) return failure("The provider returned no transcript.");
    // A clip's transcript starts at its used range: its times land on the timeline like its captions would.
    const at = (t: number) => round3(timeOffset + t / timeScale);
    const segments = transcript.segments.map((s) => ({ start: at(s.start), end: at(s.end), text: s.text.trim() }));
    const costUsd = costOf(result.output);
    const cost = costText(costUsd, estimate);
    const data = { language: transcript.language, segments, costUsd: costUsd ?? null, estimate: estimateData(estimate), jobId: result.jobId ?? null };
    if (segments.length === 0) return success(`No speech found in ${what}${cost}.`, data);
    const text = timeOffset === 0 && timeScale === 1 ? transcriptText(transcript) : segments.map((s) => `[${s.start}-${s.end}] ${s.text}`).join("\n");
    return success(cost ? `${text}\n${cost.trim()}` : text, data);
};

const autoCaptions: ToolHandler = async (args, context) => {
    const { session, signal } = context;
    const planning = await plan("auto_captions", args, context, true);
    if (!planning.ok) return planning.outcome;
    const { command, estimate } = planning.planned;
    // A cancelled or timed-out call cancels its job, so no captions land after the agent was told it failed.
    const result = await session.execute(command, { signal });
    if (!result.ok) return notDone("auto_captions", result);
    const transcript = asTranscript(result.output);
    const clipIds = result.createdClipIds ?? [];
    const language = transcript?.language ?? null;
    const costUsd = costOf(result.output);
    const cost = costText(costUsd, estimate);
    const extra = { costUsd: costUsd ?? null, estimate: estimateData(estimate), jobId: result.jobId ?? null };
    if (clipIds.length === 0) return success(`No speech found in ${planning.planned.what}; no captions were added${cost}.`, { clipIds, trackIndex: null, language, ...extra });
    const snapshot = await session.snapshot();
    const trackIndex = snapshot.clips.find((clip) => clip.id === clipIds[0])?.trackIndex ?? null;
    return success(
        `Added ${clipIds.length} caption${clipIds.length === 1 ? "" : "s"} on text track ${trackIndex ?? "?"} (language ${language ?? "unknown"})${cost}. undo_last_edit removes them and the track.`,
        { clipIds, createdClipIds: clipIds, trackIndex, language, ...extra },
    );
};

export const TRANSCRIBE_HANDLERS: Readonly<Record<string, ToolHandler>> = {
    transcribe_audio: transcribeAudio,
    auto_captions: autoCaptions,
};
