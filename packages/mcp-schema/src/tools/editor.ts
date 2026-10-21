// Offline editor tools: names from the OpenNan toolset, arguments in its
// snake_case style, field types taken from the generated timeline-core schemas.
import {
    anyObject, arrayOf, bool, editorCommandTypes, editorType, enumOf, int, num, objectOf, snakeProperties, str, toSnakeCase,
    type JsonSchema,
} from "../json-schema";
import type { ToolDefinition } from "../types";

const CLIP = editorType("TimelineClip");
const SCENE = editorType("SceneData");
const TRACK = editorType("TimelineTrack");

/** A generated field as a tool argument: the same type without null (an agent omits the argument instead). */
function nonNull(schema: JsonSchema): JsonSchema {
    if (!Array.isArray(schema.type)) return schema;
    const types = (schema.type as string[]).filter((type) => type !== "null");
    return { ...schema, type: types.length === 1 ? types[0] : types };
}

/** Generated fields of `source` as snake_case arguments without null. */
function modelFields(source: JsonSchema, keys: readonly string[], notes: Readonly<Record<string, string>> = {}): Record<string, JsonSchema> {
    return Object.fromEntries(Object.entries(snakeProperties(source, keys, notes)).map(([key, schema]) => [key, nonNull(schema)]));
}

/** Arguments narrower than their model field (an enum for a string field); the field must still exist on the type. */
function narrowed(source: JsonSchema, overrides: Readonly<Record<string, JsonSchema>>): Record<string, JsonSchema> {
    snakeProperties(source, Object.keys(overrides));
    return Object.fromEntries(Object.entries(overrides).map(([key, schema]) => [toSnakeCase(key), schema]));
}

export const CLIP_PLACEMENT_FIELDS = ["trackType", "trackIndex", "startTime", "endTime", "trimStart", "trimEnd"] as const;
export const CLIP_CONTENT_FIELDS = ["mediaUrl", "mediaType", "label", "thumbnailUrl", "textContent", "textStyle", "locked"] as const;
export const CLIP_LOOK_FIELDS = [
    "volume", "audioPan", "audioPitch", "audioEq", "audioDenoise", "audioNormalize",
    "playbackSpeed", "speedRamp", "reversePlayback", "freezeFrame",
    "fadeInDuration", "fadeOutDuration", "transitionType", "transitionDuration",
    "opacity", "scale", "positionX", "positionY", "horizontalFlip", "verticalFlip",
    "cropLeft", "cropRight", "cropTop", "cropBottom",
    "brightness", "contrast", "saturation", "visualFilter", "motionPreset", "blurStrength",
    "chromaKeyEnabled", "chromaKeyColor", "chromaKeySimilarity", "chromaKeyBlend",
    "blendMode", "mosaicStrength", "rotationDegrees", "keyframesJson",
] as const;

/** edit_timeline_clip font arguments -> keys the preview and the exporter read from textStyle (timeline-core lib/preview-text-draw.ts). */
export const TEXT_STYLE_ARGUMENTS = {
    font_size: "fontSize",
    font_color: "color",
    font_family: "fontFamily",
    bold: "fontWeight",
    italic: "fontStyle",
    stroke_width: "strokeWidth",
    stroke_color: "strokeColor",
    background_color: "bgColor",
} as const;

const FIELD_NOTES: Record<string, string> = {
    track_type: "Track kind: video, audio, text, sticker, effect, or remotion.",
    track_index: "1-based track number within its kind.",
    start_time: "Timeline seconds where the clip starts.",
    end_time: "Timeline seconds where the clip ends.",
    trim_start: "Source in-point in seconds.",
    trim_end: "Source out-point in seconds.",
    text_style: "Text style as a JSON string; the font_* arguments edit it field by field.",
    position_x: "Horizontal center as a fraction of the frame width (0-1).",
    position_y: "Vertical center as a fraction of the frame height (0-1).",
    keyframes_json: "Keyframes as a JSON string.",
    volume: "Linear gain, 1 = unchanged.",
};

const clipFields = (keys: readonly string[]) => snakeProperties(CLIP, keys, FIELD_NOTES);

const textStyleProperties: Record<string, JsonSchema> = {
    font_size: num("Font size in export pixels."),
    font_color: str("CSS color of the text."),
    font_family: str(),
    bold: bool(),
    italic: bool(),
    stroke_width: num(),
    stroke_color: str(),
    background_color: str("CSS color behind the text."),
};

