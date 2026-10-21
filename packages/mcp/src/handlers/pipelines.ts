// OpenNan project pipeline tools (phase 9b, design §5): on an OpenNan cloud project, the OpenNan-named pipeline tools
// (storyboard, smart scene video, copy-video steps) and Studio's plan_scenes / set_project_script run on the host's
// cloud seam (StudioCloud.pipelines). A priced step is quoted by OpenNan first; a quote above `accept_max_usd` (or no
// quote at all: prices are never estimated here) stops it before anything is submitted. The host then submits it,
// follows the task to its end and has the editor pull the result (one undo step where it can). There is no director
// tool: an MCP client is already an agent. Local projects are asked to be saved to OpenNan first; headless hosts have
// no cloud runtime. This module holds no network code: the host owns the API client and its key.
import { scenesInOrder, sceneByOrder, type Args } from "../args";
import { failure, success, unavailable, type ToolOutcome } from "../outcome";
import { formatUsd } from "../prices";
import type { StudioCloudPipelines, StudioPipelineQuote, StudioPipelineStep, StudioPipelineTool, StudioSession } from "../session";
import { CLOUD_UNAVAILABLE } from "./cloud";
import type { ToolContext, ToolHandler } from "./types";

export const NEEDS_CLOUD_PROJECT = "This needs an OpenNan cloud project: save it to OpenNan first (save_project_to_cloud).";
export const PRICE_UNAVAILABLE = "OpenNan can't price this right now, so it didn't run.";
export const NO_PIPELINES = "This OpenNan Studio host can't run OpenNan project pipelines yet: update the OpenNan Studio app.";

/** The server's limits on the stored script (PATCH /v1/projects/{id}). */
export const MAX_SCRIPT_TEXT_CHARS = 20_000;
export const MAX_SRT_CHARS = 200_000;
const MAX_TEXT_ARG = 4_000;
const MAX_SHOT_INDEX = 999;

/** "$0.31": a quote rounded up to the cent (never shown below what it may cost). */
function usdUp(usd: number): string {
    const cents = Math.ceil(Math.max(0, usd) * 100 - 1e-9);
    return `$${(cents / 100).toFixed(2)}`;
}

function quoteLine(quote: { priceUsd: number; holdUsd: number }): string {
    const hold = quote.holdUsd > quote.priceUsd + 1e-9 ? ` (holds up to ${usdUp(quote.holdUsd)} while it runs)` : "";
    return `OpenNan quotes ≈ ${usdUp(quote.priceUsd)}${hold}`;
}

/** The open project's pipelines, or the guidance when it has none. */
function pipelinesOf(session: StudioSession, context: ToolContext): StudioCloudPipelines | ToolOutcome {
    const capability = context.tool.capability;
    if (!session.cloud) return unavailable(CLOUD_UNAVAILABLE, capability);
    if (!session.projectId.startsWith("cloud-")) return unavailable(NEEDS_CLOUD_PROJECT, capability);
    return session.cloud.pipelines ?? unavailable(NO_PIPELINES, capability);
}

const isOutcome = (value: unknown): value is ToolOutcome => typeof value === "object" && value !== null && "ok" in value && "text" in value;

/** The scene a tool names (scene_id, or 1-based scene_order of the open project), with its 1-based position. */
async function sceneOf(session: StudioSession, args: Args): Promise<{ id: string; order: number } | string> {
    const hasId = args.scene_id !== undefined;
    const hasOrder = args.scene_order !== undefined;
    if (!hasId && !hasOrder) return "Name the scene with scene_order (1-based) or scene_id.";
    const snapshot = await session.snapshot();
    const ordered = scenesInOrder(snapshot.scenes);
    if (hasId) {
        if (typeof args.scene_id !== "string" || args.scene_id === "") return "scene_id must be a scene id of the open project.";
        const index = ordered.findIndex((scene) => scene.id === args.scene_id);
        if (index < 0) return `Scene ${args.scene_id} not found in the open project.`;
        if (hasOrder && Number(args.scene_order) !== index + 1) return `scene_id ${args.scene_id} is scene ${index + 1}, not scene ${String(args.scene_order)}: give one of them.`;
        return { id: ordered[index]!.id, order: index + 1 };
    }
    try {
        const scene = sceneByOrder(snapshot, args.scene_order);
        return { id: scene.id, order: ordered.indexOf(scene) + 1 };
    } catch (error) {
        return error instanceof Error ? error.message : String(error);
    }
}

