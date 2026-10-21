// Unit tests for timeline undo/redo queueing behavior.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EDITOR_TIMELINE_HISTORY_COALESCE_DELAY_MS,
  createEditorTimelineHistoryQueue,
  createTimelineHistoryQueue,
} from "./timeline-history";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("createTimelineHistoryQueue", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs rapid history actions sequentially without dropping them", async () => {
    const first = deferred();
    const calls: string[] = [];
    const queue = createTimelineHistoryQueue({ coalesceDelayMs: 0 });

    const undoPromise = queue.run("undo", async (steps) => {
      calls.push(`undo:${steps}:start`);
      await first.promise;
      calls.push(`undo:${steps}:end`);
    });
    const redoPromise = queue.run("redo", async (steps) => {
      calls.push(`redo:${steps}`);
    });

    await Promise.resolve();
    expect(calls).toEqual(["undo:1:start"]);

    first.resolve();
    await Promise.all([undoPromise, redoPromise]);

    expect(calls).toEqual(["undo:1:start", "undo:1:end", "redo:1"]);
  });

  it("coalesces rapid same-direction history actions into one batch", async () => {
    const calls: string[] = [];
    const queue = createTimelineHistoryQueue({ coalesceDelayMs: 0 });

    const first = queue.run("undo", async (steps) => {
      calls.push(`undo:${steps}`);
    });
    const second = queue.run("undo", async (steps) => {
      calls.push(`undo:${steps}`);
    });
    const third = queue.run("undo", async (steps) => {
      calls.push(`undo:${steps}`);
    });

    await Promise.all([first, second, third]);

    expect(calls).toEqual(["undo:3"]);
  });

  it("runs an explicit multi-step history action as one backend call", async () => {
    const calls: string[] = [];
    const queue = createTimelineHistoryQueue({ coalesceDelayMs: 0 });

    await queue.run("undo", async (steps) => {
      calls.push(`undo:${steps}`);
    }, 5);

    expect(calls).toEqual(["undo:5"]);
  });

  it("splits oversized explicit history actions at the backend step limit", async () => {
    const calls: string[] = [];
    const queue = createTimelineHistoryQueue({ coalesceDelayMs: 0 });

    await queue.run("redo", async (steps) => {
      calls.push(`redo:${steps}`);
    }, 250);

    expect(calls).toEqual(["redo:100", "redo:100", "redo:50"]);
  });

  it("splits oversized coalesced same-direction history batches at the backend step limit", async () => {
    const calls: string[] = [];
    const queue = createTimelineHistoryQueue({ coalesceDelayMs: 0 });

    const first = queue.run("undo", async (steps) => {
      calls.push(`undo:${steps}`);
    }, 80);
    const second = queue.run("undo", async (steps) => {
      calls.push(`undo:${steps}`);
    }, 80);

    await Promise.all([first, second]);

    expect(calls).toEqual(["undo:100", "undo:60"]);
  });

  it("keeps the batching window when same-direction history input queues behind an in-flight call", async () => {
    vi.useFakeTimers();
    const first = deferred();
    const calls: string[] = [];
    const queue = createTimelineHistoryQueue({ coalesceDelayMs: 16 });

    const active = queue.run("undo", async (steps) => {
      calls.push(`undo:${steps}:start`);
      await first.promise;
      calls.push(`undo:${steps}:end`);
    });

    await vi.advanceTimersByTimeAsync(16);
    expect(calls).toEqual(["undo:1:start"]);

    const queued = queue.run("undo", async (steps) => {
      calls.push(`undo:${steps}`);
    });

    first.resolve();
    await Promise.resolve();

    const late = queue.run("undo", async (steps) => {
      calls.push(`undo:${steps}`);
    });

    await vi.advanceTimersByTimeAsync(16);
    await Promise.all([active, queued, late]);

    expect(calls).toEqual(["undo:1:start", "undo:1:end", "undo:2"]);
  });

  it("waits briefly before draining so keyboard-repeat undo collapses into one backend call", async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    const queue = createTimelineHistoryQueue();

    const first = queue.run("undo", async (steps) => {
      calls.push(`undo:${steps}`);
    });

    await Promise.resolve();
    expect(calls).toEqual([]);

    const second = queue.run("undo", async (steps) => {
      calls.push(`undo:${steps}`);
    });
    const third = queue.run("undo", async (steps) => {
      calls.push(`undo:${steps}`);
    });

    await vi.advanceTimersByTimeAsync(20);
    await Promise.all([first, second, third]);

    expect(calls).toEqual(["undo:3"]);
  });

  it("cancels opposite rapid history actions before they hit the backend", async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    const queue = createTimelineHistoryQueue();

    const undo = queue.run("undo", async (steps) => {
      calls.push(`undo:${steps}`);
    });
    const redo = queue.run("redo", async (steps) => {
      calls.push(`redo:${steps}`);
    });

    await vi.advanceTimersByTimeAsync(20);
    await Promise.all([undo, redo]);

    expect(calls).toEqual([]);
  });

  it("nets mixed rapid history actions to the remaining direction", async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    const queue = createTimelineHistoryQueue();

    const first = queue.run("undo", async (steps) => {
      calls.push(`undo:${steps}`);
    });
    const second = queue.run("undo", async (steps) => {
      calls.push(`undo:${steps}`);
    });
    const third = queue.run("redo", async (steps) => {
      calls.push(`redo:${steps}`);
    });

    await vi.advanceTimersByTimeAsync(20);
    await Promise.all([first, second, third]);

    expect(calls).toEqual(["undo:1"]);
  });

  it("nets oversized opposite rapid history actions across backend-sized chunks", async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    const queue = createTimelineHistoryQueue();

    const undo = queue.run("undo", async (steps) => {
      calls.push(`undo:${steps}`);
    }, 250);
    const redo = queue.run("redo", async (steps) => {
      calls.push(`redo:${steps}`);
    }, 120);

    await vi.advanceTimersByTimeAsync(20);
    await Promise.all([undo, redo]);

    expect(calls).toEqual(["undo:100", "undo:30"]);
  });

  it("batches same-tick editor history input without adding a timer delay", async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    const queue = createEditorTimelineHistoryQueue();

    const first = queue.run("undo", async (steps) => {
      calls.push(`undo:${steps}`);
    });
    const second = queue.run("undo", async (steps) => {
      calls.push(`undo:${steps}`);
    });

    expect(calls).toEqual([]);

    await Promise.resolve();
    await Promise.all([first, second]);

    expect(calls).toEqual(["undo:2"]);
  });

  it("starts editor history actions on the next microtask", async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    const queue = createEditorTimelineHistoryQueue();
    const done = queue.run("redo", async (steps) => {
      calls.push(`redo:${steps}`);
    });

    expect(calls).toEqual([]);

    await Promise.resolve();
    await done;

    expect(calls).toEqual(["redo:1"]);
  });

  it("runs immediate history actions without waiting for the keyboard-repeat batching window", async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    const queue = createEditorTimelineHistoryQueue();
    const done = queue.runNow("undo", async (steps) => {
      calls.push(`undo:${steps}`);
    });

    await Promise.resolve();
    await done;

    expect(calls).toEqual(["undo:1"]);
  });

  it("allows immediate history runner to be passed around without losing queue context", async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    const { runNow } = createEditorTimelineHistoryQueue();
    const done = runNow("redo", async (steps) => {
      calls.push(`redo:${steps}`);
    });

    await Promise.resolve();
    await done;

    expect(calls).toEqual(["redo:1"]);
  });

  it("cancels same-tick editor undo and redo before hitting the backend", async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    const queue = createEditorTimelineHistoryQueue();

    const undo = queue.run("undo", async (steps) => {
      calls.push(`undo:${steps}`);
    });
    const redo = queue.run("redo", async (steps) => {
      calls.push(`redo:${steps}`);
    });

    await Promise.resolve();
    await Promise.all([undo, redo]);

    expect(calls).toEqual([]);
  });

  it("cancels pending keyboard history before an immediate toolbar history action runs", async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    const queue = createEditorTimelineHistoryQueue();

    const queued = queue.run("undo", async (steps) => {
      calls.push(`undo:${steps}`);
    });

    queue.cancelPending();
    calls.push("toolbar-redo");

    await Promise.resolve();
    await queued;

    expect(calls).toEqual(["toolbar-redo"]);
  });

  it("merges pending same-direction keyboard history into an immediate toolbar history action", async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    const queue = createEditorTimelineHistoryQueue();

    const queued = queue.run("undo", async (steps) => {
      calls.push(`keyboard:${steps}`);
    });

    const immediate = queue.runNow("undo", async (steps) => {
      calls.push(`toolbar:${steps}`);
    });

    await Promise.all([queued, immediate]);

    expect(calls).toEqual(["toolbar:2"]);
  });

  it("keeps the editor history coalescing delay at zero for real-time preview feedback", () => {
    expect(EDITOR_TIMELINE_HISTORY_COALESCE_DELAY_MS).toBe(0);
  });

  it("keeps keyboard history batching under one 60fps frame", () => {
    expect(EDITOR_TIMELINE_HISTORY_COALESCE_DELAY_MS).toBeLessThanOrEqual(16);
  });

  it("keeps keyboard history batching under half a 60fps frame", () => {
    expect(EDITOR_TIMELINE_HISTORY_COALESCE_DELAY_MS).toBeLessThanOrEqual(8);
  });

  it("keeps keyboard history batching under a quarter of a 60fps frame", () => {
    expect(EDITOR_TIMELINE_HISTORY_COALESCE_DELAY_MS).toBeLessThanOrEqual(4);
  });
});
