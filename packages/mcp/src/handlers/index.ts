// Handler registry: one handler per tool in @opennan/mcp-schema STUDIO_TOOLS.
import { CAPABILITY_TOOLS, STUDIO_CAPABILITY_TOOLS } from "@opennan/mcp-schema";
import { AI_TOOL_HANDLERS } from "./ai-tools";
import { ANALYSIS_HANDLERS } from "./analysis";
import { capabilityUnavailable } from "./capability";
import { CLIP_HANDLERS } from "./clips";
import { EDITOR_HANDLERS } from "./editor";
import { GENERATE_HANDLERS } from "./generate";
import { LOOK_HANDLERS } from "./looks";
import { MEDIA_HANDLERS } from "./media";
import { MOTION_HANDLERS } from "./motion";
import { PIPELINE_HANDLERS } from "./pipelines";
import { READ_HANDLERS } from "./read";
import { SCENE_HANDLERS } from "./scenes";
import { STORY_FILM_HANDLERS } from "./story-film";
import { TRACKING_HANDLERS } from "./tracking";
import { TRANSCRIBE_HANDLERS } from "./transcribe";
import type { ToolHandler } from "./types";

export const TOOL_HANDLERS: Readonly<Record<string, ToolHandler>> = {
    ...READ_HANDLERS,
    ...CLIP_HANDLERS,
    ...MEDIA_HANDLERS,
    ...SCENE_HANDLERS,
    ...EDITOR_HANDLERS,
    ...LOOK_HANDLERS,
    ...MOTION_HANDLERS,
    ...TRACKING_HANDLERS,
    ...ANALYSIS_HANDLERS,
    ...Object.fromEntries([...CAPABILITY_TOOLS, ...STUDIO_CAPABILITY_TOOLS].map((tool) => [tool.name, capabilityUnavailable])),
    // Capability tools that run through ai.run: real where the host has a provider, unavailable elsewhere.
    ...TRANSCRIBE_HANDLERS,
    ...GENERATE_HANDLERS,
    // Phase 11: the editor's AI tools (priced first), estimate_cost, check_generation_status, list_voices.
    ...AI_TOOL_HANDLERS,
    // Phase 9b: OpenNan project pipelines (and plan_scenes / set_project_script); no current host supplies them.
    ...PIPELINE_HANDLERS,
    // Story film: a consistent-character animated short in a reel frame, over the host's providers.
    ...STORY_FILM_HANDLERS,
};

export type { ToolContext, ToolHandler } from "./types";
