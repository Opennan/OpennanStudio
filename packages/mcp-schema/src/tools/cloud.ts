// OpenNan cloud project tools (phase 9a, origin "studio"): list the account's cloud projects, move the open local
// project to the cloud, open a cloud project, and read a cloud project's sync state. They run on the host's cloud
// runtime (the desktop app signed in to OpenNan); headless hosts answer that they need the app.
// Phase 9b: plan_scenes and set_project_script (Studio tools named like the server director's own) start the story
// plan and store the script of the open cloud project; with the seven OpenNan pipeline tools they make the project
// pipeline tools, which run only on OpenNan cloud projects (local projects are asked to be saved to OpenNan first).
// Phase 9c: create_share_link, list_share_links and revoke_share_link manage the open cloud project's view-only link on
// opennan.com (its latest export, or its scenes in order; never editable).
import { bool, int, objectOf, str } from "../json-schema";
import type { ToolDefinition } from "../types";
import { acceptMaxUsd } from "./capability";

/** OpenNan-named capability tools that run as project pipelines on OpenNan cloud projects (phase 9b). */
export const OPENNAN_PIPELINE_TOOLS = [
    "generate_storyboard", "generate_scene_videos_smart", "detect_copy_video_shots", "set_copy_video_source", "edit_copy_video_shot_description",
    "edit_copy_video_shot_image", "generate_video_from_panels",
] as const;

/** Share link tools of the open cloud project (phase 9c), answered by the host's cloud runtime. */
export const SHARE_TOOLS = ["create_share_link", "list_share_links", "revoke_share_link"] as const;

/** Every tool answered by the host's cloud project pipelines: the OpenNan ones plus plan_scenes and set_project_script. */
export const PROJECT_PIPELINE_TOOLS = [...OPENNAN_PIPELINE_TOOLS, "plan_scenes", "set_project_script"] as const;

const nullableText = (description: string) => ({ type: ["string", "null"], description });

export const CLOUD_TOOLS: readonly ToolDefinition[] = [
    {
        name: "list_cloud_projects", title: "List cloud projects", kind: "host", origin: "studio", readOnly: true,
        description: "Lists the signed-in account's OpenNan cloud projects, most recently edited first (or the trash), with their length, media size, and the device that edited them last.",
        inputSchema: objectOf({
            trash: bool("List the trash (projects deleted in the last 7 days) instead."),
            cursor: str("next_cursor from the page before, for the next page."),
        }),
    },
    {
        name: "save_project_to_cloud", title: "Save project to OpenNan", kind: "host", origin: "studio", readOnly: false,
        description: "Moves the open local project to the account's OpenNan cloud projects: its media is uploaded once (files the account already has are reused), the cloud project keeps the same items, and the editor opens it. From then on edits sync to every signed-in device.",
        inputSchema: objectOf({}),
    },
    {
        name: "open_cloud_project", title: "Open cloud project", kind: "host", origin: "studio", readOnly: true,
        description: "Opens one of the account's OpenNan cloud projects in the editor; later tool calls edit it, and those edits sync and undo like the person's own.",
        inputSchema: objectOf({ project_id: str("Cloud project id, as list_cloud_projects gives it (\"cloud-…\").") }, ["project_id"]),
    },
    {
        name: "get_cloud_sync_status", title: "Cloud sync status", kind: "host", origin: "studio", readOnly: true,
        description: "Reports whether a cloud project is saved, syncing, offline (with how many edits wait on this device), in conflict (with the edits that were not applied), or needs a sign-in or more storage.",
        inputSchema: objectOf({ project_id: str("Cloud project id; omit for the open project.") }),
    },
    {
        name: "plan_scenes", title: "Plan scenes", kind: "host", origin: "studio", readOnly: false,
        description: "Builds the scenes of the open OpenNan cloud project from the script or subtitles stored on it (set_project_script). OpenNan quotes the plan before it runs; the new scenes arrive as one undo step.",
        inputSchema: objectOf({
            style: str("Look of every scene (default: the project's style)."),
            concept: str("Story the scenes follow (default: the project's concept)."),
            direction: str("Setting, mood, and context shared by all scenes."),
            accept_max_usd: acceptMaxUsd,
            dry_run: bool("Only ask OpenNan for the price."),
        }),
    },
    {
        name: "set_project_script", title: "Set project script", kind: "host", origin: "studio", readOnly: false,
        description: "Saves a script text, SRT subtitles, or both on the open OpenNan cloud project for plan_scenes to plan from. Scenes are left unchanged; null clears a field.",
        inputSchema: objectOf({
            script_text: nullableText("Plain script text (null clears it)."),
            srt_content: nullableText("Subtitles in SRT format, timed cues (null clears them)."),
        }),
    },
    {
        name: "create_share_link", title: "Create share link", kind: "host", origin: "studio", readOnly: false,
        description: "Makes the open OpenNan cloud project's view-only link on opennan.com (anyone with it can watch the project's latest export, or its scenes in order without one; nobody can edit). A project has one active link: a new one replaces it and the old link stops working at once. A public link: OpenNan Studio first asks the person to allow it (unless they chose \"Let agents create share links without asking\" in Settings); a declined or unanswered request (2 minutes) makes no link and answers an error. It needs the OpenNan Studio app (headless mcp serve cannot ask). Answers the link to give to people.",
        inputSchema: objectOf({
            expires_in_days: { ...int("Days the link works, 1–365 (default 30)."), minimum: 1, maximum: 365 },
            allow_download: bool("Let viewers download the video (default false: they can only watch)."),
        }),
    },
    {
        name: "list_share_links", title: "List share links", kind: "host", origin: "studio", readOnly: true,
        description: "Lists the open OpenNan cloud project's share links, newest first: the active one with its link, and earlier ones turned off or expired, each with its views and when it was last viewed.",
        inputSchema: objectOf({}),
    },
    {
        name: "revoke_share_link", title: "Turn off share link", kind: "host", origin: "studio", readOnly: false,
        description: "Turns off the open OpenNan cloud project's share link (people who have it can no longer watch). Without share_id it stops sharing the project and answers exactly the links it turned off (expired links stay as they are). No confirmation is needed.",
        inputSchema: objectOf({ share_id: { ...str("A link's id from list_share_links (shr_…); omit to turn off the active link."), pattern: "^shr_[0-9a-f]{24}$" } }),
    },
];
