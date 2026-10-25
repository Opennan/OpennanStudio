// Generation and analysis tools. Names and argument names follow the OpenNan
// toolset; each one needs a provider capability (spec §5.11). Until providers
// land (phase 8) the server lists them and answers "capability unavailable".
import type { ToolCapability } from "../capabilities";
import { anyObject, arrayOf, bool, enumOf, int, num, objectOf, str, type JsonSchema } from "../json-schema";
import type { ToolDefinition } from "../types";

function cap(
    name: string,
    title: string,
    capability: ToolCapability,
    description: string,
    properties: Record<string, JsonSchema> = {},
    required: readonly string[] = [],
    readOnly = false,
): ToolDefinition {
    return { name, title, kind: "capability", capability, description, inputSchema: objectOf(properties, required), readOnly, origin: "opennan" };
}

const sceneOrder = int("1-based position of the scene in scene order.");
const sceneId = str();
const shotIndex = int("0-based shot index.");
const scene = { scene_order: sceneOrder, scene_id: sceneId };
const shot = { ...scene, shot_index: shotIndex };
const timelinePlacement = { timeline_track_index: int(), timeline_start_time: num() };
/** Phase 9b: the OpenNan project pipelines run after OpenNan prices them; a quote above this refuses. */
export const acceptMaxUsd = { ...num("Highest OpenNan quote, in US dollars, to go ahead with; a higher quote stops before anything is submitted."), minimum: 0 };

/** Tools estimate_cost prices: the editor's AI tools (studio-capability.ts, the local ones answer free) and the generators. */
export const ESTIMATE_TOOLS = [
    "auto_captions", "transcribe_audio", "translate_captions", "isolate_voice", "upscale_video", "remove_video_background", "lipsync_clip", "split_vocals",
    "stabilize_clip", "remove_silences", "remove_filler_words", "detect_beats", "auto_cut_to_beat",
    "generate_quick_image", "generate_video_h3", "generate_tts", "add_music", "generate_sfx",
] as const;

