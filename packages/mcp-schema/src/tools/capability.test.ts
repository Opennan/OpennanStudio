import Ajv from "ajv";
import { isToolCapability } from "../capabilities";
import { CAPABILITY_TOOLS } from "./capability";

const byName = (name: string) => CAPABILITY_TOOLS.find((t) => t.name === name)!;
const valid = (name: string, args: unknown) => new Ajv({ strict: false }).compile(byName(name).inputSchema)(args);

describe("capability tools", () => {
    it("each need a known capability and compile", () => {
        const ajv = new Ajv({ strict: false });
        for (const tool of CAPABILITY_TOOLS) {
            expect(tool.kind, tool.name).toBe("capability");
            expect(isToolCapability(tool.capability ?? ""), tool.name).toBe(true);
            expect(tool.origin, tool.name).toBe("opennan");
            expect(() => ajv.compile(tool.inputSchema), tool.name).not.toThrow();
        }
    });

    it("keep descriptions short and about function only", () => {
        for (const tool of CAPABILITY_TOOLS) {
            expect(tool.description.length, tool.name).toBeLessThanOrEqual(200);
            expect(tool.description, tool.name).not.toMatch(/\b(you|must|never|always|paid|free)\b/i);
        }
    });

    it("route OpenNan pipeline tools to OpenNan-exclusive capabilities (spec §2.1)", () => {
        const capability = (name: string) => CAPABILITY_TOOLS.find((t) => t.name === name)?.capability;
        expect(capability("generate_storyboard")).toBe("opennan.story.storyboard");
        expect(capability("detect_copy_video_shots")).toBe("opennan.copy-video");
        expect(capability("generate_scene_videos_smart")).toBe("opennan.video.smart-scene");
        expect(capability("qc_check")).toBe("opennan.qc");
        expect(capability("best_take_score")).toBe("opennan.qc");
        expect(capability("manage_character")).toBe("opennan.story.consistency");
        expect(capability("generate_tts")).toBe("audio.tts");
        expect(capability("check_generation_status")).toBe("provider.jobs");
    });

    it("OpenNan project pipelines take a scene by order or id, and accept_max_usd on the priced ones (phase 9b)", () => {
        for (const name of ["generate_storyboard", "generate_video_from_panels", "detect_copy_video_shots", "edit_copy_video_shot_image", "generate_scene_videos_smart"]) {
            expect(byName(name).inputSchema.properties.accept_max_usd, name).toMatchObject({ type: "number", minimum: 0 });
            expect(byName(name).description, name).toMatch(/OpenNan cloud project/);
            expect(valid(name, { scene_order: 2, shot_index: 0, instruction: "x", accept_max_usd: 0.5 }) || valid(name, { scene_id: "s1", accept_max_usd: 0.5 }), name).toBe(true);
            expect(valid(name, { scene_id: "s1", shot_index: 0, instruction: "x", accept_max_usd: -1 }), name).toBe(false);
        }
        for (const name of ["set_copy_video_source", "edit_copy_video_shot_description"]) {
            expect(byName(name).inputSchema.properties.accept_max_usd, name).toBeUndefined();
            expect(byName(name).description, name).toMatch(/OpenNan cloud project/);
        }
        expect(valid("generate_scene_videos_smart", { scene_order: 1, model_id: "kling-o3", dry_run: true })).toBe(true);
        expect(valid("generate_scene_videos_smart", { scene_order: 1, model_id: "veo" })).toBe(false);
        expect(valid("set_copy_video_source", { scene_id: "s1", video_url: "https://x/v.mp4", trim_start: 1, trim_end: 4 })).toBe(true);
    });

    it("transcribe_audio takes an engine and an optional clip or scene", () => {
        expect(byName("transcribe_audio").commands).toEqual(["ai.run"]);
        expect(valid("transcribe_audio", {})).toBe(true);
        expect(valid("transcribe_audio", { engine: "cloud", clip_id: "a", language: "en" })).toBe(true);
        expect(valid("transcribe_audio", { engine: "local", scene_id: "s" })).toBe(true);
        expect(valid("transcribe_audio", { engine: "gpu" })).toBe(false);
    });

    it("estimate_cost names the tool to price, check_generation_status an optional job", () => {
        expect(byName("estimate_cost").inputSchema.required).toEqual(["tool"]);
        expect(valid("estimate_cost", { tool: "isolate_voice", clip_id: "a", first_seconds: 30 })).toBe(true);
        expect(valid("estimate_cost", { tool: "upscale_video", scene_id: "s", resolution: "4k" })).toBe(true);
        expect(valid("estimate_cost", { tool: "generate_video_h3", duration_seconds: 5, first_frame_url: "https://x/a.png" })).toBe(true);
        // Phase 11.1: only what the generators send is priced (they run the default model, with no reference images).
        expect(valid("estimate_cost", { tool: "generate_video_h3", model_id: "kling-3" })).toBe(false);
        expect(valid("estimate_cost", { tool: "generate_quick_image", image_count: 2 })).toBe(false);
        expect(valid("estimate_cost", { tool: "fly_to_mars" })).toBe(false);
        expect(valid("estimate_cost", { operation: "video" })).toBe(false);
        expect(byName("estimate_cost").capability).toBe("provider.estimate");
        expect(valid("check_generation_status", {})).toBe(true);
        expect(valid("check_generation_status", { job_id: "j1" })).toBe(true);
        expect(valid("check_generation_status", { scene_order: 1 })).toBe(false);
        expect(valid("list_voices", { language: "en" })).toBe(true);
    });
});
