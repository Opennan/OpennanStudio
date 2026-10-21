import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { JobCancelledError } from "@opennan/provider-sdk";
import { downloadVerified } from "./download";

const BYTES = new TextEncoder().encode("ggml model bytes for tests ".repeat(100));
const SHA = createHash("sha256").update(BYTES).digest("hex");
const URL0 = "https://huggingface.co/ggerganov/whisper.cpp/resolve/rev/ggml-test.bin";

function body(bytes: Uint8Array, chunk = 512, onPull?: (i: number) => void): ReadableStream<Uint8Array> {
    let i = 0;
    return new ReadableStream({
        pull(controller) {
            onPull?.(i);
            if (i >= bytes.length) return controller.close();
            controller.enqueue(bytes.slice(i, i + chunk));
            i += chunk;
        },
    });
}

const ok = (bytes = BYTES, headers: Record<string, string> = { "content-length": String(BYTES.length) }) => new Response(body(bytes), { status: 200, headers });
const redirect = (location: string) => new Response(null, { status: 302, headers: { location } });

describe("downloadVerified", () => {
    let dir: string;
    beforeEach(() => {
        dir = mkdtempSync(path.join(tmpdir(), "opennan-dl-"));
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));
    const dest = () => path.join(dir, "ggml-test.bin");
    const run = (fetchImpl: typeof fetch, extra: Partial<Parameters<typeof downloadVerified>[0]> = {}) =>
        downloadVerified({ url: URL0, sha256: SHA, sizeBytes: BYTES.length, dest: dest(), fetch: fetchImpl, ...extra });

    it("follows redirects to Hugging Face hosts and writes the verified file", async () => {
        const seen: string[] = [];
        const progress: number[] = [];
        await run(async (url) => {
            seen.push(String(url));
            return seen.length === 1 ? redirect("https://us.aws.cdn.hf.co/xet/abc?sig=1") : ok();
        }, { onProgress: (received) => progress.push(received) });
        expect(seen).toEqual([URL0, "https://us.aws.cdn.hf.co/xet/abc?sig=1"]);
        expect(readFileSync(dest())).toEqual(Buffer.from(BYTES));
        expect(progress.at(-1)).toBe(BYTES.length);
        expect(readdirSync(dir)).toEqual(["ggml-test.bin"]);
    });

    it.each([
        ["http:", "http://huggingface.co/x"],
        ["a foreign host", "https://evil.example/x"],
        ["a look-alike host", "https://huggingface.co.evil.example/x"],
    ])("refuses a redirect to %s", async (_name, location) => {
        await expect(run(async () => redirect(location))).rejects.toThrow(/Download refused/);
        expect(readdirSync(dir)).toEqual([]);
    });

    it("refuses a non-https first URL, too many redirects, and a redirect without location", async () => {
        await expect(run(async () => ok(), { url: "http://huggingface.co/x" })).rejects.toThrow(/not https/);
        await expect(run(async () => redirect("https://hf.co/again"))).rejects.toThrow(/too many redirects/);
        await expect(run(async () => new Response(null, { status: 301 }))).rejects.toThrow(/without a location/);
    });

    it("refuses a wrong size or a wrong hash and leaves no file", async () => {
        await expect(run(async () => ok(BYTES, { "content-length": "12" }))).rejects.toThrow(/expected/);
        await expect(run(async () => ok(new Uint8Array([...BYTES, 1]), {}))).rejects.toThrow(/larger than/);
        await expect(run(async () => ok(BYTES.slice(10), {}))).rejects.toThrow(/incomplete/);
        const tampered = BYTES.slice();
        tampered[5] ^= 1;
        await expect(run(async () => ok(tampered))).rejects.toThrow(/SHA-256 mismatch for ggml-test\.bin/);
        await expect(run(async () => new Response("nope", { status: 404 }))).rejects.toThrow(/HTTP 404/);
        expect(readdirSync(dir)).toEqual([]);
    });

    it("stops on abort, removes the part file, and reports cancellation", async () => {
        const abort = new AbortController();
        const stream = body(BYTES, 256, (i) => {
            if (i >= 1024) abort.abort();
        });
        await expect(run(async () => new Response(stream, { status: 200 }), { signal: abort.signal })).rejects.toBeInstanceOf(JobCancelledError);
        expect(readdirSync(dir)).toEqual([]);
        expect(existsSync(dest())).toBe(false);
    });

    it("needs an absolute destination", async () => {
        await expect(run(async () => ok(), { dest: "relative/model.bin" })).rejects.toThrow(/absolute/);
    });

    it("gives up on a connection that stops sending data", async () => {
        const stuck = (signal: AbortSignal) => new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(BYTES.slice(0, 100));
                signal.addEventListener("abort", () => controller.error(new Error("aborted")), { once: true });
            },
        });
        await expect(run(async (_url, init) => new Response(stuck(init!.signal!), { status: 200 }), { idleTimeoutMs: 50 })).rejects.toThrow("Download stalled: no data for 0 s");
        expect(readdirSync(dir)).toEqual([]);
        // The caller's own cancel is still a cancel, not a stall.
        const abort = new AbortController();
        const pending = run(async (_url, init) => new Response(stuck(init!.signal!), { status: 200 }), { signal: abort.signal, idleTimeoutMs: 10_000 });
        setTimeout(() => abort.abort(), 20);
        await expect(pending).rejects.toBeInstanceOf(JobCancelledError);
    });
});
