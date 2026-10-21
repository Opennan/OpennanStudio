// runTask: the task POST, the cancel the server decides, and polling, against a scripted fetch.
import { CANCEL_REFUSED_MESSAGE, JobCancelledError, createJob, type JobUpdate } from "@opennan/provider-sdk";
import { createOpenNanApi } from "./api";
import { runTask, type TaskBody } from "./tasks";

interface Call { method: string; path: string; signal: AbortSignal | null | undefined }

const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const task = (status: string, extra: Record<string, unknown> = {}) => ({ id: "task_1", object: "task", status, progress: 0, outputs: [], price_usd: 0, error: null, ...extra });

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

function scripted(route: (call: Call) => Response | Promise<Response>) {
    const calls: Call[] = [];
    const fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const call: Call = { method: init.method ?? "GET", path: new URL(String(input)).pathname, signal: init.signal };
        calls.push(call);
        return route(call);
    }) as typeof globalThis.fetch;
    return { api: createOpenNanApi({ baseUrl: "https://api.opennan.com", fetch }), calls };
}

function start(api: ReturnType<typeof scripted>["api"], options: Parameters<typeof runTask>[5] = {}) {
    const job = createJob<TaskBody>((context) => runTask(api, "sk-test_abcdefghij", context, "/v1/videos/upscales", { video_url: "https://x/a.mp4" }, { pollIntervalMs: 1, ...options }));
    const updates: JobUpdate[] = [];
    job.subscribe((u) => updates.push(u));
    return { job, updates };
}

const cancels = (calls: Call[]) => calls.filter((c) => c.path === "/v1/tasks/task_1/cancel");

