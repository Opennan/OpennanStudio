import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JobCancelledError } from "@opennan/provider-sdk";
import { WHISPER_CHECKSUM_MISMATCH, loadWhisperBinary } from "./binary";
import { buildWhisperArgs } from "./whisper-args";
import { redactPaths, runWhisper, whisperEnv } from "./whisper-runner";

const FAKE = fileURLToPath(new URL("../test/fixtures/fake-whisper.mjs", import.meta.url));
const posix = process.platform !== "win32";
const sha = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");

function binaryDir(): string {
    const dir = mkdtempSync(path.join(tmpdir(), "opennan whisper bin "));
    const exe = path.join(dir, "whisper-cli");
    writeFileSync(exe, `#!/usr/bin/env node\n${readFileSync(FAKE, "utf8")}`);
    chmodSync(exe, 0o755);
    writeFileSync(path.join(dir, "libggml.so.0"), "lib");
    writeFileSync(path.join(dir, "checksums.json"), JSON.stringify({ version: "test", files: { "whisper-cli": sha(exe), "libggml.so.0": sha(path.join(dir, "libggml.so.0")) } }));
    return dir;
}

describe("loadWhisperBinary", () => {
    let dir: string;
    beforeEach(() => {
        dir = binaryDir();
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it("loads a folder whose files match checksums.json", async () => {
        const binary = await loadWhisperBinary(dir, { platform: "linux" });
        expect(binary.path).toBe(path.join(dir, "whisper-cli"));
        expect(Object.keys(binary.files).sort()).toEqual(["libggml.so.0", "whisper-cli"]);
    });

    it("refuses a tampered binary or library, a missing or bad checksums.json, and links", async () => {
        writeFileSync(path.join(dir, "libggml.so.0"), "evil");
        await expect(loadWhisperBinary(dir, { platform: "linux" })).rejects.toThrow(/libggml\.so\.0 does not match/);
        writeFileSync(path.join(dir, "libggml.so.0"), "lib");
        writeFileSync(path.join(dir, "whisper-cli"), "#!/bin/sh\necho evil\n");
        await expect(loadWhisperBinary(dir, { platform: "linux" })).rejects.toThrow(WHISPER_CHECKSUM_MISMATCH);
        await expect(loadWhisperBinary(dir, { platform: "win32" })).rejects.toThrow(/does not list whisper-cli\.exe/);
        writeFileSync(path.join(dir, "checksums.json"), JSON.stringify({ files: { "../whisper-cli": "0".repeat(64) } }));
        await expect(loadWhisperBinary(dir)).rejects.toThrow(/invalid file/);
        writeFileSync(path.join(dir, "checksums.json"), "{");
        await expect(loadWhisperBinary(dir)).rejects.toThrow(/not valid JSON/);
        rmSync(path.join(dir, "checksums.json"));
        await expect(loadWhisperBinary(dir)).rejects.toThrow(/checksums\.json is missing/);
        await expect(loadWhisperBinary("relative/dir")).rejects.toThrow(/absolute/);
    });

    it.skipIf(!posix)("refuses a symlinked binary", async () => {
        const real = path.join(dir, "real-cli");
        copyFileSync(path.join(dir, "whisper-cli"), real);
        rmSync(path.join(dir, "whisper-cli"));
        symlinkSync(real, path.join(dir, "whisper-cli"));
        await expect(loadWhisperBinary(dir, { platform: "linux" })).rejects.toThrow(/not a regular file/);
    });
});

describe.skipIf(!posix)("runWhisper with a fake whisper-cli", () => {
    let dir: string;
    let work: string;
    let model: string;
    let wav: string;
    beforeEach(() => {
        dir = binaryDir();
        work = mkdtempSync(path.join(tmpdir(), "opennan whisper work "));
        model = path.join(work, "my \"model\".bin");
        wav = path.join(work, "mix.wav");
        writeFileSync(model, "model");
        writeFileSync(wav, "wav");
    });
    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
        rmSync(work, { recursive: true, force: true });
    });
    const tempLeft = () => readdirSync(tmpdir()).filter((name) => name.startsWith("opennan-whisper-"));
    const env = (mode = "ok") => ({ ...whisperEnv(), FAKE_WHISPER_MODE: mode, FAKE_WHISPER_LOG: path.join(work, "argv.json") });

    it("passes the argv as built, reports progress, and parses the transcript", async () => {
        const before = tempLeft();
        const binary = await loadWhisperBinary(dir, { platform: "linux" });
        const progress: number[] = [];
        const transcript = await runWhisper({ binary, modelPath: model, wavPath: wav, language: "en", threads: 2, env: env(), onProgress: (r) => progress.push(r) });
        expect(transcript.language).toBe("en");
        expect(transcript.segments.map((s) => s.text)).toEqual([
            "And so, my fellow Americans, ask not what", "your country can do for you, ask what you", "can do for your country.",
        ]);
        expect(progress).toEqual([0, 0.5, 1]);
        const argv = JSON.parse(readFileSync(path.join(work, "argv.json"), "utf8")) as string[];
        const outputBase = argv[argv.indexOf("-of") + 1];
        expect(argv).toEqual(buildWhisperArgs({ modelPath: model, wavPath: wav, outputBase, language: "en", threads: 2 }));
        expect(argv[1]).toBe(model);
        // Other test processes (desktop transcription tests under a full turbo run) use the same prefix in the shared
        // temp folder for a moment: wait for theirs to go too rather than fail on a neighbour's folder.
        await vi.waitFor(() => expect(tempLeft().filter((name) => !before.includes(name))).toEqual([]), { timeout: 15_000 });
    });

    it("reports a failing run with the end of stderr", async () => {
        const binary = await loadWhisperBinary(dir, { platform: "linux" });
        const failed = await runWhisper({ binary, modelPath: model, wavPath: wav, env: env("fail") }).catch((error: Error) => error);
        expect((failed as Error).message).toMatch(/exit 3.*failed to load the model 'my "model"\.bin'/);
        expect((failed as Error).message).not.toContain(work);
        await expect(runWhisper({ binary, modelPath: model, wavPath: wav, env: env("bad-json") })).rejects.toThrow(/not valid JSON/);
    });

    it("kills a run on cancel and rejects with JobCancelledError", async () => {
        const binary = await loadWhisperBinary(dir, { platform: "linux" });
        const abort = new AbortController();
        const started = Date.now();
        const run = runWhisper({ binary, modelPath: model, wavPath: wav, env: env("hang"), signal: abort.signal, onProgress: (r) => { if (r === 1) abort.abort(); } });
        await expect(run).rejects.toBeInstanceOf(JobCancelledError);
        expect(Date.now() - started).toBeLessThan(3000);
        const early = new AbortController();
        early.abort();
        await expect(runWhisper({ binary, modelPath: model, wavPath: wav, env: env(), signal: early.signal })).rejects.toBeInstanceOf(JobCancelledError);
    });

    it("stops a run that exceeds its timeout", async () => {
        const binary = await loadWhisperBinary(dir, { platform: "linux" });
        await expect(runWhisper({ binary, modelPath: model, wavPath: wav, env: env("hang"), timeoutMs: 300 })).rejects.toThrow(/did not finish within/);
    });

    it("refuses relative, missing, linked, or non-WAV inputs before spawning", async () => {
        const binary = await loadWhisperBinary(dir, { platform: "linux" });
        await expect(runWhisper({ binary, modelPath: "model.bin", wavPath: wav, env: env() })).rejects.toThrow(/absolute/);
        await expect(runWhisper({ binary, modelPath: model, wavPath: path.join(work, "nope.wav"), env: env() })).rejects.toThrow(/not a regular file/);
        await expect(runWhisper({ binary, modelPath: model, wavPath: model, env: env() })).rejects.toThrow(/\.wav/);
        const link = path.join(work, "link.wav");
        symlinkSync(wav, link);
        await expect(runWhisper({ binary, modelPath: model, wavPath: link, env: env() })).rejects.toThrow(/not a regular file/);
    });
});

describe("redactPaths", () => {
    it("turns known paths into file names", () => {
        expect(redactPaths("cannot open /Users/me/models/ggml-base.bin in /tmp/opennan-whisper-x", ["/Users/me/models/ggml-base.bin", "/tmp/opennan-whisper-x"]))
            .toBe("cannot open ggml-base.bin in opennan-whisper-x");
    });
});

describe("whisperEnv", () => {
    it("keeps only PATH, temp, home, and locale", () => {
        expect(whisperEnv({ PATH: "/bin", HOME: "/h", SECRET_TOKEN: "x", ANTHROPIC_API_KEY: "k", TMPDIR: "/t" })).toEqual({ PATH: "/bin", HOME: "/h", TMPDIR: "/t" });
    });
});
