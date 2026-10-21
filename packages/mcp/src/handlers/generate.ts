// Generation tools over ai.run (phase 8): generate_quick_image, generate_video_h3, generate_tts, add_music, and
// generate_sfx run the routed provider (OpenNan by default), and the host imports the results into the project's
// media library, so the answer carries opennan-local:// media an agent can place with create_timeline_clip. Audio
// tools place their clip when asked to (and when the file's length is known). Signed out of OpenNan, they answer
// with the sign-in guidance; hosts without a provider answer "unavailable" with the §5.4 text.
import { capabilityUnavailableMessage, type ToolCapability } from "@opennan/mcp-schema";
import type { CommandResult } from "@opennan/timeline-core";
import { round3, type Args } from "../args";
import { failure, success, unavailable, type ToolOutcome } from "../outcome";
import { createPlacedClip } from "./clips";
import type { ToolContext, ToolHandler } from "./types";
import { formatUsd } from "../prices";

interface Media {
    kind: string;
    url?: string;
    name?: string;
    mimeType?: string;
    durationSeconds?: number;
}

const str = (value: unknown) => (typeof value === "string" && value.trim() !== "" ? value : undefined);
const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : undefined);

function notDone(tool: string, capability: ToolCapability, result: CommandResult): ToolOutcome {
    if (result.unavailable) {
        const reason = result.error ?? "";
        // A provider's own guidance (sign in to OpenNan) is the most useful text; the controller's generic one is not.
        return unavailable(/^(ai\.run (needs|requires) a provider|ai\.run requires)/.test(reason) || !reason ? capabilityUnavailableMessage(tool, capability) : reason, capability);
    }
    if (result.cancelled) return failure(`${tool} was cancelled.`);
    return failure(`${tool} failed: ${result.error ?? "unknown error"}`);
}

function mediaOf(result: CommandResult): { media: Media[]; costUsd?: number; result?: unknown } {
    const output = (result.output ?? {}) as { media?: unknown; costUsd?: unknown; result?: unknown };
    const media = Array.isArray(output.media) ? (output.media as Media[]).filter((m) => m && typeof m.url === "string") : [];
    return { media, ...(typeof output.costUsd === "number" ? { costUsd: output.costUsd } : {}), ...(output.result !== undefined ? { result: output.result } : {}) };
}

function describe(media: Media[], costUsd: number | undefined): string {
    const list = media.map((m) => `${m.kind} ${m.url}${m.durationSeconds ? ` (${round3(m.durationSeconds)}s)` : ""}`).join(", ");
    const cost = costUsd !== undefined ? ` Cost ${formatUsd(costUsd)}.` : "";
    return `Added to the media library: ${list}.${cost}`;
}

async function run(tool: string, capability: ToolCapability, input: Record<string, unknown>, context: ToolContext): Promise<{ outcome: ToolOutcome } | { media: Media[]; costUsd?: number; text: string }> {
    const result = await context.session.execute({ type: "ai.run", capability, input }, { signal: context.signal });
    if (!result.ok) return { outcome: notDone(tool, capability, result) };
    const { media, costUsd } = mediaOf(result);
    if (media.length === 0) return { outcome: failure(`${tool}: the provider returned no media.`) };
    return { media, ...(costUsd !== undefined ? { costUsd } : {}), text: describe(media, costUsd) };
}

/** Places an audio result when the call asked for a time (or always, for music), if its length is known. */
async function placeAudio(context: ToolContext, media: Media, start: number | undefined, trackIndex: number | undefined, label: string): Promise<string> {
    if (start === undefined) return "";
    if (!media.durationSeconds) return ` Its length is unknown here, so it was not placed: use create_timeline_clip with media_url ${media.url}.`;
    const placed = await createPlacedClip(context.session, {
        trackType: "audio", startTime: round3(start), endTime: round3(start + media.durationSeconds), mediaUrl: media.url!, label,
    }, trackIndex === undefined ? {} : { requested: trackIndex });
    return placed.ok ? ` ${placed.text}` : ` It was not placed: ${placed.text}`;
}

