// Small queue for timeline history actions so rapid undo/redo input stays ordered.
export type TimelineHistoryDirection = "undo" | "redo";

export type TimelineHistoryTask = (steps: number) => Promise<void>;

export interface TimelineHistoryQueue {
  run: (direction: TimelineHistoryDirection, task: TimelineHistoryTask, steps?: number) => Promise<void>;
  runNow: (direction: TimelineHistoryDirection, task: TimelineHistoryTask, steps?: number) => Promise<void>;
  cancelPending: () => void;
}

export interface TimelineHistoryQueueOptions {
  cancelOppositeBeforeDrain?: boolean;
  coalesceDelayMs?: number;
}

const TIMELINE_HISTORY_MAX_STEPS = 100;
export const EDITOR_TIMELINE_HISTORY_COALESCE_DELAY_MS = 0;

export function createEditorTimelineHistoryQueue(): TimelineHistoryQueue {
  return createTimelineHistoryQueue({
    cancelOppositeBeforeDrain: true,
    coalesceDelayMs: EDITOR_TIMELINE_HISTORY_COALESCE_DELAY_MS,
  });
}

export function createTimelineHistoryQueue(options: TimelineHistoryQueueOptions = {}): TimelineHistoryQueue {
  type PendingBatch = {
    direction: TimelineHistoryDirection;
    steps: number;
    task: TimelineHistoryTask;
    resolve: () => void;
    reject: (error: unknown) => void;
  };

  const queue: PendingBatch[] = [];
  const coalesceDelayMs = Math.max(0, options.coalesceDelayMs ?? 20);
  const cancelOppositeBeforeDrain = options.cancelOppositeBeforeDrain ?? coalesceDelayMs > 0;
  let draining = false;
  let drainScheduled = false;
  let drainTimer: ReturnType<typeof setTimeout> | null = null;

  const clearPendingTimer = () => {
    if (drainTimer) {
      clearTimeout(drainTimer);
      drainTimer = null;
    }
    drainScheduled = false;
  };

  const resolvePendingQueue = () => {
    while (queue.length > 0) {
      queue.shift()!.resolve();
    }
  };

  const appendPromiseHandlers = (
    batch: PendingBatch,
    resolve: () => void,
    reject: (error: unknown) => void,
  ) => {
    const previousResolve = batch.resolve;
    const previousReject = batch.reject;
    batch.resolve = () => {
      previousResolve();
      resolve();
    };
    batch.reject = (error) => {
      previousReject(error);
      reject(error);
    };
  };

  const normalizeSteps = (requestedSteps = 1) => {
    const rawSteps = Number(requestedSteps);
    return Math.max(1, Math.floor(Number.isFinite(rawSteps) ? rawSteps : 1));
  };

  const takePendingForImmediateRun = (direction: TimelineHistoryDirection) => {
    let sameDirectionSteps = 0;
    const sameDirectionResolves: Array<() => void> = [];
    const sameDirectionRejects: Array<(error: unknown) => void> = [];

    while (queue.length > 0) {
      const batch = queue.shift()!;
      if (batch.direction === direction) {
        sameDirectionSteps += batch.steps;
        sameDirectionResolves.push(batch.resolve);
        sameDirectionRejects.push(batch.reject);
      } else {
        batch.resolve();
      }
    }

    return {
      sameDirectionSteps,
      resolveSameDirection() {
        for (const resolve of sameDirectionResolves) resolve();
      },
      rejectSameDirection(error: unknown) {
        for (const reject of sameDirectionRejects) reject(error);
      },
    };
  };

  const drain = async () => {
    if (draining) return;
    drainScheduled = false;
    draining = true;
    try {
      while (queue.length > 0) {
        const batch = queue.shift()!;
        try {
          await batch.task(batch.steps);
          batch.resolve();
        } catch (error) {
          batch.reject(error);
        }
      }
    } finally {
      draining = false;
      if (queue.length > 0) void drain();
    }
  };

  const scheduleDrain = () => {
    if (draining || drainScheduled || drainTimer) return;
    if (coalesceDelayMs === 0) {
      drainScheduled = true;
      void Promise.resolve().then(drain);
      return;
    }
    drainScheduled = true;
    drainTimer = setTimeout(() => {
      drainTimer = null;
      void drain();
    }, coalesceDelayMs);
  };

  const run = (direction: TimelineHistoryDirection, task: TimelineHistoryTask, requestedSteps = 1) => {
    const steps = normalizeSteps(requestedSteps);
    return new Promise<void>((resolve, reject) => {
      let pendingPortions = 0;
      let settled = false;
      const resolvePortion = () => {
        pendingPortions -= 1;
        if (pendingPortions <= 0 && !settled) {
          settled = true;
          resolve();
        }
      };
      const rejectPortion = (error: unknown) => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      const enqueue = (count: number) => {
        let remaining = count;
        const last = queue[queue.length - 1];
        if (last?.direction === direction && last.steps < TIMELINE_HISTORY_MAX_STEPS) {
          const appendedSteps = Math.min(remaining, TIMELINE_HISTORY_MAX_STEPS - last.steps);
          last.steps += appendedSteps;
          remaining -= appendedSteps;
          pendingPortions += 1;
          appendPromiseHandlers(last, resolvePortion, rejectPortion);
        }
        while (remaining > 0) {
          const batchSteps = Math.min(TIMELINE_HISTORY_MAX_STEPS, remaining);
          queue.push({ direction, steps: batchSteps, task, resolve: resolvePortion, reject: rejectPortion });
          remaining -= batchSteps;
          pendingPortions += 1;
        }
      };

      const last = queue[queue.length - 1];
      if (!draining && cancelOppositeBeforeDrain && (drainScheduled || drainTimer) && last && last.direction !== direction) {
        let remainingSteps = steps;
        let resolvesWithPendingBatch = false;
        while (remainingSteps > 0) {
          const opposite = queue[queue.length - 1];
          if (!opposite || opposite.direction === direction) break;
          if (opposite.steps > remainingSteps) {
            opposite.steps -= remainingSteps;
            appendPromiseHandlers(opposite, resolve, reject);
            resolvesWithPendingBatch = true;
            remainingSteps = 0;
            break;
          }
          remainingSteps -= opposite.steps;
          queue.pop();
          opposite.resolve();
        }
        if (remainingSteps === 0 && !resolvesWithPendingBatch) resolve();
        else enqueue(remainingSteps);
        scheduleDrain();
        return;
      }

      enqueue(steps);
      scheduleDrain();
    });
  };

  return {
    run,
    cancelPending() {
      clearPendingTimer();
      resolvePendingQueue();
    },
    runNow(direction, task, requestedSteps = 1) {
      clearPendingTimer();
      const pending = takePendingForImmediateRun(direction);
      const done = run(direction, task, normalizeSteps(requestedSteps) + pending.sameDirectionSteps);
      if (pending.sameDirectionSteps > 0) {
        done.then(pending.resolveSameDirection, pending.rejectSameDirection);
      }
      if (!draining) {
        clearPendingTimer();
        void drain();
      }
      return done;
    },
  };
}
