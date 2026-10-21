import type { ToolDefinition } from "@opennan/mcp-schema";
import type { Args } from "../args";
import type { ToolOutcome } from "../outcome";
import type { StudioSession } from "../session";
import type { ToolCallHistory } from "../tool-calls";

export interface ToolContext {
    session: StudioSession;
    tool: ToolDefinition;
    /** Undo groups of this session's tool calls (undo_last_edit reads and updates them). */
    history: ToolCallHistory;
    /** Aborted when the call times out (StudioMcpServerOptions.callTimeoutMs) or the client cancels it. */
    signal: AbortSignal;
}

export type ToolHandler = (args: Args, context: ToolContext) => Promise<ToolOutcome>;
