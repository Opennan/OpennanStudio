// Capability tools added by OpenNan Studio (origin "studio"): not in the OpenNan toolset. They need a
// provider like the OpenNan capability tools and answer "unavailable" without one. Phase 11: the editor's AI tools
// (timeline-core ai/tools.ts) on a clip's or scene's used range, each one ai.run and one undo step.
import type { ToolCapability } from "../capabilities";
import { bool, enumOf, int, num, objectOf, str, type JsonSchema } from "../json-schema";
import type { ToolDefinition } from "../types";

const clipId = str("Timeline clip to run on (or scene_id).");
const sceneId = str("Main-track clip (scene) to run on, by its id (or clip_id).");
const firstSeconds: JsonSchema = { ...num("Send only the first N seconds of the used range (for clips past the tool's limit)."), exclusiveMinimum: 0 };
/** Accepting a higher price that an earlier call reported once the file was prepared (review finding B). */
const acceptMaxUsd: JsonSchema = { ...num("Highest price in US dollars to accept, as an earlier call reported after preparing the file."), exclusiveMinimum: 0 };
const item = { clip_id: clipId, scene_id: sceneId };
const engine = enumOf(["local", "cloud"], "\"local\": on this device (desktop); \"cloud\": OpenNan. Default: the editor's routing.");

function studioCap(
    name: string,
    title: string,
    capability: ToolCapability,
    description: string,
    properties: Record<string, JsonSchema>,
    required: readonly string[] = [],
): ToolDefinition {
    return { name, title, kind: "capability", capability, origin: "studio", readOnly: false, commands: ["ai.run"], description, inputSchema: objectOf(properties, required) };
}

export const STUDIO_CAPABILITY_TOOLS: readonly ToolDefinition[] = [
    studioCap("auto_captions", "Auto captions", "audio.transcribe",
        "Transcribes the timeline audio (or one clip or scene) and places one caption text clip per spoken line on a new Captions track.", {
            clip_id: str("Caption only this clip's used range (or scene_id; default: the whole timeline)."),
            scene_id: str("Caption only this main-track clip (scene), by id."),
            language: str("\"auto\" (default) or a language code such as en, th, ja."),
            model: str("Transcription model id offered by the provider, for example tiny, base, or small."),
            style: enumOf(["caption", "subtitle"]),
            engine,
        }),
    studioCap("translate_captions", "Translate captions", "captions.translate",
        "Translates a captions track into another language on a new captions track above it, with the same timings and style. One undo step.", {
            track_index: int("Text track holding the captions."),
            clip_id: str("Any caption clip of the track (instead of track_index)."),
            language: str("Target language code, for example th, ja, zh-TW, pt-BR."),
            keep_source: bool("Keep the original captions track (default true)."),
        }, ["language"]),
    studioCap("isolate_voice", "Isolate voice", "audio.isolate-voice",
        "Removes music and noise from the speech of a clip or scene: the clean voice lands on a new audio track in sync and the original sound is muted. One undo step.", {
            ...item, first_seconds: firstSeconds, accept_max_usd: acceptMaxUsd,
        }),
    studioCap("upscale_video", "Upscale video", "video.upscale",
        "Upscales a video clip or scene to 1080p, 2K, or 4K and stacks the result on a new track above, the original hidden. One undo step.", {
            ...item, resolution: enumOf(["1080p", "2k", "4k"]), first_seconds: firstSeconds, accept_max_usd: acceptMaxUsd,
        }, ["resolution"]),
    studioCap("remove_video_background", "Remove video background", "video.remove-background",
        "Removes the background behind people in a video clip or scene and stacks the cut-out on a new track above, the original hidden. One undo step.", {
            ...item, background: enumOf(["transparent", "green", "blue", "black", "white"], "What replaces the background (default transparent)."), first_seconds: firstSeconds, accept_max_usd: acceptMaxUsd,
        }),
    studioCap("lipsync_clip", "Lip sync", "video.lipsync",
        "Moves the lips in a video clip or scene to follow an audio clip; the synced video stacks above the original. One undo step.", {
            ...item, audio_clip_id: str("Audio clip the lips follow."), first_seconds: firstSeconds, accept_max_usd: acceptMaxUsd,
        }, ["audio_clip_id"]),
    studioCap("split_vocals", "Split vocals", "audio.separate",
        "Splits the sound of a clip or scene into vocals and accompaniment (or vocals, drums, bass, other), one new audio track per stem, the original muted. One undo step.", {
            ...item, stems: enumOf(["vocals", "all"], "\"vocals\" (default): vocals + accompaniment; \"all\": four stems."), first_seconds: firstSeconds, accept_max_usd: acceptMaxUsd,
        }),
    studioCap("stabilize_clip", "Stabilize clip", "media.stabilize",
        "Reduces camera shake in a video clip or scene on this device and stacks the steady copy above the original. One undo step.", item),
];
