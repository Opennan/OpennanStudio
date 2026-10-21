import { createTabLocks } from "./tab-lock";

/** A LockManager for one origin shared by "tabs" (ifAvailable and steal, as the Web Locks spec has them). */
function fakeLocks() {
    const held = new Map<string, { reject(error: Error): void; done: Promise<unknown> }>();
    return {
        async request(name: string, options: LockOptions, callback: (lock: Lock | null) => Promise<unknown>) {
            const current = held.get(name);
            if (current && options.ifAvailable) return callback(null);
            if (current && options.steal) current.reject(new DOMException("stolen", "AbortError"));
            let reject!: (error: Error) => void;
            const aborted = new Promise<never>((_, r) => (reject = r));
            const done = Promise.race([callback({ name, mode: "exclusive" } as Lock), aborted]);
            held.set(name, { reject, done });
            try {
                return await done;
            } finally {
                if (held.get(name)?.done === done) held.delete(name);
            }
        },
        async query() {
            return { held: [...held.keys()].map((name) => ({ name, mode: "exclusive" })), pending: [] };
        },
    } as unknown as LockManager;
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("tab locks", () => {
    it("lets one tab hold a cloud project; another sees it busy, takes it over, and the first loses it", async () => {
        const locks = fakeLocks();
        const first = createTabLocks(locks).acquire("cloud-p");
        await tick();
        expect(first.lock.state()).toBe("held");
        const second = createTabLocks(locks).acquire("cloud-p");
        await tick();
        expect(second.lock.state()).toBe("busy");
        second.lock.takeOver();
        await tick();
        expect(second.lock.state()).toBe("held");
        expect(first.lock.state()).toBe("lost");
    });

    it("holds every lock where Web Locks are missing", async () => {
        const handle = createTabLocks(null).acquire("cloud-p");
        await tick();
        expect(handle.lock.state()).toBe("held");
    });

    it("keeps the lock through a quick release and re-acquire (a remount)", async () => {
        const locks = createTabLocks(fakeLocks());
        const a = locks.acquire("cloud-p");
        await tick();
        a.release();
        const b = locks.acquire("cloud-p");
        await tick();
        expect(b.lock.state()).toBe("held");
    });

    it("tells whether another tab uses a cloud project (the account id migration leaves its records alone, 9a.1)", async () => {
        const locks = fakeLocks();
        const tabA = createTabLocks(locks);
        const tabB = createTabLocks(locks);
        expect(await tabB.inUseElsewhere("cloud-p")).toBe(false);
        const held = tabA.acquire("cloud-p");
        await tick();
        expect(await tabB.inUseElsewhere("cloud-p")).toBe(true);
        expect(await tabA.inUseElsewhere("cloud-p")).toBe(false);
        held.release();
        await new Promise((r) => setTimeout(r, 80));
        expect(await tabB.inUseElsewhere("cloud-p")).toBe(false);
        expect(await createTabLocks(null).inUseElsewhere("cloud-p")).toBe(false);
    });
});
