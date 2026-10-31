// Story film tools (origin "studio"): a consistent-character animated short in a 9:16 reel frame, made shot by shot
// over provider capabilities (@opennan/story-film). The story lives on the project, so every call sees what earlier
// calls (and the editor's wizard) made: a paid step makes only what is missing (ids + redo to remake one), is priced
// first (estimate_only answers the price and runs nothing; a total above accept_max_usd refuses), and records each
// result as project media. Order: story_film_create or story_film_copy, story_film_cast, story_film_frames,
// story_film_animate, story_film_music, story_film_assemble.
import type { ToolCapability } from "../capabilities";
import { anyObject, arrayOf, bool, enumOf, int, num, objectOf, str, type JsonSchema } from "../json-schema";
import type { ToolDefinition } from "../types";

const ids = arrayOf(str(), "Only these character ids (cast) or shot ids (frames, animate). Default: every one not made yet.");
const redo = bool("Make the chosen ids again even though they exist (the old file stays if the new one fails). Needs ids.");
const estimateOnly = bool("Answer the price of the run and run nothing.");
const acceptMaxUsd: JsonSchema = { ...num("Highest total, in US dollars, to go ahead with; a higher estimate stops before anything is sent."), minimum: 0 };
const paid = { ids, redo, estimate_only: estimateOnly, accept_max_usd: acceptMaxUsd };

function storyTool(name: string, title: string, capability: ToolCapability, description: string, properties: Record<string, JsonSchema>, required: readonly string[] = []): ToolDefinition {
    return { name, title, kind: "capability", capability, origin: "studio", readOnly: false, commands: ["ai.run", "project.update"], description, inputSchema: objectOf(properties, required) };
}

const STORY_STEPS_TEXT = "Make it with story_film_cast, story_film_frames, story_film_animate, story_film_music, then story_film_assemble.";

