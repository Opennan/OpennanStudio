// One browser tab at a time edits a cloud project (Web Locks "opennan-cloud:<id>"): two tabs syncing one project
// would write the same queue and working copy on disk. The second tab sees "open in another tab" and can take the
// project over (the first tab then shows that it was opened elsewhere). Without Web Locks every tab holds its lock.

export type ProjectLockState = "waiting" | "held" | "busy" | "lost";

export interface ProjectLock {
    state(): ProjectLockState;
    subscribe(listener: () => void): () => void;
    takeOver(): void;
}

interface Entry {
    state: ProjectLockState;
    listeners: Set<() => void>;
    holds: number;
    release: (() => void) | null;
    closeTimer: ReturnType<typeof setTimeout> | null;
}

type LockManagerLike = Pick<LockManager, "request"> & Partial<Pick<LockManager, "query">>;

export interface TabLocks {
    /** Holds the project's lock while the returned release is not called (released one task later, so a remount keeps it). */
    acquire(projectId: string): { lock: ProjectLock; release(): void };
    /** Another tab holds the project's lock now (this tab does not). */
    inUseElsewhere(projectId: string): Promise<boolean>;
}

export function createTabLocks(locks: LockManagerLike | null | undefined = globalThis.navigator?.locks): TabLocks {
    const entries = new Map<string, Entry>();
    const set = (entry: Entry, state: ProjectLockState) => {
        entry.state = state;
        for (const listener of entry.listeners) listener();
    };
    const hold = (projectId: string, entry: Entry, options: LockOptions) => {
        if (!locks) {
            set(entry, "held");
            return;
        }
        locks.request(`opennan-cloud:${projectId}`, options, async (granted) => {
            if (!granted) {
                set(entry, "busy");
                return;
            }
            set(entry, "held");
            await new Promise<void>((resolve) => (entry.release = resolve));
        }).catch(() => {
            // Another tab took the project over (steal), or the page is going away.
            entry.release = null;
            set(entry, "lost");
        });
    };
    return {
        async inUseElsewhere(projectId) {
            if (!locks?.query || entries.get(projectId)?.state === "held") return false;
            try {
                const state = await locks.query();
                return (state.held ?? []).some((lock) => lock.name === `opennan-cloud:${projectId}`);
            } catch {
                return false;
            }
        },
        acquire(projectId) {
            let entry = entries.get(projectId);
            if (!entry) {
                entry = { state: "waiting", listeners: new Set(), holds: 0, release: null, closeTimer: null };
                entries.set(projectId, entry);
                hold(projectId, entry, { ifAvailable: true });
            }
            const current = entry;
            if (current.closeTimer) clearTimeout(current.closeTimer);
            current.closeTimer = null;
            current.holds += 1;
            const lock: ProjectLock = {
                state: () => current.state,
                subscribe(listener) {
                    current.listeners.add(listener);
                    return () => current.listeners.delete(listener);
                },
                takeOver() {
                    set(current, "waiting");
                    hold(projectId, current, { steal: true });
                },
            };
            let released = false;
            return {
                lock,
                release() {
                    if (released) return;
                    released = true;
                    current.holds -= 1;
                    if (current.holds > 0) return;
                    current.closeTimer = setTimeout(() => {
                        if (current.holds > 0) return;
                        current.release?.();
                        entries.delete(projectId);
                    }, 50);
                },
            };
        },
    };
}