// Tools with commands: ["ai.run"] run the editor's ai.run on the host's providers (phase 7: transcription; phase 8:
// generate_quick_image, generate_video_h3, generate_tts, add_music, generate_sfx).
export const CAPABILITY_TOOLS: readonly ToolDefinition[] = [
    // ── OpenNan story planning, storyboard, consistency, memory, QC (spec §2.1) ──
    cap("manage_character", "Manage characters", "opennan.story.consistency", "Lists, creates, updates, or deletes project characters, their faces and outfits, and their scene assignments.", {
        action: enumOf(["list", "create", "update", "delete", "set_face", "add_outfit", "generate_outfit", "update_outfit", "remove_outfit", "assign_scene_outfit", "bulk_assign_outfits"]),
        character_id: str(), name: str(), description: str(), visual_traits: str(), face_image_url: str(), force: bool(),
        label: str(), image_url: str(), is_default: bool(), outfit_id: str(), gender: str(), regenerate: bool(),
        style: str(), style_directive: str(), scene_order: sceneOrder, assignments: arrayOf(anyObject()),
    }, ["action"]),
    cap("create_story_object", "Create story object", "opennan.story.consistency", "Registers a recurring object with a tag and reference image so it stays consistent across shots.", {
        tag: str(), name: str(), description: str(), reference_image_url: str(),
    }, ["tag", "name"]),
    cap("delete_story_object", "Delete story object", "opennan.story.consistency", "Deletes a registered story object.", { object_id: str() }, ["object_id"]),
    cap("create_story_location", "Create story location", "opennan.story.consistency", "Registers a recurring location with a tag and reference image.", {
        tag: str(), name: str(), description: str(), reference_image_url: str(), is_real_place: bool(),
    }, ["tag", "name"]),
    cap("delete_story_location", "Delete story location", "opennan.story.consistency", "Deletes a registered story location.", { location_id: str() }, ["location_id"]),
    cap("list_resources", "List story resources", "opennan.story.consistency", "Lists reference resources attached to the project.", {
        resource_type: enumOf(["audio", "video", "image", "document", "url"]),
    }, [], true),
    cap("generate_shot_keyframe", "Generate shot keyframe", "opennan.story.consistency", "Generates the start keyframe image of a shot with consistent characters.", shot, ["shot_index"]),
    cap("generate_shot_end_keyframe", "Generate shot end keyframe", "opennan.story.consistency", "Generates the end keyframe image of a shot with consistent characters.", shot, ["shot_index"]),
    cap("run_pipeline", "Run story pipeline", "opennan.story.plan", "Runs the full story pipeline for the project: plan, images, and videos."),
    cap("generate_camera_shots", "Plan camera shots", "opennan.story.plan", "Plans the camera shots of a scene.", { scene_order: sceneOrder, duration: int() }, ["scene_order"]),
    cap("generate_all_camera_shots", "Plan all camera shots", "opennan.story.plan", "Plans the camera shots of every scene."),
    cap("generate_storyboard", "Generate storyboard", "opennan.story.storyboard", "Draws a scene's storyboard on a project stored on OpenNan, one panel per shot. OpenNan quotes it first.", {
        ...scene, regenerate: bool("Draw again over a storyboard the scene already has."), accept_max_usd: acceptMaxUsd,
    }),
    cap("generate_video_from_panels", "Video from storyboard", "opennan.story.storyboard", "Turns the shot panels of a copied scene on a project stored on OpenNan into a new video, shot by shot. OpenNan quotes it first.", {
        ...scene, accept_max_usd: acceptMaxUsd,
    }),
    cap("recrop_storyboard_panels", "Recrop storyboard", "opennan.story.storyboard", "Re-detects and crops the panels of a scene's storyboard sheet.", scene),
    cap("undo_shot_image", "Undo shot image", "opennan.story.storyboard", "Restores the previous image of a shot.", shot, ["shot_index"]),
    cap("set_copy_video_source", "Set copy-video source", "opennan.copy-video", "Makes a scene of a project stored on OpenNan copy an https video, optionally trimmed. No charge.", {
        ...scene, video_url: str("https link of the video to copy (up to 10 minutes)."), trim_start: num("Seconds into the video where the copy starts."), trim_end: num("Seconds into the video where the copy ends."),
    }, ["video_url"]),
    cap("detect_copy_video_shots", "Detect copy-video shots", "opennan.copy-video", "Finds the shots, actions and camera moves of the video a scene of a project stored on OpenNan copies. OpenNan quotes it first.", {
        ...scene, accept_max_usd: acceptMaxUsd,
    }),
    cap("edit_copy_video_shot_image", "Edit copy-video shot image", "opennan.copy-video", "Redraws the panel of one copied shot on a project stored on OpenNan from an instruction. OpenNan quotes it first.", {
        ...shot, instruction: str("What to change in the panel."), accept_max_usd: acceptMaxUsd,
    }, ["shot_index", "instruction"]),
    cap("edit_copy_video_shot_description", "Edit copy-video shot text", "opennan.copy-video", "Rewrites the words for what one copied shot shows on a project stored on OpenNan; its panel stays. No charge.", {
        ...shot, description: str("What the shot shows, in plain words."),
    }, ["shot_index", "description"]),
    cap("detach_scene_audio", "Detach scene audio", "opennan.copy-video", "Moves a copy-video scene's original audio to its own audio clip.", { scene_id: sceneId }),
    cap("reattach_scene_audio", "Reattach scene audio", "opennan.copy-video", "Puts a detached copy-video audio clip back into its scene.", { scene_id: sceneId }),
    cap("generate_scene_videos_smart", "Smart scene videos", "opennan.video.smart-scene", "Renders a scene of a project stored on OpenNan as video, joining shots that belong together. OpenNan quotes it first; dry_run answers with the quote alone.", {
        ...scene, model_id: enumOf(["auto", "seedance-2", "kling-o3", "kling-3"], "Video model (default auto)."), dry_run: bool("Only ask OpenNan for the price."),
        accept_max_usd: acceptMaxUsd,
    }),
    cap("set_video_prompt_overrides", "Set video overrides", "opennan.video.smart-scene", "Sets per-scene style, audio, and lighting overrides for video generation.", {
        scene_order: sceneOrder, style: str(), audio: str(), lighting: str(), directive: str(), visual_style_directive: str(),
    }),
    cap("recall_project_memory", "Recall project memory", "opennan.story.memory", "Returns the notes remembered about this project.", {}, [], true),
    cap("remember_about_project", "Remember note", "opennan.story.memory", "Stores a note about this project for later sessions.", { note: str() }, ["note"]),
    cap("qc_check", "Quality check", "opennan.qc", "Checks scenes for technical and continuity problems.", { scene_order: sceneOrder }, [], true),
    cap("validate_scenes", "Validate scenes", "opennan.qc", "Checks that scenes have what generation needs.", {}, [], true),
    cap("best_take_score", "Score take", "opennan.qc", "Rates the technical quality of a scene's video take.", { scene_order: sceneOrder }, [], true),

    // ── video ──
    cap("generate_video", "Generate scene video", "video.image-to-video", "Generates the video of a scene from its images and description.", {
        scene_order: sceneOrder, duration: int("Seconds."),
    }, ["scene_order"]),
    { ...cap("generate_video_h3", "Generate video", "video.text-to-video", "Generates a video from text, with optional first and last frames.", {
        prompt: str(), seconds: num(), first_frame_url: str(), last_frame_url: str(), seed: int(),
    }, ["prompt"]), commands: ["ai.run"] },
    cap("reference_video_h3", "Video from references", "video.image-to-video", "Generates a video guided by reference images and videos.", {
        prompt: str(), ref_image_urls: arrayOf(str()), ref_video_urls: arrayOf(str()), seconds: num(), seed: int(),
    }, ["prompt"]),
    cap("edit_shot_video_range", "Regenerate video range", "video.edit", "Regenerates a time range of a shot's video from a description.", {
        ...shot, prompt: str(), start_time: num(), end_time: num(), model_id: str(),
    }, ["prompt", "start_time", "end_time"]),
    cap("generate_live_portrait", "Animate portrait", "video.lipsync", "Animates a scene's portrait image to its audio.", { scene_order: sceneOrder }, ["scene_order"]),
    cap("generate_echomimic", "Talking portrait", "video.lipsync", "Makes a scene's portrait speak its audio.", { scene_order: sceneOrder }, ["scene_order"]),
    cap("generate_talking_video", "Talking video", "video.lipsync", "Generates a talking video from a portrait, a voice, and text.", {
        voice_id: str(), text: str(), portrait_image_url: str(), character_id: str(), scene_order: sceneOrder,
    }, ["voice_id", "text", "portrait_image_url"]),
    cap("create_podcast", "Create podcast", "video.lipsync", "Creates a talking-avatar podcast scene from a script.", {
        script: str(), avatar: str(), scene_order: sceneOrder, confirm_avatar_activation: bool(),
    }, ["script"]),
    cap("run_deepfake", "Face swap", "video.face-swap", "Replaces faces in a scene video with project characters.", {
        scene_order: sceneOrder, character_ids: arrayOf(str()),
    }, ["scene_order", "character_ids"]),
    cap("remove_background", "Remove video background", "video.remove-background", "Removes the background behind people in a scene video.", {
        scene_order: sceneOrder, background: enumOf(["transparent", "green", "blue", "black", "white"]),
    }),

    // ── images ──
    cap("generate_images", "Generate scene images", "image.generate", "Generates the start and end images of a scene.", {
        scene_order: sceneOrder, generate_start: bool(), generate_end: bool(), prompt: str(),
    }, ["scene_order"]),
    { ...cap("generate_quick_image", "Generate image", "image.generate", "Generates one image from text.", { prompt: str(), aspect_ratio: str() }, ["prompt"]), commands: ["ai.run"] },
    cap("add_text_to_image", "Add text to image", "image.edit", "Renders text onto an image and returns the new image.", {
        image_url: str(), text: str(), position: str(), font_size: int(), color: str(), bg_color: str(),
    }, ["image_url", "text"]),
    cap("edit_shot_keyframe", "Edit shot keyframe", "image.edit", "Edits a shot's keyframe image from a description.", { ...shot, prompt: str() }, ["shot_index", "prompt"]),
    cap("edit_shot_image", "Edit shot image", "image.edit", "Edits a shot's image from an instruction.", { ...shot, instruction: str() }, ["shot_index", "instruction"]),

    // ── audio ──
    { ...cap("generate_tts", "Text to speech", "audio.tts", "Speaks text with a voice and can place the audio on the timeline.", {
        voice_id: str(), text: str(), provider: str(), stability: num(), similarity_boost: num(), speed: num(),
        scene_order: sceneOrder, ...timelinePlacement,
    }, ["voice_id", "text"]), commands: ["ai.run"] },
    cap("generate_voiceover", "Generate voiceover", "audio.tts", "Generates a character's voiceover line for a scene.", {
        scene_order: sceneOrder, character_name: str(), text: str(),
    }, ["scene_order", "character_name", "text"]),
    cap("list_voices", "List voices", "audio.tts", "Returns the speech provider's voice ids with their names, languages, and genders, for generate_tts.", {
        language: str("Only voices of this language code (en, th, ...)."),
    }, [], true),
    cap("clone_voice", "Clone voice", "audio.voice-clone", "Creates a reusable voice from a voice sample.", { voice_id: str(), provider: str() }, ["voice_id", "provider"]),
    cap("clone_character_voice", "Clone character voice", "audio.voice-clone", "Creates a reusable voice for a character from its audio.", { character_name: str() }, ["character_name"]),
    cap("convert_dialogue_voice", "Convert dialogue voice", "audio.voice-convert", "Converts the dialogue of a scene to another voice.", {
        scene_order: sceneOrder, voice_id: str(), shot_index: shotIndex, speaker_id: str(), timeline_track_index: int(),
    }, ["scene_order", "voice_id"]),
    cap("revoice_shot_dialogue", "Revoice dialogue", "audio.voice-convert", "Re-speaks the dialogue of a scene or shot with another voice.", {
        scene_order: sceneOrder, voice_id: str(), shot_index: shotIndex, speaker_id: str(), timeline_track_index: int(), provider: str(), speed: num(),
    }, ["scene_order", "voice_id"]),
    cap("edit_scene_audio", "Edit scene audio", "audio.voice-convert", "Enhances speech, changes the voice, or splits speakers in a scene's audio.", {
        scene_order: sceneOrder, operation: enumOf(["enhance_speech", "change_voice", "split_by_speaker", "detect_speakers"]), voice_name_or_character: str(),
    }, ["scene_order", "operation"]),
    cap("edit_clip_audio", "Edit clip audio", "audio.voice-convert", "Enhances speech, changes the voice, splits speakers, or separates music in a clip's audio.", {
        clip_id: str(), operation: enumOf(["enhance_speech", "change_voice", "split_by_speaker", "detect_speakers", "separate_music_speech"]), voice_name_or_character: str(),
    }, ["clip_id", "operation"]),
    { ...cap("add_music", "Add music", "audio.music", "Generates music from a description and places it as the project music.", {
        description: str(), instrumental: bool(), replace: bool(),
    }, ["description"]), commands: ["ai.run"] },
    { ...cap("generate_sfx", "Generate sound effect", "audio.sfx", "Creates a short sound clip described in words; it can be placed on the timeline.", {
        description: str(), duration_seconds: num(), scene_order: sceneOrder, ...timelinePlacement,
    }, ["description"]), commands: ["ai.run"] },
    cap("generate_ambient", "Generate ambience", "audio.sfx", "Generates background ambience and can place it on the timeline.", {
        description: str(), preset_id: str(), duration_seconds: num(), scene_order: sceneOrder, ...timelinePlacement, timeline_end_time: num(),
    }),
    cap("generate_video_foley", "Generate foley", "audio.sfx", "Generates sound effects that match a video.", {
        video_url: str(), prompt: str(), negative_prompt: str(), duration: num(),
    }, ["video_url"]),
    cap("separate_audio_stems", "Separate stems", "audio.separate", "Splits audio into vocals, music, and other stems.", { media_url: str() }),
    cap("separate_speakers", "Separate speakers", "audio.separate", "Splits speech audio into one track per speaker.", { media_url: str() }),
    // Runs ai.run (phase 7): real wherever the host routes audio.transcribe to a provider.
    { ...cap("transcribe_audio", "Transcribe audio", "audio.transcribe", "Turns speech into timed text: the whole timeline, or one clip or scene. Runs on this device or in the cloud.", {
        language: str("\"auto\" (default) or a language code such as en, th, ja."),
        engine: enumOf(["local", "cloud"], "\"local\": whisper on this device (desktop); \"cloud\": OpenNan. Default: the editor's routing."),
        clip_id: str("Only this clip's used range (or scene_id; default: the timeline mix)."),
        scene_id: str("Only this main-track clip (scene), by id."),
    }, [], true), commands: ["ai.run"] },
    cap("sync_lyrics_to_timeline", "Sync lyrics", "audio.transcribe", "Transcribes the music and places timed lyric text clips.", {
        style: enumOf(["text", "animated"]), track_index: int(), position: enumOf(["lower_third", "bottom", "center", "top"]),
        font_size: int(), font_color: str(), bg_color: str(), max_words: int(), safe_bottom: int(), clear_existing: bool(),
    }),
    cap("read_video_subtitles", "Read subtitles", "audio.transcribe", "Returns the subtitles or transcript of a video URL.", { url: str() }, ["url"], true),

    // ── media analysis and processing ──
    cap("probe_media", "Probe media", "media.analyze", "Returns duration, size, codecs, and streams of a media URL.", { url: str() }, ["url"], true),
    cap("analyze_video_url", "Analyze video", "media.analyze", "Describes the content and structure of a video URL.", { url: str() }, ["url"], true),
    cap("read_video_deep", "Read video in depth", "media.analyze", "Returns a detailed timed description of a video URL.", { url: str() }, ["url"], true),
    cap("describe_scene_media", "Describe scene media", "media.analyze", "Explains what a scene's pictures or footage show, or answers a question about them.", {
        scene_order: sceneOrder, media: enumOf(["start_image", "end_image", "video", "all_images", "storyboard_panels"]), question: str(), start_time: num(), end_time: num(),
    }, ["scene_order"], true),
    cap("look_at_media", "Look at media", "media.analyze", "Describes frames of a media URL or scene, optionally answering a question.", {
        media_url: str(), scene_order: sceneOrder, question: str(), frames: int(),
    }, [], true),
    cap("describe_image_url", "Describe image", "media.analyze", "Describes an image URL, optionally answering a question.", { url: str(), question: str() }, ["url"], true),
    cap("ask_video_range", "Ask about video range", "media.analyze", "Answers a question about part of one shot's footage, between two times.", { ...shot, prompt: str() }, ["shot_index"], true),
    cap("track_subject", "Track subject", "media.analyze", "Returns the position of the main subject over time in a scene's footage.", { scene_order: sceneOrder }, [], true),
    cap("match_cut_points", "Find match cuts", "media.analyze", "Suggests cut points where two moments of a scene's footage look alike.", { scene_order: sceneOrder }, [], true),
    cap("multicam_sync", "Sync cameras", "media.analyze", "Lines up two recordings of one event by comparing their sound and returns the delay between them.", {
        scene_order_a: sceneOrder, scene_order_b: sceneOrder, url_a: str(), url_b: str(),
    }, [], true),
    cap("transcode_proxy", "Make proxy", "media.process", "Creates a smaller stand-in file of a scene's footage for smoother editing.", { scene_order: sceneOrder, height: int() }),
    cap("compress_video", "Compress video", "media.process", "Makes a smaller copy of a scene video.", { scene_order: sceneOrder, crf: int() }),
    cap("stabilize_video", "Stabilize video", "media.process", "Reduces camera shake in a scene video.", { scene_order: sceneOrder, strength: int() }),
    cap("reframe_video", "Reframe video", "media.process", "Recrops a scene video to another aspect ratio.", {
        scene_order: sceneOrder, aspect: enumOf(["9:16", "1:1", "4:5", "16:9"]),
    }),
    cap("extract_scene_audio", "Extract scene audio", "media.process", "Copies a scene video's audio to its own audio clip.", { scene_order: sceneOrder }, ["scene_order"]),
    cap("cut_source_clip", "Cut source clip", "media.process", "Cuts a time range of a source video into a scene.", {
        scene_order: sceneOrder, start_time: num(), end_time: num(), source_url: str(),
    }, ["scene_order", "start_time", "end_time", "source_url"]),

    // ── web ──
    cap("fetch_url", "Fetch URL", "web.fetch", "Fetches a web page and returns its text.", { url: str() }, ["url"], true),
    cap("capture_website", "Capture website", "web.fetch", "Records or screenshots a website and places it on the timeline.", {
        url: str(), mode: enumOf(["highlights", "walkthrough", "screenshot"]), duration: num(), start_time: num(), label: str(),
    }, ["url"]),
    cap("record_browser", "Record browser", "web.fetch", "Records a scripted browser session and places it on the timeline.", {
        url: str(), steps: arrayOf(anyObject()), start_time: num(), label: str(),
    }, ["url", "steps"]),
    cap("find_stock_footage", "Find stock footage", "web.fetch", "Searches a stock video library by keyword.", { query: str(), count: int() }, ["query"], true),

    // ── graphics ──
    cap("write_custom_graphics", "Write custom graphics", "graphics.generate", "Generates a custom animated graphic from a description and places it on the timeline.", {
        prompt: str(), start_time: num(), end_time: num(), track_index: int(),
    }, ["prompt", "start_time", "end_time"]),
    cap("edit_custom_graphics", "Edit custom graphics", "graphics.generate", "Changes a custom graphic from a change request.", { clip_id: str(), change_request: str() }, ["clip_id", "change_request"]),

    // ── provider jobs ──
    cap("check_generation_status", "Generation status", "provider.jobs", "Reports AI jobs started in this editor: status, progress, stage, cost, refund, and whether a cancel can still stop them. Newest first, or one job.", {
        job_id: str("Job id from an AI tool's answer (jobId); omit for recent jobs."),
    }, [], true),
    cap("estimate_cost", "Estimate cost", "provider.estimate", "Prices one AI tool run on a clip, scene, or captions track before it runs, from the provider's published prices (the figure the editor shows).", {
        tool: enumOf(ESTIMATE_TOOLS, "The AI tool to price."),
        clip_id: str("Clip the tool would run on."),
        scene_id: str("Main-track clip (scene) the tool would run on, by id."),
        track_index: int("Captions text track (translate_captions)."),
        resolution: enumOf(["1080p", "2k", "4k"], "upscale_video tier (default 1080p)."),
        stems: enumOf(["vocals", "all"], "split_vocals stems (default vocals)."),
        language: str("translate_captions target language, or the spoken language."),
        engine: enumOf(["local", "cloud"], "auto_captions / transcribe_audio engine."),
        audio_clip_id: str("lipsync_clip audio clip."),
        first_seconds: { ...num("Price only the first N seconds of the used range."), exclusiveMinimum: 0 },
        duration_seconds: num("Length to generate: generate_video_h3's seconds, generate_sfx's duration (add_music always makes the default length)."),
        first_frame_url: str("generate_video_h3 start image (prices image-to-video)."),
        last_frame_url: str("generate_video_h3 end image."),
        text: str("Text to speak (generate_tts)."),
    }, ["tool"], true),
];