/**
 * The ai.run request each generator sends, from its arguments. estimate_cost prices the same request (phase 11.1), so
 * a price is always for the call the generator makes: its default model, its own length rules, its image inputs.
 */
export type GeneratorTool = "generate_quick_image" | "generate_video_h3" | "generate_tts" | "add_music" | "generate_sfx";

export function generationRequest(tool: GeneratorTool, args: Args): { capability: ToolCapability; input: Record<string, unknown> } {
    switch (tool) {
        case "generate_quick_image":
            return { capability: "image.generate", input: { description: String(args.prompt ?? ""), ...(str(args.aspect_ratio) ? { aspectRatio: args.aspect_ratio } : {}) } };
        case "generate_video_h3": {
            const input: Record<string, unknown> = { description: String(args.prompt ?? "") };
            if (num(args.seconds)) input.durationSeconds = Math.round(args.seconds as number);
            if (str(args.first_frame_url)) input.image = args.first_frame_url;
            if (str(args.last_frame_url)) input.endImage = args.last_frame_url;
            return { capability: input.image ? "video.image-to-video" : "video.text-to-video", input };
        }
        case "generate_tts": {
            const input: Record<string, unknown> = { text: String(args.text ?? "") };
            if (str(args.voice_id)) input.voice = args.voice_id;
            if (num(args.speed)) input.speed = args.speed;
            return { capability: "audio.tts", input };
        }
        case "add_music": {
            // No length: the provider makes its default length.
            const input: Record<string, unknown> = { description: String(args.description ?? "") };
            if (typeof args.instrumental === "boolean") input.instrumental = args.instrumental;
            return { capability: "audio.music", input };
        }
        case "generate_sfx": {
            const input: Record<string, unknown> = { description: String(args.description ?? "") };
            if (num(args.duration_seconds)) input.durationSeconds = args.duration_seconds;
            return { capability: "audio.sfx", input };
        }
    }
}

const generateQuickImage: ToolHandler = async (args, context) => {
    const request = generationRequest("generate_quick_image", args);
    const ran = await run("generate_quick_image", request.capability, request.input, context);
    if ("outcome" in ran) return ran.outcome;
    return success(ran.text, { media: ran.media, costUsd: ran.costUsd ?? null });
};

const generateVideoH3: ToolHandler = async (args, context) => {
    const { capability, input } = generationRequest("generate_video_h3", args);
    const ran = await run("generate_video_h3", capability, input, context);
    if ("outcome" in ran) return ran.outcome;
    return success(ran.text, { media: ran.media, costUsd: ran.costUsd ?? null });
};

const generateTts: ToolHandler = async (args, context) => {
    const { capability, input } = generationRequest("generate_tts", args);
    const ran = await run("generate_tts", capability, input, context);
    if ("outcome" in ran) return ran.outcome;
    const placed = await placeAudio(context, ran.media[0]!, num(args.timeline_start_time), num(args.timeline_track_index), "Voice");
    return success(ran.text + placed, { media: ran.media, costUsd: ran.costUsd ?? null });
};

const addMusic: ToolHandler = async (args, context) => {
    const { capability, input } = generationRequest("add_music", args);
    const ran = await run("add_music", capability, input, context);
    if ("outcome" in ran) return ran.outcome;
    const placed = await placeAudio(context, ran.media[0]!, 0, undefined, "Music");
    return success(ran.text + placed, { media: ran.media, costUsd: ran.costUsd ?? null });
};

const generateSfx: ToolHandler = async (args, context) => {
    const { capability, input } = generationRequest("generate_sfx", args);
    const ran = await run("generate_sfx", capability, input, context);
    if ("outcome" in ran) return ran.outcome;
    const placed = await placeAudio(context, ran.media[0]!, num(args.timeline_start_time), num(args.timeline_track_index), "Sound effect");
    return success(ran.text + placed, { media: ran.media, costUsd: ran.costUsd ?? null });
};

export const GENERATE_HANDLERS: Readonly<Record<string, ToolHandler>> = {
    generate_quick_image: generateQuickImage,
    generate_video_h3: generateVideoH3,
    generate_tts: generateTts,
    add_music: addMusic,
    generate_sfx: generateSfx,
};