describe("runTask cancel", () => {
    it("waits for the task POST, then cancels on the server: 200 ends the job cancelled", async () => {
        const post = deferred<Response>();
        const { api, calls } = scripted((call) => {
            if (call.path === "/v1/videos/upscales") return post.promise;
            if (call.path.endsWith("/cancel")) return json(200, task("cancelled"));
            return json(200, task("running"));
        });
        const { job } = start(api);
        await vi.waitFor(() => expect(calls).toHaveLength(1));
        const cancelling = job.cancel();
        await new Promise((r) => setTimeout(r, 5));
        // The POST was sent: it is not aborted, so a task the server created is known (and cancelled).
        expect(calls[0]!.signal?.aborted ?? false).toBe(false);
        expect(await job.status()).toBe("running");
        post.resolve(json(202, task("queued")));
        await cancelling;
        expect(cancels(calls)).toHaveLength(1);
        expect(await job.status()).toBe("cancelled");
        await expect(job.result()).rejects.toBeInstanceOf(JobCancelledError);
    });

    it("keeps the job when the server refuses (409): it runs on and is charged", async () => {
        const post = deferred<Response>();
        let polls = 0;
        const { api, calls } = scripted((call) => {
            if (call.path === "/v1/videos/upscales") return post.promise;
            if (call.path.endsWith("/cancel")) return json(409, { error: { message: "This task can't be cancelled: it has finished or already started work that is charged.", code: "conflict" } });
            polls += 1;
            return json(200, polls < 3 ? task("running") : task("succeeded", { price_usd: 0.5 }));
        });
        const { job, updates } = start(api);
        await vi.waitFor(() => expect(calls).toHaveLength(1));
        const cancelling = job.cancel();
        post.resolve(json(202, task("queued")));
        await cancelling;
        expect(updates.some((u) => u.cancellable === false && u.message === CANCEL_REFUSED_MESSAGE)).toBe(true);
        await expect(job.result()).resolves.toMatchObject({ status: "succeeded" });
    });

    it.each([
        ["a network failure", () => Promise.reject(new TypeError("fetch failed"))],
        ["a 5xx", () => Promise.resolve(json(502, { error: { message: "Bad gateway" } }))],
        ["a 404", () => Promise.resolve(json(404, { error: { message: "No such task" } }))],
    ])("does not report cancelled when the cancel POST meets %s (the task may still run and be charged)", async (_what, answer) => {
        let polls = 0;
        const { api, calls } = scripted((call) => {
            if (call.path === "/v1/videos/upscales") return json(202, task("queued"));
            if (call.path.endsWith("/cancel")) return answer();
            // Runs until the cancel was asked, then finishes (and is charged).
            if (cancels(calls).length > 0) polls += 1;
            return json(200, polls < 3 ? task("running") : task("succeeded"));
        });
        const { job, updates } = start(api);
        await vi.waitFor(() => expect(calls.some((c) => c.path === "/v1/tasks/task_1")).toBe(true));
        await job.cancel();
        expect(cancels(calls).length).toBeGreaterThanOrEqual(1);
        expect(updates.some((u) => u.cancellable === false)).toBe(true);
        await expect(job.result()).resolves.toMatchObject({ status: "succeeded" });
    });

    it("cancels without asking the server when the task POST failed (nothing was created)", async () => {
        const post = deferred<Response>();
        const { api, calls } = scripted((call) => {
            if (call.path === "/v1/videos/upscales") return post.promise;
            return json(200, task("running"));
        });
        const { job } = start(api);
        await vi.waitFor(() => expect(calls).toHaveLength(1));
        const cancelling = job.cancel();
        post.resolve(json(503, { error: { message: "This tool is temporarily unavailable. You were not charged." } }));
        await cancelling;
        await expect(job.result()).rejects.toThrow();
        expect(["cancelled", "failed"]).toContain(await job.status());
        expect(cancels(calls)).toEqual([]);
    });

    const BUSY = { error: { message: "This task is busy and could not be cancelled right now. Try again.", code: "conflict" } };

    it("asks again when the server is busy, and cancels once it confirms", async () => {
        let asked = 0;
        const { api, calls } = scripted((call) => {
            if (call.path === "/v1/videos/upscales") return json(202, task("queued"));
            if (call.path.endsWith("/cancel")) {
                asked += 1;
                return asked < 3 ? json(409, BUSY) : json(200, task("cancelled"));
            }
            return json(200, task("running"));
        });
        const { job } = start(api, { cancelRetryMs: 1 });
        await vi.waitFor(() => expect(calls.some((c) => c.path === "/v1/tasks/task_1")).toBe(true));
        await job.cancel();
        expect(cancels(calls)).toHaveLength(3);
        expect(await job.status()).toBe("cancelled");
    });

    it("gives up as refused after three more busy answers", async () => {
        let polls = 0;
        const { api, calls } = scripted((call) => {
            if (call.path === "/v1/videos/upscales") return json(202, task("queued"));
            if (call.path.endsWith("/cancel")) return json(409, BUSY);
            if (cancels(calls).length >= 4) polls += 1;
            return json(200, polls < 3 ? task("running") : task("succeeded"));
        });
        const { job, updates } = start(api, { cancelRetryMs: 1 });
        await vi.waitFor(() => expect(calls.some((c) => c.path === "/v1/tasks/task_1")).toBe(true));
        await job.cancel();
        expect(cancels(calls)).toHaveLength(4);
        expect(updates.some((u) => u.cancellable === false)).toBe(true);
        await expect(job.result()).resolves.toMatchObject({ status: "succeeded" });
    });

    it("does not ask again when the task cannot be cancelled (not busy)", async () => {
        const { api, calls } = scripted((call) => {
            if (call.path === "/v1/videos/upscales") return json(202, task("queued"));
            if (call.path.endsWith("/cancel")) return json(409, { error: { message: "This task can't be cancelled: it has finished or already started work that is charged.", code: "conflict" } });
            return json(200, cancels(calls).length > 0 ? task("succeeded") : task("running"));
        });
        const { job } = start(api, { cancelRetryMs: 1 });
        await vi.waitFor(() => expect(calls.some((c) => c.path === "/v1/tasks/task_1")).toBe(true));
        await job.cancel();
        expect(cancels(calls)).toHaveLength(1);
        await job.result();
    });
});

describe("runTask polling", () => {
    it("keeps polling through network failures, 429 and 5xx, waiting what Retry-After asks", async () => {
        const answers: Array<() => Response | Promise<Response>> = [
            () => Promise.reject(new TypeError("fetch failed")),
            () => json(503, { error: { message: "Unavailable" } }, { "retry-after": "1" }),
            () => json(429, { error: { message: "Slow down" } }),
            () => json(500, { error: { message: "Oops" } }),
            () => json(200, task("succeeded", { price_usd: 0.2 })),
        ];
        const at: number[] = [];
        const { api } = scripted((call) => {
            if (call.path === "/v1/videos/upscales") return json(202, task("queued"));
            at.push(Date.now());
            return answers.shift()!();
        });
        const { job } = start(api);
        await expect(job.result()).resolves.toMatchObject({ status: "succeeded", price_usd: 0.2 });
        expect(at).toHaveLength(5);
        // The poll after the 503 waited the second its Retry-After asked for.
        expect(at[2]! - at[1]!).toBeGreaterThanOrEqual(950);
    });

    it("fails at once on a 4xx other than 429", async () => {
        const { api, calls } = scripted((call) => {
            if (call.path === "/v1/videos/upscales") return json(202, task("queued"));
            return json(404, { error: { message: "No such task.", code: "not_found" } });
        });
        const { job } = start(api);
        await expect(job.result()).rejects.toThrow("No such task.");
        expect(calls.filter((c) => c.path === "/v1/tasks/task_1")).toHaveLength(1);
    });

    it("gives up at the deadline saying the task may still finish and be charged (not refunded)", async () => {
        const { api } = scripted((call) => {
            if (call.path === "/v1/videos/upscales") return json(202, task("queued"));
            return json(502, { error: { message: "Bad gateway" } });
        });
        const { job } = start(api, { deadlineMs: 60 });
        const error = await job.result().catch((e: unknown) => e);
        expect((error as Error).message).toMatch(/may still finish and be charged/);
        expect(error).toMatchObject({ refunded: false });
    });
});

