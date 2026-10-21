import { createStudioExporter, exportJobStatus } from "./export";
import { STUB_EXPORT_PATH, createStubExportRunner } from "./testing/export-runner";
import { createFixtureStudio } from "./testing/fixture";

describe("createStudioExporter", () => {
    it("runs export.start through @opennan/export and keeps the job state", async () => {
        const runner = createStubExportRunner();
        const { controller, session, exporter } = await createFixtureStudio({ exportRunner: runner });
        const result = await controller.execute({ type: "export.start", options: { resolution: "720p" } });
        expect(result).toMatchObject({ ok: true, jobId: expect.stringMatching(/^export-/) });
        const done = await exporter?.settled(result.jobId as string);
        expect(done).toMatchObject({
            status: "done", output: { kind: "file", path: STUB_EXPORT_PATH }, container: "mp4", width: 1280, height: 720, durationSeconds: 15,
        });
        expect(done?.status === "done" ? done.warnings.map((w) => w.code) : []).toContain("text-unsupported");
        expect([...runner.probed].sort()).toEqual(["https://media.test/a.mp4", "https://media.test/end.png", "https://media.test/music.mp3"]);
        await expect(session.exportStatus?.(result.jobId as string)).resolves.toEqual(done);
        await expect(session.exportStatus?.("nope")).resolves.toBeNull();
    });

    it("runs one export at a time and only at resolutions the runner renders", async () => {
        const runner = createStubExportRunner();
        let release!: () => void;
        runner.hold = new Promise<void>((resolve) => {
            release = resolve;
        });
        const { controller, exporter } = await createFixtureStudio({ exportRunner: runner });
        const first = await controller.execute({ type: "export.start", options: {} });
        expect(exporter?.status(first.jobId as string)).toMatchObject({ status: "running" });
        await expect(controller.execute({ type: "export.start", options: {} })).resolves.toMatchObject({ ok: false, error: "An export is already running." });
        release();
        await expect(exporter?.settled(first.jobId as string)).resolves.toMatchObject({ status: "done", width: 1920, height: 1080 });
        await expect(controller.execute({ type: "export.start", options: { resolution: "4k" } })).resolves.toMatchObject({ ok: false, error: "This exporter renders up to 1080p." });
        await expect(controller.execute({ type: "export.start", options: { resolution: "8k" } })).resolves.toMatchObject({ ok: false, error: "resolution must be one of 720p, 1080p, 4k." });
    });

    it("cancels the running export through export.cancel (phase 10d), checking the job id", async () => {
        const runner = createStubExportRunner();
        runner.hold = new Promise<void>(() => undefined);
        const { controller, exporter } = await createFixtureStudio({ exportRunner: runner });
        await expect(controller.execute({ type: "export.cancel" })).resolves.toMatchObject({ ok: false, error: "No export is running." });
        const started = await controller.execute({ type: "export.start", options: {} });
        const jobId = started.jobId as string;
        await expect(controller.execute({ type: "export.cancel", jobId: "export-other" })).resolves.toMatchObject({ ok: false, error: expect.stringContaining("is not the running export") });
        await expect(controller.execute({ type: "export.cancel", jobId })).resolves.toEqual({ ok: true, changed: {}, jobId });
        await expect(exporter?.settled(jobId)).resolves.toMatchObject({ status: "cancelled" });
    });

    it("exports an animated GIF when asked (phase 10d) and refuses unknown formats", async () => {
        const { controller } = await createFixtureStudio();
        const exporter = createStudioExporter({ runner: createStubExportRunner() });
        const outcome = await exporter.onExport({ format: "gif", resolution: "720p" }, controller.snapshot());
        const status = await exporter.settled((outcome as { jobId: string }).jobId);
        expect(status).toMatchObject({ status: "done", container: "gif", mimeType: "image/gif", encoder: "gif", width: 640, height: 360 });
        await expect(exporter.onExport({ format: "mov" }, controller.snapshot())).resolves.toEqual({ error: "format must be video or gif." });
    });

    it("renders preview frames through the same runner", async () => {
        const runner = createStubExportRunner();
        const { controller } = await createFixtureStudio({ frameRenderer: createStudioExporter({ runner }).frameRenderer });
        await expect(controller.previewFrame(5, { width: 320 })).resolves.toMatchObject({
            ok: true, seconds: 5, frame: { mimeType: "image/png", width: 320, height: 180 },
        });
        expect(runner.frames).toEqual([{ seconds: 5, size: { width: 320, height: 180 } }]);
    });
});

describe("session state for UIs", () => {
    it("publishes the current job and state to subscribers, and resets after a run", async () => {
        const { controller } = await createFixtureStudio();
        const exporter = createStudioExporter({ runner: createStubExportRunner() });
        const seen: Array<[string | null, string]> = [];
        const stop = exporter.subscribe((state, jobId) => seen.push([jobId, state.status]));
        expect(exporter.getState()).toEqual({ status: "idle" });
        const outcome = await exporter.onExport({}, controller.snapshot());
        const jobId = (outcome as { jobId: string }).jobId;
        await exporter.settled(jobId);
        expect(seen[0]).toEqual([jobId, "running"]);
        expect(seen.at(-1)).toEqual([jobId, "done"]);
        expect(exporter.getState().status).toBe("done");
        exporter.reset();
        expect(exporter.getState()).toEqual({ status: "idle" });
        stop();
        exporter.reset();
        expect(seen.at(-1)).toEqual([null, "idle"]);
    });
});

describe("exportJobStatus", () => {
    it("maps session states to agent job states", () => {
        expect(exportJobStatus("gpu-1", { status: "running", progress: { phase: "render", ratio: 0.25, etaSeconds: 3, engine: "gpu" } }))
            .toEqual({ jobId: "gpu-1", status: "running", phase: "render", ratio: 0.25, etaSeconds: 3, engine: "gpu" });
        expect(exportJobStatus("gpu-1", { status: "error", code: "unknown", message: "lost" })).toEqual({ jobId: "gpu-1", status: "error", code: "unknown", message: "lost" });
        expect(exportJobStatus("gpu-1", { status: "cancelled" })).toEqual({ jobId: "gpu-1", status: "cancelled" });
    });
});
