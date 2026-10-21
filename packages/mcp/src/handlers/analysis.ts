// Local AI tools over MCP (phase 11): remove_silences, remove_filler_words, detect_beats, and auto_cut_to_beat run
// the editor's analysis commands and apply each result as one undo step, with no provider and no charge. Silences
// and beats need the host's audio decoder (the editor window; headless `mcp serve` with --ffmpeg); filler words read
// the caption word timings, so they work wherever captions exist.
import { planAiTool, type AiToolParams, type CommandResult, type EditorCommand } from "@opennan/timeline-core";
import { round3, type Args } from "../args";
import { commandFailureText, failure, success, unavailable, type ToolOutcome } from "../outcome";
import { aiParams, itemArgsError } from "./ai-tools";
import type { ToolContext, ToolHandler } from "./types";

interface Range {
    start: number;
    end: number;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const rangesText = (ranges: Range[]) => ranges.slice(0, 20).map((r) => `${round3(r.start)}-${round3(r.end)}s`).join(", ") + (ranges.length > 20 ? ", ..." : "");
const total = (ranges: Range[]) => round3(ranges.reduce((sum, r) => sum + r.end - r.start, 0));

const ANALYZER_NEEDED = "needs an audio decoder: the OpenNan Studio editor window (desktop or web), or `opennan-studio mcp serve` started with --ffmpeg.";

function analysisNotDone(tool: string, result: CommandResult): ToolOutcome {
    if (result.unavailable) {
        const cause = result.error && !/^analysis\.run needs an audio analyzer/.test(result.error) ? ` ${result.error}` : "";
        return unavailable(`${tool} ${ANALYZER_NEEDED}${cause}`);
    }
    if (result.cancelled) return failure(`${tool} was cancelled.`);
    return failure(commandFailureText("analysis.run", result.error));
}

/** The analysis command the editor's panel sends (planAiTool), or why the item cannot be analysed. */
async function analysisCommand(tool: string, toolId: "silences" | "fillers" | "beats", params: AiToolParams, context: ToolContext): Promise<{ ok: true; command: EditorCommand } | { ok: false; outcome: ToolOutcome }> {
    const planned = planAiTool(await context.session.snapshot(), toolId, params);
    if (!planned.ok) return { ok: false, outcome: failure(`${tool}: ${planned.error}.`) };
    const { kind, ...rest } = planned.plan.input as { kind: string } & Record<string, unknown>;
    const command = (toolId === "fillers" ? { type: "analysis.fillers", ...rest } : { type: "analysis.run", kind, ...rest }) as EditorCommand;
    return { ok: true, command };
}

function item(args: Args): { clipId: string } | { sceneId: string } {
    return args.clip_id !== undefined ? { clipId: String(args.clip_id) } : { sceneId: String(args.scene_id) };
}

/** cuts.apply on the found ranges, answered in words. */
async function applyCuts(what: string, args: Args, ranges: Range[], context: ToolContext, extra: Record<string, unknown>): Promise<ToolOutcome> {
    const found = `${plural(ranges.length, what)} (${total(ranges)} s): ${rangesText(ranges)}`;
    if (ranges.length === 0) return success(`No ${what}s found; nothing was cut.`, { ...extra, ranges: [], applied: false });
    if (args.apply === false) return success(`Found ${found}. Nothing was cut (apply: false); call again without apply: false to cut them.`, { ...extra, ranges, applied: false });
    const cut = await context.session.execute({ type: "cuts.apply", ...item(args), ranges });
    if (!cut.ok) return failure(`Found ${found}, but they were not cut: ${commandFailureText("cuts.apply", cut.error)}`, { ...extra, ranges, applied: false });
    const output = (cut.output ?? {}) as { removed?: Range[]; removedSeconds?: number; linkedClipIds?: string[] };
    const removed = output.removed ?? ranges;
    const linked = output.linkedClipIds?.length ? ` Linked clips cut with it: ${output.linkedClipIds.join(", ")}.` : "";
    return success(
        `Cut ${plural(removed.length, what)} (${round3(output.removedSeconds ?? total(removed))} s) and closed the gaps; later items moved left.${linked} undo_last_edit restores them in one step.`,
        { ...extra, ranges: removed, applied: true, removedSeconds: output.removedSeconds ?? total(removed), linkedClipIds: output.linkedClipIds ?? [], createdClipIds: cut.createdClipIds ?? [] },
    );
}

const removeSilences: ToolHandler = async (args, context) => {
    const itemError = itemArgsError("remove_silences", args);
    if (itemError) return failure(itemError);
    const analysisOptions = {
        ...(typeof args.threshold_db === "number" ? { thresholdDb: args.threshold_db } : {}),
        ...(typeof args.min_silence === "number" ? { minSilence: args.min_silence } : {}),
        ...(typeof args.padding === "number" ? { padding: args.padding } : {}),
    };
    const planned = await analysisCommand("remove_silences", "silences", { ...aiParams(args), analysisOptions }, context);
    if (!planned.ok) return planned.outcome;
    const run = await context.session.execute(planned.command, { signal: context.signal });
    if (!run.ok) return analysisNotDone("remove_silences", run);
    const ranges = ((run.output as { ranges?: Range[] } | undefined)?.ranges ?? []).map((r) => ({ start: r.start, end: r.end }));
    return applyCuts("silence", args, ranges, context, {});
};

const removeFillerWords: ToolHandler = async (args, context) => {
    const itemError = itemArgsError("remove_filler_words", args);
    if (itemError) return failure(itemError);
    const planned = await analysisCommand("remove_filler_words", "fillers", aiParams(args), context);
    if (!planned.ok) return planned.outcome;
    const run = await context.session.execute(planned.command);
    if (!run.ok) {
        const hint = /No word timings/.test(run.error ?? "") ? " Add captions with word timings first (auto_captions)." : "";
        return failure(`${commandFailureText("analysis.fillers", run.error)}.${hint}`);
    }
    const output = (run.output ?? {}) as { ranges?: Range[]; words?: Array<{ text: string; start: number; end: number }>; language?: string };
    const words = (output.words ?? []).map((w) => w.text);
    return applyCuts("filler word", args, output.ranges ?? [], context, { words, language: output.language ?? null });
};

const detectBeats: ToolHandler = async (args, context) => {
    const clipId = String(args.clip_id ?? "");
    const clip = (await context.session.snapshot()).clips.find((c) => c.id === clipId);
    if (!clip) return failure(`Timeline clip not found: ${clipId}`);
    if (clip.trackType !== "audio") return failure(`Clip ${clipId} is a ${clip.trackType} clip; beats are found on audio clips.`);
    const planned = await analysisCommand("detect_beats", "beats", { clipId }, context);
    if (!planned.ok) return planned.outcome;
    const run = await context.session.execute(planned.command, { signal: context.signal });
    if (!run.ok) return analysisNotDone("detect_beats", run);
    const output = (run.output ?? {}) as { bpm?: number; times?: number[]; sourceTimes?: number[] };
    const times = output.times ?? [];
    const bpm = round3(output.bpm ?? 0);
    if (times.length === 0) return success(`No beats found in clip ${clipId}.`, { clipId, bpm, beats: [], saved: false });
    const saved = await context.session.execute({ type: "beats.set", clipId, beats: output.sourceTimes ?? [] });
    if (!saved.ok) return failure(`Found ${plural(times.length, "beat")} at ${bpm} BPM, but they were not saved: ${commandFailureText("beats.set", saved.error)}`, { clipId, bpm, beats: times });
    const first = times.slice(0, 8).map(round3).join(", ");
    return success(
        `Found ${plural(times.length, "beat")} at about ${bpm} BPM in clip ${clipId} (timeline s: ${first}${times.length > 8 ? ", ..." : ""}) and saved them on the clip. auto_cut_to_beat can cut to them; undo_last_edit removes them.`,
        { clipId, bpm, beats: times, saved: true },
    );
};

const autoCutToBeat: ToolHandler = async (args, context) => {
    const ids = (value: unknown) => (Array.isArray(value) ? value.map(String) : undefined);
    const clipIds = ids(args.clip_ids);
    const sceneIds = ids(args.scene_ids);
    const command = {
        type: "beats.autoCut" as const,
        // Ids given: exactly those (the command reads the selection only when both are absent).
        ...(clipIds || sceneIds ? { clipIds: clipIds ?? [], sceneIds: sceneIds ?? [] } : {}),
        ...(typeof args.beat_clip_id === "string" ? { beatClipId: args.beat_clip_id } : {}),
        ...(typeof args.every === "number" ? { every: args.every } : {}),
    };
    const result = await context.session.execute(command);
    if (!result.ok) {
        const hint = /beat/i.test(result.error ?? "") ? " Run detect_beats on the music clip first." : "";
        return failure(`${commandFailureText("beats.autoCut", result.error)}${hint}`);
    }
    const output = (result.output ?? {}) as { snapped?: number; unchanged?: number; beatClipId?: string };
    const snapped = output.snapped ?? 0;
    const unchanged = output.unchanged ? ` ${plural(output.unchanged, "cut")} had no beat nearby and stayed.` : "";
    return success(
        `Moved ${plural(snapped, "cut")} onto beats of clip ${output.beatClipId ?? "?"}.${unchanged}${snapped > 0 ? " undo_last_edit restores the old timing in one step." : ""}`,
        { snapped, unchanged: output.unchanged ?? 0, beatClipId: output.beatClipId ?? null },
    );
};

export const ANALYSIS_HANDLERS: Readonly<Record<string, ToolHandler>> = {
    remove_silences: removeSilences,
    remove_filler_words: removeFillerWords,
    detect_beats: detectBeats,
    auto_cut_to_beat: autoCutToBeat,
};
