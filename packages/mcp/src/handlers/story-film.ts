// Story film tools over MCP (@opennan/story-film on the session): the story lives on the project
// (ProjectMeta.storyFilmJson, no undo step), so the editor's wizard and an agent share it. Each paid step is priced
// through the session (the provider's never-under estimate; estimate_only answers it and runs nothing; a total above
// accept_max_usd refuses), makes only what is missing (ids + redo remake one), and stores every result on the story as
// it lands, so a call that times out or fails part way keeps what it paid for and the next call skips it.
import {
    copyDraftRequest, estimateStep, mergeStory, parseDraftReply, parseStoryFilm, readStoryJson, reelInputOf, runStep, storyJson, storyProgress, withAssembled,
    writeDraftRequest, type DraftRequest, type StepEstimate, type StoryFilm, type StoryFilmHost, type StoryMedium, type StoryRunResult, type StoryStep,
} from "@opennan/story-film";
import { applyReelLayout, type CommandResult } from "@opennan/timeline-core";
import type { Args } from "../args";
import { failure, success, unavailable, type ToolOutcome } from "../outcome";
import { formatUsd } from "../prices";
import type { StudioSession } from "../session";
import type { ToolContext, ToolHandler } from "./types";

const str = (value: unknown) => (typeof value === "string" && value.trim() !== "" ? value.trim() : undefined);
const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
const NO_STORY = "This project has no story film yet: call story_film_create (a story or a written text) or story_film_copy first.";
const STEP_WORDS: Record<StoryStep, string> = { cast: "character sheet", frames: "keyframe", animate: "clip", music: "music bed" };
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export async function readStory(session: StudioSession): Promise<StoryFilm | null> {
    return readStoryJson((await session.snapshot()).project?.storyFilmJson ?? null);
}

export async function saveStory(session: StudioSession, story: StoryFilm): Promise<void> {
    const result = await session.execute({ type: "project.update", patch: { storyFilmJson: storyJson(story) } });
    if (!result.ok) throw new Error(`The story film could not be saved: ${result.error ?? "unknown error"}`);
}

/** The pipeline's host over the session: ai.run (results imported into the project) and the session's prices. */
export function sessionStoryHost(session: StudioSession, signal: AbortSignal): StoryFilmHost {
    return {
        async run(capability, input, options): Promise<StoryRunResult> {
            const result = await session.execute({ type: "ai.run", capability, input }, { signal: options.signal ?? signal });
            return runResult(result);
        },
        async price(capability, input, units) {
            if (!session.estimate) return { kind: "unknown", reason: "This host cannot price runs." };
            return session.estimate({ capability, input, units });
        },
    };
}

function runResult(result: CommandResult): StoryRunResult {
    if (!result.ok) return { ok: false, error: result.error ?? "unknown error", ...(result.cancelled ? { cancelled: true } : {}), ...(result.unavailable ? { unavailable: true } : {}) };
    const output = (result.output ?? {}) as { media?: Array<Record<string, unknown>>; costUsd?: unknown; result?: unknown };
    const media = (output.media ?? []).filter((m) => typeof m?.url === "string").map((m) => ({
        url: m.url as string,
        ...(num(m.width) && num(m.height) ? { width: m.width as number, height: m.height as number } : {}),
        ...(num(m.durationSeconds) ? { durationSeconds: m.durationSeconds as number } : {}),
    }));
    return { ok: true, media, ...(num(output.costUsd) !== undefined ? { costUsd: output.costUsd as number } : {}), ...(output.result !== undefined ? { result: output.result } : {}) };
}

function summaryText(story: StoryFilm): string {
    const progress = storyProgress(story);
    const parts = progress.map((p) => `${p.step} ${p.made}/${p.total}${p.changed.length ? ` (${p.changed.length} changed since made: ${p.changed.join(", ")})` : ""}`);
    return `"${story.title}": ${plural(story.characters.length, "character")}, ${plural(story.shots.length, "shot")}. Made: ${parts.join("; ")}. Spent ${formatUsd(story.spentUsd ?? 0)}.`;
}

function storyData(story: StoryFilm): Record<string, unknown> {
    return { story, progress: storyProgress(story), spentUsd: story.spentUsd ?? 0 };
}

const storyFilmGet: ToolHandler = async (_args, { session }) => {
    const story = await readStory(session);
    if (!story) return failure(NO_STORY);
    return success(summaryText(story), storyData(story));
};