function shotIndexOf(args: Args): number | string {
    const index = args.shot_index;
    if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index > MAX_SHOT_INDEX) return `shot_index must be a 0-based shot index (0 to ${MAX_SHOT_INDEX}).`;
    return index;
}

function textOf(args: Args, key: string, required: boolean): string | undefined | { error: string } {
    const value = args[key];
    if (value === undefined && !required) return undefined;
    if (typeof value !== "string" || value.trim() === "") return { error: `${key} must be a non-empty text.` };
    if (value.length > MAX_TEXT_ARG) return { error: `${key} is too long (at most ${MAX_TEXT_ARG} characters).` };
    return value;
}

const isError = (value: unknown): value is { error: string } => typeof value === "object" && value !== null && "error" in value;

function acceptMaxOf(args: Args): number | undefined | { error: string } {
    const value = args.accept_max_usd;
    if (value === undefined) return undefined;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return { error: "accept_max_usd must be a dollar amount of 0 or more." };
    return value;
}

/** What one priced tool sends: its pipeline, the route body, and its words. */
interface PricedSpec {
    tool: StudioPipelineTool;
    scene: boolean;
    shot: boolean;
    /** The route's body from the tool's arguments, or a reason the arguments can't run. */
    body(args: Args): Record<string, unknown> | { error: string };
    label(scene: number, shot: number): string;
    dryRun?: boolean;
}

const VIDEO_MODELS = ["auto", "seedance-2", "kling-o3", "kling-3"];

const PRICED: Readonly<Record<string, PricedSpec>> = {
    generate_storyboard: {
        tool: "storyboard", scene: true, shot: false, label: (scene) => `Storyboard of scene ${scene}`,
        body: (args) => {
            if (args.regenerate !== undefined && typeof args.regenerate !== "boolean") return { error: "regenerate must be true or false." };
            return args.regenerate === undefined ? {} : { regenerate: args.regenerate };
        },
    },
    generate_scene_videos_smart: {
        tool: "smart-scene-video", scene: true, shot: false, dryRun: true, label: (scene) => `Video of scene ${scene}`,
        body: (args) => {
            if (args.model_id === undefined) return {};
            if (typeof args.model_id !== "string" || !VIDEO_MODELS.includes(args.model_id)) return { error: `model_id must be one of ${VIDEO_MODELS.join(", ")}.` };
            return { model: args.model_id };
        },
    },
    detect_copy_video_shots: { tool: "copy-video-detect", scene: true, shot: false, body: () => ({}), label: (scene) => `Shots of the copied video in scene ${scene}` },
    edit_copy_video_shot_image: {
        tool: "copy-video-edit", scene: true, shot: true, label: (scene, shot) => `Panel of shot ${shot + 1} in scene ${scene}`,
        body: (args) => {
            const instruction = textOf(args, "instruction", true);
            return isError(instruction) ? instruction : { instruction };
        },
    },
    generate_video_from_panels: { tool: "copy-video-recreate", scene: true, shot: false, body: () => ({}), label: (scene) => `Video from the panels of scene ${scene}` },
    plan_scenes: {
        tool: "story-scenes", scene: false, shot: false, dryRun: true, label: () => "Scene plan",
        body: (args) => {
            const body: Record<string, unknown> = {};
            for (const key of ["style", "concept", "direction"]) {
                const value = textOf(args, key, false);
                if (isError(value)) return value;
                if (value !== undefined) body[key] = value;
            }
            return body;
        },
    },
};

