import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createNodeRunner } from "@opennan/export/node";
import { EXPORT_BUSY, MAX_GPU_JOB_RECORDS, MAX_GPU_VIDEO_BYTES, createGpuJobs, sweepGpuTemp } from "./gpu-jobs";

const FFMPEG = process.env.OPENNAN_FFMPEG ?? "/opt/homebrew/bin/ffmpeg";
const FFPROBE = process.env.OPENNAN_FFPROBE ?? "/opt/homebrew/bin/ffprobe";
const HAVE_FFMPEG = fs.existsSync(FFMPEG) && fs.existsSync(FFPROBE);

const snapshot = (url: string) => ({
    projectId: "p", project: { name: "Trip", aspectRatio: "16:9", musicUrl: null, musicVolume: 1 },
    tracks: [{ type: "video", index: 1, label: "", muted: false, locked: false, visible: true, volume: 1 }],
    clips: [],
    scenes: [{
        id: "s", order: 0, caption: "", startTime: "0", endTime: "0", startImageUrl: null, endImageUrl: null, videoUrl: null, sourceVideoUrl: url,
        status: "ready", transition: "cut", cardType: "source_clip", duration: 2, frameConsistencyScore: null, audioUrl: null, audioText: null,
        cardConfig: null, timelinePositionSeconds: 0.001,
    }],
}) as never;

