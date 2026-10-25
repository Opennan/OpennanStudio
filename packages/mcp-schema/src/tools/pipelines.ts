// OpenNan project pipeline tools (phase 9b, origin "studio"): plan_scenes and set_project_script (Studio tools named
// like the server director's own) start the story plan and store the script; with the seven OpenNan pipeline tools
// they make the project pipeline tools. OpenNan runs these only on a project stored on its server, and OpenNan Studio
// keeps projects on the device, so every current host answers them as unavailable. They stay listed until OpenNan
// offers the pipelines as project-free tools.
import { bool, objectOf, str } from "../json-schema";
import type { ToolDefinition } from "../types";
import { acceptMaxUsd } from "./capability";

/** OpenNan-named capability tools that OpenNan runs as project pipelines on its server-side projects (phase 9b). */
export const OPENNAN_PIPELINE_TOOLS = [
    "generate_storyboard", "generate_scene_videos_smart", "detect_copy_video_shots", "set_copy_video_source", "edit_copy_video_shot_description",
    "edit_copy_video_shot_image", "generate_video_from_panels",
] as const;

/** Every tool answered by the host's project pipelines: the OpenNan ones plus plan_scenes and set_project_script. */
export const PROJECT_PIPELINE_TOOLS = [...OPENNAN_PIPELINE_TOOLS, "plan_scenes", "set_project_script"] as const;

const nullableText = (description: string) => ({ type: ["string", "null"], description });

export const PIPELINE_TOOLS: readonly ToolDefinition[] = [
    {
        name: "plan_scenes", title: "Plan scenes", kind: "host", origin: "studio", readOnly: false,
        description: "Builds the scenes of a project stored on OpenNan from the script or subtitles stored on it (set_project_script). OpenNan quotes the plan before it runs. Not available in OpenNan Studio, whose projects stay on this device.",
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
        description: "Saves a script text, SRT subtitles, or both on a project stored on OpenNan for plan_scenes to plan from. Scenes are left unchanged; null clears a field. Not available in OpenNan Studio, whose projects stay on this device.",
        inputSchema: objectOf({
            script_text: nullableText("Plain script text (null clears it)."),
            srt_content: nullableText("Subtitles in SRT format, timed cues (null clears them)."),
        }),
    },
];