const SCENE_ORDER = int("1-based position of the scene in scene order.");
const SHOT_INDEX = int("0-based index of the shot in the scene's shot list.");
const TRACK_KINDS = ["video", "audio", "text", "sticker"] as const;
/** "none" plus the 25 library transitions (timeline-core lib/timeline-editing-navigation.ts TIMELINE_TRANSITION_TYPES). */
export const VISUAL_TRANSITIONS = [
    "none", "cross_dissolve", "dip_black", "dip_white", "flash", "luma_fade", "slide_left", "slide_right", "slide_up", "slide_down",
    "push_left", "push_right", "wipe_left", "wipe_right", "wipe_up", "wipe_down", "circle_open", "clock_wipe", "zoom_in", "zoom_out",
    "spin", "blur_dissolve", "glitch", "swirl", "pixelate", "ripple",
] as const;
/** "none" plus the 30 filter presets (timeline-core looks/filters.ts). */
export const FILTER_IDS = [
    "none", "fresh", "warm", "cool", "soft", "bright", "cinematic", "teal_orange", "blockbuster", "moody", "bleach_bypass",
    "vintage", "instant", "faded", "seventies", "cross_process", "mono", "noir", "silver", "selenium", "blue_tone",
    "delicious", "crisp", "honey", "fresh_greens", "rich", "vivid", "golden_hour", "lush", "azure", "desert",
] as const;
/** The 13 Adjust controls (timeline-core looks/adjust.ts), as the editor shows them: -100..100 (0..100 for the last four). */
export const ADJUSTMENT_ARGUMENTS = [
    "brightness", "contrast", "saturation", "exposure", "temperature", "tint", "highlights", "shadows", "vibrance",
    "fade", "sharpen", "vignette", "grain",
] as const;
const LOOK_TARGET = {
    clip_id: str("Target layer clip (video or sticker)."),
    scene_order: int("Target main-track clip: 1-based position of the scene in scene order."),
};
/** The 20 text templates and their categories (timeline-core text/templates.ts); mcp handlers/motion.test.ts keeps them in sync. */
export const TEXT_TEMPLATE_IDS = [
    "plain", "title_bold", "subtitle_clean", "lower_third", "caption_pill", "tiktok_bold", "yellow_pop", "boxed_white",
    "neon_pink", "neon_cyan", "soft_glow", "outline_thick", "drop_shadow", "long_shadow", "gradient_sunset", "gradient_ocean",
    "handwritten_caveat", "script_dancing", "poster_bebas", "comic_bangers",
] as const;
export const TEXT_TEMPLATE_CATEGORIES = ["basic", "social", "neon", "outline", "gradient", "handwritten", "display"] as const;
/** The 12 bundled font families (timeline-core text/fonts.ts). */
export const TEXT_FONT_FAMILIES = [
    "Inter", "Montserrat", "Poppins", "Bebas Neue", "Anton", "Oswald", "Playfair Display", "Lobster", "Pacifico", "Caveat",
    "Dancing Script", "Bangers",
] as const;
/** The 8 caption styles (timeline-core text/captions.ts). */
export const CAPTION_STYLE_IDS = ["classic", "pill", "bold_yellow", "boxed", "neon", "minimal", "karaoke_highlight", "karaoke_box"] as const;
/** Sticker categories (timeline-core stickers/catalog.ts). */
export const STICKER_CATEGORY_IDS = [
    "arrows", "shapes", "callouts", "badges", "sparkles", "marks",
    "emoji-faces", "emoji-hands", "emoji-symbols", "emoji-celebration", "emoji-things",
] as const;
/** Keyframe easings (timeline-core motion/easing.ts). */
export const EASING_IDS = ["linear", "ease_in", "ease_out", "ease_in_out", "hold", "bezier"] as const;
/** Mask keyframe channels (timeline-core looks/masks.ts MASK_KEYFRAME_CHANNELS). */
export const MASK_KEYFRAME_CHANNELS = ["mask_x", "mask_y", "mask_w", "mask_h", "mask_rotation", "mask_feather"] as const;
/** Keyframe channels: timeline-core motion/keyframes.ts KEYFRAME_CHANNELS, then the mask channels. */
export const KEYFRAME_CHANNELS = [
    "position_x", "position_y", "scale", "rotation_degrees", "opacity", "volume", "filter_intensity",
    "adj_brightness", "adj_contrast", "adj_saturation", "adj_exposure", "adj_temperature", "adj_tint",
    "adj_highlights", "adj_shadows", "adj_vibrance", "adj_fade",
    ...MASK_KEYFRAME_CHANNELS,
] as const;
/** "none" plus the mask shapes (timeline-core looks/masks.ts MASK_SHAPES). */
export const MASK_SHAPE_IDS = ["none", "linear", "mirror", "circle", "rectangle", "heart", "star"] as const;
/** Kinds paste_attributes copies (timeline-core attributes/attributes.ts ATTRIBUTE_KINDS). */
export const ATTRIBUTE_KINDS = ["filter", "adjust", "effects", "animation", "speed", "mask", "transform"] as const;
/** "none" plus the speed curve presets (timeline-core motion/speed.ts SPEED_CURVE_PRESETS). */
export const SPEED_CURVE_IDS = ["none", "montage", "hero", "bullet", "jump_cut", "flash_in", "flash_out"] as const;
/** set_text_style arguments -> textStyle keys (timeline-core lib/preview-text-draw.ts); gradient_* fill the `gradient` object. */
export const TEXT_STYLE_KEYS = {
    font_family: "fontFamily",
    font_size: "fontSize",
    font_weight: "fontWeight",
    color: "color",
    stroke_color: "strokeColor",
    stroke_width: "strokeWidth",
    shadow_color: "shadowColor",
    shadow_blur: "shadowBlur",
    shadow_offset_x: "shadowOffsetX",
    shadow_offset_y: "shadowOffsetY",
    glow_color: "glowColor",
    glow_size: "glowSize",
    background_color: "bgColor",
    background_padding: "bgPadding",
    background_radius: "bgRadius",
    text_align: "textAlign",
    letter_spacing: "letterSpacing",
    line_height: "lineHeight",
} as const;

/**
 * Numeric bounds of the set_text_style sizes (reference pixels on a 1080-tall frame; line_height a multiple of
 * the font size). The caps keep a style from blowing up the text bitmap (the export rasterizer clamps too); the
 * MCP handler enforces the same bounds.
 */
export const TEXT_STYLE_LIMITS = {
    font_size: { minimum: 1, maximum: 400 },
    font_weight: { minimum: 100, maximum: 900 },
    stroke_width: { minimum: 0, maximum: 100 },
    shadow_blur: { minimum: 0, maximum: 200 },
    glow_size: { minimum: 0, maximum: 200 },
    background_padding: { minimum: 0, maximum: 200 },
    background_radius: { minimum: 0, maximum: 10000 },
    letter_spacing: { minimum: -100, maximum: 200 },
    line_height: { minimum: 0.5, maximum: 4 },
} as const satisfies Partial<Record<keyof typeof TEXT_STYLE_KEYS, { minimum: number; maximum: number }>>;

/** A set_text_style argument: the value or null (null removes the key, back to the default look). */
const nullable = (schema: JsonSchema): JsonSchema => {
    const out: JsonSchema = { ...schema, type: [schema.type as string, "null"] };
    if (Array.isArray(schema.enum)) out.enum = [...schema.enum, null];
    return out;
};
const ranged = (schema: JsonSchema, limit: { minimum: number; maximum: number }): JsonSchema => ({ ...schema, minimum: limit.minimum, maximum: limit.maximum });
const L = TEXT_STYLE_LIMITS;
const COLOR = "CSS color: #rgb, #rrggbb, #rrggbbaa, rgb()/rgba()/hsl()/hsla() with numbers, or a basic color name";

const textStyleSetProperties: Record<string, JsonSchema> = {
    font_family: nullable(enumOf(TEXT_FONT_FAMILIES, "A bundled font family.")),
    font_size: nullable(ranged(num("Reference pixels on a 1080-tall frame (1 to 400)."), L.font_size)),
    font_weight: nullable(ranged(int("100 to 900."), L.font_weight)),
    color: nullable(str(`${COLOR} of the text.`)),
    stroke_color: nullable(str(`${COLOR}.`)),
    stroke_width: nullable(ranged(num("Outline width in reference pixels (0 to 100)."), L.stroke_width)),
    shadow_color: nullable(str(`${COLOR}.`)),
    shadow_blur: nullable(ranged(num("Reference pixels (0 to 200)."), L.shadow_blur)),
    shadow_offset_x: nullable(num("Reference pixels.")),
    shadow_offset_y: nullable(num("Reference pixels.")),
    glow_color: nullable(str(`${COLOR}.`)),
    glow_size: nullable(ranged(num("Glow blur in reference pixels (0 to 200)."), L.glow_size)),
    background_color: nullable(str(`${COLOR} of the box behind the text.`)),
    background_padding: nullable(ranged(num("Box padding in reference pixels (0 to 200)."), L.background_padding)),
    background_radius: nullable(ranged(num("Box corner radius in reference pixels."), L.background_radius)),
    gradient_from: nullable(str(`Gradient fill start color (${COLOR}); with gradient_to it replaces the solid color. null removes the gradient.`)),
    gradient_to: nullable(str("Gradient fill end color.")),
    gradient_angle: nullable(num("Degrees: 0 = left to right, 90 = top to bottom (default 90).")),
    text_align: nullable(enumOf(["left", "center", "right"])),
    letter_spacing: nullable(ranged(num("Reference pixels between letters (-100 to 200)."), L.letter_spacing)),
    line_height: nullable(ranged(num("Multiple of the font size (0.5 to 4)."), L.line_height)),
};

