import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExportRunner, MediaInfo } from "@opennan/export";
import { findWhisperModel, sha256File } from "@opennan/provider-local";
import type { ControllerSnapshot } from "@opennan/timeline-core";
import type { AiJobEvent } from "../../shared/bridge";
import { resolveFfmpeg } from "../export/ffmpeg-paths";
import { resolveWhisper } from "./whisper-paths";
import { TRANSCRIPTION_BUSY, createTranscriptionService, type TranscriptionServiceOptions } from "./transcription";

const ID = "3f2b8c1e-1d2a-4c3b-9e8f-0a1b2c3d4e5f";
const TRANSCRIPT = { language: "en", segments: [{ start: 0, end: 1, text: "hello" }] };

function snapshotWith(mediaUrl: string): ControllerSnapshot {
    return {
        projectId: "p", project: { id: "p", name: "P", aspectRatio: "16:9" } as never, markers: [], currentTime: 0, canUndo: false, canRedo: false,
        selection: { clipIds: [], sceneId: null, transition: null, audioTarget: null },
        tracks: [{ type: "audio", index: 1, label: "A1", muted: false, locked: false, visible: true, volume: 1 }, { type: "audio", index: 2, label: "A2", muted: false, locked: false, visible: true, volume: 1 }],
        clips: [{ id: "c1", projectId: "p", trackType: "audio", trackIndex: 2, startTime: 0, endTime: 2, mediaUrl, mediaType: "audio" } as never],
        scenes: [],
    };
}