describe("runTask lost submits (review findings C2, C3)", () => {
    it("a task POST whose answer is lost may have started: the job fails without 'not charged' and a cancel is refused", async () => {
        const { api } = scripted((call) => {
            if (call.path === "/v1/videos/upscales") throw new TypeError("network down");
            return json(200, task("running"));
        });
        const { job } = start(api);
        const error = await job.result().catch((e: unknown) => e);
        expect(error).toMatchObject({ code: "submit_unknown", refunded: false });
        expect((error as Error).message).toMatch(/may still finish and be charged/);
    });

    it("a cancel waiting on a POST whose answer is lost is refused, not reported as not charged", async () => {
        const post = deferred<Response>();
        const { api } = scripted((call) => {
            if (call.path === "/v1/videos/upscales") return post.promise;
            return json(200, task("running"));
        });
        const { job, updates } = start(api);
        await new Promise((r) => setTimeout(r, 5));
        const cancelling = job.cancel();
        post.reject(new TypeError("connection reset"));
        await cancelling;
        // Never "cancelled" (which the editor words as not charged): the job ends failed, saying it may have started.
        await expect(job.result()).rejects.toMatchObject({ code: "submit_unknown" });
        expect(await job.status()).toBe("failed");
        expect(updates.some((u) => u.status === "cancelled")).toBe(false);
    });

    it("an HTTP refusal of the POST means nothing was created: a cancel then ends the job cancelled", async () => {
        const post = deferred<Response>();
        const { api } = scripted((call) => {
            if (call.path === "/v1/videos/upscales") return post.promise;
            return json(200, task("running"));
        });
        const { job } = start(api);
        await new Promise((r) => setTimeout(r, 5));
        const cancelling = job.cancel();
        post.resolve(json(400, { error: { type: "invalid_request_error", message: "bad", code: null } }));
        await cancelling;
        await expect(job.result()).rejects.not.toMatchObject({ code: "submit_unknown" });
        expect(["cancelled", "failed"]).toContain(await job.status());
    });

    it("a task POST that never answers is given up after the submit timeout, as one that may have started", async () => {
        const { api } = scripted((call) => {
            if (call.path === "/v1/videos/upscales") return new Promise<Response>((_resolve, reject) => call.signal?.addEventListener("abort", () => reject(new DOMException("timed out", "TimeoutError"))));
            return json(200, task("running"));
        });
        const { job } = start(api, { submitTimeoutMs: 20 });
        await expect(job.result()).rejects.toMatchObject({ code: "submit_unknown", refunded: false });
    });
});

