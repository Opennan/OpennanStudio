// Public API of @opennan/mcp-schema (Apache-2.0).
export const MCP_SCHEMA_VERSION = "0.13.0";

export {
    OPEN_CAPABILITIES, OPENNAN_CAPABILITIES, PROVIDER_RUNTIME_CAPABILITIES, isToolCapability, isOpenNanCapability,
    isProviderRuntimeCapability, capabilityUnavailableMessage,
    type OpenCapability, type OpenNanCapability, type ProviderRuntimeCapability, type ToolCapability,
} from "./capabilities";
export {
    str, num, int, bool, anyObject, arrayOf, enumOf, objectOf, toSnakeCase, toCamelCase,
    editorType, editorCommandTypes, commandSchema, snakeProperties,
    type JsonSchema, type ObjectSchema, type EditorTypeName,
} from "./json-schema";
export type { ToolDefinition, ToolKind, ReadApi, NotExposedTool } from "./types";
export { CLIP_PLACEMENT_FIELDS, CLIP_CONTENT_FIELDS, CLIP_LOOK_FIELDS, TEXT_STYLE_ARGUMENTS, SCENE_PLANNING_FIELDS } from "./tools/editor";
export {
    TEXT_TEMPLATE_IDS, TEXT_TEMPLATE_CATEGORIES, TEXT_FONT_FAMILIES, CAPTION_STYLE_IDS, STICKER_CATEGORY_IDS, EASING_IDS, KEYFRAME_CHANNELS,
    SPEED_CURVE_IDS, TEXT_STYLE_KEYS, TEXT_STYLE_LIMITS, MASK_KEYFRAME_CHANNELS, MASK_SHAPE_IDS, ATTRIBUTE_KINDS,
} from "./tools/editor";
export { STUDIO_TOOLS, EDITOR_TOOLS, CAPABILITY_TOOLS, STUDIO_CAPABILITY_TOOLS, CLOUD_TOOLS, NOT_EXPOSED_TOOLS, getTool, toolCoverage, type CoverageRow } from "./registry";
export { ESTIMATE_TOOLS } from "./tools/capability";
export { OPENNAN_PIPELINE_TOOLS, PROJECT_PIPELINE_TOOLS, SHARE_TOOLS } from "./tools/cloud";
export { OPENNAN_TOOL_NAMES, type OpenNanToolName } from "./opennan-tool-names";
export { renderCoverageMarkdown } from "./coverage-markdown";