describe("createTranscriptionService", () => {
    let dir: string;
    let audioFile: string;
    let probed: string[][];
    let rendered: string[];
    beforeEach(() => {
        dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "opennan-tx-")));
        fs.mkdirSync(path.join(dir, "media"));
        audioFile = path.join(dir, "media", `${ID}.wav`);
        fs.writeFileSync(audioFile, "wav");
        probed = [];
        rendered = [];
    });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    function service(overrides: Partial<TranscriptionServiceOptions> = {}, runImpl?: TranscriptionServiceOptions["run"]) {
        const createRunner: TranscriptionServiceOptions["createRunner"] = (runnerOptions) => ({
            kind: "node", supportsGl: false, maxResolution: "4k",
            async probe(urls) {
                probed.push(urls);
                const out = new Map<string, MediaInfo>();
                for (const url of urls) {
                    const source = await runnerOptions.resolveSource!(url);
                    if (source) out.set(url, { durationSeconds: 2, hasVideo: false, hasAudio: true, width: 0, height: 0 });
                }
                return out;
            },
            chooseEncoder: async () => { throw new Error("unused"); },
            run: async () => { throw new Error("unused"); },
            async renderAudio(_plan, outputPath) {
                rendered.push(outputPath);
                fs.writeFileSync(outputPath, "RIFF");
            },
        }) as ExportRunner;
        // A pre-verified model so ensure() never downloads.
        const modelsDir = path.join(dir, "models");
        return createTranscriptionService({
            whisperDir: "/w", reason: null, ffmpeg: { ffmpegPath: "/ff/ffmpeg", ffprobePath: "/ff/ffprobe" },
            mediaStore: { root: path.join(dir, "media"), pathOf: (id) => (id === ID ? audioFile : null) },
            modelsDir, createRunner,
            fetch: (async () => { throw new Error("no network in tests"); }) as never,
            loadBinary: async () => ({ dir: "/w", path: "/w/whisper-cli", files: {} }),
            run: runImpl ?? (async (o) => {
                expect(fs.existsSync(o.wavPath)).toBe(true);
                o.onProgress?.(1);
                return TRANSCRIPT;
            }),
            ...overrides,
        });
    }

    function seedModel(id = "base") {
        const model = findWhisperModel(id)!;
        const modelsDir = path.join(dir, "models");
        fs.mkdirSync(modelsDir, { recursive: true });
        // A file of the catalog size with a matching stamp: list()/ensure() trust the stamp (size + mtime).
        const file = path.join(modelsDir, model.file);
        fs.writeFileSync(file, "");
        fs.truncateSync(file, model.sizeBytes);
        const stat = fs.statSync(file);
        fs.writeFileSync(`${file}.verified`, JSON.stringify({ sha256: model.sha256, size: stat.size, mtimeMs: stat.mtimeMs }));
    }

    const events = (s: ReturnType<typeof service>) => {
        const seen: AiJobEvent[] = [];
        s.subscribe((event) => seen.push(event));
        return seen;
    };
    const settled = (seen: AiJobEvent[]) => vi.waitFor(() => expect(seen.some((e) => ["succeeded", "failed", "cancelled"].includes(e.status))).toBe(true));

    it("mixes only imported media and transcribes the mix", async () => {
        seedModel();
        const s = service();
        const seen = events(s);
        const { jobId } = await s.start({ snapshot: snapshotWith(`opennan-local://media/${ID}`), language: "en" });
        await settled(seen);
        expect(seen.at(-1)).toEqual({ jobId, status: "succeeded", progress: 1, transcript: { ...TRANSCRIPT, model: "base", durationSeconds: 2 } });
        expect(seen.map((e) => e.status)).toContain("running");
        expect(probed).toEqual([[`opennan-local://media/${ID}`]]);
        expect(rendered).toHaveLength(1);
        // The mix folder is removed after the job.
        expect(fs.existsSync(path.dirname(rendered[0]))).toBe(false);
    });

    it("never hands ffmpeg media that was not imported", async () => {
        seedModel();
        const s = service();
        const seen = events(s);
        await s.start({ snapshot: snapshotWith("file:///etc/passwd") });
        await settled(seen);
        expect(seen.at(-1)).toMatchObject({ status: "failed", error: "The timeline has no audio to transcribe." });
        expect(rendered).toEqual([]);
    });

    it("transcribes one imported media's range, trimmed to 16 kHz WAV by the preparer", async () => {
        seedModel();
        const prepared: unknown[] = [];
        let cleaned = 0;
        const wav = path.join(dir, "range.wav");
        fs.writeFileSync(wav, "RIFF");
        const s = service({
            preparer: {
                prepareFile: async (input, purpose) => {
                    prepared.push({ input, purpose });
                    return { path: wav, contentType: "audio/wav", filename: "audio.wav", sizeBytes: 4, durationSeconds: 2, cleanup: async () => void cleaned++ };
                },
            },
        }, async (o) => {
            expect(o.wavPath).toBe(wav);
            return TRANSCRIPT;
        });
        const seen = events(s);
        const source = { mediaUrl: `opennan-local://media/${ID}`, startSeconds: 1, endSeconds: 3 };
        const { jobId } = await s.start({ source, language: "en" });
        await settled(seen);
        expect(seen.at(-1)).toEqual({ jobId, status: "succeeded", progress: 1, transcript: { ...TRANSCRIPT, model: "base", durationSeconds: 2 } });
        expect(prepared).toEqual([{ input: { kind: "media", source }, purpose: expect.objectContaining({ output: "audio", sampleRate: 16_000, contentTypes: ["audio/wav"] }) }]);
        expect(cleaned).toBe(1);
        expect(rendered).toEqual([]);
    });

    it("refuses a media range that is not imported media", async () => {
        seedModel();
        const prepareFile = vi.fn();
        const s = service({ preparer: { prepareFile } });
        const seen = events(s);
        await s.start({ source: { mediaUrl: "https://cdn.example/a.mp3" } });
        await settled(seen);
        expect(seen.at(-1)).toMatchObject({ status: "failed", error: expect.stringMatching(/imported into the project/) });
        expect(prepareFile).not.toHaveBeenCalled();
    });

    it("runs one job at a time and cancels", async () => {
        seedModel();
        // whisper takes a moment to exit after a cancel (SIGTERM, then SIGKILL).
        let exited = false;
        const s = service({}, (o) => new Promise((_resolve, reject) => o.signal!.addEventListener("abort", () => setTimeout(() => {
            exited = true;
            reject(Object.assign(new Error("cancelled"), { name: "JobCancelledError" }));
        }, 50))));
        const seen = events(s);
        const { jobId } = await s.start({ snapshot: snapshotWith(`opennan-local://media/${ID}`) });
        await expect(s.start({ snapshot: snapshotWith(`opennan-local://media/${ID}`) })).rejects.toThrow(TRANSCRIPTION_BUSY);
        await vi.waitFor(() => expect(seen.some((e) => e.message === "Transcribing")).toBe(true));
        await s.cancel("job-other");
        await s.cancel(jobId);
        await settled(seen);
        expect(seen.at(-1)).toEqual({ jobId, status: "cancelled" });
        // "Try again" right away waits for the old run to stop instead of failing as busy.
        expect(exited).toBe(false);
        const again = await s.start({ snapshot: snapshotWith(`opennan-local://media/${ID}`) });
        expect(exited).toBe(true);
        expect(again.jobId).not.toBe(jobId);
        await s.cancelAll();
    });

    it("cancelAll resolves only after the running job has stopped (so quit leaves no whisper or temp files behind)", async () => {
        seedModel();
        let exited = false;
        const s = service({}, (o) => new Promise((_resolve, reject) => o.signal!.addEventListener("abort", () => setTimeout(() => {
            exited = true;
            reject(Object.assign(new Error("cancelled"), { name: "JobCancelledError" }));
        }, 50))));
        const seen = events(s);
        await s.start({ snapshot: snapshotWith(`opennan-local://media/${ID}`) });
        await vi.waitFor(() => expect(seen.some((e) => e.message === "Transcribing")).toBe(true));
        await s.cancelAll();
        expect(exited).toBe(true);
    });

    it("reports why it is unavailable", async () => {
        expect(service({ whisperDir: null, reason: "No whisper.cpp here" }).status()).toEqual({ available: false, reason: "No whisper.cpp here" });
        expect(service({ ffmpeg: null }).status()).toEqual({ available: false, reason: expect.stringMatching(/ffmpeg/) });
        await expect(service({ ffmpeg: null }).start({ snapshot: snapshotWith("x") })).rejects.toThrow(/ffmpeg/);
        expect(service().status()).toEqual({ available: true, reason: null });
    });

    it("lists the catalog models with what is downloaded", async () => {
        seedModel("tiny");
        const models = await service().models();
        expect(models.map((m) => [m.id, m.installed, m.default])).toEqual([["tiny", true, false], ["base", false, true], ["small", false, false]]);
    });
});

