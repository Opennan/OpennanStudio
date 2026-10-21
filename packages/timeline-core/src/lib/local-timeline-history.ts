// Local-first undo/redo stack for timeline snapshots.
export interface LocalTimelineHistory<TSnapshot> {
  /** Returns an entry token when recorded, or null when before === after. */
  record: (before: TSnapshot, after: TSnapshot) => number | null;
  undo: (steps?: number) => TSnapshot | null;
  redo: (steps?: number) => TSnapshot | null;
  canUndo: () => boolean;
  canRedo: () => boolean;
  clear: () => void;
  /** Remove a specific recorded entry (by token) — used when the server
   * rejects the optimistic edit that produced it, so undo/redo never replays
   * a change that was rolled back. */
  dropEntry: (token: number) => boolean;
  /** Rewrite snapshots in place via a mapper — used to swap optimistic temp
   * ids for real server ids so redo never resurrects unpersistable clips. */
  mapSnapshots: (mapper: (snapshot: TSnapshot) => TSnapshot) => void;
}

type HistoryEntry<TSnapshot> = {
  before: TSnapshot;
  after: TSnapshot;
  token: number;
};

function cloneSnapshot<TSnapshot>(snapshot: TSnapshot): TSnapshot {
  // structuredClone avoids the serialize-then-parse round trip (and the large
  // intermediate string + GC pressure) that JSON cloning incurs on big
  // timelines. Fall back to JSON for older runtimes.
  if (typeof structuredClone === "function") {
    try {
      return structuredClone(snapshot);
    } catch {
      // Fall through to JSON clone for non-cloneable values.
    }
  }
  return JSON.parse(JSON.stringify(snapshot)) as TSnapshot;
}

function normalizeSteps(steps = 1): number {
  const raw = Number(steps);
  return Math.max(1, Math.floor(Number.isFinite(raw) ? raw : 1));
}

export function createLocalTimelineHistory<TSnapshot>(limit = 50): LocalTimelineHistory<TSnapshot> {
  const undoStack: Array<HistoryEntry<TSnapshot>> = [];
  const redoStack: Array<HistoryEntry<TSnapshot>> = [];
  const maxEntries = Math.max(1, Math.floor(limit));
  let nextToken = 1;

  return {
    record(before, after) {
      if (JSON.stringify(before) === JSON.stringify(after)) return null;
      const token = nextToken++;
      undoStack.push({ before: cloneSnapshot(before), after: cloneSnapshot(after), token });
      while (undoStack.length > maxEntries) undoStack.shift();
      redoStack.length = 0;
      return token;
    },
    dropEntry(token) {
      for (const stack of [undoStack, redoStack]) {
        const index = stack.findIndex((entry) => entry.token === token);
        if (index >= 0) {
          stack.splice(index, 1);
          return true;
        }
      }
      return false;
    },
    mapSnapshots(mapper) {
      for (const stack of [undoStack, redoStack]) {
        for (const entry of stack) {
          entry.before = mapper(entry.before);
          entry.after = mapper(entry.after);
        }
      }
    },
    undo(steps = 1) {
      let snapshot: TSnapshot | null = null;
      const count = normalizeSteps(steps);
      for (let i = 0; i < count; i += 1) {
        const entry = undoStack.pop();
        if (!entry) break;
        redoStack.push(entry);
        snapshot = entry.before;
      }
      return snapshot ? cloneSnapshot(snapshot) : null;
    },
    redo(steps = 1) {
      let snapshot: TSnapshot | null = null;
      const count = normalizeSteps(steps);
      for (let i = 0; i < count; i += 1) {
        const entry = redoStack.pop();
        if (!entry) break;
        undoStack.push(entry);
        snapshot = entry.after;
      }
      return snapshot ? cloneSnapshot(snapshot) : null;
    },
    canUndo() {
      return undoStack.length > 0;
    },
    canRedo() {
      return redoStack.length > 0;
    },
    clear() {
      undoStack.length = 0;
      redoStack.length = 0;
    },
  };
}
