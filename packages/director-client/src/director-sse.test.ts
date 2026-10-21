import { readSse, SseIdleError, type SseEvent } from "./director-sse";

function streamOf(chunks: Array<string | Uint8Array>): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    let i = 0;
    return new ReadableStream<Uint8Array>({
        pull(controller) {
            if (i >= chunks.length) {
                controller.close();
                return;
            }
            const chunk = chunks[i++]!;
            controller.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
        },
    });
}

async function collect(stream: ReadableStream<Uint8Array>, options?: Parameters<typeof readSse>[1]): Promise<SseEvent[]> {
    const out: SseEvent[] = [];
    for await (const event of readSse(stream, options)) out.push(event);
    return out;
}

describe("readSse", () => {
    it("reads named events with JSON data", async () => {
        const events = await collect(streamOf(['event: turn.started\ndata: {"turn_id":"turn_1"}\n\n', "event: message\ndata: {\"text\":\"hi\"}\n\n"]));
        expect(events).toEqual([
            { event: "turn.started", data: '{"turn_id":"turn_1"}' },
            { event: "message", data: '{"text":"hi"}' },
        ]);
    });

    it("joins multi-line data with newlines and ignores comments and other fields", async () => {
        const events = await collect(streamOf([": ping\n\n", "id: 4\nretry: 100\nevent: x\ndata: a\ndata: b\n\n", ":comment only\n\n"]));
        expect(events).toEqual([{ event: "x", data: "a\nb" }]);
    });

    it("accepts CRLF and lone CR line endings and a space-less colon", async () => {
        const events = await collect(streamOf(["event:a\r\ndata:1\r\n\r\n", "event: b\rdata: 2\r\r"]));
        expect(events).toEqual([{ event: "a", data: "1" }, { event: "b", data: "2" }]);
    });

    it("a CRLF split across two chunks is one line ending", async () => {
        const events = await collect(streamOf(["event: a\r", "\ndata: 1\r", "\n\r", "\n"]));
        expect(events).toEqual([{ event: "a", data: "1" }]);
    });

    it("an event without a name is 'message'; one without data is dropped", async () => {
        const events = await collect(streamOf(["data: x\n\n", "event: empty\n\n"]));
        expect(events).toEqual([{ event: "message", data: "x" }]);
    });

    it("decodes UTF-8 split inside a character", async () => {
        const bytes = new TextEncoder().encode('event: message\ndata: {"text":"สวัสดี 🎬"}\n\n');
        const chunks = [bytes.slice(0, 27), bytes.slice(27, 28), bytes.slice(28, 41), bytes.slice(41)];
        const events = await collect(streamOf(chunks));
        expect(JSON.parse(events[0]!.data)).toEqual({ text: "สวัสดี 🎬" });
    });

    it("drops an unfinished event at the end of the stream", async () => {
        const events = await collect(streamOf(["event: a\ndata: 1\n\n", "event: b\ndata: 2\n"]));
        expect(events).toEqual([{ event: "a", data: "1" }]);
    });

    it("any random chunking gives the same events (property)", async () => {
        const text = [
            ": ping\n\n",
            'event: turn.started\r\ndata: {"turn_id":"turn_abc","hold_usd":0.429}\r\n\r\n',
            "event: message\ndata: {\"round\":1,\"text\":\"Done: scene 2 is 4 s — ✂️ ok\"}\n\n",
            "event: tool.started\ndata: {\"label\":\"Draw the storyboard of scene 3\"}\n\n",
            "event: turn.finished\ndata: {\"id\":\"turn_abc\"}\n\n",
        ].join("");
        const bytes = new TextEncoder().encode(text);
        const expected = await collect(streamOf([bytes]));
        expect(expected.map((e) => e.event)).toEqual(["turn.started", "message", "tool.started", "turn.finished"]);
        let seed = 7;
        const random = () => {
            seed = (seed * 1103515245 + 12345) % 2147483648;
            return seed / 2147483648;
        };
        for (let run = 0; run < 200; run++) {
            const chunks: Uint8Array[] = [];
            let at = 0;
            while (at < bytes.length) {
                const size = 1 + Math.floor(random() * 12);
                chunks.push(bytes.slice(at, at + size));
                at += size;
            }
            expect(await collect(streamOf(chunks))).toEqual(expected);
        }
    });

    it("fails with SseIdleError when no byte arrives for the idle time", async () => {
        vi.useFakeTimers();
        try {
            const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode("event: a\ndata: 1\n\n")); } });
            const seen: SseEvent[] = [];
            const run = (async () => {
                for await (const event of readSse(stream, { idleMs: 30_000 })) seen.push(event);
            })();
            const settled = run.then(() => "done", (error) => error);
            await vi.advanceTimersByTimeAsync(29_000);
            expect(seen).toHaveLength(1);
            await vi.advanceTimersByTimeAsync(2_000);
            const outcome = await settled;
            expect(outcome).toBeInstanceOf(SseIdleError);
        } finally {
            vi.useRealTimers();
        }
    });

    it("a heartbeat comment keeps the stream alive", async () => {
        vi.useFakeTimers();
        try {
            let push!: (text: string) => void;
            let close!: () => void;
            const stream = new ReadableStream<Uint8Array>({
                start(controller) {
                    push = (text) => controller.enqueue(new TextEncoder().encode(text));
                    close = () => controller.close();
                },
            });
            const seen: SseEvent[] = [];
            const run = (async () => {
                for await (const event of readSse(stream, { idleMs: 30_000 })) seen.push(event);
            })();
            const settled = run.then(() => "done", (error) => error);
            for (let i = 0; i < 4; i++) {
                await vi.advanceTimersByTimeAsync(15_000);
                push(": ping\n\n");
            }
            push("event: a\ndata: 1\n\n");
            close();
            expect(await settled).toBe("done");
            expect(seen).toEqual([{ event: "a", data: "1" }]);
        } finally {
            vi.useRealTimers();
        }
    });

    it("stops reading and cancels the stream when the signal aborts", async () => {
        let cancelled = false;
        const controller = new AbortController();
        const stream = new ReadableStream<Uint8Array>({
            start(c) {
                c.enqueue(new TextEncoder().encode("event: a\ndata: 1\n\n"));
            },
            cancel() {
                cancelled = true;
            },
        });
        const seen: SseEvent[] = [];
        await expect((async () => {
            for await (const event of readSse(stream, { signal: controller.signal })) {
                seen.push(event);
                controller.abort();
            }
        })()).rejects.toMatchObject({ name: "AbortError" });
        expect(seen).toHaveLength(1);
        expect(cancelled).toBe(true);
    });
});
