// Per-device undo for a cloud project: one entry per backend write call (TimelineBackend.undo counts calls), each the
// server-space delta of that write. Undo applies an entry's inverse only where the field still holds the entry's
// after, so another device's or an agent's later edit is kept; the result is an ordinary edit that syncs forward.
// The server's project-wide /timeline/undo is never used.
import type { ServerDoc } from "./codec";
import { invertDelta, undoDelta, type Delta } from "./delta";
import { mapStrings } from "./json";

export interface HistoryResult {
    doc: ServerDoc;
    skipped: Array<{ key: string; field: string }>;
}

export class DeltaHistory {
    private undoStack: Delta[] = [];
    private redoStack: Delta[] = [];

    constructor(private readonly limit = 100) {}

    record(delta: Delta): void {
        this.undoStack.push(delta);
        if (this.undoStack.length > this.limit) this.undoStack.splice(0, this.undoStack.length - this.limit);
        this.redoStack = [];
    }

    /** The entry the next undo takes back (by identity), if any. */
    newest(): Delta | undefined {
        return this.undoStack[this.undoStack.length - 1];
    }

    canUndo(): boolean {
        return this.undoStack.length > 0;
    }

    canRedo(): boolean {
        return this.redoStack.length > 0;
    }

    depth(): { undo: number; redo: number } {
        return { undo: this.undoStack.length, redo: this.redoStack.length };
    }

    undo(current: ServerDoc, steps = 1): HistoryResult {
        return this.travel(current, steps, this.undoStack, this.redoStack, (entry) => entry, "Nothing to undo");
    }

    redo(current: ServerDoc, steps = 1): HistoryResult {
        return this.travel(current, steps, this.redoStack, this.undoStack, invertDelta, "Nothing to redo");
    }

    /**
     * Rewrites every string in every entry (a local media URL becoming its uploaded URL, a shots version the server
     * answered); returns each rewritten entry's replacement, so holders of an entry can follow it.
     */
    rewrite(map: (text: string) => string): Map<Delta, Delta> {
        const replaced = new Map<Delta, Delta>();
        const follow = (entry: Delta) => {
            const next = mapStrings(entry, map);
            if (next !== entry) replaced.set(entry, next);
            return next;
        };
        this.undoStack = this.undoStack.map(follow);
        this.redoStack = this.redoStack.map(follow);
        return replaced;
    }

    clear(): void {
        this.undoStack = [];
        this.redoStack = [];
    }

    private travel(current: ServerDoc, steps: number, from: Delta[], to: Delta[], orient: (entry: Delta) => Delta, empty: string): HistoryResult {
        if (from.length === 0) throw new Error(empty);
        const count = Math.min(Math.max(1, Math.floor(steps)), from.length);
        let doc = current;
        const skipped: HistoryResult["skipped"] = [];
        for (let i = 0; i < count; i++) {
            const entry = from.pop()!;
            const result = undoDelta(doc, orient(entry));
            doc = result.doc;
            skipped.push(...result.skipped);
            to.push(entry);
        }
        return { doc, skipped };
    }
}