/** The price check every paid call makes: refused when it cannot be priced, or costs more than accept_max_usd. */
function priceGate(tool: string, estimate: StepEstimate | null, args: Args): ToolOutcome | null {
    if (!estimate) return null;
    if (!estimate.ready) return failure(`${tool} did not run: ${estimate.reason ?? "it could not be priced"} Nothing was sent.`, { estimate: estimate.label });
    const accept = num(args.accept_max_usd);
    if (accept !== undefined && estimate.usd > accept + 1e-9) {
        return failure(`${tool} did not run: it is estimated at ${estimate.label}, more than accept_max_usd $${accept}. Nothing was sent.`, { estimate: estimate.label, estimateUsd: estimate.usd });
    }
    return null;
}

function stepTool(tool: string, step: StoryStep): ToolHandler {
    return async (args, context) => {
        let story = await readStory(context.session);
        if (!story) return failure(NO_STORY);
        if (step === "animate" && (str(args.model) || str(args.quality))) {
            story = { ...story, settings: { ...story.settings, ...(str(args.model) ? { videoModel: str(args.model) } : {}), ...(str(args.quality) ? { quality: str(args.quality) } : {}) } };
            await saveStory(context.session, story);
        }
        const ids = Array.isArray(args.ids) ? (args.ids as unknown[]).filter((id): id is string => typeof id === "string") : undefined;
        const redo = args.redo === true;
        if (redo && !ids && step !== "music") return failure(`${tool}: redo needs ids (the ${step === "cast" ? "character" : "shot"} ids to make again).`);
        const castCheck = step === "frames" ? num(args.cast_check) : undefined;
        const options = { ...(ids ? { only: ids } : step === "music" && redo ? { only: ["music"] } : {}), redo, ...(castCheck !== undefined ? { castCheck } : {}) };
        const host = sessionStoryHost(context.session, context.signal);
        const estimate = context.session.estimate ? await estimateStep(host, story, step, options) : null;
        if (estimate && !estimate.ready && estimate.reason?.startsWith("Nothing to make")) return success(`${tool}: every ${STEP_WORDS[step]} is made already (redo with ids to make one again).`, storyData(story));
        const refused = priceGate(tool, estimate, args);
        if (refused) return refused;
        const count = estimate?.items.length;
        if (args.estimate_only === true) {
            return success(`${tool} would make ${plural(count ?? 0, STEP_WORDS[step])}, estimated ${estimate?.label ?? "(no price from this host)"}. Nothing was sent.`, { estimate: estimate?.label ?? null, estimateUsd: estimate?.usd ?? null, items: estimate?.items.map((i) => i.id) ?? [] });
        }
        const outcome = await runStep(host, story, step, { ...options, signal: context.signal, onStory: (s) => saveStory(context.session, s) });
        const made = outcome.made.length;
        const failed = outcome.failed.map((f) => `${f.id}: ${f.error}`).join("; ");
        const flagged = outcome.flagged.map((f) => `${f.id} (${f.unread ? "the check could not tell" : f.misses.map((m) => `${m.id}${m.reason ? `: ${m.reason}` : ""}`).join("; ")})`).join(", ");
        const text = [
            `${tool} made ${plural(made, STEP_WORDS[step])}${made ? ` (${outcome.made.join(", ")})` : ""}, charged ${formatUsd(outcome.spentUsd)}${estimate ? `; estimated ${estimate.label}` : ""}.`,
            outcome.redrawn.length ? ` Redrawn after the cast check: ${outcome.redrawn.join(", ")}.` : "",
            flagged ? ` Check these shots (a character still looks off their sheet): ${flagged}. Look at them, fix the text if needed, and redo with ids + redo.` : "",
            failed ? ` Not made: ${failed}. Nothing was retried; call the tool again to retry.` : "",
            outcome.cancelled ? " The run was stopped; what was made is kept and the next call skips it." : "",
            " " + summaryText(outcome.story),
        ].join("");
        const data = {
            ...storyData(outcome.story), made: outcome.made, failed: outcome.failed, cancelled: outcome.cancelled, costUsd: outcome.spentUsd, estimate: estimate?.label ?? null,
            ...(step === "frames" ? { redrawn: outcome.redrawn, flagged: outcome.flagged } : {}),
        };
        return made > 0 || outcome.failed.length === 0 ? success(text, data) : failure(text, data);
    };
}

