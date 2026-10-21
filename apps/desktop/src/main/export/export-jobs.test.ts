import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExportSessionState } from "@opennan/export";
import { exportJobStatus, type StudioExporter } from "@opennan/mcp";
import { createDesktopExportJobs } from "./export-jobs";
import { createGpuJobs } from "./gpu-jobs";

const snapshot = {
    projectId: "p", project: { name: "Trip", aspectRatio: "16:9", musicUrl: null, musicVolume: 1 },
    tracks: [{ type: "video", index: 1, label: "", muted: false, locked: false, visible: true, volume: 1 }],
    clips: [],
    scenes: [{
        id: "s", order: 0, caption: "", startTime: "0", endTime: "0", startImageUrl: null, endImageUrl: null, videoUrl: null, sourceVideoUrl: "/m/a.mkv",
        status: "ready", transition: "cut", cardType: "source_clip", duration: 2, frameConsistencyScore: null, audioUrl: null, audioText: null,
        cardConfig: null, timelinePositionSeconds: 0.001,
    }],
} as never;

/** A main exporter whose jobs the test drives by hand. */
function fakeMain() {
    let state: ExportSessionState = { status: "idle" };
    const jobs = new Map<string, { state: ExportSessionState; done: Promise<void>; finish(): void }>();
    let current: string | null = null;
    let counter = 0;
    const listeners = new Set<(state: ExportSessionState, jobId: string | null) => void>();
    const set = (next: ExportSessionState) => {
        state = next;
        const job = current ? jobs.get(current) : undefined;
        if (job) {
            job.state = next;
            if (next.status !== "running") job.finish();
        }
        for (const listener of listeners) listener(next, next.status === "idle" ? null : current);
    };
    const main: StudioExporter & { set(next: ExportSessionState): void } = {
        set,
        onExport: vi.fn(async () => {
            if (state.status === "running") return { error: "An export is already running." };
            counter += 1;
            current = `export-1-${counter}`;
            let finish: () => void = () => undefined;
            const done = new Promise<void>((resolve) => {
                finish = resolve;
            });
            jobs.set(current, { state, done, finish });
            set({ status: "running", progress: { phase: "probe", ratio: 0, engine: "ffmpeg" } });
            return { jobId: current };
        }),
        frameRenderer: { renderFrame: vi.fn() },
        status: (jobId) => (jobs.has(jobId) ? exportJobStatus(jobId, jobs.get(jobId)!.state) : null),
        settled: async (jobId) => {
            const job = jobs.get(jobId);
            if (!job) return null;
            await job.done;
            return exportJobStatus(jobId, job.state);
        },
        cancel: vi.fn(() => {
            if (state.status === "running") set({ status: "cancelled" });
        }),
        getState: () => state,
        isBusy: () => state.status === "running",
        subscribe: (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        reset: vi.fn(() => {
            if (state.status !== "running") set({ status: "idle" });
        }),
    };
    return main;
}

describe("desktop export jobs (main's exports and the window's GPU jobs as one StudioExporter)", () => {
    let dir: string;
    beforeEach(() => {
        dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "opennan-xjobs-")));
    });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    function setup() {
        const main = fakeMain();
        const runner = { kind: "node", supportsGl: false, maxResolution: "4k", probe: vi.fn(async () => new Map()), chooseEncoder: vi.fn(), run: vi.fn(), mux: vi.fn(async () => ({ kind: "file", path: "/exports/trip.mp4" })) } as never;
        const setTarget = vi.fn();
        const gpu = createGpuJobs({ runner, mainBusy: () => main.isBusy(), setTarget, tempDir: dir });
        const cancelWindowJob = vi.fn();
        const jobs = createDesktopExportJobs({ main, gpu, cancelWindowJob, setTarget });
        const begin = async () => `gpu-${((await gpu.begin({ options: { resolution: "720p" }, snapshot, container: "mp4", codec: "avc" })) as { jobId: string }).jobId}`;
        return { main, gpu, jobs, cancelWindowJob, setTarget, begin };
    }

    it("answers status and settled for gpu- ids from the GPU jobs and for export- ids from main", async () => {
        const { gpu, jobs, main, begin } = setup();
        const id = begin();
        const jobId = await id;
        const uuid = jobId.slice(4);
        expect(jobs.status(jobId)).toEqual({ jobId, status: "running", phase: "probe", ratio: 0, engine: "gpu" });
        gpu.progress(uuid, { phase: "render", ratio: 0.4, etaSeconds: 6 });
        expect(jobs.status(jobId)).toEqual({ jobId, status: "running", phase: "render", ratio: 0.4, etaSeconds: 6, engine: "gpu" });
        expect(jobs.isBusy()).toBe(true);
        const settled = jobs.settled(jobId);
        await gpu.chunk(uuid, 0, new Uint8Array([1]));
        await gpu.mux(uuid);
        await expect(settled).resolves.toMatchObject({ jobId, status: "done", output: { kind: "file", path: "/exports/trip.mp4" }, encoder: "webcodecs-avc", width: 1280, height: 720 });
        expect(jobs.isBusy()).toBe(false);
        expect(jobs.status("gpu-00000000-0000-4000-8000-000000000000")).toBeNull();
        expect(jobs.status("gpu-nope")).toBeNull();
        await expect(jobs.settled("gpu-nope")).resolves.toBeNull();

        const started = await jobs.onExport({}, snapshot);
        expect(started).toEqual({ jobId: "export-1-1" });
        expect(main.onExport).toHaveBeenCalledWith({}, snapshot);
        expect(jobs.status("export-1-1")).toMatchObject({ status: "running", engine: "ffmpeg" });
        main.set({ status: "cancelled" });
        await expect(jobs.settled("export-1-1")).resolves.toEqual({ jobId: "export-1-1", status: "cancelled" });
    });

    it("shows the latest job's state and publishes both sources with their job ids", async () => {
        const { gpu, jobs, main, begin } = setup();
        const seen: Array<[string, string | null]> = [];
        const stop = jobs.subscribe((state, jobId) => seen.push([state.status, jobId]));
        const jobId = await begin();
        expect(jobs.getState()).toEqual({ status: "running", progress: { phase: "probe", ratio: 0, engine: "gpu" } });
        expect(seen).toContainEqual(["running", jobId]);
        await gpu.abort(jobId.slice(4), { code: "media-read-failed", message: "unreadable" });
        expect(jobs.getState()).toEqual({ status: "error", code: "media-read-failed", message: "unreadable" });
        jobs.reset();
        expect(main.reset).toHaveBeenCalled();
        expect(jobs.getState()).toEqual({ status: "idle" });
        await jobs.onExport({}, snapshot);
        expect(jobs.getState()).toMatchObject({ status: "running", progress: { engine: "ffmpeg" } });
        expect(seen.at(-1)).toEqual(["running", "export-1-1"]);
        stop();
        main.set({ status: "cancelled" });
        expect(seen.at(-1)).toEqual(["running", "export-1-1"]);
    });

    it("cancel asks the window to stop its GPU job and ends main's side of it; otherwise it cancels main's export", async () => {
        const { gpu, jobs, main, cancelWindowJob, begin } = setup();
        const jobId = await begin();
        const settled = jobs.settled(jobId);
        jobs.cancel();
        expect(cancelWindowJob).toHaveBeenCalledWith(jobId.slice(4));
        await expect(settled).resolves.toEqual({ jobId, status: "cancelled" });
        expect(gpu.active()).toBe(false);
        expect(main.cancel).not.toHaveBeenCalled();
        await jobs.onExport({}, snapshot);
        jobs.cancel();
        expect(main.cancel).toHaveBeenCalledTimes(1);
        expect(cancelWindowJob).toHaveBeenCalledTimes(1);
    });

    it("a fallback runs main's export from the job's own snapshot and the gpu- id follows it", async () => {
        const { jobs, main, setTarget, begin } = setup();
        const jobId = await begin();
        const settled = jobs.settled(jobId);
        await expect(jobs.fallback(jobId.slice(4))).resolves.toEqual({ jobId: "export-1-1" });
        expect(main.onExport).toHaveBeenCalledWith({ resolution: "720p" }, snapshot);
        expect(setTarget).toHaveBeenLastCalledWith("Trip");
        expect(jobs.status(jobId)).toEqual({ jobId, status: "running", phase: "probe", ratio: 0, engine: "ffmpeg" });
        expect(jobs.getState()).toMatchObject({ status: "running", progress: { engine: "ffmpeg" } });
        main.set({ status: "error", code: "ffmpeg-failed", message: "ffmpeg exited" });
        await expect(settled).resolves.toEqual({ jobId, status: "error", code: "ffmpeg-failed", message: "ffmpeg exited" });
        // A second fallback for the same job, or for a job that is not open, is refused.
        await expect(jobs.fallback(jobId.slice(4))).rejects.toThrow("No such export job");
    });

    it("a fallback that main refuses fails the GPU job with the refusal", async () => {
        const { jobs, main, begin } = setup();
        const jobId = await begin();
        main.onExport = vi.fn(async () => ({ error: "Export needs the bundled ffmpeg, which is missing from this build." }));
        await expect(jobs.fallback(jobId.slice(4))).resolves.toEqual({ error: expect.stringContaining("ffmpeg") });
        expect(jobs.status(jobId)).toEqual({ jobId, status: "error", code: "unknown", message: "Export needs the bundled ffmpeg, which is missing from this build." });
    });

    it("a fallback whose native start throws settles the GPU job as an error (agents never wait on it forever)", async () => {
        const { jobs, main, begin } = setup();
        const jobId = await begin();
        const settled = jobs.settled(jobId);
        main.onExport = vi.fn(async () => {
            throw new Error("The editor window detached");
        });
        await expect(jobs.fallback(jobId.slice(4))).resolves.toEqual({ error: "The editor window detached" });
        await expect(settled).resolves.toEqual({ jobId, status: "error", code: "unknown", message: "The editor window detached" });
    });
});
