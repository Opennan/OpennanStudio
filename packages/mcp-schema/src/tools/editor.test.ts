import Ajv from "ajv";
import { editorCommandTypes, type JsonSchema } from "../json-schema";
import {
    ATTRIBUTE_KINDS, CAPTION_STYLE_IDS, EASING_IDS, EDITOR_TOOLS, KEYFRAME_CHANNELS, MASK_KEYFRAME_CHANNELS, MASK_SHAPE_IDS, SCENE_PLANNING_FIELDS,
    SPEED_CURVE_IDS, STICKER_CATEGORY_IDS, TEXT_FONT_FAMILIES, TEXT_STYLE_KEYS, TEXT_STYLE_LIMITS, TEXT_TEMPLATE_CATEGORIES, TEXT_TEMPLATE_IDS,
} from "./editor";

const byName = (name: string) => {
    const tool = EDITOR_TOOLS.find((t) => t.name === name);
    if (!tool) throw new Error(`missing ${name}`);
    return tool;
};

describe("editor tools", () => {
    it("compile as closed object schemas", () => {
        const ajv = new Ajv({ strict: false });
        for (const tool of EDITOR_TOOLS) {
            expect(tool.inputSchema.type, tool.name).toBe("object");
            expect(tool.inputSchema.additionalProperties, tool.name).toBe(false);
            expect(() => ajv.compile(tool.inputSchema), tool.name).not.toThrow();
        }
    });

    it("name only real EditorCommand types and declare what they read", () => {
        const commands = new Set([...editorCommandTypes(), "*"]);
        for (const tool of EDITOR_TOOLS) {
            expect(["read", "command", "host"], tool.name).toContain(tool.kind);
            for (const command of tool.commands ?? []) expect(commands.has(command), `${tool.name}: ${command}`).toBe(true);
            if (tool.kind === "command") expect(tool.commands?.length, tool.name).toBeGreaterThan(0);
            if (tool.kind === "read") expect(tool.reads?.length, tool.name).toBeGreaterThan(0);
        }
    });

    it("keeps descriptions short and about function only", () => {
        for (const tool of EDITOR_TOOLS) {
            expect(tool.description.length, tool.name).toBeLessThanOrEqual(200);
            expect(tool.description, tool.name).not.toMatch(/\b(you|must|never|always)\b/i);
        }
    });

    it("derives clip arguments from the TimelineClip type in snake_case", () => {
        const edit = byName("edit_timeline_clip").inputSchema;
        expect(edit.required).toEqual(["clip_id"]);
        expect(edit.properties.position_x).toMatchObject({ type: "number" });
        expect(edit.properties.media_url).toMatchObject({ type: ["string", "null"] });
        expect(edit.properties.font_size).toMatchObject({ type: "number" });
        const create = byName("create_timeline_clip").inputSchema;
        expect(create.required).toEqual(["track_type", "track_index", "start_time", "end_time"]);
        expect(create.properties.track_type).toMatchObject({ enum: ["video", "audio", "text", "sticker"] });
    });

    it("marks story-planning arguments as needing OpenNan", () => {
        expect(byName("update_scene").capabilityFields).toEqual({ fields: SCENE_PLANNING_FIELDS, capability: "opennan.story.plan" });
        expect(byName("create_scenes").capabilityFields?.fields).toContain("scenes[].start_frame_prompt");
    });

    it("exposes every EditorCommand through a compact run_editor_command schema", () => {
        const tool = byName("run_editor_command");
        const command = tool.inputSchema.properties.command as { properties: { type: { enum: string[] } }; required: string[] };
        expect(command.properties.type.enum).toEqual(editorCommandTypes());
        expect(command.required).toEqual(["type"]);
        // The full EditorCommand schema is ~31 KB; the server validates against it instead (Task 18).
        expect(JSON.stringify(tool.inputSchema).length).toBeLessThan(2000);
    });

    it("accepts OpenNan-style arguments that the server answers itself", () => {
        const ajv = new Ajv({ strict: false });
        expect(ajv.validate(byName("create_scenes").inputSchema, { scenes: [{ source_url: "a.mp4", source_start_time: 1, source_end_time: 4 }] })).toBe(true);
        expect(ajv.validate(byName("apply_visual_effect").inputSchema, { effect_id: "blur", scene_order: 1, start_time: 0, end_time: 2 })).toBe(true);
        expect(ajv.validate(byName("remove_visual_effect").inputSchema, { effect_id: "blur", scene_order: 1 })).toBe(true);
    });

    it("bounds the preview frame size an agent may ask for", () => {
        const ajv = new Ajv({ strict: false });
        const schema = byName("preview_timeline_frame").inputSchema;
        expect(ajv.validate(schema, { time_seconds: 1, width: 1280 })).toBe(true);
        expect(ajv.validate(schema, { time_seconds: 1, width: 100000 })).toBe(false);
        expect(ajv.validate(schema, { time_seconds: 1, height: 0 })).toBe(false);
    });

    it("takes scene and track arguments from the generated SceneData and TimelineTrack", () => {
        const update = byName("update_scene").inputSchema.properties as Record<string, JsonSchema>;
        expect(update.caption).toEqual({ type: "string" });
        expect(update.audio_text).toEqual({ type: "string" });
        expect(update.source_video_url).toEqual({ type: "string" });
        expect(update.duration).toEqual({ type: "number", description: "Scene length in seconds." });
        expect(update.visual_transition_duration).toEqual({ type: "number" });
        const tracks = byName("manage_timeline_tracks").inputSchema.properties as Record<string, JsonSchema>;
        expect(tracks).toMatchObject({ muted: { type: "boolean" }, volume: { type: "number" }, track_index: { type: "integer" } });
    });

    it("routes exports through export.start and reads the job back", () => {
        const ajv = new Ajv({ strict: false });
        const assemble = byName("assemble_video");
        expect(assemble.commands).toEqual(["export.start"]);
        expect(ajv.validate(assemble.inputSchema, {})).toBe(true);
        expect(ajv.validate(assemble.inputSchema, { resolution: "1080p" })).toBe(true);
        expect(ajv.validate(assemble.inputSchema, { resolution: "8k" })).toBe(false);
        expect(ajv.validate(assemble.inputSchema, { format: "gif", resolution: "720p" })).toBe(true);
        expect(ajv.validate(assemble.inputSchema, { format: "mov" })).toBe(false);
        const status = byName("get_export_status");
        expect(status).toMatchObject({ kind: "read", origin: "studio", readOnly: true, reads: ["exportStatus"] });
        expect(status.inputSchema.required).toEqual(["job_id"]);
    });

    describe("text, animation, sticker, keyframe, speed, and caption tools (phase 10b)", () => {
        const ajv = new Ajv({ strict: false });
        const valid = (name: string, args: Record<string, unknown>) => ajv.validate(byName(name).inputSchema, args);
        const MOTION_TOOLS = [
            "list_text_templates", "apply_text_template", "set_text_style", "list_animations", "set_animation", "list_stickers",
            "add_sticker", "set_keyframe", "remove_keyframe", "set_speed", "apply_caption_style",
        ];

        it("are studio tools that read the motion catalog or run the motion commands", () => {
            for (const name of MOTION_TOOLS) expect(byName(name).origin, name).toBe("studio");
            for (const name of ["list_text_templates", "list_animations", "list_stickers"]) {
                expect(byName(name), name).toMatchObject({ kind: "read", readOnly: true, reads: ["motionCatalog"] });
            }
            expect(byName("apply_text_template").commands).toEqual(["text.template.apply", "clip.create"]);
            expect(byName("set_text_style").commands).toEqual(["text.style.set"]);
            expect(byName("set_animation").commands).toEqual(["animation.set"]);
            expect(byName("add_sticker").commands).toEqual(["clip.create"]);
            expect(byName("set_keyframe").commands).toEqual(["keyframe.set", "keyframe.easing"]);
            expect(byName("remove_keyframe").commands).toEqual(["keyframe.remove"]);
            expect(byName("set_speed").commands).toEqual(["speed.set"]);
            expect(byName("apply_caption_style").commands).toEqual(["caption.style.apply"]);
        });

        it("lists the catalog ids the handlers accept", () => {
            expect(TEXT_TEMPLATE_IDS).toHaveLength(20);
            expect(TEXT_TEMPLATE_CATEGORIES).toEqual(["basic", "social", "neon", "outline", "gradient", "handwritten", "display"]);
            expect(TEXT_FONT_FAMILIES).toHaveLength(12);
            expect(CAPTION_STYLE_IDS).toHaveLength(8);
            expect(STICKER_CATEGORY_IDS).toHaveLength(11);
            expect(EASING_IDS).toEqual(["linear", "ease_in", "ease_out", "ease_in_out", "hold", "bezier"]);
            expect(KEYFRAME_CHANNELS).toHaveLength(23);
            expect(KEYFRAME_CHANNELS.slice(17)).toEqual([...MASK_KEYFRAME_CHANNELS]);
            expect(SPEED_CURVE_IDS).toEqual(["none", "montage", "hero", "bullet", "jump_cut", "flash_in", "flash_out"]);
        });

        it("applies a template to a clip or creates a text clip from one", () => {
            expect(byName("apply_text_template").inputSchema.required).toEqual(["template_id"]);
            expect(valid("apply_text_template", { template_id: "neon_pink", clip_id: "c1" })).toBe(true);
            expect(valid("apply_text_template", { template_id: "neon_pink", text: "Hi", start_time: 0, end_time: 2 })).toBe(true);
            expect(valid("apply_text_template", { template_id: "nope", clip_id: "c1" })).toBe(false);
            expect(valid("list_text_templates", { category: "neon" })).toBe(true);
            expect(valid("list_text_templates", { category: "nope" })).toBe(false);
        });

        it("maps every set_text_style argument to a preview text style key, null resetting it", () => {
            const props = byName("set_text_style").inputSchema.properties as Record<string, JsonSchema>;
            expect(byName("set_text_style").inputSchema.required).toEqual(["clip_id"]);
            expect(Object.keys(TEXT_STYLE_KEYS).sort()).toEqual(Object.keys(props).filter((k) => k !== "clip_id" && !k.startsWith("gradient_")).sort());
            expect(TEXT_STYLE_KEYS).toMatchObject({ font_family: "fontFamily", background_color: "bgColor", glow_size: "glowSize", line_height: "lineHeight" });
            for (const [key, schema] of Object.entries(props)) {
                if (key !== "clip_id") expect((schema.type as string[]).includes("null"), key).toBe(true);
            }
            expect(valid("set_text_style", { clip_id: "c", font_family: "Bebas Neue", font_size: 72, color: "#fff", stroke_width: null, gradient_from: "#f00", gradient_to: "#00f", gradient_angle: 45 })).toBe(true);
            expect(valid("set_text_style", { clip_id: "c", font_family: "Comic Sans" })).toBe(false);
            expect(valid("set_text_style", { clip_id: "c", text_align: "justify" })).toBe(false);
            expect(valid("set_text_style", { clip_id: "c", font_weight: 1200 })).toBe(false);
        });

        it("caps the set_text_style sizes so a style cannot blow up the text bitmap", () => {
            const props = byName("set_text_style").inputSchema.properties as Record<string, JsonSchema>;
            expect(TEXT_STYLE_LIMITS).toMatchObject({
                font_size: { minimum: 1, maximum: 400 }, stroke_width: { minimum: 0, maximum: 100 }, shadow_blur: { minimum: 0, maximum: 200 },
                glow_size: { minimum: 0, maximum: 200 }, background_padding: { minimum: 0, maximum: 200 }, letter_spacing: { minimum: -100, maximum: 200 },
            });
            for (const [key, limit] of Object.entries(TEXT_STYLE_LIMITS)) {
                expect([props[key].minimum, props[key].maximum], key).toEqual([limit.minimum, limit.maximum]);
            }
            expect(valid("set_text_style", { clip_id: "c", font_size: 400, letter_spacing: -100, glow_size: 200 })).toBe(true);
            for (const [key, value] of [["font_size", 401], ["stroke_width", 101], ["shadow_blur", 201], ["glow_size", 201], ["background_padding", 201], ["letter_spacing", 201], ["letter_spacing", -101]] as const) {
                expect(valid("set_text_style", { clip_id: "c", [key]: value }), key).toBe(false);
            }
        });

        it("sets and lists animations by kind and slot", () => {
            expect(byName("list_animations").inputSchema.required).toEqual(["kind"]);
            expect(valid("list_animations", { kind: "sticker", slot: "loop" })).toBe(true);
            expect(valid("list_animations", { kind: "audio" })).toBe(false);
            expect(byName("set_animation").inputSchema.required).toEqual(["slot", "animation_id"]);
            expect(valid("set_animation", { clip_id: "c", slot: "in", animation_id: "fade", duration: 0.5 })).toBe(true);
            expect(valid("set_animation", { scene_order: 1, slot: "combo", animation_id: null })).toBe(true);
            expect(valid("set_animation", { clip_id: "c", slot: "middle", animation_id: "fade" })).toBe(false);
        });

        it("searches stickers and adds one with a placement", () => {
            expect(valid("list_stickers", { query: "heart", category: "emoji-symbols" })).toBe(true);
            expect(valid("list_stickers", { category: "cats" })).toBe(false);
            expect(byName("add_sticker").inputSchema.required).toEqual(["sticker_id", "start_time", "end_time"]);
            expect(valid("add_sticker", { sticker_id: "twemoji:2764", start_time: 1, end_time: 3, position_x: 0.2, position_y: 0.8, scale: 0.5 })).toBe(true);
        });

        it("takes keyframe values per catalog channel with an easing and bezier handles", () => {
            const set = byName("set_keyframe").inputSchema;
            expect(set.required).toEqual(["time"]);
            const values = set.properties.values as { properties: Record<string, JsonSchema>; additionalProperties: boolean };
            expect(Object.keys(values.properties)).toEqual([...KEYFRAME_CHANNELS]);
            expect(values.additionalProperties).toBe(false);
            expect(valid("set_keyframe", { clip_id: "c", time: 1, values: { scale: 1.5, opacity: 0.5 }, easing: "bezier", bezier: [0.4, 0, 0.2, 1] })).toBe(true);
            expect(valid("set_keyframe", { clip_id: "c", time: 1, easing: "ease_in" })).toBe(true);
            expect(valid("set_keyframe", { clip_id: "c", time: 1, values: { wobble: 1 } })).toBe(false);
            expect(valid("set_keyframe", { clip_id: "c", time: 1, values: { scale: 1 }, bezier: [0, 1] })).toBe(false);
            expect(valid("remove_keyframe", { scene_order: 1, time: 0, channels: ["scale"] })).toBe(true);
            expect(valid("remove_keyframe", { scene_order: 1, time: 0, channels: ["wobble"] })).toBe(false);
            // Mask channels (phase 10c) ride in the same keyframes.
            expect(valid("set_keyframe", { clip_id: "c", time: 1, values: { mask_x: 0.4, mask_feather: 0.2 } })).toBe(true);
            expect(valid("remove_keyframe", { clip_id: "c", time: 1, channels: ["mask_w", "mask_rotation"] })).toBe(true);
        });

        it("sets several clips' speed in one call", () => {
            expect(valid("set_speed", { clip_ids: ["a", "b"], speed: 2 })).toBe(true);
            expect(valid("set_speed", { clip_ids: [], speed: 2 })).toBe(false);
        });

        it("bounds speed and speed curve points", () => {
            expect(valid("set_speed", { clip_id: "c", speed: 2, preserve_pitch: false })).toBe(true);
            expect(valid("set_speed", { scene_order: 1, curve_id: "hero" })).toBe(true);
            expect(valid("set_speed", { scene_order: 1, curve_points: [[0, 1], [0.5, 3], [1, 1]] })).toBe(true);
            expect(valid("set_speed", { clip_id: "c", speed: 200 })).toBe(false);
            expect(valid("set_speed", { clip_id: "c", speed: 0.05 })).toBe(false);
            expect(valid("set_speed", { clip_id: "c", curve_points: [[0, 1]] })).toBe(false);
            expect(valid("set_speed", { clip_id: "c", curve_points: [[0, 1, 2], [1, 1]] })).toBe(false);
        });

        it("applies a caption style to given clips, a track, or every caption", () => {
            expect(byName("apply_caption_style").inputSchema.required).toEqual(["style_id"]);
            expect(valid("apply_caption_style", { style_id: "karaoke_box" })).toBe(true);
            expect(valid("apply_caption_style", { style_id: "pill", clip_ids: ["a"], track_index: 2 })).toBe(true);
            expect(valid("apply_caption_style", { style_id: "nope" })).toBe(false);
        });
    });

    describe("mask, keyframe retime, and paste attributes tools (phase 10c)", () => {
        const ajv = new Ajv({ strict: false });
        const valid = (name: string, args: Record<string, unknown>) => ajv.validate(byName(name).inputSchema, args);

        it("are studio commands that run the editor's own commands", () => {
            for (const name of ["set_mask", "retime_keyframe", "paste_attributes"]) {
                expect(byName(name), name).toMatchObject({ kind: "command", origin: "studio", readOnly: false, reads: ["snapshot"] });
            }
            expect(byName("set_mask").commands).toEqual(["mask.set"]);
            expect(byName("retime_keyframe").commands).toEqual(["keyframe.retime"]);
            expect(byName("paste_attributes").commands).toEqual(["attributes.paste"]);
        });

        it("lists the mask shapes, mask channels, and attribute kinds the commands take", () => {
            expect(MASK_SHAPE_IDS).toEqual(["none", "linear", "mirror", "circle", "rectangle", "heart", "star"]);
            expect(MASK_KEYFRAME_CHANNELS).toEqual(["mask_x", "mask_y", "mask_w", "mask_h", "mask_rotation", "mask_feather"]);
            expect(ATTRIBUTE_KINDS).toEqual(["filter", "adjust", "effects", "animation", "speed", "mask", "transform"]);
        });

        it("bounds set_mask fields to the mask model's ranges", () => {
            expect(byName("set_mask").inputSchema.required ?? []).toEqual([]);
            expect(valid("set_mask", { clip_id: "c", shape: "circle", x: 0.3, y: 0.6, width: 0.5, height: 0.5, rotation: 45, feather: 0.2, invert: true })).toBe(true);
            expect(valid("set_mask", { scene_order: 1, shape: "rectangle", roundness: 0.5, time: 1.5 })).toBe(true);
            expect(valid("set_mask", { scene_order: 1, reset: true, shape: "star" })).toBe(true);
            expect(valid("set_mask", { scene_order: 1, remove: true })).toBe(true);
            expect(valid("set_mask", { clip_id: "c", shape: "triangle" })).toBe(false);
            expect(valid("set_mask", { clip_id: "c", feather: 1.5 })).toBe(false);
            expect(valid("set_mask", { clip_id: "c", width: 0 })).toBe(false);
            expect(valid("set_mask", { clip_id: "c", x: 4 })).toBe(false);
            expect(valid("set_mask", { clip_id: "c", rotation: 4000 })).toBe(false);
        });

        it("moves a keyframe with optional channels and destination values", () => {
            expect(byName("retime_keyframe").inputSchema.required).toEqual(["from", "to"]);
            expect(valid("retime_keyframe", { clip_id: "c", from: 1, to: 2 })).toBe(true);
            expect(valid("retime_keyframe", { scene_order: 1, from: 1, to: 2, channels: ["scale", "mask_x"], values: { scale: 1.2 } })).toBe(true);
            expect(valid("retime_keyframe", { clip_id: "c", from: 1, to: 2, channels: [] })).toBe(false);
            expect(valid("retime_keyframe", { clip_id: "c", from: 1, to: 2, channels: ["wobble"] })).toBe(false);
            expect(valid("retime_keyframe", { clip_id: "c", from: 1, to: 2, values: { wobble: 1 } })).toBe(false);
        });

        it("tracks a region and names its followers", () => {
            const schema = byName("track_motion");
            expect(schema.commands).toEqual(["tracking.run", "tracking.apply"]);
            expect(schema.inputSchema.required).toEqual(["region"]);
            const region = { x: 0.4, y: 0.3, width: 0.2, height: 0.25 };
            expect(valid("track_motion", { clip_id: "v", region, follower_clip_ids: ["t"], time: 1.5 })).toBe(true);
            expect(valid("track_motion", { scene_order: 1, region, follow_mask: true, start: 0.5, end: 3 })).toBe(true);
            expect(valid("track_motion", { clip_id: "v", region: { x: 0.4, y: 0.3, width: 0.2 }, follower_clip_ids: ["t"] })).toBe(false);
            expect(valid("track_motion", { clip_id: "v", region: { ...region, x: 1.2 }, follower_clip_ids: ["t"] })).toBe(false);
            expect(valid("track_motion", { clip_id: "v", region, follower_clip_ids: [] })).toBe(false);
        });

        it("finds and cuts silences, filler words, and beats with the analysis commands", () => {
            expect(byName("remove_silences").commands).toEqual(["analysis.run", "cuts.apply"]);
            expect(byName("remove_filler_words").commands).toEqual(["analysis.fillers", "cuts.apply"]);
            expect(byName("detect_beats").commands).toEqual(["analysis.run", "beats.set"]);
            expect(byName("auto_cut_to_beat").commands).toEqual(["beats.autoCut"]);
            for (const name of ["remove_silences", "remove_filler_words", "detect_beats", "auto_cut_to_beat"]) {
                expect(byName(name).kind, name).toBe("command");
                expect(byName(name).origin, name).toBe("studio");
            }
            expect(valid("remove_silences", { clip_id: "a" })).toBe(true);
            expect(valid("remove_silences", { scene_id: "s", threshold_db: -35, min_silence: 0.5, padding: 0.1, apply: false })).toBe(true);
            expect(valid("remove_silences", { clip_id: "a", threshold_db: 3 })).toBe(false);
            expect(valid("remove_silences", { clip_id: "a", min_silence: -1 })).toBe(false);
            expect(valid("remove_filler_words", { clip_id: "a", language: "th", apply: false })).toBe(true);
            expect(valid("detect_beats", { clip_id: "m" })).toBe(true);
            expect(byName("detect_beats").inputSchema.required).toEqual(["clip_id"]);
            expect(valid("auto_cut_to_beat", {})).toBe(true);
            expect(valid("auto_cut_to_beat", { clip_ids: ["a"], scene_ids: ["s"], beat_clip_id: "m", every: 2 })).toBe(true);
            expect(valid("auto_cut_to_beat", { every: 0 })).toBe(false);
        });

        it("pastes from one clip or scene onto many with an optional kind filter", () => {
            expect(valid("paste_attributes", { source_clip_id: "a", clip_ids: ["b", "c"], scene_orders: [2] })).toBe(true);
            expect(valid("paste_attributes", { source_scene_order: 1, scene_orders: [2, 3], attributes: ["filter", "mask"] })).toBe(true);
            expect(valid("paste_attributes", { source_scene_order: 1, scene_orders: [2], attributes: ["colour"] })).toBe(false);
            expect(valid("paste_attributes", { source_scene_order: 1, scene_orders: [2], attributes: [] })).toBe(false);
            expect(valid("paste_attributes", { source_scene_order: 1, scene_orders: [0] })).toBe(false);
        });
    });
});