describe("GPU export jobs", () => {
    let dir: string;
    beforeEach(() => {
        dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "opennan-gpujobs-")));
    });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    const fakeRunner = () => ({ kind: "node", supportsGl: false, maxResolution: "4k", probe: vi.fn(async () => new Map()), chooseEncoder: vi.fn(), run: vi.fn(), mux: vi.fn() }) as never;

    it("refuses without ffmpeg, while main exports, and a second job; ends a job on abort", async () => {
        const none = createGpuJobs({ runner: null, mainBusy: () => false, setTarget: vi.fn(), tempDir: dir });
        await expect(none.begin({ options: {}, snapshot: snapshot("/m/a.mkv"), container: "mp4" })).resolves.toEqual({ error: expect.stringContaining("ffmpeg") });
        let busy = true;
        const jobs = createGpuJobs({ runner: fakeRunner(), mainBusy: () => busy, setTarget: vi.fn(), tempDir: dir });
        await expect(jobs.begin({ options: {}, snapshot: snapshot("/m/a.mkv"), container: "mp4" })).resolves.toEqual({ error: EXPORT_BUSY });
        busy = false;
        const begun = await jobs.begin({ options: {}, snapshot: snapshot("/m/a.mkv"), container: "mp4" }) as { jobId: string };
        expect(begun.jobId).toMatch(/^[0-9a-f-]{36}$/);
        expect(jobs.active()).toBe(true);
        await expect(jobs.begin({ options: {}, snapshot: snapshot("/m/a.mkv"), container: "mp4" })).resolves.toEqual({ error: EXPORT_BUSY });
        expect(fs.readdirSync(dir)).toHaveLength(1);
        await jobs.abort(begun.jobId);
        expect(jobs.active()).toBe(false);
        expect(fs.readdirSync(dir)).toHaveLength(0);
        await expect(jobs.chunk(begun.jobId, 0, new Uint8Array([1]))).rejects.toThrow("No such export job");
    });

    it("refuses chunks past the size limit and a mux of an empty video", async () => {
        const jobs = createGpuJobs({ runner: fakeRunner(), mainBusy: () => false, setTarget: vi.fn(), tempDir: dir });
        const { jobId } = await jobs.begin({ options: {}, snapshot: snapshot("/m/a.mkv"), container: "mp4" }) as { jobId: string };
        await expect(jobs.chunk(jobId, MAX_GPU_VIDEO_BYTES, new Uint8Array([1]))).rejects.toThrow("too large");
        await expect(jobs.chunk(jobId, -1, new Uint8Array([1]))).rejects.toThrow("too large");
        await expect(jobs.mux(jobId)).rejects.toThrow("no video");
        expect(jobs.active()).toBe(false);
        expect(fs.readdirSync(dir)).toHaveLength(0);
    });

    it("finishes a GIF job with the runner's GIF step from its own snapshot, not the audio mux (phase 10d)", async () => {
        const gif = vi.fn(async () => ({ kind: "file", path: path.join(dir, "out.gif") }));
        const runner = { ...(fakeRunner() as object), gif } as never;
        const jobs = createGpuJobs({ runner, mainBusy: () => false, setTarget: vi.fn(), tempDir: dir });
        const withMusic = { ...(snapshot("/m/a.mkv") as object), project: { name: "Trip", aspectRatio: "16:9", musicUrl: "/m/music.mp3", musicVolume: 1 } } as never;
        const { jobId } = await jobs.begin({ options: { resolution: "1080p", format: "gif" }, snapshot: withMusic, container: "mp4" }) as { jobId: string };
        await jobs.chunk(jobId, 0, new Uint8Array([1, 2, 3]));
        await expect(jobs.mux(jobId)).resolves.toEqual({ path: path.join(dir, "out.gif") });
        expect(gif).toHaveBeenCalledWith(
            { format: expect.objectContaining({ width: 640, height: 360, fps: 15 }), durationSeconds: 2 },
            { kind: "file", path: expect.stringMatching(/video\.mp4$/) },
            expect.objectContaining({ container: "mp4" }),
        );
        expect((runner as { mux: ReturnType<typeof vi.fn> }).mux).not.toHaveBeenCalled();
        // A GIF has no audio: no "audio could not be read" warnings from the unread media.
        const done = jobs.status(jobId)!.state;
        expect(done).toMatchObject({ status: "done", result: { container: "gif", mimeType: "image/gif" } });
        expect((done as { result: { warnings: Array<{ code: string }> } }).result.warnings.map((w) => w.code)).not.toContain("media-unreadable");
        // A runner without a GIF step refuses GIF jobs up front.
        const plain = createGpuJobs({ runner: fakeRunner(), mainBusy: () => false, setTarget: vi.fn(), tempDir: dir });
        await expect(plain.begin({ options: { format: "gif" }, snapshot: snapshot("/m/a.mkv"), container: "mp4" })).resolves.toEqual({ error: expect.stringContaining("GIF") });
    });

    it("opens one job when two begins race (the slot is claimed before the first await)", async () => {
        const jobs = createGpuJobs({ runner: fakeRunner(), mainBusy: () => false, setTarget: vi.fn(), tempDir: dir });
        const results = await Promise.all([
            jobs.begin({ options: {}, snapshot: snapshot("/m/a.mkv"), container: "mp4" }),
            jobs.begin({ options: {}, snapshot: snapshot("/m/a.mkv"), container: "mp4" }),
        ]);
        expect(results.filter((r) => "jobId" in r)).toHaveLength(1);
        expect(results.filter((r) => "error" in r)).toEqual([{ error: EXPORT_BUSY }]);
        expect(fs.readdirSync(dir)).toHaveLength(1);
        await jobs.abortAll();
        expect(fs.readdirSync(dir)).toHaveLength(0);
    });

    it("never writes a chunk after the job ended (writes are ordered before the descriptor closes)", async () => {
        const jobs = createGpuJobs({ runner: fakeRunner(), mainBusy: () => false, setTarget: vi.fn(), tempDir: dir });
        const { jobId } = await jobs.begin({ options: {}, snapshot: snapshot("/m/a.mkv"), container: "mp4" }) as { jobId: string };
        const first = jobs.chunk(jobId, 0, new Uint8Array(1024));
        const aborted = jobs.abort(jobId);
        await first.catch(() => undefined);
        await aborted;
        await expect(jobs.chunk(jobId, 1024, new Uint8Array(4))).rejects.toThrow();
        expect(fs.readdirSync(dir)).toHaveLength(0);
    });

    it("sweeps job folders a crash left behind, keeping recent ones", async () => {
        const old = path.join(dir, "opennan-gpu-old");
        const fresh = path.join(dir, "opennan-gpu-new");
        const other = path.join(dir, "keep-me");
        for (const d of [old, fresh, other]) fs.mkdirSync(d);
        const past = new Date(Date.now() - 3 * 60 * 60 * 1000);
        fs.utimesSync(old, past, past);
        fs.utimesSync(other, past, past);
        await expect(sweepGpuTemp(dir)).resolves.toBe(1);
        expect(fs.readdirSync(dir).sort()).toEqual(["keep-me", "opennan-gpu-new"]);
    });

    it.skipIf(!HAVE_FFMPEG)("writes streamed chunks and muxes them with the timeline's audio into the exports folder", async () => {
        const media = path.join(dir, "media");
        const exportsDir = path.join(dir, "exports");
        fs.mkdirSync(media);
        fs.mkdirSync(exportsDir);
        execFileSync(FFMPEG, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30:duration=2", "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
            "-c:v", "ffv1", "-c:a", "flac", "-shortest", path.join(media, "a.mkv")]);
        const video = path.join(dir, "gpu.mp4");
        execFileSync(FFMPEG, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=320x180:rate=30:duration=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", video]);
        const runner = createNodeRunner({
            ffmpegPath: FFMPEG, ffprobePath: FFPROBE, mediaRoots: [media],
            resolveSource: (url) => (url === "/m/a.mkv" ? path.join(media, "a.mkv") : null),
            outputPath: (container) => path.join(exportsDir, `trip.${container}`),
        });
        const setTarget = vi.fn();
        const tempDir = path.join(dir, "tmp");
        fs.mkdirSync(tempDir);
        const jobs = createGpuJobs({ runner, mainBusy: () => false, setTarget, tempDir });
        const { jobId } = await jobs.begin({ options: { resolution: "720p" }, snapshot: snapshot("/m/a.mkv"), container: "mp4" }) as { jobId: string };
        expect(setTarget).toHaveBeenCalledWith("Trip");
        const bytes = new Uint8Array(fs.readFileSync(video));
        const half = Math.floor(bytes.length / 2);
        // Out of order, as a muxer that seeks back to patch a header writes.
        await jobs.chunk(jobId, half, bytes.subarray(half));
        await jobs.chunk(jobId, 0, bytes.subarray(0, half));
        const { path: out } = await jobs.mux(jobId);
        expect(out).toBe(path.join(exportsDir, "trip.mp4"));
        const probe = JSON.parse(execFileSync(FFPROBE, ["-v", "error", "-show_entries", "stream=codec_name", "-of", "json", out], { encoding: "utf8" }));
        expect(probe.streams.map((s: { codec_name: string }) => s.codec_name).sort()).toEqual(["aac", "h264"]);
        expect(jobs.active()).toBe(false);
        expect(fs.readdirSync(tempDir)).toHaveLength(0);
    });
});