function refusedByQuote(quote: Exclude<StudioPipelineQuote, { kind: "quote" }>): ToolOutcome {
    if (quote.kind === "unavailable") return failure(PRICE_UNAVAILABLE, { quoted: false, submitted: false });
    return failure(`OpenNan won't run this: ${quote.message}`, { quoted: false, submitted: false, code: quote.code });
}

function pricedHandler(spec: PricedSpec): ToolHandler {
    return async (args, context) => {
        const pipelines = pipelinesOf(context.session, context);
        if (isOutcome(pipelines)) return pipelines;
        const acceptMax = acceptMaxOf(args);
        if (isError(acceptMax)) return failure(acceptMax.error);
        const body = spec.body(args);
        if (isError(body)) return failure(body.error as string);
        let shot = 0;
        if (spec.shot) {
            const index = shotIndexOf(args);
            if (typeof index === "string") return failure(index);
            shot = index;
        }
        let scene: { id: string; order: number } | null = null;
        if (spec.scene) {
            const found = await sceneOf(context.session, args);
            if (typeof found === "string") return failure(found);
            scene = found;
        }
        const step: StudioPipelineStep = {
            tool: spec.tool, ...(scene ? { sceneId: scene.id } : {}), ...(spec.shot ? { index: shot } : {}), body: body as Record<string, unknown>,
            label: spec.label(scene?.order ?? 0, shot),
        };
        try {
            const quote = await pipelines.quote(step);
            if (quote.kind !== "quote") return refusedByQuote(quote);
            const priced = { quoted: true, priceUsd: quote.priceUsd, holdUsd: quote.holdUsd, ...(acceptMax !== undefined ? { acceptMaxUsd: acceptMax } : {}) };
            const line = quoteLine(quote);
            if (acceptMax !== undefined && Math.max(quote.priceUsd, quote.holdUsd) > acceptMax + 1e-9) {
                return failure(`${line}, above accept_max_usd ${formatUsd(acceptMax)}: nothing ran.`, { ...priced, submitted: false });
            }
            if (spec.dryRun && args.dry_run === true) {
                return success(`${line} for ${step.label.charAt(0).toLowerCase()}${step.label.slice(1)}. Nothing ran (dry_run).`, { ...priced, dryRun: true, submitted: false });
            }
            // Never above what was reported: the agent's own limit, else the quote this answer states.
            const result = await pipelines.run(step, { maxHoldUsd: acceptMax ?? Math.max(quote.priceUsd, quote.holdUsd), signal: context.signal });
            const data = {
                ...priced, submitted: true, taskId: result.taskId, status: result.status, chargedUsd: result.chargedUsd, projectRevision: result.projectRevision,
                synced: result.synced, undoable: result.undoable, ...(result.error ? { error: result.error } : {}),
            };
            if (result.status === "succeeded") {
                const charged = result.chargedUsd !== null ? `, charged ${formatUsd(result.chargedUsd)}` : "";
                const landed = !result.synced
                    ? " OpenNan saved the result; the editor shows it once it syncs."
                    : result.undoable ? " The result is in the editor; undo_last_edit takes it back in one step." : " The result is in the editor.";
                return success(`${line}. ${step.label} finished${charged}.${landed}`, data);
            }
            const why = result.error?.message ? `: ${result.error.message}` : "";
            const money = result.error?.refunded || result.status === "cancelled" ? " The hold was refunded." : result.chargedUsd !== null ? ` Charged ${formatUsd(result.chargedUsd)}.` : "";
            return failure(`${line}. ${step.label} ${result.status === "cancelled" ? "was cancelled" : "failed"}${why}.${money}`, data);
        } catch (error) {
            return failure(error instanceof Error ? error.message : String(error), { submitted: false });
        }
    };
}

