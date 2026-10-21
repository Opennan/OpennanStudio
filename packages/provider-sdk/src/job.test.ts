import { JobCancelledError, JobFailedError } from "./errors";
import { createJob, type JobUpdate } from "./job";

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("createJob (spec §5.4 Job<T>)", () => {
    it("goes queued -> running -> succeeded and resolves the value", async () => {
        const gate = deferred<string>();
        const job = createJob(() => gate.promise);
        expect(await job.status()).toBe("queued");
        await tick();
        expect(await job.status()).toBe("running");
        gate.resolve("done");
        await expect(job.result()).resolves.toBe("done");
        expect(await job.status()).toBe("succeeded");
        expect(job.update()).toMatchObject({ status: "succeeded", progress: 1 });
    });

    it("reports progress (clamped to 0..1) and messages to subscribers", async () => {
        const gate = deferred<void>();
        const updates: JobUpdate[] = [];
        const job = createJob(async ({ report }) => {
            report(0.25, "Downloading");
            report(1.7, "Transcribing");
            report(-1);
            await gate.promise;
            return 1;
        });
        job.subscribe!((update) => updates.push(update));
        await tick();
        gate.resolve();
        await job.result();
        expect(updates[0]).toEqual({ status: "queued" });
        expect(updates).toContainEqual({ status: "running", progress: 0.25, message: "Downloading" });
        expect(updates).toContainEqual({ status: "running", progress: 1, message: "Transcribing" });
        expect(updates).toContainEqual({ status: "running", progress: 0, message: "Transcribing" });
        expect(updates.at(-1)).toEqual({ status: "succeeded", progress: 1, message: "Transcribing" });
    });

    it("keeps the message when report passes null progress", async () => {
        const job = createJob(async ({ report }) => {
            report(null, "Checking the model");
            return 0;
        });
        const updates: JobUpdate[] = [];
        job.subscribe!((update) => updates.push(update));
        await job.result();
        expect(updates).toContainEqual({ status: "running", message: "Checking the model" });
    });

    it("fails with JobFailedError carrying the provider's message", async () => {
        const job = createJob(async () => {
            throw new Error("model file is corrupt");
        });
        await expect(job.result()).rejects.toBeInstanceOf(JobFailedError);
        await expect(job.result()).rejects.toThrow("model file is corrupt");
        expect(await job.status()).toBe("failed");
        expect(job.update().error).toBe("model file is corrupt");
        const odd = createJob(async () => {
            throw "plain string"; // eslint-disable-line no-throw-literal
        });
        await expect(odd.result()).rejects.toThrow("plain string");
    });

    it("cancels before start without running", async () => {
        const run = vi.fn(async () => 1);
        const job = createJob(run);
        await job.cancel();
        await expect(job.result()).rejects.toBeInstanceOf(JobCancelledError);
        expect(await job.status()).toBe("cancelled");
        await tick();
        expect(run).not.toHaveBeenCalled();
    });

    it("cancels while running: aborts the signal and stays cancelled even if run resolves later", async () => {
        const gate = deferred<string>();
        let signal: AbortSignal | null = null;
        const job = createJob((context) => {
            signal = context.signal;
            return gate.promise;
        });
        await tick();
        await job.cancel();
        expect(signal!.aborted).toBe(true);
        gate.resolve("late");
        await expect(job.result()).rejects.toBeInstanceOf(JobCancelledError);
        expect(await job.status()).toBe("cancelled");
    });

    it("maps a JobCancelledError thrown by run to cancelled", async () => {
        const job = createJob(async () => {
            throw new JobCancelledError();
        });
        await expect(job.result()).rejects.toBeInstanceOf(JobCancelledError);
        expect(await job.status()).toBe("cancelled");
    });

    it("ignores cancel after success", async () => {
        const job = createJob(async () => 5);
        await job.result();
        await job.cancel();
        expect(await job.status()).toBe("succeeded");
        await expect(job.result()).resolves.toBe(5);
    });

    it("gives late subscribers the current update first and stops after unsubscribe", async () => {
        const gate = deferred<void>();
        const job = createJob(async ({ report }) => {
            report(0.5, "Half");
            await gate.promise;
            return 0;
        });
        await tick();
        const seen: JobUpdate[] = [];
        const stop = job.subscribe!((update) => seen.push(update));
        expect(seen).toEqual([{ status: "running", progress: 0.5, message: "Half" }]);
        stop();
        gate.resolve();
        await job.result();
        expect(seen).toHaveLength(1);
    });

    it("uses unique ids unless one is given", () => {
        const a = createJob(async () => 0);
        const b = createJob(async () => 0);
        expect(a.id).toMatch(/^job-[A-Za-z0-9_-]+$/);
        expect(a.id).not.toBe(b.id);
        expect(createJob(async () => 0, { id: "job-fixed" }).id).toBe("job-fixed");
        void a.result();
        void b.result();
    });

    it("does not report unhandled rejections when nobody awaits a failed job", async () => {
        const job = createJob(async () => {
            throw new Error("nobody listens");
        });
        await tick();
        await tick();
        expect(await job.status()).toBe("failed");
    });

    it("finished() waits for run to stop, also after cancel", async () => {
        const gate = deferred<void>();
        let stopped = false;
        const job = createJob(async ({ signal }) => {
            await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
            await gate.promise;
            stopped = true;
            return 1;
        });
        await tick();
        await job.cancel();
        expect(await job.status()).toBe("cancelled");
        let finished = false;
        void job.finished().then(() => { finished = true; });
        await tick();
        expect(finished).toBe(false);
        gate.resolve();
        await job.finished();
        expect(stopped).toBe(true);
        const before = createJob(async () => 1);
        await before.cancel();
        await before.finished();
    });
});

