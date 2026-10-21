import { AiJobBook, MAX_AI_JOB_RECORDS } from "./job-book";

describe("AiJobBook", () => {
    it("records a job, applies updates, and stamps the finish time", () => {
        let now = 1000;
        const book = new AiJobBook({ now: () => now });
        book.record({ jobId: "a", capability: "audio.isolate-voice" });
        expect(book.get("a")).toEqual({ jobId: "a", capability: "audio.isolate-voice", status: "queued", cancellable: true, startedAt: 1000 });
        book.update("a", { status: "running", progress: 0.5, message: "Isolating" });
        now = 2500;
        book.update("a", { status: "succeeded", progress: 1, costUsd: 0.13 });
        expect(book.get("a")).toEqual({
            jobId: "a", capability: "audio.isolate-voice", status: "succeeded", progress: 1, message: "Isolating", costUsd: 0.13, cancellable: true, startedAt: 1000, finishedAt: 2500,
        });
        book.update("missing", { status: "failed" });
        expect(book.get("missing")).toBeUndefined();
    });

    it("records failures with the refund flag and a refused cancel", () => {
        const book = new AiJobBook();
        book.record({ jobId: "b", capability: "video.upscale" });
        book.update("b", { status: "running", cancellable: false });
        book.update("b", { status: "failed", error: "The run failed. You were not charged.", refunded: true });
        expect(book.get("b")).toMatchObject({ status: "failed", cancellable: false, error: "The run failed. You were not charged.", refunded: true, finishedAt: expect.any(Number) });
    });

    it("hands out copies", () => {
        const book = new AiJobBook();
        book.record({ jobId: "c", capability: "audio.tts" });
        (book.get("c") as { status: string }).status = "failed";
        book.list()[0]!.status = "failed";
        expect(book.get("c")?.status).toBe("queued");
    });

    it("lists newest first and keeps at most 200 records, dropping finished ones first", () => {
        let now = 0;
        const book = new AiJobBook({ now: () => now++ });
        book.record({ jobId: "keep-running", capability: "audio.tts" });
        for (let i = 0; i < MAX_AI_JOB_RECORDS + 5; i += 1) {
            book.record({ jobId: `j${i}`, capability: "audio.tts" });
            book.update(`j${i}`, { status: "succeeded" });
        }
        const list = book.list();
        expect(MAX_AI_JOB_RECORDS).toBe(200);
        expect(list).toHaveLength(200);
        expect(list[0]!.jobId).toBe(`j${MAX_AI_JOB_RECORDS + 4}`);
        expect(list.some((r) => r.jobId === "keep-running")).toBe(true);
        expect(book.get("j0")).toBeUndefined();
    });

    it("re-recording an id starts it afresh", () => {
        const book = new AiJobBook();
        book.record({ jobId: "e", capability: "audio.tts" });
        book.update("e", { status: "failed", error: "x" });
        book.record({ jobId: "e", capability: "audio.tts" });
        expect(book.get("e")).toMatchObject({ status: "queued" });
        expect(book.get("e")?.error).toBeUndefined();
        expect(book.list()).toHaveLength(1);
    });

    it("notifies subscribers on every change and counts versions", () => {
        const book = new AiJobBook();
        const listener = vi.fn();
        const stop = book.subscribe(listener);
        book.record({ jobId: "d", capability: "audio.tts" });
        book.update("d", { status: "running" });
        expect(listener).toHaveBeenCalledTimes(2);
        expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ jobId: "d", status: "running" }));
        expect(book.version()).toBe(2);
        stop();
        book.update("d", { status: "cancelled" });
        expect(listener).toHaveBeenCalledTimes(2);
    });
});