const setCopyVideoSource: ToolHandler = async (args, context) => {
    const pipelines = pipelinesOf(context.session, context);
    if (isOutcome(pipelines)) return pipelines;
    const url = args.video_url;
    if (typeof url !== "string" || !/^https:\/\/[^\s]+$/i.test(url) || url.length > 2_000) return failure("video_url must be an https link to the video to copy.");
    const trim: { trimStart?: number; trimEnd?: number } = {};
    for (const [key, field] of [["trim_start", "trimStart"], ["trim_end", "trimEnd"]] as const) {
        const value = args[key];
        if (value === undefined) continue;
        if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return failure(`${key} must be seconds (0 or more).`);
        trim[field] = value;
    }
    if (trim.trimEnd !== undefined && !(trim.trimEnd > (trim.trimStart ?? 0))) return failure("trim_end must come after trim_start.");
    const scene = await sceneOf(context.session, args);
    if (typeof scene === "string") return failure(scene);
    try {
        const { synced } = await pipelines.editScene({ kind: "copy-video-source", sceneId: scene.id, videoUrl: url, ...trim });
        return success(`Scene ${scene.order} now copies ${url}${synced ? "" : "; the editor shows it once it syncs"}. No charge; detect_copy_video_shots finds its shots next.`, { sceneId: scene.id, synced });
    } catch (error) {
        return failure(error instanceof Error ? error.message : String(error));
    }
};

const editCopyVideoShotDescription: ToolHandler = async (args, context) => {
    const pipelines = pipelinesOf(context.session, context);
    if (isOutcome(pipelines)) return pipelines;
    const index = shotIndexOf(args);
    if (typeof index === "string") return failure(index);
    const description = textOf(args, "description", true);
    if (isError(description)) return failure(description.error);
    const scene = await sceneOf(context.session, args);
    if (typeof scene === "string") return failure(scene);
    try {
        const { synced } = await pipelines.editScene({ kind: "shot-text", sceneId: scene.id, index, action: description as string });
        return success(`Rewrote shot ${index + 1} of scene ${scene.order}${synced ? "" : "; the editor shows it once it syncs"}. No charge; its panel stays as it was.`, { sceneId: scene.id, shotIndex: index, synced });
    } catch (error) {
        return failure(error instanceof Error ? error.message : String(error));
    }
};

const setProjectScript: ToolHandler = async (args, context) => {
    const pipelines = pipelinesOf(context.session, context);
    if (isOutcome(pipelines)) return pipelines;
    const texts: { scriptText?: string | null; srtContent?: string | null } = {};
    for (const [key, field, max] of [["script_text", "scriptText", MAX_SCRIPT_TEXT_CHARS], ["srt_content", "srtContent", MAX_SRT_CHARS]] as const) {
        const value = args[key];
        if (value === undefined) continue;
        if (value !== null && typeof value !== "string") return failure(`${key} must be a text or null.`);
        if (typeof value === "string" && value.length > max) return failure(`${key} is too long (at most ${max.toLocaleString("en-US")} characters).`);
        texts[field] = value;
    }
    if (texts.scriptText === undefined && texts.srtContent === undefined) return failure("Give script_text, srt_content, or both (null clears one).");
    try {
        await pipelines.setScript(texts);
        const what = [texts.scriptText !== undefined ? (texts.scriptText === null ? "cleared the script text" : "stored the script text") : null,
            texts.srtContent !== undefined ? (texts.srtContent === null ? "cleared the subtitles" : "stored the subtitles") : null].filter(Boolean).join(" and ");
        return success(`${what.charAt(0).toUpperCase()}${what.slice(1)} of the project (scenes unchanged, no charge). plan_scenes plans the scenes from them.`, {
            scriptText: texts.scriptText === undefined ? "unchanged" : texts.scriptText === null ? "cleared" : "stored",
            srtContent: texts.srtContent === undefined ? "unchanged" : texts.srtContent === null ? "cleared" : "stored",
        });
    } catch (error) {
        return failure(error instanceof Error ? error.message : String(error));
    }
};

export const PIPELINE_HANDLERS: Readonly<Record<string, ToolHandler>> = {
    ...Object.fromEntries(Object.entries(PRICED).map(([name, spec]) => [name, pricedHandler(spec)])),
    set_copy_video_source: setCopyVideoSource,
    edit_copy_video_shot_description: editCopyVideoShotDescription,
    set_project_script: setProjectScript,
};