/** clip_id or scene_order targets of the motion tools. */
const MOTION_TARGET = {
    clip_id: str("Target clip."),
    scene_order: int("Target main-track clip: 1-based position of the scene in scene order."),
};
const ITEM_TIME = num("Item-local seconds (0 = the start of the clip or scene).");
const KEYFRAME_VALUES = {
    type: "object",
    description: "Channel values. Clip position_x/y 0-1 of the frame; scene position_x/y percent offset; scale factor; rotation_degrees; opacity, filter_intensity 0-1; volume factor; adj_* -1 to 1; mask_* as in set_mask.",
    properties: Object.fromEntries(KEYFRAME_CHANNELS.map((channel) => [channel, num()])),
    additionalProperties: false,
} as JsonSchema;
const KEYFRAME_CHANNEL_LIST = (description: string): JsonSchema => ({ ...arrayOf(enumOf(KEYFRAME_CHANNELS), description), minItems: 1 });
const ranged01 = (description: string): JsonSchema => ({ ...num(description), minimum: 0, maximum: 1 });
/** set_mask fields in the mask model's units and ranges (timeline-core looks/masks.ts). */
const MASK_FIELDS: Record<string, JsonSchema> = {
    x: { ...num("Mask center, fraction of the item's width (0.5 = center; -2 to 3)."), minimum: -2, maximum: 3 },
    y: { ...num("Mask center, fraction of the item's height (0.5 = center; -2 to 3)."), minimum: -2, maximum: 3 },
    width: { ...num("Mask width in units of the item's shorter side (0.01 to 5); the band thickness of mirror."), minimum: 0.01, maximum: 5 },
    height: { ...num("Mask height in units of the item's shorter side (0.01 to 5)."), minimum: 0.01, maximum: 5 },
    rotation: { ...num("Degrees clockwise about the mask center (-3600 to 3600)."), minimum: -3600, maximum: 3600 },
    feather: ranged01("Edge softness, 0 (hard) to 1."),
    roundness: ranged01("Rectangle corner rounding, 0 to 1."),
    invert: bool("Keep what is outside the shape instead of inside."),
};
const BEZIER = { ...arrayOf(num(), "Cubic bezier handles [x1, y1, x2, y2] for easing bezier (x in 0-1)."), minItems: 4, maxItems: 4 };
const CURVE_POINT = { ...arrayOf(num()), minItems: 2, maxItems: 2 };

const CARD_TYPES = ["ai_video", "copy_video", "image", "live_portrait", "source_clip", "podcast"] as const;
/** Shot durations: seconds as a number, or as the string OpenNan shot lists store ("3"). anyOf, not a type union (registry.test.ts lint). */
const SHOT_SECONDS = (description?: string): JsonSchema => ({ anyOf: [{ type: "number" }, { type: "string" }], ...(description ? { description } : {}) });
const SHOT_ITEM = objectOf({ prompt: str(), duration: SHOT_SECONDS(), speech: str() }, ["prompt", "duration"]);

/** Scene fields that only OpenNan story planning can act on (spec §2.1). */
export const SCENE_PLANNING_FIELDS = [
    "start_frame_prompt", "end_frame_prompt", "video_motion_prompt", "scene_location",
    "character_ids", "video_generation_mode", "outfits", "objects_in_scene", "auto_generate_audio",
] as const;

const planningProperties: Record<string, JsonSchema> = {
    start_frame_prompt: str(),
    end_frame_prompt: str(),
    video_motion_prompt: str(),
    scene_location: str(),
    character_ids: arrayOf(str()),
    video_generation_mode: str(),
    outfits: anyObject(),
    objects_in_scene: arrayOf(str()),
    auto_generate_audio: bool(),
};

const sceneProperties: Record<string, JsonSchema> = {
    ...modelFields(SCENE, ["caption", "duration", "sourceVideoUrl", "startImageUrl", "audioText"], { duration: "Scene length in seconds." }),
    ...narrowed(SCENE, { cardType: enumOf(CARD_TYPES), transition: enumOf(["cut", "continue"]) }),
    // SceneData.shotBreakdown is a JSON string; the tool takes the list and the handler serializes it.
    ...narrowed(SCENE, { shotBreakdown: arrayOf(SHOT_ITEM) }),
};

function tool(definition: ToolDefinition): ToolDefinition {
    return definition;
}