describe("runTask cancel by error code (phase 11.1)", () => {
    const NOT_CANCELLABLE = { error: { type: "conflict", message: "This task can't be cancelled: it has finished or already started work that is charged.", code: "task_not_cancellable" } };
    const FINISHED = { error: { type: "conflict", message: "This task can't be cancelled: it has finished or already started work that is charged.", code: "task_already_finished" } };
    const BUSY_CODE = { error: { type: "conflict", message: "Try later.", code: "task_busy_retry" } };

    it("task_not_cancellable: asked once, the job keeps running and says it will finish and be charged", async () => {
        const { api, calls } = scripted((call) => {
            if (call.path === "/v1/videos/upscales") return json(202, task("queued"));
            if (call.path.endsWith("/cancel")) return json(409, NOT_CANCELLABLE);
            return json(200, cancels(calls).length > 0 ? task("succeeded", { price_usd: 0.4 }) : task("running"));
        });
        const { job, updates } = start(api, { cancelRetryMs: 1 });
        await vi.waitFor(() => expect(calls.some((c) => c.path === "/v1/tasks/task_1")).toBe(true));
        await job.cancel();
        expect(cancels(calls)).toHaveLength(1);
        expect(updates.some((u) => u.cancellable === false && u.message === CANCEL_REFUSED_MESSAGE)).toBe(true);
        await expect(job.result()).resolves.toMatchObject({ status: "succeeded", price_usd: 0.4 });
    });

    it("task_busy_retry: asks again after Retry-After (the code alone decides, whatever the message)", async () => {
        const at: number[] = [];
        const { api, calls } = scripted((call) => {
            if (call.path === "/v1/videos/upscales") return json(202, task("queued"));
            if (call.path.endsWith("/cancel")) {
                at.push(Date.now());
                return at.length < 2 ? json(409, BUSY_CODE, { "retry-after": "1" }) : json(200, task("cancelled"));
            }
            return json(200, task("running"));
        });
        const { job } = start(api);
        await vi.waitFor(() => expect(calls.some((c) => c.path === "/v1/tasks/task_1")).toBe(true));
        await job.cancel();
        expect(cancels(calls)).toHaveLength(2);
        expect(at[1]! - at[0]!).toBeGreaterThanOrEqual(900);
        expect(await job.status()).toBe("cancelled");
    });

    it("task_busy_retry: bounded, refused after three more busy answers", async () => {
        const { api, calls } = scripted((call) => {
            if (call.path === "/v1/videos/upscales") return json(202, task("queued"));
            if (call.path.endsWith("/cancel")) return json(409, BUSY_CODE, { "retry-after": "1" });
            return json(200, cancels(calls).length >= 4 ? task("succeeded") : task("running"));
        });
        const { job, updates } = start(api, { cancelRetryMs: 1 });
        await vi.waitFor(() => expect(calls.some((c) => c.path === "/v1/tasks/task_1")).toBe(true));
        await job.cancel();
        expect(cancels(calls)).toHaveLength(4);
        expect(updates.some((u) => u.cancellable === false)).toBe(true);
        await job.result();
    });

    it("waits Retry-After clamped to a quarter second … five seconds (one second without it)", async () => {
        const { cancelRetryDelayMs } = await import("./tasks");
        const { OpenNanApiError } = await import("./errors");
        expect(cancelRetryDelayMs(new OpenNanApiError(409, "task_busy_retry", "x", { retryAfterSeconds: 1 }))).toBe(1_000);
        expect(cancelRetryDelayMs(new OpenNanApiError(409, "task_busy_retry", "x", { retryAfterSeconds: 120 }))).toBe(5_000);
        expect(cancelRetryDelayMs(new OpenNanApiError(409, "task_busy_retry", "x", { retryAfterSeconds: 0 }))).toBe(250);
        expect(cancelRetryDelayMs(new OpenNanApiError(409, "task_busy_retry", "x"))).toBe(1_000);
    });

    it("task_already_finished: GETs the task at once and ends the job in its final state (succeeded)", async () => {
        let finished = false;
        const { api, calls } = scripted((call) => {
            if (call.path === "/v1/videos/upscales") return json(202, task("queued"));
            if (call.path.endsWith("/cancel")) {
                finished = true;
                return json(409, FINISHED);
            }
            return json(200, finished ? task("succeeded", { price_usd: 0.4, result: { video_url: "https://cdn.opennan.com/v.mp4" } }) : task("running"));
        });
        // Polls an hour apart: only the cancel's own GET can bring the final state in time.
        const { job, updates } = start(api, { pollIntervalMs: 3_600_000 });
        await vi.waitFor(() => expect(calls.some((c) => c.path === "/v1/tasks/task_1")).toBe(true));
        await job.cancel();
        expect(updates.some((u) => u.message === "It had already finished.")).toBe(true);
        await expect(job.result()).resolves.toMatchObject({ status: "succeeded", price_usd: 0.4 });
        expect(cancels(calls)).toHaveLength(1);
    });

    it("task_already_finished: a failed task shows its refund wording", async () => {
        let finished = false;
        const { api, calls } = scripted((call) => {
            if (call.path === "/v1/videos/upscales") return json(202, task("queued"));
            if (call.path.endsWith("/cancel")) {
                finished = true;
                return json(409, FINISHED);
            }
            return json(200, finished ? task("failed", { error: { message: "The run failed. You were not charged.", refunded: true, code: "pipeline_failed" } }) : task("running"));
        });
        const { job } = start(api, { pollIntervalMs: 3_600_000 });
        await vi.waitFor(() => expect(calls.some((c) => c.path === "/v1/tasks/task_1")).toBe(true));
        await job.cancel();
        await expect(job.result()).rejects.toMatchObject({ message: "The run failed. You were not charged.", refunded: true });
    });

    it("an older server's generic conflict is matched by its message: busy is asked again, the rest is refused", async () => {
        let asked = 0;
        const { api, calls } = scripted((call) => {
            if (call.path === "/v1/videos/upscales") return json(202, task("queued"));
            if (call.path.endsWith("/cancel")) {
                asked += 1;
                return asked === 1 ? json(409, { error: { message: "This task is busy and could not be cancelled right now. Try again.", code: null } }) : json(409, { error: { message: "This task can't be cancelled: it has finished or already started work that is charged." } });
            }
            return json(200, asked >= 2 ? task("succeeded") : task("running"));
        });
        const { job, updates } = start(api, { cancelRetryMs: 1 });
        await vi.waitFor(() => expect(calls.some((c) => c.path === "/v1/tasks/task_1")).toBe(true));
        await job.cancel();
        expect(cancels(calls)).toHaveLength(2);
        expect(updates.some((u) => u.message === CANCEL_REFUSED_MESSAGE)).toBe(true);
        await job.result();
    });
});

