// Tool results. Handlers return a ToolOutcome; the server turns it into an MCP
// CallToolResult (text + optional images + structuredContent, isError on failure).
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
    DEFAULT_COMMAND_ERROR_MESSAGES, DEFAULT_FALLBACK_ERROR_MESSAGE, type CommandResult, type EditorCommandType, type RenderedFrame,
} from "@opennan/timeline-core";

export interface ToolOutcome {
    ok: boolean;
    text: string;
    data?: Record<string, unknown>;
    images?: RenderedFrame[];
    /** Set when the host or provider lacks what the tool needs (spec §5.4 guidance, not a crash). */
    unavailable?: { reason: string; capability?: string };
}

export function success(text: string, data?: Record<string, unknown>, images?: RenderedFrame[]): ToolOutcome {
    return { ok: true, text, data, images };
}

export function failure(text: string, data?: Record<string, unknown>): ToolOutcome {
    return { ok: false, text, data };
}

export function unavailable(reason: string, capability?: string): ToolOutcome {
    return { ok: false, text: reason, unavailable: { reason, capability } };
}

/** The UI's failure message for a command (controller/messages.ts), followed by the cause. */
export function commandFailureText(type: EditorCommandType, error: string | undefined): string {
    const ui = DEFAULT_COMMAND_ERROR_MESSAGES[type] ?? DEFAULT_FALLBACK_ERROR_MESSAGE;
    return error ? `${ui}: ${error}` : ui;
}

/** Maps a failed CommandResult to an outcome; returns null for ok results. */
export function commandFailure(type: EditorCommandType, result: CommandResult): ToolOutcome | null {
    if (result.ok) return null;
    if (result.unavailable) return unavailable(result.error ?? `${type} is not available in this host`);
    if (result.cancelled) return failure(`${type} was cancelled`);
    if (result.superseded) return failure(`${type} was replaced by a newer edit`);
    return failure(commandFailureText(type, result.error));
}

/** btoa instead of Buffer: this module is part of the runtime-agnostic @opennan/mcp/server entry. */
function toBase64(data: Uint8Array): string {
    let binary = "";
    for (let i = 0; i < data.length; i += 0x8000) binary += String.fromCharCode(...data.subarray(i, i + 0x8000));
    return btoa(binary);
}

export function toCallToolResult(outcome: ToolOutcome): CallToolResult {
    const structured: Record<string, unknown> = { ok: outcome.ok, ...(outcome.data ?? {}) };
    if (outcome.unavailable) {
        structured.unavailable = true;
        structured.reason = outcome.unavailable.reason;
        if (outcome.unavailable.capability) structured.capability = outcome.unavailable.capability;
    }
    if (!outcome.ok && !outcome.unavailable) structured.error = outcome.text;
    return {
        content: [
            { type: "text", text: outcome.text },
            ...(outcome.images ?? []).map((image) => ({ type: "image" as const, data: toBase64(image.data), mimeType: image.mimeType })),
        ],
        structuredContent: structured,
        isError: !outcome.ok,
    };
}
