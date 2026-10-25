import { getTool, STUDIO_TOOLS } from "../registry";
import { OPENNAN_TOOL_NAMES } from "../opennan-tool-names";
import Ajv from "ajv";
import { PIPELINE_TOOLS, PROJECT_PIPELINE_TOOLS } from "./pipelines";

const valid = (name: string, args: unknown) => new Ajv({ strict: false }).compile(getTool(name)!.inputSchema)(args);

describe("project pipeline host tools", () => {
    it("adds two host tools, none named like an OpenNan tool", () => {
        expect(PIPELINE_TOOLS.map((t) => t.name)).toEqual(["plan_scenes", "set_project_script"]);
        for (const tool of PIPELINE_TOOLS) {
            expect(tool).toMatchObject({ kind: "host", origin: "studio" });
            expect((OPENNAN_TOOL_NAMES as readonly string[]).includes(tool.name)).toBe(false);
            expect(getTool(tool.name)).toBe(tool);
        }
        expect(STUDIO_TOOLS.filter((t) => PIPELINE_TOOLS.includes(t))).toHaveLength(2);
    });

    it("lists no cloud project or share link tools (cloud projects were removed)", () => {
        for (const name of ["list_cloud_projects", "save_project_to_cloud", "open_cloud_project", "get_cloud_sync_status", "create_share_link", "list_share_links", "revoke_share_link"]) {
            expect(getTool(name), name).toBeUndefined();
        }
    });

    it("plans scenes (priced, with accept_max_usd and dry_run) and stores the script (phase 9b)", () => {
        expect(valid("plan_scenes", {})).toBe(true);
        expect(valid("plan_scenes", { style: "Watercolor", concept: "A trip", direction: "Warm", accept_max_usd: 1, dry_run: true })).toBe(true);
        expect(valid("plan_scenes", { accept_max_usd: -0.1 })).toBe(false);
        expect(valid("plan_scenes", { scene_order: 1 })).toBe(false);
        expect(valid("set_project_script", { script_text: "Hello.", srt_content: null })).toBe(true);
        expect(valid("set_project_script", { script_text: 3 })).toBe(false);
        expect(getTool("plan_scenes")!.readOnly).toBe(false);
        expect(getTool("set_project_script")!.readOnly).toBe(false);
    });

    it("names the project pipeline tools the host's pipelines answer", () => {
        expect([...PROJECT_PIPELINE_TOOLS].sort()).toEqual([
            "detect_copy_video_shots", "edit_copy_video_shot_description", "edit_copy_video_shot_image", "generate_scene_videos_smart", "generate_storyboard",
            "generate_video_from_panels", "plan_scenes", "set_copy_video_source", "set_project_script",
        ]);
        for (const name of PROJECT_PIPELINE_TOOLS) expect(getTool(name), name).toBeDefined();
    });
});
