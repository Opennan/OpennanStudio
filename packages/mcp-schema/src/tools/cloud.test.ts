import { getTool, STUDIO_TOOLS } from "../registry";
import { OPENNAN_TOOL_NAMES } from "../opennan-tool-names";
import Ajv from "ajv";
import { CLOUD_TOOLS, PROJECT_PIPELINE_TOOLS, SHARE_TOOLS } from "./cloud";

const valid = (name: string, args: unknown) => new Ajv({ strict: false }).compile(getTool(name)!.inputSchema)(args);

describe("cloud project tools", () => {
    it("adds nine host tools, none named like an OpenNan tool", () => {
        expect(CLOUD_TOOLS.map((t) => t.name)).toEqual([
            "list_cloud_projects", "save_project_to_cloud", "open_cloud_project", "get_cloud_sync_status", "plan_scenes", "set_project_script",
            "create_share_link", "list_share_links", "revoke_share_link",
        ]);
        for (const tool of CLOUD_TOOLS) {
            expect(tool).toMatchObject({ kind: "host", origin: "studio" });
            expect((OPENNAN_TOOL_NAMES as readonly string[]).includes(tool.name)).toBe(false);
            expect(getTool(tool.name)).toBe(tool);
        }
        expect(STUDIO_TOOLS.filter((t) => CLOUD_TOOLS.includes(t))).toHaveLength(9);
    });

    it("takes a project id to open and nothing to save", () => {
        expect(getTool("open_cloud_project")!.inputSchema.required).toEqual(["project_id"]);
        expect(getTool("save_project_to_cloud")!.inputSchema.required ?? []).toEqual([]);
        expect(getTool("list_cloud_projects")!.readOnly).toBe(true);
        expect(getTool("get_cloud_sync_status")!.readOnly).toBe(true);
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

    it("names the project pipeline tools the cloud runtime answers", () => {
        expect([...PROJECT_PIPELINE_TOOLS].sort()).toEqual([
            "detect_copy_video_shots", "edit_copy_video_shot_description", "edit_copy_video_shot_image", "generate_scene_videos_smart", "generate_storyboard",
            "generate_video_from_panels", "plan_scenes", "set_copy_video_source", "set_project_script",
        ]);
        for (const name of PROJECT_PIPELINE_TOOLS) expect(getTool(name), name).toBeDefined();
    });

    it("creates (expiry 1–365 whole days, allow download), lists and revokes view-only share links (phase 9c)", () => {
        expect(valid("create_share_link", {})).toBe(true);
        expect(valid("create_share_link", { expires_in_days: 7, allow_download: true })).toBe(true);
        expect(valid("create_share_link", { expires_in_days: 0 })).toBe(false);
        expect(valid("create_share_link", { expires_in_days: 366 })).toBe(false);
        expect(valid("create_share_link", { expires_in_days: 2.5 })).toBe(false);
        expect(valid("create_share_link", { allow_download: "yes" })).toBe(false);
        expect(valid("create_share_link", { password: "x" })).toBe(false);
        expect(valid("list_share_links", {})).toBe(true);
        expect(valid("revoke_share_link", {})).toBe(true);
        expect(valid("revoke_share_link", { share_id: "shr_0123456789abcdef01234567" })).toBe(true);
        expect(valid("revoke_share_link", { share_id: "../x" })).toBe(false);
        expect(getTool("list_share_links")!.readOnly).toBe(true);
        expect(getTool("create_share_link")!.readOnly).toBe(false);
        expect(getTool("revoke_share_link")!.readOnly).toBe(false);
        expect(SHARE_TOOLS).toEqual(["create_share_link", "list_share_links", "revoke_share_link"]);
    });

    it("tells agents that Studio asks the person before a link is made, and what stop sharing answers (9c.1)", () => {
        expect(getTool("create_share_link")!.description).toMatch(/asks the person to allow it.*declined or unanswered.*no link/);
        expect(getTool("create_share_link")!.description).toMatch(/needs the OpenNan Studio app/);
        expect(getTool("revoke_share_link")!.description).toMatch(/answers exactly the links it turned off/);
    });
});