/** Runs a draft through the story writer (priced first) and stores it as the project's story film. */
async function runDraft(tool: string, request: DraftRequest, source: Parameters<typeof parseDraftReply>[1], args: Args, context: ToolContext): Promise<ToolOutcome> {
    const { session } = context;
    const reply = session.estimate ? await session.estimate({ capability: request.capability, input: request.input, units: {} }) : null;
    if (reply?.kind === "unavailable") return unavailable(reply.reason, request.capability);
    if (reply?.kind === "unknown" && reply.priced) return failure(`${tool}: the price could not be checked${reply.reason ? ` (${reply.reason})` : ""}. Nothing was sent; try again.`);
    const label = reply?.kind === "estimate" ? reply.estimate.label : null;
    const usd = reply?.kind === "estimate" ? reply.estimate.usd : 0;
    const accept = num(args.accept_max_usd);
    if (accept !== undefined && usd > accept + 1e-9) return failure(`${tool} did not run: it is estimated at ${label}, more than accept_max_usd $${accept}. Nothing was sent.`);
    if (args.estimate_only === true) return success(`${tool} would ask the story writer for a draft, estimated ${label ?? "(no price from this host)"}. Nothing was sent.`, { estimate: label });
    const result = await session.execute({ type: "ai.run", capability: request.capability, input: request.input }, { signal: context.signal });
    if (!result.ok) {
        if (result.unavailable) return unavailable(result.error ?? `${tool} needs a provider with a story writer (text.generate).`, request.capability);
        return failure(`${tool} failed: ${result.error ?? "unknown error"}`);
    }
    const ran = runResult(result);
    const text = ran.ok ? (ran.result as { text?: unknown } | undefined)?.text : undefined;
    if (typeof text !== "string") return failure(`${tool}: the story writer returned no text.`);
    const parsed = parseDraftReply(text, source);
    const cost = ran.ok && ran.costUsd !== undefined ? ran.costUsd : 0;
    if (!parsed.ok) return failure(`${tool}: the draft did not read as a story film (${parsed.errors.slice(0, 5).join("; ")}). Charged ${formatUsd(cost)}. Fix it and send it with story_film_create { story }.`, { reply: text.slice(0, 20_000), errors: parsed.errors });
    // A new draft replaces the story (its ids name other shots): nothing is carried over but what it cost.
    const previous = await readStory(session);
    const story: StoryFilm = { ...parsed.story, spentUsd: Math.round(((previous?.spentUsd ?? 0) + cost) * 1e6) / 1e6 };
    await saveStory(session, story);
    return success(`${tool} drafted the story film (charged ${formatUsd(cost)}${label ? `; estimated ${label}` : ""}). Review and edit it (story_film_create { story }) before drawing. ${summaryText(story)}`, storyData(story));
}

const storyFilmCreate: ToolHandler = async (args, context) => {
    if (args.story !== undefined && args.text !== undefined) return failure("story_film_create takes story or text, not both.");
    if (args.story !== undefined) {
        const parsed = parseStoryFilm(args.story);
        if (!parsed.ok) return failure(`The story film has problems: ${parsed.errors.join("; ")}.`, { errors: parsed.errors });
        const story = mergeStory(await readStory(context.session), parsed.story);
        await saveStory(context.session, story);
        return success(`Saved the story film. ${summaryText(story)}`, storyData(story));
    }
    const text = str(args.text);
    if (!text) return failure("story_film_create needs story (a story film object) or text (a story to draft from).");
    const request = writeDraftRequest({
        text, ...(str(args.style) ? { style: str(args.style) } : {}), ...(str(args.medium) ? { medium: str(args.medium) as StoryMedium } : {}),
        ...(num(args.shots) ? { shots: num(args.shots) } : {}),
    });
    return runDraft("story_film_create", request, { kind: "write" }, args, context);
};

const SHEET_FRAMES = 16;

