// Per-StudioSession tool-call state, shared by every MCP Server over that session
// (the HTTP host runs one Server per MCP session). Calls run one at a time, in
// arrival order: handlers read the snapshot, compute a whole value, and write it
// back. Each call's undo entries are counted so undo_last_edit undoes whole calls.
import type { HistoryDepth } from "@opennan/timeline-core";
import type { StudioSession } from "./session";

export interface ToolCallHistory {
    /** Undo entries added by each recent tool call, oldest first. */
    groups: number[];
    /** historyDepth() when the last call ended; entries recorded after it came from elsewhere. */
    last: HistoryDepth | null;
    /** Set by undo_last_edit after it removed the groups it undid. */
    undoneByTool: boolean;
}

interface SessionCalls {
    tail: Promise<void>;
    history: ToolCallHistory;
}

const SESSIONS = new WeakMap<StudioSession, SessionCalls>();

function sessionCalls(session: StudioSession): SessionCalls {
    let calls = SESSIONS.get(session);
    if (!calls) {
        calls = { tail: Promise.resolve(), history: { groups: [], last: null, undoneByTool: false } };
        SESSIONS.set(session, calls);
    }
    return calls;
}

export function toolCallHistory(session: StudioSession): ToolCallHistory {
    return sessionCalls(session).history;
}

/** Runs `run` once every earlier call on this session has finished. */
export async function runSerialized<T>(session: StudioSession, run: () => Promise<T>): Promise<T> {
    const calls = sessionCalls(session);
    const previous = calls.tail;
    let release!: () => void;
    calls.tail = new Promise<void>((resolve) => {
        release = resolve;
    });
    await previous;
    try {
        return await run();
    } finally {
        release();
    }
}

const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);

/** Drops the oldest groups (or part of one) that fell off the undo limit. */
function trim(history: ToolCallHistory, undoDepth: number): void {
    let excess = sum(history.groups) - undoDepth;
    while (excess > 0 && history.groups.length > 0) {
        if (history.groups[0] <= excess) {
            excess -= history.groups.shift() as number;
        } else {
            history.groups[0] -= excess;
            excess = 0;
        }
    }
}

/**
 * Before a call: entries recorded since the last call (edits in the editor UI) count
 * as one call each; an undo or redo made elsewhere resets the groups to single steps.
 */
export function reconcileHistory(history: ToolCallHistory, depth: HistoryDepth): void {
    const last = history.last;
    if (last) {
        const external = depth.recorded - last.recorded;
        if (external > 0) history.groups.push(...Array.from({ length: external }, () => 1));
        else if (depth.undo !== last.undo || depth.redo !== last.redo) history.groups = [];
    }
    trim(history, depth.undo);
}

/** After a call: the entries it added become one group. */
export function recordToolCall(history: ToolCallHistory, before: HistoryDepth, after: HistoryDepth): void {
    const added = after.recorded - before.recorded;
    if (added > 0) {
        history.groups.push(added);
    } else if (!history.undoneByTool && (after.undo !== before.undo || after.redo !== before.redo)) {
        // history.undo/redo through run_editor_command moves raw entries.
        history.groups = [];
    }
    history.undoneByTool = false;
    trim(history, after.undo);
    history.last = after;
}

/** After a call whose own entries the server undid: nothing to group; the undo stack shrank. */
export function recordRolledBack(history: ToolCallHistory, after: HistoryDepth): void {
    history.undoneByTool = false;
    trim(history, after.undo);
    history.last = after;
}

/**
 * Undo entries that cover the last `calls` tool calls. Entries older than every
 * group (recorded before this server saw them) count as one call each.
 */
export function undoStepsFor(history: ToolCallHistory, calls: number, undoDepth: number): number {
    const grouped = history.groups.slice(-calls);
    const ungrouped = Math.max(0, undoDepth - sum(history.groups));
    return Math.min(undoDepth, sum(grouped) + Math.min(ungrouped, calls - grouped.length));
}
