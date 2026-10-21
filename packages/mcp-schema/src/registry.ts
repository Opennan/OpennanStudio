// The tool registry the MCP server serves, and the coverage of the OpenNan toolset.
import { CAPABILITY_TOOLS } from "./tools/capability";
import { CLOUD_TOOLS } from "./tools/cloud";
import { EDITOR_TOOLS } from "./tools/editor";
import { NOT_EXPOSED_TOOLS } from "./tools/not-exposed";
import { STUDIO_CAPABILITY_TOOLS } from "./tools/studio-capability";
import type { NotExposedTool, ToolDefinition } from "./types";

/** Every tool the MCP server lists: offline editor tools first, then capability tools (OpenNan names, then Studio additions), then cloud projects. */
export const STUDIO_TOOLS: readonly ToolDefinition[] = [...EDITOR_TOOLS, ...CAPABILITY_TOOLS, ...STUDIO_CAPABILITY_TOOLS, ...CLOUD_TOOLS];

const BY_NAME = new Map(STUDIO_TOOLS.map((tool) => [tool.name, tool]));

export function getTool(name: string): ToolDefinition | undefined {
    return BY_NAME.get(name);
}

export type CoverageRow =
    | { name: string; exposed: true; tool: ToolDefinition }
    | { name: string; exposed: false; reason: string };

/** One row per tool name: every MCP tool plus the OpenNan tools that are not exposed. */
export function toolCoverage(): CoverageRow[] {
    const exposed: CoverageRow[] = STUDIO_TOOLS.map((tool) => ({ name: tool.name, exposed: true, tool }));
    const hidden: CoverageRow[] = NOT_EXPOSED_TOOLS.map((tool: NotExposedTool) => ({ name: tool.name, exposed: false, reason: tool.reason }));
    return [...exposed, ...hidden];
}

export { EDITOR_TOOLS, CAPABILITY_TOOLS, STUDIO_CAPABILITY_TOOLS, CLOUD_TOOLS, NOT_EXPOSED_TOOLS };