// Real ffmpeg + whisper.cpp + the cached tiny model (pnpm --filter @opennan/desktop fetch:ffmpeg / fetch:whisper; the smoke fills the cache).
const REPO = path.resolve(__dirname, "../../../../..");
const ffmpeg = resolveFfmpeg({ env: process.env, resourcesPath: "", appPath: path.resolve(__dirname, "../../.."), platform: process.platform, arch: process.arch, isPackaged: false });
const whisper = resolveWhisper({ env: process.env, resourcesPath: "", appPath: path.resolve(__dirname, "../../.."), platform: process.platform, arch: process.arch, isPackaged: false });
const TINY = path.join(REPO, ".cache", "whisper-models", "ggml-tiny.bin");
const NATIVE = Boolean(ffmpeg && whisper.dir && fs.existsSync(TINY));

describe.skipIf(!NATIVE)("createTranscriptionService on the bundled ffmpeg and whisper.cpp", () => {
    it("transcribes jfk.wav imported into the media folder", async () => {
        const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "opennan-txn-")));
        try {
            fs.mkdirSync(path.join(dir, "media"));
            const media = path.join(dir, "media", `${ID}.wav`);
            fs.copyFileSync(path.join(REPO, "packages/provider-local/test/fixtures/jfk.wav"), media);
            const modelsDir = path.join(dir, "models");
            fs.mkdirSync(modelsDir);
            fs.copyFileSync(TINY, path.join(modelsDir, "ggml-tiny.bin"));
            expect(await sha256File(path.join(modelsDir, "ggml-tiny.bin"))).toBe(findWhisperModel("tiny")!.sha256);
            const s = createTranscriptionService({
                whisperDir: whisper.dir, reason: null, ffmpeg, modelsDir,
                mediaStore: { root: path.join(dir, "media"), pathOf: (id) => (id === ID ? media : null) },
            });
            const duration = Number(execFileSync(ffmpeg!.ffprobePath, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", media], { encoding: "utf8" }));
            const snapshot = snapshotWith(`opennan-local://media/${ID}`);
            (snapshot.clips[0] as { endTime: number }).endTime = duration;
            const seen: AiJobEvent[] = [];
            s.subscribe((event) => seen.push(event));
            await s.start({ snapshot, model: "tiny", language: "auto" });
            await vi.waitFor(() => expect(seen.some((e) => e.status === "succeeded" || e.status === "failed")).toBe(true), { timeout: 60_000 });
            const last = seen.at(-1)!;
            expect(last.error).toBeUndefined();
            expect(last.transcript!.segments.map((x) => x.text).join(" ")).toMatch(/your country/i);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    }, 90_000);
});
