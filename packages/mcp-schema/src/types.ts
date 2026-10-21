import type { ToolCapability } from "./capabilities";
import type { ObjectSchema } from "./json-schema";

/**
 * read: answers from the read API. command: runs EditorCommands.
 * host: needs the editor UI (desktop/web host). capability: needs a provider.
 */
export type ToolKind = "read" | "command" | "host" | "capability";

/** Read APIs a handler uses (spec §5.1.1), plus the host's export job states (StudioSession.exportStatus). */
export type ReadApi = "snapshot" | "describeTimeline" | "previewFrame" | "uiState" | "listEffects" | "exportStatus"
    /** The built-in looks catalog (transitions, filters, adjustments): static, part of every host. */
    | "looksCatalog"
    /** The built-in motion catalog (text templates, fonts, caption styles, animations, stickers): static, part of every host. */
    | "motionCatalog";

export interface ToolDefinition {
    name: string;
    title: string;
    /** What the tool does, in one or two sentences. No usage policy. */
    description: string;
    kind: ToolKind;
    inputSchema: ObjectSchema;
    /** EditorCommand types the handler may execute. */
    commands?: readonly string[];
    reads?: readonly ReadApi[];
    /** Set for kind "capability". */
    capability?: ToolCapability;
    /**
     * Arguments of an offline tool that need a provider. A call that sets any of
     * them is refused as unavailable. "a[].b" names field b of items of array a.
     */
    capabilityFields?: { fields: readonly string[]; capability: ToolCapability };
    readOnly: boolean;
    destructive?: boolean;
    /** "opennan": name from the OpenNan toolset. "studio": added by OpenNan Studio. */
    origin: "opennan" | "studio";
}

/** OpenNan chat tools that the MCP server does not expose, with the reason. */
export interface NotExposedTool {
    name: string;
    reason: string;
}