export const STORY_FILM_TOOLS: readonly ToolDefinition[] = [
    {
        name: "story_film_get", title: "Get story film", kind: "read", origin: "studio", readOnly: true, reads: ["snapshot"],
        description: "Returns the project's story film: its story (title, style, characters, shots, music), every sheet, keyframe, clip and the music made so far (project media URLs, marked changed when their text was edited after), what is still missing, and what it has cost.",
        inputSchema: objectOf({}),
    },
    {
        name: "story_film_create", title: "Create story film", kind: "command", origin: "studio", readOnly: false, commands: ["project.update", "ai.run"],
        description: `Sets the project's story film from a story object (title, style, medium, characters [{id, name, look}], shots [{id, cast, frame, motion, seconds}], music), or drafts one from a written story with the provider's story writer (text; priced first). Replaces the story but keeps every file made for characters and shots that keep their ids. ${STORY_STEPS_TEXT}`,
        inputSchema: objectOf({
            story: anyObject("The whole story film (see examples/story-film/rain-check.json). Edit a story by sending it back changed."),
            text: str("A story in your own words, for the story writer to turn into shots (instead of story)."),
            style: str("The art style wanted (with text)."),
            medium: enumOf(["2d", "3d", "stop-motion", "anime"], "How the film is drawn (with text; default 2d)."),
            shots: int("About how many shots (with text)."),
            estimate_only: estimateOnly,
            accept_max_usd: acceptMaxUsd,
        }),
    },
    storyTool("story_film_copy", "Copy a video's story", "text.generate",
        `Drafts a story film from a reference video: the host finds its shots (cut to cut, 2-15 s each), a few frames of each go on one contact sheet to the provider's story writer, which writes one story shot per real shot with the same beats, order and feel. By default the cast and title are original (new character designs and names, safe to publish); cast "keep" only for the person's own video. Only copy a video the person has the rights to. With keep_motion (on by default when the video model takes reference videos) each shot is cut out as a project video and story_film_animate remakes it: the same motion, blocking and camera with the new cast and style. The draft replaces the project's story film and is always shown for editing before anything is drawn. ${STORY_STEPS_TEXT}`, {
            media_url: str("A video in the project (opennan-local://media/…): the host samples its frames (needs the editor or mcp serve --ffmpeg)."),
            video_url: str("A video-site https link (Instagram, TikTok, YouTube…): downloaded into the project first (free), then sampled."),
            sheet_image_url: str("A contact sheet you made of the video's frames (a project image or https link), instead of sampling."),
            frames: int("Frames on the sheet (with sheet_image_url; default 16)."),
            every_seconds: num("Seconds between the sheet's frames (with sheet_image_url)."),
            duration_seconds: num("The video's length in seconds (with sheet_image_url)."),
            shots: arrayOf(objectOf({ start: num("Seconds into the video."), end: num("Seconds into the video.") }, ["start", "end"]), "The video's real shots in order (with sheet_image_url, when this host cannot find them): each story shot is placed on one, so it can be remade from it."),
            keep_motion: bool("Remake each shot from the real shot (its clip as a reference video: the same motion, blocking and camera). Default: on when the video model takes reference videos. Each shot's seconds of reference video are billed with its clip."),
            cast: enumOf(["original", "keep"], "original (default): a new cast and title that keep the beats. keep: the people as they are, for your own video only."),
            notes: str("What the video is about, or what to change."),
            estimate_only: estimateOnly,
            accept_max_usd: acceptMaxUsd,
        }),
    storyTool("story_film_cast", "Draw the cast", "image.generate",
        "Draws one character design sheet per character (16:9, 2K, no references) and stores each on the story. Review them before drawing keyframes; redo one with ids + redo.", paid),
    storyTool("story_film_frames", "Draw the keyframes", "image.generate",
        "Draws one 16:9 keyframe per shot, in order, each from the shot's cast sheets (in cast order) and the previous shot's keyframe (the style anchor), and stores each on the story. Needs every cast sheet. A failure stops at that shot (later shots anchor on it). The cast check looks at each new keyframe beside its cast's sheets (hair, outfit, colours) and redraws it once with the look restated when a character is off; a shot still off is kept and listed as flagged. Review every keyframe before animating, flagged ones first; redo one with ids + redo.", {
            ...paid,
            cast_check: { ...int("Redraws a keyframe gets when the cast check finds a character off their sheet (default 1, at most 3); 0 turns the check off. The estimate counts every check and every possible redraw."), minimum: 0, maximum: 3 },
        }),
    storyTool("story_film_animate", "Animate the shots", "video.image-to-video",
        "Animates each shot from its keyframe (the first frame) for the shot's seconds, 16:9, without sound, two at a time, and stores each clip on the story. The motion text must match what the keyframe shows. A story copied from a video with keep_motion is remade instead when the model takes reference videos: each shot's original clip is the reference video (@Video1), its cast sheets then its keyframe are the images, and the clip keeps the real shot's motion, blocking and camera; the reference seconds are billed too (the estimate counts them). Default model seedance-2-5 at 720p (seedance-2-mini when seedance-2-5 is not listed; it takes no reference videos, so shots animate from their keyframes).", {
            ...paid,
            keep_motion: bool("A copied story: remake each shot from its real shot (true) or animate from its keyframe (false). Kept on the story."),
            model: str("Image-to-video model the provider lists (default seedance-2-5, else seedance-2-mini): kept on the story for later shots."),
            quality: str("Quality the model offers, such as 720p or 1080p (default 720p)."),
        }),
    storyTool("story_film_music", "Make the music", "audio.music",
        "Makes one instrumental music bed the film's length from the story's music text and stores it on the story.", { redo, estimate_only: estimateOnly, accept_max_usd: acceptMaxUsd }),
    {
        name: "story_film_assemble", title: "Put the story film on the timeline", kind: "command", origin: "studio", readOnly: false,
        commands: ["project.update", "scene.add", "scene.update", "scene.delete", "clip.create", "clip.delete"],
        description: "Puts the story film on the timeline with the reel layout: a 9:16 canvas, every shot's clip on V1 fitted into a 16:9 film in the middle, the title above it, the music faded in and out under it. Placing it again replaces the earlier placement. Needs every shot's clip.",
        inputSchema: objectOf({}),
    },
    {
        name: "apply_reel_layout", title: "Apply reel layout", kind: "command", origin: "studio", readOnly: false,
        commands: ["project.update", "scene.add", "scene.update", "clip.create"],
        description: "Lays out a reel: a 9:16 canvas, the given 16:9 clips end to end on V1 fitted in the middle (1080x608 at y 656 of 1080x1920), a bold white title 34 px above the film, and optional music faded in 0.5 s and out 2.5 s. Each clip is a project video and its length.",
        inputSchema: objectOf({
            title: str("The title above the film (at most 80 characters)."),
            clips: arrayOf(objectOf({ media_url: str("Project video URL."), duration_seconds: num("Its length on the timeline."), label: str() }, ["media_url", "duration_seconds"]), "The film's clips in order."),
            music_url: str("A project audio file to put under the film."),
            music_duration_seconds: num("The music file's length."),
        }, ["title", "clips"]),
    },
];