export const EDITOR_TOOLS: readonly ToolDefinition[] = [
    // ── read ─────────────────────────────────────────────
    tool({
        name: "read_timeline", title: "Read timeline", kind: "read", origin: "opennan", readOnly: true,
        reads: ["snapshot", "describeTimeline"],
        description: "Returns the project, tracks, scenes, and clips of the open timeline. Filters by scene or time range; media URLs are left out unless asked for.",
        inputSchema: objectOf({
            scene_order: SCENE_ORDER,
            start_time: num("Only items that overlap this range (timeline seconds)."),
            end_time: num(),
            include_media_urls: bool(),
            max_items: int("Maximum clips and scenes returned (default 200)."),
        }),
    }),
    tool({
        name: "find_clip", title: "Find clips", kind: "read", origin: "opennan", readOnly: true, reads: ["snapshot"],
        description: "Searches the timeline and returns the ids of clips that match the given track, times, label, or text.",
        inputSchema: objectOf({
            track_type: enumOf(TRACK_KINDS),
            track_index: int(),
            start_time: num(),
            end_time: num(),
            label: str("Case-insensitive substring of the clip label."),
            text_contains: str("Case-insensitive substring of the clip text."),
        }),
    }),
    tool({
        name: "client_get_ui_state", title: "Get editor state", kind: "read", origin: "opennan", readOnly: true, reads: ["uiState"],
        description: "Returns the playhead time, playback state, selection, zoom, tool, and markers of the editor.",
        inputSchema: objectOf({}),
    }),
    tool({
        name: "preview_timeline_frame", title: "Preview frame", kind: "read", origin: "opennan", readOnly: true,
        reads: ["previewFrame", "snapshot"],
        description: "Renders the composed frame at a timeline time and lists the clips and scenes visible there. Without a frame renderer only the list is returned.",
        inputSchema: objectOf({ time_seconds: num("Timeline seconds."), width: { ...int("Frame width in pixels."), minimum: 2, maximum: 3840 }, height: { ...int("Frame height in pixels."), minimum: 2, maximum: 3840 } }, ["time_seconds"]),
    }),
    tool({
        name: "list_media", title: "List media", kind: "read", origin: "opennan", readOnly: true, reads: ["snapshot"],
        description: "Lists the media URLs used by clips and scenes of the project.",
        inputSchema: objectOf({
            media_type: enumOf(["video", "audio", "image", "all"]),
            search: str("Case-insensitive substring of the URL or label."),
            limit: int(),
        }),
    }),
    tool({
        name: "archive_project", title: "Archive manifest", kind: "read", origin: "opennan", readOnly: true, reads: ["snapshot"],
        description: "Returns a manifest of every media file the project uses, with where each one is used.",
        inputSchema: objectOf({}),
    }),
    tool({
        name: "list_visual_effects", title: "List effects", kind: "read", origin: "opennan", readOnly: true, reads: ["listEffects"],
        description: "Lists the visual effects that can be applied to clips, with their parameters.",
        inputSchema: objectOf({}),
    }),

    // ── clips ────────────────────────────────────────────
    tool({
        name: "create_timeline_clip", title: "Create clip", kind: "command", origin: "opennan", readOnly: false,
        commands: ["clip.create"],
        description: "Creates one clip on a track (video, audio, text, or sticker) with optional media, text, and look settings.",
        inputSchema: objectOf({
            ...clipFields(CLIP_PLACEMENT_FIELDS),
            track_type: enumOf(TRACK_KINDS, FIELD_NOTES.track_type),
            ...clipFields(CLIP_CONTENT_FIELDS),
            ...clipFields(CLIP_LOOK_FIELDS),
        }, ["track_type", "track_index", "start_time", "end_time"]),
    }),
    tool({
        name: "edit_timeline_clip", title: "Edit clip", kind: "command", origin: "opennan", readOnly: false,
        commands: ["clip.update"],
        description: "Changes fields of one clip: timing, trims, track, media, text, font, audio, speed, transitions, and look. A trim change without new times also shortens or lengthens the clip on the timeline.",
        inputSchema: objectOf({
            clip_id: str(),
            ...clipFields(CLIP_PLACEMENT_FIELDS),
            ...clipFields(CLIP_CONTENT_FIELDS),
            ...clipFields(CLIP_LOOK_FIELDS),
            ...textStyleProperties,
        }, ["clip_id"]),
    }),
    tool({
        name: "delete_timeline_clip", title: "Delete clip", kind: "command", origin: "opennan", readOnly: false, destructive: true,
        commands: ["clip.delete"],
        description: "Deletes one clip from the timeline. Undoable.",
        inputSchema: objectOf({ clip_id: str() }, ["clip_id"]),
    }),
    tool({
        name: "split_timeline_clip", title: "Split clip", kind: "command", origin: "opennan", readOnly: false,
        commands: ["clip.split"],
        description: "Splits one clip in two at a timeline time inside it and returns the id of the new right part.",
        inputSchema: objectOf({ clip_id: str(), at_time: num("Timeline seconds, strictly inside the clip.") }, ["clip_id", "at_time"]),
    }),
    tool({
        name: "add_text_overlay", title: "Add text", kind: "command", origin: "opennan", readOnly: false,
        commands: ["clip.create"],
        description: "Adds a text clip on a text track with font size, color, and placement.",
        inputSchema: objectOf({
            text: str(),
            start_time: num(),
            end_time: num(),
            track_index: int("Text track number (default: the first free text track)."),
            font_size: num(),
            font_color: str(),
            position: enumOf(["center", "top", "bottom", "lower_third"], "Vertical placement when position_y is not set."),
            ...clipFields(["opacity", "scale", "positionX", "positionY", "fadeInDuration", "fadeOutDuration", "transitionType", "transitionDuration", "rotationDegrees"]),
            transition_type: enumOf(VISUAL_TRANSITIONS),
        }, ["text", "start_time", "end_time"]),
    }),
    tool({
        name: "add_audio_layer", title: "Add scene audio", kind: "command", origin: "opennan", readOnly: false,
        commands: ["clip.create"], reads: ["snapshot"],
        description: "Places an audio URL as an audio clip aligned to a scene, on the first audio track that is free for that range.",
        inputSchema: objectOf({
            scene_order: SCENE_ORDER,
            type: enumOf(["voiceover", "sfx", "ambient"], "Used as the clip label."),
            url: str(),
            volume: num(),
            offset: num("Seconds after the scene start (default 0)."),
        }, ["scene_order", "type", "url"]),
    }),
    tool({
        name: "publish_audio_to_timeline", title: "Publish local audio", kind: "command", origin: "opennan", readOnly: false,
        commands: ["clip.create"],
        description: "Imports a local audio file into the project media and places it on an audio track.",
        inputSchema: objectOf({
            local_path: str("Path inside the project folder (or a folder the host allows)."),
            start_time: num("Timeline seconds (default 0)."),
            duration: num("Clip length in seconds."),
            track_index: int("Audio track number (default: the first free audio track)."),
            label: str(),
        }, ["local_path", "duration"]),
    }),
    tool({
        name: "publish_video_to_timeline", title: "Publish local video", kind: "command", origin: "opennan", readOnly: false,
        commands: ["clip.create"],
        description: "Imports a local video file into the project media and places it on a video overlay track.",
        inputSchema: objectOf({
            local_path: str("Path inside the project folder (or a folder the host allows)."),
            start_time: num(),
            duration: num("Clip length in seconds."),
            track_index: int("Video track number (default: the first free track from 2; track 1 holds scenes)."),
            label: str(),
        }, ["local_path", "start_time", "duration"]),
    }),
    tool({
        name: "add_graphics_clip", title: "Add graphics clip", kind: "command", origin: "opennan", readOnly: false,
        commands: ["clip.create"],
        description: "Places one of the built-in graphics (list_graphics_templates names them) with its props on a graphics track; it draws in the preview and in both export engines.",
        inputSchema: objectOf({
            template_id: str("Which built-in graphic (see list_graphics_templates)."),
            props: anyObject("Template props (missing ones take the template's defaults)."),
            start_time: num(),
            end_time: num(),
            track_index: int("Graphics track number (default: the first free graphics track)."),
        }, ["template_id", "start_time", "end_time"]),
    }),
    tool({
        name: "list_graphics_templates", title: "List graphics templates", kind: "read", origin: "opennan", readOnly: true, reads: ["motionCatalog"],
        description: "Returns the built-in graphics (lower thirds, titles, charts, callouts, social, shapes): id, name, category, and each prop with its type and default.",
        inputSchema: objectOf({ category: str("Only this category (text, data, callout, social, shape, scene, brand, utility).") }),
    }),
    tool({
        name: "update_graphics_clip", title: "Update graphics clip", kind: "command", origin: "opennan", readOnly: false,
        commands: ["clip.update"],
        description: "Changes the props, timing, or track of a template graphics clip.",
        inputSchema: objectOf({
            clip_id: str(),
            props: anyObject("Props merged over the current ones."),
            start_time: num(),
            end_time: num(),
            track_index: int(),
        }, ["clip_id"]),
    }),
    tool({
        name: "apply_visual_effect", title: "Apply effect", kind: "command", origin: "opennan", readOnly: false,
        commands: ["clip.effect.add", "clip.create", "track.update"], reads: ["snapshot", "listEffects"],
        description: "Adds a visual effect from list_visual_effects to a clip's or scene's effect stack, or as an effect layer over a time range, with optional parameter values.",
        inputSchema: objectOf({
            effect_id: str(),
            clip_id: str("Target clip (its own effect stack)."),
            scene_order: SCENE_ORDER,
            start_time: num("With end_time and no target: an effect layer over this range of the composite."),
            end_time: num(),
            params: anyObject("Parameter values by key."),
        }, ["effect_id"]),
    }),
    tool({
        name: "remove_visual_effect", title: "Remove effect", kind: "command", origin: "opennan", readOnly: false,
        commands: ["clip.effect.update", "clip.effect.remove"], reads: ["snapshot"],
        description: "Turns off a visual effect on a clip or scene (the row stays and can be turned on again), or deletes the row with delete: true.",
        inputSchema: objectOf({
            effect_id: str("Effect id or effect row id."),
            clip_id: str("Target clip."),
            scene_order: SCENE_ORDER,
            delete: bool("Remove the row from the stack instead of turning it off."),
        }, ["effect_id"]),
    }),

    // ── scenes and shots ─────────────────────────────────
    tool({
        name: "create_scenes", title: "Create scenes", kind: "command", origin: "opennan", readOnly: false,
        commands: ["scene.add", "scene.update", "scene.delete"],
        capabilityFields: { fields: SCENE_PLANNING_FIELDS.map((f) => `scenes[].${f}`), capability: "opennan.story.plan" },
        description: "Appends scenes with captions, durations, media, and shot lists. replace_existing deletes the current scenes first.",
        inputSchema: objectOf({
            replace_existing: bool(),
            scenes: arrayOf(objectOf({
                ...sceneProperties,
                video_url: str(),
                source_url: str("Source video of a source-clip scene."),
                source_start_time: num("Source in-point in seconds."),
                source_end_time: num("Source out-point in seconds."),
                ...planningProperties,
            })),
        }, ["scenes"]),
    }),
    tool({
        name: "update_scene", title: "Update scene", kind: "command", origin: "opennan", readOnly: false,
        commands: ["scene.update", "scene.trim"],
        capabilityFields: { fields: SCENE_PLANNING_FIELDS, capability: "opennan.story.plan" },
        description: "Changes a scene's caption, media, transitions, duration, audio text, or shot list.",
        inputSchema: objectOf({
            scene_order: SCENE_ORDER,
            ...sceneProperties,
            ...narrowed(SCENE, { visualTransition: enumOf(VISUAL_TRANSITIONS) }),
            ...modelFields(SCENE, ["visualTransitionDuration"]),
            ...planningProperties,
        }, ["scene_order"]),
    }),
    tool({
        name: "delete_scenes", title: "Delete scenes", kind: "command", origin: "opennan", readOnly: false, destructive: true,
        commands: ["scene.delete"],
        description: "Deletes scenes by scene order. Undoable.",
        inputSchema: objectOf({ scene_orders: arrayOf(int()) }, ["scene_orders"]),
    }),
    tool({
        name: "reorder_scenes", title: "Reorder scenes", kind: "command", origin: "opennan", readOnly: false,
        commands: ["scene.reorder"],
        description: "Puts the scenes in a new order, given as the current scene orders listed in the wanted order.",
        inputSchema: objectOf({ new_order: arrayOf(int()) }, ["new_order"]),
    }),
    tool({
        name: "split_scene", title: "Split scene", kind: "command", origin: "opennan", readOnly: false,
        commands: ["scene.split"],
        description: "Divides a media scene at a timeline time; the part after that time becomes a new scene.",
        inputSchema: objectOf({ scene_order: SCENE_ORDER, at_time: num("Timeline seconds.") }, ["scene_order", "at_time"]),
    }),
    tool({
        name: "add_shot", title: "Add shot", kind: "command", origin: "opennan", readOnly: false,
        commands: ["scene.update"],
        description: "Inserts a shot into a scene's shot list.",
        inputSchema: objectOf({
            scene_order: SCENE_ORDER,
            prompt: str("Shot description."),
            duration: SHOT_SECONDS("Seconds."),
            position: int("0-based insert index (default: end)."),
            speech: str(),
        }, ["scene_order", "prompt", "duration"]),
    }),
    tool({
        name: "update_shot", title: "Update shot", kind: "command", origin: "opennan", readOnly: false,
        commands: ["scene.update"],
        description: "Changes a shot's description, duration, transition, or speech. An empty speech clears it.",
        inputSchema: objectOf({
            scene_order: SCENE_ORDER,
            shot_index: SHOT_INDEX,
            prompt: str(),
            duration: SHOT_SECONDS(),
            transition: enumOf(["cut", "continuous"]),
            speech: str(),
        }, ["scene_order", "shot_index"]),
    }),
    tool({
        name: "delete_shot", title: "Delete shot", kind: "command", origin: "opennan", readOnly: false, destructive: true,
        commands: ["shot.delete"],
        description: "Removes a shot from a scene's shot list.",
        inputSchema: objectOf({ scene_order: SCENE_ORDER, shot_index: SHOT_INDEX }, ["scene_order", "shot_index"]),
    }),
    tool({
        name: "merge_shots", title: "Merge shots", kind: "command", origin: "opennan", readOnly: false,
        commands: ["scene.update"],
        description: "Merges one shot into another in the same scene: durations add up, descriptions and speech are joined, the source shot is removed.",
        inputSchema: objectOf({ scene_order: SCENE_ORDER, target_shot_index: SHOT_INDEX, source_shot_index: SHOT_INDEX }, ["scene_order", "target_shot_index", "source_shot_index"]),
    }),
    tool({
        name: "update_project", title: "Update project", kind: "command", origin: "opennan", readOnly: false,
        commands: ["project.update"],
        capabilityFields: { fields: ["creative_direction", "movie_concept"], capability: "opennan.story.plan" },
        description: "Changes the project name, aspect ratio, music URL, or music volume.",
        inputSchema: objectOf({
            name: str(),
            aspect_ratio: enumOf(["16:9", "9:16", "1:1", "4:5"]),
            music_url: { type: ["string", "null"] },
            music_volume: num(),
            creative_direction: str(),
            movie_concept: str(),
        }),
    }),

    // ── tracks, history, editor state ────────────────────
    tool({
        name: "manage_timeline_tracks", title: "Manage tracks", kind: "command", origin: "opennan", readOnly: false,
        commands: ["track.update"], reads: ["snapshot"],
        description: "Lists tracks, adds a track, or changes a track's mute, lock, visibility, or volume.",
        inputSchema: objectOf({
            action: enumOf(["add", "list", "update"]),
            // TimelineTrack.type and .index under the clip tools' argument names.
            track_type: narrowed(TRACK, { type: enumOf(TRACK_KINDS) }).type,
            track_index: narrowed(TRACK, { index: int() }).index,
            ...modelFields(TRACK, ["muted", "locked", "visible", "volume"]),
        }, ["action"]),
    }),
    tool({
        name: "undo_last_edit", title: "Undo", kind: "command", origin: "opennan", readOnly: false,
        commands: ["history.undo"],
        description: "Undoes the last tool calls in the editor's undo history; a call that made several edits is undone as a whole.",
        inputSchema: objectOf({ steps: int("Number of tool calls to undo (default 1). An edit made in the editor counts as one.") }),
    }),
    tool({
        name: "client_playback", title: "Playback", kind: "command", origin: "opennan", readOnly: false,
        commands: ["playback.set", "playhead.seek"],
        description: "Plays, pauses, or seeks the editor playhead.",
        inputSchema: objectOf({ action: enumOf(["play", "pause", "seek"]), time: num("Timeline seconds; needed for seek.") }, ["action"]),
    }),
    tool({
        name: "client_select_clip", title: "Select clips", kind: "command", origin: "opennan", readOnly: false,
        commands: ["selection.set"],
        description: "Selects clips in the editor. An empty list clears the clip selection.",
        inputSchema: objectOf({ clip_ids: arrayOf(str()) }, ["clip_ids"]),
    }),
    tool({
        name: "client_add_marker", title: "Add marker", kind: "command", origin: "opennan", readOnly: false,
        commands: ["marker.add"],
        description: "Adds a marker on the timeline ruler and returns it.",
        inputSchema: objectOf({ time: num("Timeline seconds."), label: str() }, ["time"]),
    }),
    tool({
        name: "client_remove_marker", title: "Remove marker", kind: "command", origin: "opennan", readOnly: false,
        commands: ["marker.remove"],
        description: "Removes a timeline marker by id.",
        inputSchema: objectOf({ marker_id: str() }, ["marker_id"]),
    }),
    tool({
        name: "client_open_panel", title: "Open panel", kind: "host", origin: "opennan", readOnly: false,
        description: "Opens a side panel of the editor UI.",
        inputSchema: objectOf({ panel: enumOf(["audio", "assets", "graphics", "effects", "transitions", "properties", "settings", "color"]) }, ["panel"]),
    }),
    tool({
        name: "client_snapshot_page", title: "Screenshot editor", kind: "host", origin: "opennan", readOnly: true,
        description: "Returns a screenshot of the editor UI.",
        inputSchema: objectOf({}),
    }),
    tool({
        name: "assemble_video", title: "Export video", kind: "command", origin: "opennan", readOnly: false,
        commands: ["export.start"],
        description: "Starts rendering the timeline to a video file (or an animated GIF) with the local exporter and returns a job id. get_export_status reports progress and the output file.",
        inputSchema: objectOf({
            resolution: enumOf(["720p", "1080p", "4k"], "Output height class (default 1080p, or the highest the exporter renders)."),
            format: enumOf(["video", "gif"], "What to make: a video file (default), or an animated GIF (15 fps, at most 640 px wide, no audio, loops forever)."),
        }),
    }),

    // ── studio additions ─────────────────────────────────
    tool({
        name: "list_transitions", title: "List transitions", kind: "read", origin: "studio", readOnly: true, reads: ["looksCatalog"],
        description: "Lists the transitions that can go on a cut between two main-track clips, with categories and default durations.",
        inputSchema: objectOf({}),
    }),
    tool({
        name: "apply_transition", title: "Apply transition", kind: "command", origin: "studio", readOnly: false,
        commands: ["transition.set", "transition.applyAll"], reads: ["snapshot"],
        description: "Sets the transition on the cut after a main-track clip (scene_order), or on every cut with apply_to_all. The duration is clamped to what the cut allows; transition_id none removes it.",
        inputSchema: objectOf({
            transition_id: enumOf(VISUAL_TRANSITIONS),
            scene_order: int("The main-track clip before the cut (1-based scene order)."),
            duration: num("Seconds (0.1 to 2), centered on the cut. Default: the transition's own."),
            apply_to_all: bool("Set it on every cut between main-track clips (one undo step)."),
        }, ["transition_id"]),
    }),
    tool({
        name: "list_filters", title: "List filters", kind: "read", origin: "studio", readOnly: true, reads: ["looksCatalog"],
        description: "Lists the color filter presets with their categories.",
        inputSchema: objectOf({}),
    }),
    tool({
        name: "apply_filter", title: "Apply filter", kind: "command", origin: "studio", readOnly: false,
        commands: ["look.set"], reads: ["snapshot"],
        description: "Applies a filter preset to a layer clip or a main-track clip at an intensity; filter_id none removes it.",
        inputSchema: objectOf({
            filter_id: enumOf(FILTER_IDS),
            intensity: num("0 to 100 (default 80)."),
            ...LOOK_TARGET,
        }, ["filter_id"]),
    }),
    tool({
        name: "set_adjustments", title: "Set adjustments", kind: "command", origin: "studio", readOnly: false,
        commands: ["look.set"], reads: ["snapshot"],
        description: "Sets Adjust controls on a clip or main-track clip: color and light from -100 to 100; fade, sharpen, vignette, grain from 0 to 100. Omitted ones keep their values.",
        inputSchema: objectOf({
            ...LOOK_TARGET,
            ...Object.fromEntries(ADJUSTMENT_ARGUMENTS.map((key) => [key, num()])),
            reset: bool("Set every control back to 0 before applying the given ones."),
        }),
    }),
    tool({
        name: "reorder_visual_effects", title: "Reorder effects", kind: "command", origin: "studio", readOnly: false,
        commands: ["clip.effect.reorder"], reads: ["snapshot"],
        description: "Puts a clip's or scene's effect stack in a new order (effect row ids, first applied first).",
        inputSchema: objectOf({
            ...LOOK_TARGET,
            effect_row_ids: arrayOf(str()),
        }, ["effect_row_ids"]),
    }),
    tool({
        name: "list_text_templates", title: "List text templates", kind: "read", origin: "studio", readOnly: true, reads: ["motionCatalog"],
        description: "Lists the text style templates (id, name, category, default text, font, animation), the bundled fonts, and the caption styles.",
        inputSchema: objectOf({ category: enumOf(TEXT_TEMPLATE_CATEGORIES) }),
    }),
    tool({
        name: "apply_text_template", title: "Apply text template", kind: "command", origin: "studio", readOnly: false,
        commands: ["text.template.apply", "clip.create"], reads: ["snapshot"],
        description: "Applies a text template (style and default animation) to a text clip, or creates a text clip with it from text, start_time, and end_time on a free text track.",
        inputSchema: objectOf({
            template_id: enumOf(TEXT_TEMPLATE_IDS),
            clip_id: str("Existing text clip to restyle."),
            text: str("Text of a new clip (default: the template's sample text)."),
            start_time: num("Timeline seconds where a new clip starts."),
            end_time: num("Timeline seconds where a new clip ends."),
            track_index: int("Text track for a new clip (default: the first free one; a new track when none is free)."),
            position_x: num("Horizontal center of a new clip, 0-1 of the frame width (default 0.5)."),
            position_y: num("Vertical center of a new clip, 0-1 of the frame height (default 0.5)."),
        }, ["template_id"]),
    }),
    tool({
        name: "set_text_style", title: "Set text style", kind: "command", origin: "studio", readOnly: false,
        commands: ["text.style.set"], reads: ["snapshot"],
        description: "Changes style fields of a text clip: font, size, weight, colors, stroke, shadow, glow, background box, gradient, alignment, spacing. null resets a field; omitted ones stay.",
        inputSchema: objectOf({ clip_id: str("Text clip."), ...textStyleSetProperties }, ["clip_id"]),
    }),
    tool({
        name: "list_animations", title: "List animations", kind: "read", origin: "studio", readOnly: true, reads: ["motionCatalog"],
        description: "Lists the in, out, combo, and loop animations for a kind of item (clip: video, image, graphics, and main-track clips; text; sticker) with default durations.",
        inputSchema: objectOf({
            kind: enumOf(["clip", "text", "sticker"]),
            slot: enumOf(["in", "out", "combo", "loop"]),
        }, ["kind"]),
    }),
    tool({
        name: "set_animation", title: "Set animation", kind: "command", origin: "studio", readOnly: false,
        commands: ["animation.set"], reads: ["snapshot"],
        description: "Sets the in, out, combo, or loop animation of a clip or main-track clip from list_animations; a combo replaces in and out. animation_id null or none removes the slot.",
        inputSchema: objectOf({
            ...MOTION_TARGET,
            slot: enumOf(["in", "out", "combo", "loop"]),
            animation_id: { type: ["string", "null"], description: "Animation id from list_animations; null or none removes it." },
            duration: num("Seconds (a loop: the period). Default: the animation's own; a combo spans the item."),
        }, ["slot", "animation_id"]),
    }),
    tool({
        name: "list_stickers", title: "List stickers", kind: "read", origin: "studio", readOnly: true, reads: ["motionCatalog"],
        description: "Searches the bundled stickers (shapes, arrows, callouts, badges, emoji) by name or keyword and category; returns ids for add_sticker.",
        inputSchema: objectOf({
            query: str("Words matched against sticker names and keywords."),
            category: enumOf(STICKER_CATEGORY_IDS),
            limit: { ...int("Maximum stickers returned (default 50)."), minimum: 1, maximum: 200 },
        }),
    }),
    tool({
        name: "add_sticker", title: "Add sticker", kind: "command", origin: "studio", readOnly: false,
        commands: ["clip.create"], reads: ["snapshot"],
        description: "Adds a bundled sticker from list_stickers as a clip on the first free sticker track (a new sticker track when none is free).",
        inputSchema: objectOf({
            sticker_id: str("Sticker id from list_stickers."),
            start_time: num("Timeline seconds."),
            end_time: num("Timeline seconds."),
            track_index: int("Sticker track (default: the first free one)."),
            position_x: num("Horizontal center, 0-1 of the frame width (default 0.5)."),
            position_y: num("Vertical center, 0-1 of the frame height (default 0.5)."),
            scale: num("Size factor; 1 = about 22% of the frame height (default 1)."),
        }, ["sticker_id", "start_time", "end_time"]),
    }),
    tool({
        name: "set_keyframe", title: "Set keyframe", kind: "command", origin: "studio", readOnly: false,
        commands: ["keyframe.set", "keyframe.easing"], reads: ["snapshot"],
        description: "Adds or updates the keyframe at an item-local time with channel values, and the easing of the segment it starts. Without values only the easing of an existing keyframe changes.",
        inputSchema: objectOf({
            ...MOTION_TARGET,
            time: ITEM_TIME,
            values: KEYFRAME_VALUES,
            easing: enumOf(EASING_IDS, "Easing from this keyframe to the next one (default linear)."),
            bezier: BEZIER,
        }, ["time"]),
    }),
    tool({
        name: "remove_keyframe", title: "Remove keyframe", kind: "command", origin: "studio", readOnly: false,
        commands: ["keyframe.remove"], reads: ["snapshot"],
        description: "Removes the keyframe at an item-local time from a clip or main-track clip, or only some of its channels.",
        inputSchema: objectOf({
            ...MOTION_TARGET,
            time: ITEM_TIME,
            channels: KEYFRAME_CHANNEL_LIST("Channels to remove (default: all)."),
        }, ["time"]),
    }),
    tool({
        name: "set_speed", title: "Set speed", kind: "command", origin: "studio", readOnly: false,
        commands: ["speed.set"], reads: ["snapshot"],
        description: "Sets the speed of a video or audio clip or main-track clip: a constant speed, a curve preset or points, and pitch. The length follows; later items on the track move.",
        inputSchema: objectOf({
            ...MOTION_TARGET,
            clip_ids: { ...arrayOf(str(), "Several video or audio clips set in one step (instead of clip_id or scene_order)."), minItems: 1 },
            speed: { ...num("Constant speed factor, 0.1 to 100 (1 = normal)."), minimum: 0.1, maximum: 100 },
            curve_id: enumOf(SPEED_CURVE_IDS, "Speed curve preset; none removes the curve."),
            curve_points: { ...arrayOf(CURVE_POINT, "Custom curve: 2 to 10 points [x, y], x = 0-1 of the item, y = speed multiplier 0.1-10."), minItems: 2, maxItems: 10 },
            preserve_pitch: bool("Keep the audio pitch when the speed changes (default true)."),
        }),
    }),
    tool({
        name: "apply_caption_style", title: "Apply caption style", kind: "command", origin: "studio", readOnly: false,
        commands: ["caption.style.apply"], reads: ["snapshot"],
        description: "Applies a caption style (karaoke ones highlight the current word) to the given caption clips, to the captions of one text track, or to every caption clip.",
        inputSchema: objectOf({
            style_id: enumOf(CAPTION_STYLE_IDS),
            clip_ids: arrayOf(str(), "Caption or text clips (default: every caption clip)."),
            track_index: int("Only the caption clips of this text track."),
        }, ["style_id"]),
    }),
    tool({
        name: "set_mask", title: "Set mask", kind: "command", origin: "studio", readOnly: false,
        commands: ["mask.set"], reads: ["snapshot"],
        description: "Adds or edits the mask of a video, image, text, or sticker clip or a main-track clip. Omitted fields keep their values; keyframed fields get a keyframe at time. remove or shape none deletes it.",
        inputSchema: objectOf({
            clip_id: str("Target video, image, text, or sticker clip."),
            scene_order: int("Target main-track clip: 1-based position of the scene in scene order."),
            shape: enumOf(MASK_SHAPE_IDS, "Mask shape; required for an item without a mask. none removes the mask."),
            ...MASK_FIELDS,
            reset: bool("Start from the shape's default size and position and drop the mask keyframes."),
            remove: bool("Delete the mask and its mask keyframes."),
            time: num("Item-local seconds for the keyframes of keyframed fields (default: the playhead)."),
        }),
    }),
    tool({
        name: "retime_keyframe", title: "Move keyframe", kind: "command", origin: "studio", readOnly: false,
        commands: ["keyframe.retime"], reads: ["snapshot"],
        description: "Moves the keyframe at one item-local time to another; with channels only those move. Landing on a keyframe merges into it. values are written at the new time.",
        inputSchema: objectOf({
            ...MOTION_TARGET,
            from: num("Item-local seconds of the keyframe to move."),
            to: num("Item-local seconds to move it to (clamped to the item)."),
            channels: KEYFRAME_CHANNEL_LIST("Only move these channels (the keyframe splits)."),
            values: KEYFRAME_VALUES,
        }, ["from", "to"]),
    }),
    tool({
        name: "paste_attributes", title: "Paste attributes", kind: "command", origin: "studio", readOnly: false,
        commands: ["attributes.paste"], reads: ["snapshot"],
        description: "Copies the look and motion of one clip or main-track clip (filter, adjust, effects, animation, speed, mask, transform) onto others in one step; reports what was applied or skipped.",
        inputSchema: objectOf({
            source_clip_id: str("Clip to copy from."),
            source_scene_order: int("Main-track clip to copy from (1-based scene order)."),
            clip_ids: arrayOf(str(), "Clips to paste onto."),
            scene_orders: arrayOf({ ...int(), minimum: 1 }, "Main-track clips to paste onto (1-based scene order)."),
            attributes: { ...arrayOf(enumOf(ATTRIBUTE_KINDS), "Kinds to paste (default: every kind the source has)."), minItems: 1 },
        }),
    }),
    tool({
        name: "track_motion", title: "Track motion", kind: "command", origin: "studio", readOnly: false,
        commands: ["tracking.run", "tracking.apply"], reads: ["snapshot"],
        description: "Follows a box drawn on one frame of a video clip or main-track clip through its other frames on this device, then moves the chosen clips or the item's mask with it. One undo step.",
        inputSchema: objectOf({
            clip_id: str("Video clip to track."),
            scene_order: int("Main-track clip to track: 1-based position of the scene in scene order."),
            region: objectOf({
                x: ranged01("Left edge, fraction of the picture's width."),
                y: ranged01("Top edge, fraction of the picture's height."),
                width: { ...num("Box width, fraction of the picture's width."), exclusiveMinimum: 0, maximum: 1 },
                height: { ...num("Box height, fraction of the picture's height."), exclusiveMinimum: 0, maximum: 1 },
            }, ["x", "y", "width", "height"], "Box around the thing to follow on the frame at time, in fractions of the tracked item's own picture."),
            time: num("Item-local seconds of the frame the box is drawn on (default: the playhead when it is over the item, else 0)."),
            follower_clip_ids: { ...arrayOf(str(), "Text, sticker, graphics, or video clips that move with the tracked point, keeping their offset."), minItems: 1 },
            follow_mask: bool("Also move the tracked item's own mask (mask_x and mask_y keyframes)."),
            start: num("Item-local seconds where tracking starts (default 0)."),
            end: num("Item-local seconds where tracking stops (default: the end of the item)."),
        }, ["region"]),
    }),
    // ── AI in the editor: local analysis and ripple cuts (phase 11; no provider) ──
    tool({
        name: "remove_silences", title: "Remove silences", kind: "command", origin: "studio", readOnly: false,
        commands: ["analysis.run", "cuts.apply"], reads: ["snapshot"],
        description: "Finds the quiet parts of a clip or scene on this device and ripple-deletes them, keeping linked captions and audio in sync. apply false only lists them. One undo step.",
        inputSchema: objectOf({
            clip_id: str("Audio or video clip to clean up (or scene_id)."),
            scene_id: str("Main-track clip (scene) to clean up, by its id (or clip_id)."),
            threshold_db: { ...num("Level under which audio counts as silence, dBFS (default -40)."), minimum: -100, maximum: 0 },
            min_silence: { ...num("Shortest pause worth cutting, seconds (default 0.35)."), minimum: 0 },
            padding: { ...num("Sound kept on each side of a cut, seconds (default 0.08)."), minimum: 0 },
            apply: bool("Cut the silences (default true); false only reports the ranges."),
        }),
    }),
    tool({
        name: "remove_filler_words", title: "Remove filler words", kind: "command", origin: "studio", readOnly: false,
        commands: ["analysis.fillers", "cuts.apply"], reads: ["snapshot"],
        description: "Finds filler words (um, uh, เอ่อ, えーと) in the caption word timings over a clip or scene and ripple-deletes them. apply false only lists them. One undo step.",
        inputSchema: objectOf({
            clip_id: str("Audio or video clip to clean up (or scene_id)."),
            scene_id: str("Main-track clip (scene) to clean up, by its id (or clip_id)."),
            language: str("Language of the words (en, th, ja, ...); default: guessed from the words."),
            apply: bool("Cut the filler words (default true); false only reports them."),
        }),
    }),
    tool({
        name: "detect_beats", title: "Detect beats", kind: "command", origin: "studio", readOnly: false,
        commands: ["analysis.run", "beats.set"], reads: ["snapshot"],
        description: "Finds the beats of an audio clip on this device and saves them on the clip (beat dots, snap to beats, auto_cut_to_beat). One undo step.",
        inputSchema: objectOf({ clip_id: str("Audio clip with the music.") }, ["clip_id"]),
    }),
    tool({
        name: "auto_cut_to_beat", title: "Auto cut to beat", kind: "command", origin: "studio", readOnly: false,
        commands: ["beats.autoCut"], reads: ["snapshot"],
        description: "Re-times clips and scenes so each cut lands on a beat of a music clip (run detect_beats first), laid end to end. Without ids, the selection. One undo step.",
        inputSchema: objectOf({
            clip_ids: { ...arrayOf(str()), minItems: 1, description: "Clips to re-time." },
            scene_ids: { ...arrayOf(str()), minItems: 1, description: "Main-track clips (scenes) to re-time, by id." },
            beat_clip_id: str("Audio clip whose beats to use (default: the first one with beats under the items)."),
            every: { ...int("Cut every N beats (default 1)."), minimum: 1 },
        }),
    }),
    tool({
        name: "cancel_export", title: "Cancel export", kind: "command", origin: "studio", readOnly: false,
        commands: ["export.cancel"],
        description: "Stops the export assemble_video started (the running one, or only the given job). get_export_status then reports it as cancelled.",
        inputSchema: objectOf({ job_id: str("Job id returned by assemble_video; omit to stop whichever export is running.") }),
    }),
    tool({
        name: "get_export_status", title: "Export status", kind: "read", origin: "studio", readOnly: true, reads: ["exportStatus"],
        description: "Returns the state of an export started by assemble_video: progress while it runs, then the output file, size, and export warnings, or the error.",
        inputSchema: objectOf({ job_id: str("Job id returned by assemble_video.") }, ["job_id"]),
    }),
    tool({
        name: "run_editor_command", title: "Run editor command", kind: "command", origin: "studio", readOnly: false,
        commands: ["*"],
        description: "Runs any editor command (the same command the editor UI runs), for example history.redo or scene.move.",
        // A compact schema: the full EditorCommand union is ~31 KB and would ride on every
        // tools/list. The server validates `command` against the full variant (Task 18).
        inputSchema: objectOf({
            command: {
                type: "object",
                description: "An editor command: `type` plus that command's fields, in camelCase.",
                properties: { type: enumOf(editorCommandTypes()) },
                required: ["type"],
                additionalProperties: true,
            },
        }, ["command"]),
    }),
];