const storyFilmCopy: ToolHandler = async (args, context) => {
    const { session } = context;
    const cast = args.cast === "keep" ? "keep" : "original";
    let mediaUrl = str(args.media_url);
    const link = str(args.video_url);
    let sheet: { image: unknown; frames: number; everySeconds: number; durationSeconds: number } | null = null;
    const sheetUrl = str(args.sheet_image_url);
    if (sheetUrl) {
        const frames = Math.max(1, Math.round(num(args.frames) ?? SHEET_FRAMES));
        const duration = num(args.duration_seconds) ?? 0;
        const every = num(args.every_seconds) ?? (duration > 0 ? duration / frames : 0);
        sheet = { image: sheetUrl.startsWith("https://") ? sheetUrl : { mediaUrl: sheetUrl }, frames, everySeconds: every, durationSeconds: duration || every * frames };
    } else {
        if (!mediaUrl && link) {
            if (args.estimate_only === true) return success("story_film_copy would download the video (free), sample its frames, and ask the story writer for a draft. Call it without estimate_only, or pass sheet_image_url to price the draft first.");
            const downloaded = await session.execute({ type: "ai.run", capability: "web.fetch", input: { url: link } }, { signal: context.signal });
            if (!downloaded.ok) {
                if (downloaded.unavailable) return unavailable(downloaded.error ?? "Downloading a video link needs OpenNan.", "web.fetch");
                return failure(`story_film_copy could not download the video: ${downloaded.error ?? "unknown error"}`);
            }
            const got = runResult(downloaded);
            mediaUrl = got.ok ? got.media[0]?.url : undefined;
            if (!mediaUrl) return failure("story_film_copy: the download returned no video.");
        }
        if (!mediaUrl) return failure("story_film_copy needs media_url (a project video), video_url (a video-site link), or sheet_image_url (a contact sheet of its frames).");
        if (!session.host.storySheet) {
            return unavailable(`Sampling a video's frames needs the editor or mcp serve --ffmpeg. The video is in the project at ${mediaUrl}: make a 4x4 contact sheet of its frames (ffmpeg -i video -vf "fps=16/DURATION,scale=480:-2,tile=4x4" -frames:v 1 sheet.jpg), then call story_film_copy with sheet_image_url.`);
        }
        try {
            const made = await session.host.storySheet(mediaUrl, SHEET_FRAMES, context.signal);
            sheet = { image: { mediaUrl: made.url }, frames: made.frames, everySeconds: made.everySeconds, durationSeconds: made.durationSeconds };
        } catch (error) {
            return failure(`story_film_copy could not sample the video's frames: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    const request = copyDraftRequest({
        sheet: sheet.image, frames: sheet.frames, everySeconds: sheet.everySeconds, durationSeconds: sheet.durationSeconds, cast,
        ...(str(args.notes) ? { notes: str(args.notes) } : {}),
    });
    return runDraft("story_film_copy", request, { kind: "copy", cast, ...(mediaUrl ? { mediaUrl } : {}), ...(link ? { link } : {}) }, args, context);
};

const storyFilmAssemble: ToolHandler = async (_args, { session }) => {
    const story = await readStory(session);
    if (!story) return failure(NO_STORY);
    const reel = reelInputOf(story);
    if (!reel.ok) return failure(`story_film_assemble: ${reel.error} (story_film_animate).`, { missing: reel.missing });
    const outcome = await applyReelLayout((command) => session.execute(command), await session.snapshot(), reel.input);
    if (!outcome.ok) return failure(`story_film_assemble: ${outcome.error}`);
    await saveStory(session, withAssembled(story, outcome));
    return success(
        `Put "${story.title}" on the timeline as a 9:16 reel: ${plural(outcome.sceneIds.length, "shot")} on V1 from ${outcome.start}s to ${outcome.end}s, the title above the film${outcome.musicClipId ? ", the music under it" : ""}. undo_last_edit takes it back in one step.`,
        { sceneIds: outcome.sceneIds, titleClipId: outcome.titleClipId, musicClipId: outcome.musicClipId, start: outcome.start, end: outcome.end },
    );
};

const applyReelLayoutTool: ToolHandler = async (args, { session }) => {
    const clips = Array.isArray(args.clips) ? (args.clips as Args[]) : [];
    const input = {
        title: String(args.title ?? ""),
        clips: clips.map((c) => ({ mediaUrl: String(c.media_url ?? ""), durationSeconds: Number(c.duration_seconds), ...(str(c.label) ? { label: str(c.label) } : {}) })),
        music: str(args.music_url) ? { mediaUrl: str(args.music_url)!, ...(num(args.music_duration_seconds) ? { durationSeconds: num(args.music_duration_seconds) } : {}) } : null,
    };
    const outcome = await applyReelLayout((command) => session.execute(command), await session.snapshot(), input);
    if (!outcome.ok) return failure(`apply_reel_layout: ${outcome.error}`);
    return success(`Laid out a 9:16 reel: ${plural(outcome.sceneIds.length, "clip")} on V1 from ${outcome.start}s to ${outcome.end}s with the title above${outcome.musicClipId ? " and the music under it" : ""}.`, {
        sceneIds: outcome.sceneIds, titleClipId: outcome.titleClipId, musicClipId: outcome.musicClipId,
    });
};

export const STORY_FILM_HANDLERS: Readonly<Record<string, ToolHandler>> = {
    story_film_get: storyFilmGet,
    story_film_create: storyFilmCreate,
    story_film_copy: storyFilmCopy,
    story_film_cast: stepTool("story_film_cast", "cast"),
    story_film_frames: stepTool("story_film_frames", "frames"),
    story_film_animate: stepTool("story_film_animate", "animate"),
    story_film_music: stepTool("story_film_music", "music"),
    story_film_assemble: storyFilmAssemble,
    apply_reel_layout: applyReelLayoutTool,
};
