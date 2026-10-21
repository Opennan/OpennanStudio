// Local-first undo/redo stack for SCENE state.
//
// Timeline clips already have a local stack (local-timeline-history.ts), but
// scene edits — moves, trims, retimes, deletes — only existed server-side, so
// Ctrl+Z had to wait for the undo mutation (~2s) plus a full editor refetch
// (~1s) before anything moved on screen. This stack lets the editor repaint the
// previous scene state on the same frame as the keypress and reconcile with the
// server afterwards.
//
// It stores STATES with a cursor (not diffs): each recorded state is the whole
// scene list at that moment, so restoring is a plain assignment and a late
// server payload that matches the cursor state is a no-op instead of a new
// history entry.

export type SceneRow = Record<string, unknown> & { id: string };

/** Fields the timeline and properties panel actually render. Anything outside
 *  this list (media urls rewritten by generation, status flags) must NOT make a
 *  scene edit look like a user action — those land via polling, constantly. */
// `order` is deliberately absent: the editor recomputes it from position and
// track on every render, so tracking it would make a restored state fail to
// match its own snapshot and drift the undo cursor.
export const SCENE_HISTORY_FIELDS = [
    "trackIndex",
    "timelinePositionSeconds",
    "duration",
    "startTime",
    "endTime",
    "caption",
    "cardConfig",
    "shotBreakdown",
    "transition",
] as const;

export function sceneStateSignature(scenes: readonly SceneRow[]): string {
    const parts: string[] = [];
    for (const scene of scenes) {
        parts.push(String(scene.id));
        for (const field of SCENE_HISTORY_FIELDS) {
            const value = scene[field];
            parts.push(value === undefined || value === null ? "" : String(value));
        }
    }
    return parts.join("");
}

function cloneScenes(scenes: readonly SceneRow[]): SceneRow[] {
    // Shallow per-row copy: history only reads the flat fields above, and the
    // nested payloads (cardConfig/shotBreakdown) are JSON strings already.
    return scenes.map((scene) => ({ ...scene }));
}

export interface LocalSceneHistory {
    /** Record a new state. No-op when it matches the state at the cursor. */
    record: (scenes: readonly SceneRow[]) => boolean;
    /** Previous state, or null when there is nothing to undo. */
    undo: (steps?: number) => SceneRow[] | null;
    /** Next state, or null when there is nothing to redo. */
    redo: (steps?: number) => SceneRow[] | null;
    canUndo: () => boolean;
    canRedo: () => boolean;
    clear: () => void;
    size: () => number;
}

function normalizeSteps(steps = 1): number {
    const raw = Number(steps);
    return Math.max(1, Math.floor(Number.isFinite(raw) ? raw : 1));
}

export function createLocalSceneHistory(limit = 40): LocalSceneHistory {
    const states: Array<{ scenes: SceneRow[]; signature: string }> = [];
    const maxEntries = Math.max(2, Math.floor(limit));
    let cursor = -1;

    return {
        record(scenes) {
            const signature = sceneStateSignature(scenes);
            if (cursor >= 0 && states[cursor]?.signature === signature) return false;
            // A new edit invalidates everything ahead of the cursor.
            states.length = cursor + 1;
            states.push({ scenes: cloneScenes(scenes), signature });
            while (states.length > maxEntries) states.shift();
            cursor = states.length - 1;
            return true;
        },
        undo(steps = 1) {
            const count = normalizeSteps(steps);
            const target = Math.max(0, cursor - count);
            if (cursor <= 0 || target === cursor) return null;
            cursor = target;
            return cloneScenes(states[cursor].scenes);
        },
        redo(steps = 1) {
            const count = normalizeSteps(steps);
            const target = Math.min(states.length - 1, cursor + count);
            if (cursor < 0 || target === cursor) return null;
            cursor = target;
            return cloneScenes(states[cursor].scenes);
        },
        canUndo() {
            return cursor > 0;
        },
        canRedo() {
            return cursor >= 0 && cursor < states.length - 1;
        },
        clear() {
            states.length = 0;
            cursor = -1;
        },
        size() {
            return states.length;
        },
    };
}