describe("runTask phase 11.1 review findings", () => {
    it("a proxy 5xx without OpenNan's error envelope on the task POST may have started: not 'not charged', a cancel is refused", async () => {
        const { api, calls } = scripted((call) => {
            if (call.path === "/v1/videos/upscales") return new Response("<html>502 Bad Gateway</html>", { status: 502 });
            return json(200, task("running"));
        });
        const { job } = start(api);
        const error = await job.result().catch((e: unknown) => e);
        expect(error).toMatchObject({ code: "submit_unknown", refunded: false });
        expect(cancels(calls)).toEqual([]);
    });

    it("OpenNan's own 503 on the task POST is a refusal: nothing was created", async () => {
        const { api } = scripted((call) => {
            if (call.path === "/v1/videos/upscales") return json(503, { error: { type: "unavailable", message: "This tool is temporarily unavailable. You were not charged.", code: "unavailable" } });
            return json(200, task("running"));
        });
        const { job } = start(api);
        const error = await job.result().catch((e: unknown) => e);
        expect(error).toMatchObject({ code: "unavailable", refunded: true });
    });

    it("a task given up at the deadline names the last error in Studio's words, never the server's body", async () => {
        const { api } = scripted((call) => {
            if (call.path === "/v1/videos/upscales") return json(202, task("queued"));
            return json(500, { error: { type: "server_error", message: "Traceback: KeyError 'fal_request_id'", code: "server_error" } });
        });
        const { job } = start(api, { deadlineMs: 30 });
        const error = await job.result().catch((e: unknown) => e) as Error;
        expect(error.message).not.toMatch(/Traceback|fal_request_id/);
        expect(error.message).toMatch(/may still finish and be charged/);
    });
});

describe("runTask review round 2", () => {
    it("a 2xx task POST whose body cannot be read may have created a task: never 'not charged'", async () => {
        const { api, calls } = scripted((call) => {
            if (call.path === "/v1/videos/upscales") return new Response("{\"id\": \"task_1\", \"sta", { status: 202, headers: { "content-type": "application/json" } });
            return json(200, task("running"));
        });
        const { job } = start(api);
        const error = await job.result().catch((e: unknown) => e);
        expect(error).toMatchObject({ code: "submit_unknown", refunded: false });
        expect((error as Error).message).not.toMatch(/not charged/);
        await job.cancel();
        expect(cancels(calls)).toEqual([]);
    });

    it("a 2xx task POST that names no task is unknown too (not 'not charged')", async () => {
        const { api } = scripted((call) => {
            if (call.path === "/v1/videos/upscales") return json(202, { object: "task", status: "queued" });
            return json(200, task("running"));
        });
        const { job } = start(api);
        await expect(job.result()).rejects.toMatchObject({ code: "submit_unknown", refunded: false });
    });

    it("the deadline message names a fixed reason, never a 'try again' that invites a second paid run", async () => {
        const { api } = scripted((call) => {
            if (call.path === "/v1/videos/upscales") return json(202, task("queued"));
            return json(429, { error: { type: "rate_limit_error", message: "slow", code: "rate_limit_exceeded" } }, { "retry-after": "30" });
        });
        const { job } = start(api, { deadlineMs: 30 });
        const error = await job.result().catch((e: unknown) => e) as Error;
        expect(error.message).toBe("Studio could not check the OpenNan task (OpenNan was busy): it may still finish and be charged.");
    });
});
