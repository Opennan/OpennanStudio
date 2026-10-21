// Unit tests for the durable timeline sync queue. Uses an in-memory store and a
// controllable clock so retry/backoff/offline behavior is deterministic.
import { describe, expect, it, vi } from "vitest";
import {
    TimelineSyncQueue,
    nextBackoffDelayMs,
    selectDrainable,
    type QueuedCommand,
    type SyncQueueStore,
} from "./timeline-sync-queue";

class MemoryStore implements SyncQueueStore {
    rows: QueuedCommand[] = [];
    private seq = 1;
    async enqueue(cmd: Omit<QueuedCommand, "id">): Promise<number> {
        const id = this.seq++;
        this.rows.push({ ...cmd, id });
        return id;
    }
    async list(projectId: string): Promise<QueuedCommand[]> {
        return this.rows.filter((r) => r.projectId === projectId).map((r) => ({ ...r }));
    }
    async remove(id: number): Promise<void> {
        this.rows = this.rows.filter((r) => r.id !== id);
    }
    async update(id: number, patch: Partial<QueuedCommand>): Promise<void> {
        const row = this.rows.find((r) => r.id === id);
        if (row) Object.assign(row, patch);
    }
    async supersede(projectId: string, coalesceKey: string, exceptId?: number): Promise<void> {
        this.rows = this.rows.filter(
            (r) => !(r.projectId === projectId && r.coalesceKey === coalesceKey && r.id !== exceptId),
        );
    }
}

describe("nextBackoffDelayMs", () => {
    it("grows then clamps to the last schedule entry", () => {
        const sched = [0, 100, 500];
        expect(nextBackoffDelayMs(0, sched)).toBe(0);
        expect(nextBackoffDelayMs(1, sched)).toBe(100);
        expect(nextBackoffDelayMs(2, sched)).toBe(500);
        expect(nextBackoffDelayMs(9, sched)).toBe(500);
    });
});

describe("selectDrainable", () => {
    it("returns only ready commands, oldest first", () => {
        const cmds: QueuedCommand[] = [
            { id: 2, projectId: "p", op: "updateClip", payload: {}, createdAt: 20, attempts: 0, nextAttemptAt: 0 },
            { id: 1, projectId: "p", op: "updateClip", payload: {}, createdAt: 10, attempts: 0, nextAttemptAt: 0 },
            { id: 3, projectId: "p", op: "updateClip", payload: {}, createdAt: 30, attempts: 1, nextAttemptAt: 999 },
        ];
        const ready = selectDrainable(cmds, 100);
        expect(ready.map((c) => c.id)).toEqual([1, 2]);
    });
});

describe("TimelineSyncQueue", () => {
    it("drains queued commands in createdAt order and removes them on success", async () => {
        const store = new MemoryStore();
        const sentOrder: number[] = [];
        const q = new TimelineSyncQueue(store, async (cmd) => {
            sentOrder.push(cmd.id!);
            return true;
        });
        await q.enqueue("p", "updateClip", { clipId: "a" });
        await q.enqueue("p", "updateClip", { clipId: "b" });
        const sent = await q.drain("p");
        expect(sent).toBe(2);
        expect(sentOrder).toEqual([1, 2]);
        expect(store.rows.length).toBe(0);
    });

    it("coalesces repeated edits to the same key, keeping only the newest", async () => {
        const store = new MemoryStore();
        const q = new TimelineSyncQueue(store, async () => true);
        await q.enqueue("p", "updateClip", { v: 1 }, "clip:a");
        await q.enqueue("p", "updateClip", { v: 2 }, "clip:a");
        const rows = await store.list("p");
        expect(rows.length).toBe(1);
        expect((rows[0].payload as { v: number }).v).toBe(2);
    });

    it("retries with backoff on failure and preserves ordering", async () => {
        const store = new MemoryStore();
        let clock = 1000;
        const sender = vi
            .fn<(cmd: QueuedCommand) => Promise<boolean>>()
            .mockResolvedValueOnce(false) // first attempt fails
            .mockResolvedValue(true); // later attempts succeed
        const q = new TimelineSyncQueue(store, sender, {
            now: () => clock,
            backoffScheduleMs: [0, 50, 200],
        });
        await q.enqueue("p", "updateClip", { clipId: "a" });
        await q.enqueue("p", "updateClip", { clipId: "b" });

        // First drain: command 1 fails, ordering stops the pass.
        expect(await q.drain("p")).toBe(0);
        expect(store.rows.length).toBe(2);
        expect(store.rows.find((r) => r.id === 1)?.attempts).toBe(1);
        // Not yet due (backoff for attempt 1 = 50ms).
        expect(await q.drain("p")).toBe(0);

        // Advance past the backoff window; both now succeed in order.
        clock += 100;
        expect(await q.drain("p")).toBe(2);
        expect(store.rows.length).toBe(0);
    });

    it("does not send while offline", async () => {
        const store = new MemoryStore();
        let online = false;
        const sender = vi.fn(async () => true);
        const q = new TimelineSyncQueue(store, sender, { isOnline: () => online });
        await q.enqueue("p", "updateClip", { clipId: "a" });
        expect(await q.drain("p")).toBe(0);
        expect(sender).not.toHaveBeenCalled();
        online = true;
        expect(await q.drain("p")).toBe(1);
    });

    it("drops a command after maxAttempts so it cannot wedge the queue", async () => {
        const store = new MemoryStore();
        let clock = 0;
        const q = new TimelineSyncQueue(store, async () => false, {
            now: () => clock,
            backoffScheduleMs: [0, 0, 0],
            maxAttempts: 2,
        });
        await q.enqueue("p", "updateClip", { clipId: "a" });
        await q.drain("p"); // attempt 1 -> attempts=1
        clock += 1;
        await q.drain("p"); // attempt 2 -> reaches maxAttempts -> removed
        expect(store.rows.length).toBe(0);
    });
});
