import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createModelStore } from "./model-store";
import type { WhisperModel } from "./models";

const BYTES = Buffer.from("tiny whisper model ".repeat(64));
const CATALOG: WhisperModel[] = [
    { id: "tiny", label: "Tiny", file: "ggml-tiny.bin", url: "https://huggingface.co/x/resolve/rev/ggml-tiny.bin", sizeBytes: BYTES.length, sha256: createHash("sha256").update(BYTES).digest("hex"), license: "MIT" },
    { id: "base", label: "Base", file: "ggml-base.bin", url: "https://huggingface.co/x/resolve/rev/ggml-base.bin", sizeBytes: 4, sha256: "0".repeat(64), license: "MIT" },
];

describe("createModelStore", () => {
    let dir: string;
    let fetches: number;
    const fetchImpl = (async () => {
        fetches += 1;
        return new Response(BYTES, { status: 200, headers: { "content-length": String(BYTES.length) } });
    }) as unknown as typeof fetch;
    beforeEach(() => {
        dir = path.join(mkdtempSync(path.join(tmpdir(), "opennan-models-")), "whisper");
        fetches = 0;
    });
    afterEach(() => rmSync(path.dirname(dir), { recursive: true, force: true }));
    const store = () => createModelStore({ dir, fetch: fetchImpl, catalog: CATALOG });

    it("downloads a model once, then trusts its stamp", async () => {
        const progress: number[] = [];
        const file = await store().ensure("tiny", { onDownload: (p) => progress.push(p.received) });
        expect(file).toBe(path.join(dir, "ggml-tiny.bin"));
        expect(readFileSync(file)).toEqual(BYTES);
        expect(JSON.parse(readFileSync(`${file}.verified`, "utf8"))).toMatchObject({ sha256: CATALOG[0].sha256, size: BYTES.length });
        expect(progress.at(-1)).toBe(BYTES.length);
        await store().ensure("tiny", { onDownload: () => { throw new Error("must not download"); } });
        expect(fetches).toBe(1);
        expect((await store().list()).map((m) => [m.id, m.installed, m.default])).toEqual([["tiny", true, false], ["base", false, true]]);
    });

    it("shares one download between concurrent callers", async () => {
        const s = store();
        await Promise.all([s.ensure("tiny"), s.ensure("tiny"), s.ensure("tiny")]);
        expect(fetches).toBe(1);
    });

    it("re-verifies a file whose stamp no longer matches, and replaces a tampered one", async () => {
        const file = await store().ensure("tiny");
        const tampered = Buffer.from(BYTES);
        tampered[0] ^= 1;
        writeFileSync(file, tampered);
        utimesSync(file, new Date(), new Date(Date.now() + 5000));
        expect((await store().list())[0].installed).toBe(false);
        await store().ensure("tiny");
        expect(fetches).toBe(2);
        expect(readFileSync(file)).toEqual(BYTES);
    });

    it("adopts a correct file that has no stamp without downloading", async () => {
        const s = store();
        await s.ensure("tiny");
        rmSync(path.join(dir, "ggml-tiny.bin.verified"));
        await store().ensure("tiny");
        expect(fetches).toBe(1);
        expect(existsSync(path.join(dir, "ggml-tiny.bin.verified"))).toBe(true);
    });

    it("refuses unknown ids, symlinked models, and relative folders", async () => {
        await expect(store().ensure("../../etc/passwd")).rejects.toThrow(/Unknown model/);
        await store().ensure("tiny");
        const other = path.join(path.dirname(dir), "elsewhere.bin");
        writeFileSync(other, BYTES);
        rmSync(path.join(dir, "ggml-tiny.bin"));
        symlinkSync(other, path.join(dir, "ggml-tiny.bin"));
        await expect(store().ensure("tiny")).rejects.toThrow(/not a regular file/);
        expect(() => createModelStore({ dir: "models" })).toThrow(/absolute/);
    });

    it("leaves nothing behind when the download fails its hash", async () => {
        await expect(store().ensure("base")).rejects.toThrow(/expected 4/);
        expect(existsSync(path.join(dir, "ggml-base.bin"))).toBe(false);
        expect(existsSync(path.join(dir, "ggml-base.bin.verified"))).toBe(false);
    });

    it("removes part files left by an earlier crash before downloading", async () => {
        const fs = await import("node:fs");
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, "ggml-tiny.bin.part-0123456789ab"), "leftover");
        fs.writeFileSync(path.join(dir, "other.txt"), "keep");
        await store().ensure("tiny");
        expect(fs.readdirSync(dir).sort()).toEqual(["ggml-tiny.bin", "ggml-tiny.bin.verified", "other.txt"]);
    });

    it("does not hand a cancelled download to the next caller", async () => {
        let release: (() => void) | undefined;
        const slow = (async (_url: unknown, init?: RequestInit) => {
            fetches += 1;
            if (fetches === 1) {
                await new Promise<void>((resolve) => { release = resolve; });
                if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError");
            }
            return new Response(BYTES, { status: 200, headers: { "content-length": String(BYTES.length) } });
        }) as unknown as typeof fetch;
        const s = createModelStore({ dir, fetch: slow, catalog: CATALOG });
        const abort = new AbortController();
        const first = s.ensure("tiny", { signal: abort.signal });
        // Wait for the first fetch to be in flight; a fixed sleep loses the race under full parallel load.
        await vi.waitFor(() => expect(release).toBeTypeOf("function"), { timeout: 5000, interval: 5 });
        abort.abort();
        const second = s.ensure("tiny");
        release!();
        await expect(first).rejects.toThrow();
        await expect(second).resolves.toBe(path.join(dir, "ggml-tiny.bin"));
        expect(fetches).toBe(2);
    });
});