describe("GPU export job states (agent exports, phase 10d)", () => {
    let dir: string;
    beforeEach(() => {
        dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "opennan-gpustate-")));
    });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    const runner = (mux: (...args: never[]) => Promise<unknown> = async () => ({ kind: "file", path: "/exports/trip-20261020.mp4" })) =>
        ({ kind: "node", supportsGl: false, maxResolution: "4k", probe: vi.fn(async () => new Map()), chooseEncoder: vi.fn(), run: vi.fn(), mux: vi.fn(mux) }) as never;
    const begin = async (jobs: ReturnType<typeof createGpuJobs>, extra: Record<string, unknown> = {}) =>
        (await jobs.begin({ options: { resolution: "720p" }, snapshot: snapshot("/m/a.mkv"), container: "mp4", codec: "avc", ...extra })) as { jobId: string };

    it("runs from begin, takes clamped progress for its own id only, and ends done with main's own path and facts", async () => {
        const mux = vi.fn(async (_plan: unknown, _video: unknown, options: { onProgress?(ratio: number): void }) => {
            options.onProgress?.(0.5);
            return { kind: "file", path: "/exports/trip-20261020.mp4" };
        });
        const jobs = createGpuJobs({ runner: runner(mux as never), mainBusy: () => false, setTarget: vi.fn(), tempDir: dir });
        const seen: Array<[string, string | null]> = [];
        jobs.subscribe((state, jobId) => seen.push([state.status === "running" ? `running:${state.progress.phase}` : state.status, jobId]));
        const { jobId } = await begin(jobs);
        expect(jobs.status(jobId)).toEqual({ state: { status: "running", progress: { phase: "probe", ratio: 0, engine: "gpu" } }, fallback: null });
        expect(jobs.current()).toBe(jobId);
        jobs.progress(jobId, { phase: "render", ratio: 1.7, etaSeconds: 1e12 });
        expect(jobs.status(jobId)?.state).toEqual({ status: "running", progress: { phase: "render", ratio: 1, etaSeconds: 7 * 24 * 3600, engine: "gpu" } });
        jobs.progress(jobId, { phase: "render", ratio: -3 });
        expect(jobs.status(jobId)?.state).toEqual({ status: "running", progress: { phase: "render", ratio: 0, engine: "gpu" } });
        jobs.progress("00000000-0000-4000-8000-000000000000", { phase: "mux", ratio: 0.9 });
        expect(jobs.status("00000000-0000-4000-8000-000000000000")).toBeNull();
        await jobs.chunk(jobId, 0, new Uint8Array([1, 2, 3]));
        const settled = jobs.settled(jobId);
        await expect(jobs.mux(jobId)).resolves.toEqual({ path: "/exports/trip-20261020.mp4" });
        const done = jobs.status(jobId)!.state;
        expect(done).toMatchObject({
            status: "done",
            result: {
                output: { kind: "file", path: "/exports/trip-20261020.mp4" }, container: "mp4", mimeType: "video/mp4", encoder: "webcodecs-avc",
                width: 1280, height: 720, engine: "gpu",
            },
        });
        expect((done as { result: { durationSeconds: number } }).result.durationSeconds).toBeCloseTo(2, 1);
        await expect(settled).resolves.toEqual({ state: done, fallback: null });
        // Late progress (a throttled report after the end) changes nothing.
        jobs.progress(jobId, { phase: "render", ratio: 0.2 });
        expect(jobs.status(jobId)?.state.status).toBe("done");
        expect(jobs.current()).toBeNull();
        expect(seen).toContainEqual(["running:mux", jobId]);
        expect(seen.at(-1)).toEqual(["done", jobId]);
        expect(jobs.latest()).toEqual({ jobId, state: done });
        jobs.reset();
        expect(jobs.latest()).toBeNull();
        expect(seen.at(-1)).toEqual(["idle", null]);
    });

    it("records the window's abort as cancelled, or as the error it reports", async () => {
        const jobs = createGpuJobs({ runner: runner(), mainBusy: () => false, setTarget: vi.fn(), tempDir: dir });
        const first = await begin(jobs);
        await jobs.abort(first.jobId);
        expect(jobs.status(first.jobId)?.state).toEqual({ status: "cancelled" });
        const second = await begin(jobs);
        await jobs.abort(second.jobId, { code: "media-read-failed", message: "a file could not be read" });
        expect(jobs.status(second.jobId)?.state).toEqual({ status: "error", code: "media-read-failed", message: "a file could not be read" });
        await expect(jobs.settled(second.jobId)).resolves.toMatchObject({ state: { status: "error" } });
        // An abort of a job that already ended changes nothing.
        await jobs.abort(first.jobId, { code: "unknown", message: "late" });
        expect(jobs.status(first.jobId)?.state).toEqual({ status: "cancelled" });
        expect(fs.readdirSync(dir)).toHaveLength(0);
    });

    it("records a failed mux as an error, and a cancel during the mux as cancelled", async () => {
        const failing = createGpuJobs({
            runner: runner(async () => {
                throw Object.assign(new Error("ffmpeg exited with code 1"), { code: "ffmpeg-failed" });
            }),
            mainBusy: () => false, setTarget: vi.fn(), tempDir: dir,
        });
        const a = await begin(failing);
        await failing.chunk(a.jobId, 0, new Uint8Array([1]));
        await expect(failing.mux(a.jobId)).rejects.toThrow("ffmpeg exited");
        expect(failing.status(a.jobId)?.state).toEqual({ status: "error", code: "ffmpeg-failed", message: "ffmpeg exited with code 1" });

        let release: () => void = () => undefined;
        const slow = createGpuJobs({
            runner: runner((_plan: never, _video: never, options: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
                release = () => reject(new Error("killed"));
                options.signal.addEventListener("abort", () => release(), { once: true });
            }) as never),
            mainBusy: () => false, setTarget: vi.fn(), tempDir: dir,
        });
        const b = await begin(slow);
        await slow.chunk(b.jobId, 0, new Uint8Array([1]));
        const muxing = slow.mux(b.jobId).then(() => null, (error: Error) => error);
        await vi.waitFor(() => expect(slow.status(b.jobId)?.state).toMatchObject({ progress: { phase: "mux" } }));
        await slow.abort(b.jobId);
        await expect(muxing).resolves.toBeInstanceOf(Error);
        expect(slow.status(b.jobId)?.state).toEqual({ status: "cancelled" });
    });

    it("ends the job with an error when the window reloads, crashes, or closes (never stuck running)", async () => {
        const jobs = createGpuJobs({ runner: runner(), mainBusy: () => false, setTarget: vi.fn(), tempDir: dir });
        const { jobId } = await begin(jobs);
        const settled = jobs.settled(jobId);
        await jobs.abortAll("The editor window reloaded during the export.");
        await expect(settled).resolves.toEqual({ state: { status: "error", code: "unknown", message: "The editor window reloaded during the export." }, fallback: null });
        expect(jobs.active()).toBe(false);
    });

    it("hands a fallback the job's own begin request and follows the export that took over", async () => {
        const jobs = createGpuJobs({ runner: runner(), mainBusy: () => false, setTarget: vi.fn(), tempDir: dir });
        const { jobId } = await begin(jobs);
        const settled = jobs.settled(jobId);
        const released = await jobs.release(jobId);
        expect(released).toEqual({ options: { resolution: "720p" }, snapshot: snapshot("/m/a.mkv") });
        expect(jobs.active()).toBe(false);
        expect(fs.readdirSync(dir)).toHaveLength(0);
        jobs.link(jobId, { jobId: "export-1-1" });
        await expect(settled).resolves.toEqual({ state: { status: "running", progress: { phase: "probe", ratio: 0, engine: "gpu" } }, fallback: "export-1-1" });
        expect(jobs.status(jobId)?.fallback).toBe("export-1-1");
        await expect(jobs.release(jobId)).rejects.toThrow("No such export job");

        const other = await begin(jobs);
        await jobs.release(other.jobId);
        jobs.link(other.jobId, { error: "An export is already running." });
        expect(jobs.status(other.jobId)).toEqual({ state: { status: "error", code: "unknown", message: "An export is already running." }, fallback: null });
    });

    it(`keeps the last ${MAX_GPU_JOB_RECORDS} jobs`, async () => {
        const jobs = createGpuJobs({ runner: runner(), mainBusy: () => false, setTarget: vi.fn(), tempDir: dir });
        const ids: string[] = [];
        for (let i = 0; i < MAX_GPU_JOB_RECORDS + 2; i += 1) {
            const { jobId } = await begin(jobs);
            ids.push(jobId);
            await jobs.abort(jobId);
        }
        expect(jobs.status(ids[0])).toBeNull();
        expect(jobs.status(ids[1])).toBeNull();
        expect(jobs.status(ids[2])?.state).toEqual({ status: "cancelled" });
        expect(jobs.status(ids.at(-1)!)?.state).toEqual({ status: "cancelled" });
    });
});
