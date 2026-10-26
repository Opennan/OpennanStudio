// createStudioMcpServer: a host-agnostic MCP server over a StudioSession.
// Tools and their JSON schemas come from @opennan/mcp-schema; the low-level SDK
// Server is used because those schemas are JSON Schema, not zod.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError, type CallToolResult, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { OPENNAN_PIPELINE_TOOLS, PIPELINE_TOOLS, STUDIO_TOOLS, capabilityUnavailableMessage, type ToolDefinition } from "@opennan/mcp-schema";
import Ajv from "ajv";
import { presentFields, type Args } from "./args";
import { TOOL_HANDLERS, type ToolHandler } from "./handlers";
import { failure, toCallToolResult, unavailable, type ToolOutcome } from "./outcome";
import type { StudioSession } from "./session";
import { reconcileHistory, recordRolledBack, recordToolCall, runSerialized, toolCallHistory } from "./tool-calls";
import { MCP_VERSION } from "./version";

export const SERVER_NAME = "opennan-studio";

/** A tool call that takes longer answers a timeout error and frees the session's queue. */
export const DEFAULT_CALL_TIMEOUT_MS = 10 * 60_000;

export type ToolPreset = "all" | "offline";

/** "offline": only the tools that run without a provider or an OpenNan account (the editor and studio tools, not the OpenNan project pipelines). */
export function toolsForPreset(preset: ToolPreset = "all"): readonly ToolDefinition[] {
    return STUDIO_TOOLS.filter((tool) => !PIPELINE_TOOLS.includes(tool) && !(OPENNAN_PIPELINE_TOOLS as readonly string[]).includes(tool.name) && (preset !== "offline" || tool.kind !== "capability"));
}

export const SERVER_INSTRUCTIONS =
    "OpenNan Studio editor tools. read_timeline shows the project. scene_order is 1-based, shot_index 0-based, times are timeline seconds.";

export interface StudioMcpServerOptions {
    /** Default STUDIO_TOOLS; toolsForPreset("offline") for the offline tools. */
    tools?: readonly ToolDefinition[];
    handlers?: Readonly<Record<string, ToolHandler>>;
    /** Default DEFAULT_CALL_TIMEOUT_MS (10 minutes). */
    callTimeoutMs?: number;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function toMcpTool(tool: ToolDefinition): Tool {
    return {
        name: tool.name,
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema as Tool["inputSchema"],
        annotations: {
            title: tool.title,
            readOnlyHint: tool.readOnly,
            destructiveHint: tool.destructive ?? false,
            idempotentHint: tool.readOnly,
            openWorldHint: tool.kind === "capability",
        },
    };
}

export function createStudioMcpServer(session: StudioSession, options: StudioMcpServerOptions = {}): Server {
    const tools = options.tools ?? toolsForPreset();
    const handlers = options.handlers ?? TOOL_HANDLERS;
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    const ajv = new Ajv({ strict: false, allErrors: true });
    const validators = new Map(tools.map((tool) => [tool.name, ajv.compile(tool.inputSchema)]));
    const listed = tools.map(toMcpTool);
    const callTimeoutMs = options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;

    const server = new Server({ name: SERVER_NAME, version: MCP_VERSION }, { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS });

    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: listed }));

    server.setRequestHandler(CallToolRequestSchema, async (request, extra): Promise<CallToolResult> => {
        const { name } = request.params;
        const tool = byName.get(name);
        if (!tool) throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${name}`);
        const args = (request.params.arguments ?? {}) as Args;
        const validate = validators.get(name);
        if (validate && !validate(args)) {
            return toCallToolResult(failure(`Invalid arguments for ${name}: ${ajv.errorsText(validate.errors, { dataVar: "arguments" })}`));
        }
        if (tool.capabilityFields) {
            const set = presentFields(args, tool.capabilityFields.fields);
            if (set.length > 0) {
                const { capability } = tool.capabilityFields;
                return toCallToolResult(unavailable(`${capabilityUnavailableMessage(name, capability)} These arguments need it: ${set.join(", ")}.`, capability));
            }
        }
        const handler = handlers[name];
        if (!handler) return toCallToolResult(unavailable(`${name} has no handler in this server.`));
        // One call at a time per StudioSession, across every Server over it (tool-calls.ts).
        return runSerialized(session, async () => {
            const history = toolCallHistory(session);
            const before = await session.historyDepth?.();
            if (before) reconcileHistory(history, before);
            const abort = new AbortController();
            const cancel = () => abort.abort();
            extra.signal.addEventListener("abort", cancel, { once: true });
            let timer: ReturnType<typeof setTimeout> | undefined;
            const timedOut = new Promise<ToolOutcome>((resolve) => {
                timer = setTimeout(() => {
                    abort.abort();
                    resolve(failure(
                        `${name} did not finish within ${callTimeoutMs / 1000} s and was stopped waiting; edits it made so far stay (undo_last_edit undoes them).`,
                        { timedOut: true },
                    ));
                }, callTimeoutMs);
            });
            let outcome: ToolOutcome;
            try {
                outcome = await Promise.race([handler(args, { session, tool, history, signal: abort.signal }), timedOut]);
            } catch (error) {
                outcome = failure(error instanceof Error ? error.message : String(error));
            } finally {
                clearTimeout(timer);
                extra.signal.removeEventListener("abort", cancel);
            }
            let after = before ? await session.historyDepth?.() : undefined;
            const added = before && after ? after.recorded - before.recorded : 0;
            // A call that failed part way is undone as a whole, so it changes nothing. Only when every
            // entry it recorded is still on the undo stack; a timed-out handler may still be running.
            if (!outcome.ok && !outcome.unavailable && !outcome.data?.timedOut && after && added > 0 && after.undo >= added) {
                const undone = await session.execute({ type: "history.undo", steps: added });
                outcome = undone.ok
                    ? { ...outcome, text: `${outcome.text} Undid the ${plural(added, "edit")} this call made before it failed.`, data: { ...outcome.data, rolledBack: added } }
                    : { ...outcome, text: `${outcome.text} Undoing the ${plural(added, "edit")} this call made also failed (${undone.error ?? "unknown error"}); undo_last_edit can retry.`, data: { ...outcome.data, rolledBack: 0 } };
                after = await session.historyDepth?.();
                if (undone.ok && after) {
                    recordRolledBack(history, after);
                    return toCallToolResult(outcome);
                }
            }
            if (before && after) recordToolCall(history, before, after);
            return toCallToolResult(outcome);
        });
    });

    return server;
}