describe("createJob typed failures", () => {
    it("passes a CapabilityUnavailableError through as the failure", async () => {
        const { CapabilityUnavailableError } = await import("./errors");
        const job = createJob(async () => {
            throw new CapabilityUnavailableError("opennan.qc", "qc_check");
        });
        await expect(job.result()).rejects.toBeInstanceOf(CapabilityUnavailableError);
        expect(await job.status()).toBe("failed");
    });
});

describe("createJob refusable cancel (phase 11)", () => {
    it("asks the cancel handler first: refused keeps the job running and no longer cancellable", async () => {
        let release!: (value: string) => void;
        const job = createJob<string>(async (context) => {
            context.onCancel(async () => false);
            return new Promise<string>((resolve) => {
                release = resolve;
            });
        });
        const updates: Array<{ status: string; cancellable?: boolean; message?: string }> = [];
        job.subscribe((u) => updates.push(u));
        await tick();
        await job.cancel();
        expect(await job.status()).toBe("running");
        expect(job.update()).toMatchObject({ status: "running", cancellable: false, message: "Already running: it will finish and be charged." });
        release("done");
        await expect(job.result()).resolves.toBe("done");
        expect(await job.status()).toBe("succeeded");
        // A second cancel after the refusal changes nothing either.
        await job.cancel();
        expect(await job.status()).toBe("succeeded");
        expect(updates.some((u) => u.cancellable === false)).toBe(true);
    });

    it("accepted by the handler: the job ends cancelled and its signal aborts", async () => {
        let aborted = false;
        const job = createJob<string>(async (context) => {
            context.onCancel(async () => true);
            context.signal.addEventListener("abort", () => { aborted = true; });
            return new Promise<string>(() => undefined);
        });
        await tick();
        await job.cancel();
        expect(await job.status()).toBe("cancelled");
        expect(aborted).toBe(true);
        await expect(job.result()).rejects.toBeInstanceOf(JobCancelledError);
    });

    it("a handler that throws counts as accepted (nothing is left running here)", async () => {
        const job = createJob<string>(async (context) => {
            context.onCancel(async () => {
                throw new Error("network");
            });
            return new Promise<string>(() => undefined);
        });
        await tick();
        await job.cancel();
        expect(await job.status()).toBe("cancelled");
    });

    it("a refusal can carry its own message (e.g. the task had already finished)", async () => {
        let release!: (value: string) => void;
        const job = createJob<string>(async (context) => {
            context.onCancel(async () => ({ accepted: false, message: "It had already finished." }));
            return new Promise<string>((resolve) => {
                release = resolve;
            });
        });
        await tick();
        await job.cancel();
        expect(job.update()).toMatchObject({ status: "running", cancellable: false, message: "It had already finished." });
        release("done");
        await expect(job.result()).resolves.toBe("done");
    });

    it("the handler can be replaced or cleared as the job moves on", async () => {
        const job = createJob<string>(async (context) => {
            context.onCancel(async () => false);
            context.onCancel(null);
            return new Promise<string>(() => undefined);
        });
        await tick();
        await job.cancel();
        expect(await job.status()).toBe("cancelled");
    });
});
