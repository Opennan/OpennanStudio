// What an agent sees of an export on desktop (phase 10d): MCP assemble_video → export.start on the editor window's
// controller (renderer RPC) → the window's export platform takes the GPU path → main's GPU job, reached through
// the real export IPC handlers (payloads validated as in the app). Before phase 10d get_export_status answered
// "No export job gpu-… in this session" for every GPU export, during the run and after a fallback.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createStudioMcpServer } from "@opennan/mcp";
import { LocalBackend, TimelineController, createEditorStore, createMemoryPersistence } from "@opennan/timeline-core";
import { createDesktopExportPlatform } from "../../renderer/export-platform";
import { createSessionResponder } from "../../renderer/session-responder";
import { createTestBridge } from "../../renderer/test-bridge";
import { EVENTS, IPC } from "../../shared/ipc";
import { createDesktopExporter } from "../export/desktop-exporter";
import { registerExportIpc } from "../export/export-ipc";
import { createDesktopExportJobs } from "../export/export-jobs";
import { createGpuJobs } from "../export/gpu-jobs";
import type { IpcEventLike, IpcMainLike } from "../ipc/handle";
import { openDatabase, type DesktopDatabase } from "../store/database";
import { createMediaStore } from "../store/media-store";
import { createDesktopSession } from "./desktop-session";
import { createRendererRpc, type SessionRequest } from "./renderer-rpc";

const ID = "3f2b8c1e-1d2a-4c3b-9e8f-0a1b2c3d4e5f";
const text = (result: unknown) => ((result as { content: Array<{ text?: string }> }).content ?? []).map((c) => c.text ?? "").join("\n");

type Run = (input: unknown, settings: unknown, options: {
    signal: AbortSignal;
    onProgress(progress: { phase: string; ratio: number; etaSeconds?: number }): void;
    runner: { mux(plan: unknown, video: unknown, options: { container: string; signal?: AbortSignal }): Promise<unknown> };
    gpu: { createVideoSink(): { writable: WritableStream } };
}) => Promise<unknown>;

describe("agent exports on desktop take the GPU path and are first-class jobs", () => {
    let dir: string;
    let db: DesktopDatabase;
    beforeAll(() => {
        (globalThis as { VideoEncoder?: unknown }).VideoEncoder ??= class {};
    });
    beforeEach(() => {
        dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "opennan-agent-export-")));
        db = openDatabase(":memory:");
    });
    afterEach(() => {
        db.close();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    async function setup(run: Run) {
        const root = fs.mkdtempSync(path.join(dir, "studio-"));
        const exportsDir = path.join(root, "exports");
        fs.mkdirSync(exportsDir);
        // Main: no bundled ffmpeg here, so a fallback is refused by main's exporter; the GPU jobs' mux is a fake
        // that "writes" the export into the exports folder.
        const desktop = createDesktopExporter({ ffmpeg: null, mediaStore: { pathOf: () => null, root }, exportsDir });
        const muxed = path.join(exportsDir, "agent-20261020-050000.mp4");
        const runner = {
            kind: "node", supportsGl: false, maxResolution: "4k", probe: vi.fn(async () => new Map()), chooseEncoder: vi.fn(), run: vi.fn(),
            mux: vi.fn(async () => {
                fs.writeFileSync(muxed, "mp4");
                return { kind: "file", path: muxed };
            }),
        } as never;
        const gpuJobs = createGpuJobs({ runner, mainBusy: () => desktop.exporter.isBusy(), setTarget: (name) => desktop.setTarget(name), tempDir: root });
        const events: Array<[string, unknown]> = [];
        let windowCancel: (jobId: string) => void = () => undefined;
        const send = (channel: string, payload: unknown) => {
            events.push([channel, payload]);
            if (channel === EVENTS.exportGpuCancel) windowCancel((payload as { jobId: string }).jobId);
        };
        const jobs = createDesktopExportJobs({ main: desktop.exporter, gpu: gpuJobs, setTarget: desktop.setTarget, cancelWindowJob: (jobId) => send(EVENTS.exportGpuCancel, { jobId }) });
        const handlers = new Map<string, (event: IpcEventLike, payload: unknown) => unknown>();
        const ipc: IpcMainLike = { handle: (channel, listener) => void handlers.set(channel, listener) };
        registerExportIpc(ipc, { desktop, gpuJobs, jobs, exportsDir, send, showItemInFolder: vi.fn() });
        const top = { url: "opennan-app://app/" } as { url: string; top?: unknown };
        top.top = top;
        const invoke = async <T>(channel: string, payload: unknown = {}) => (await handlers.get(channel)!({ senderFrame: top }, payload)) as T;

        // The window: its bridge calls main's real handlers, as the preload does.
        const { bridge } = createTestBridge();
        bridge.exports = {
            ...bridge.exports,
            start: (options, snapshot) => invoke(IPC.exportStart, { options, snapshot }),
            cancel: () => invoke(IPC.exportCancel),
            state: () => invoke(IPC.exportState),
            gpuBegin: (options, snapshot, container, codec) => invoke(IPC.exportGpuBegin, { options, snapshot, container, ...(codec ? { codec } : {}) }),
            gpuChunk: (jobId, position, bytes) => invoke(IPC.exportGpuChunk, { jobId, position, bytes }),
            gpuMux: (jobId) => invoke(IPC.exportGpuMux, { jobId }),
            gpuAbort: (jobId, error) => invoke(IPC.exportGpuAbort, { jobId, ...(error ? { error } : {}) }),
            gpuProgress: (jobId, progress) => invoke(IPC.exportGpuProgress, { jobId, ...progress }),
            gpuFallback: (jobId) => invoke(IPC.exportGpuFallback, { jobId }),
            onGpuCancel: (listener) => {
                windowCancel = listener;
                return () => undefined;
            },
        };
        const gpu = () => ({
            loadMediabunny: async () => ({ getFirstEncodableVideoCodec: async () => "avc" }) as never,
            createSource: () => { throw new Error("unused"); },
            fetchBlob: async () => new Blob(),
            createRenderer: () => null,
            isAvailable: () => true,
        });
        const exporter = createDesktopExportPlatform(bridge, { gpu, exportGpu: run as never, progressIntervalMs: 0 }).createExporter({ resolveMediaUrl: (u) => u });
        const backend = new LocalBackend({ persistence: createMemoryPersistence() });
        // Something to export (main compiles the audio mux from the job's snapshot, which must not be empty).
        await backend.seedProject(ID, {
            meta: { name: "Agent" },
            scenes: [{
                id: "s", order: 0, caption: "", startTime: "0", endTime: "0", startImageUrl: null, endImageUrl: null, videoUrl: null, sourceVideoUrl: `opennan-local://media/${ID}`,
                status: "ready", transition: "cut", cardType: "source_clip", duration: 2, frameConsistencyScore: null, audioUrl: null, audioText: null,
                cardConfig: null, timelinePositionSeconds: 0.001,
            }] as never,
        });
        const store = createEditorStore();
        const show = vi.fn();
        const controller = new TimelineController({ backend, store, projectId: ID, onExport: exporter.commandHandler(backend, show) });
        await controller.load();
        const respond = createSessionResponder({ projectId: ID, controller, store, backend });
        const rpc = createRendererRpc({
            send: (request: SessionRequest) => void respond(request.method, request.args).then(
                (value) => rpc.receive({ id: request.id, ok: true, value }),
                (error: Error) => rpc.receive({ id: request.id, ok: false, error: error.message }),
            ),
        });
        const projectDir = path.join(root, "project");
        fs.mkdirSync(projectDir);
        const session = await createDesktopSession({ projectId: ID, rpc, exporter: jobs, mediaStore: createMediaStore({ db, root: path.join(root, "media") }), projectDir });
        const server = createStudioMcpServer(session);
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await server.connect(serverTransport);
        const client = new Client({ name: "agent", version: "1.0.0" });
        await client.connect(clientTransport);
        const assemble = async () => {
            const started = await client.callTool({ name: "assemble_video", arguments: { resolution: "720p" } });
            expect(started.isError, text(started)).toBeFalsy();
            return (started.structuredContent as { jobId: string }).jobId;
        };
        const status = async (jobId: string) => {
            const result = await client.callTool({ name: "get_export_status", arguments: { job_id: jobId } });
            return { isError: result.isError, text: text(result), job: result.structuredContent as Record<string, unknown> };
        };
        return { assemble, status, exporter, show, gpuJobs, jobs, events, muxed, invoke };
    }

    it("follows the GPU job from assemble_video to done with the file main wrote; the window's dialog shows it too", async () => {
        let release: () => void = () => undefined;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const { assemble, status, exporter, show, muxed, events } = await setup(async (_input, _settings, { onProgress, runner, gpu }) => {
            onProgress({ phase: "probe", ratio: 0 });
            onProgress({ phase: "render", ratio: 0.5, etaSeconds: 2 });
            await gpu.createVideoSink().writable.getWriter().write({ type: "write", data: new Uint8Array([0, 0, 0, 1]), position: 0 });
            await gate;
            onProgress({ phase: "mux", ratio: 0 });
            const output = await runner.mux({}, { kind: "file", path: "main" }, { container: "mp4" });
            return { kind: "done", result: { output, container: "mp4", mimeType: "video/mp4", encoder: "webcodecs-avc", durationSeconds: 2, width: 1280, height: 720, warnings: [], engine: "gpu" } };
        });
        const jobId = await assemble();
        expect(jobId).toMatch(/^gpu-[0-9a-f-]{36}$/);
        expect(show).toHaveBeenCalled();
        await vi.waitFor(async () => expect((await status(jobId)).job).toEqual({ ok: true, jobId, status: "running", phase: "render", ratio: 0.5, etaSeconds: 2, engine: "gpu" }));
        expect((await status(jobId)).text).toContain("is running (render, 50%)");
        // Main's mirror for the dialog carries the same state.
        expect(events).toContainEqual([EVENTS.exportState, { status: "running", progress: { phase: "render", ratio: 0.5, etaSeconds: 2, engine: "gpu" } }]);
        expect(exporter.session.getState()).toMatchObject({ status: "running", progress: { phase: "render", engine: "gpu" } });
        release();
        await vi.waitFor(async () => expect((await status(jobId)).job).toMatchObject({ status: "done" }));
        const done = await status(jobId);
        expect(done.isError).toBeFalsy();
        expect(done.job).toMatchObject({ jobId, status: "done", output: { kind: "file", path: muxed }, container: "mp4", encoder: "webcodecs-avc", width: 1280, height: 720 });
        expect(done.text).toContain(muxed);
        await vi.waitFor(() => expect(exporter.session.getState()).toMatchObject({ status: "done", result: { output: { kind: "file", path: muxed } } }));
    });

    it("main's cancel route stops the window's GPU job and the agent sees cancelled", async () => {
        const { assemble, status, exporter, invoke, gpuJobs } = await setup((_input, _settings, { signal, onProgress }) => new Promise((_resolve, reject) => {
            onProgress({ phase: "render", ratio: 0.1 });
            signal.addEventListener("abort", () => reject(Object.assign(new Error("Export cancelled."), { code: "cancelled" })), { once: true });
        }));
        const jobId = await assemble();
        await vi.waitFor(async () => expect((await status(jobId)).job).toMatchObject({ status: "running", phase: "render" }));
        await invoke(IPC.exportCancel);
        await vi.waitFor(async () => expect((await status(jobId)).job).toEqual({ ok: true, jobId, status: "cancelled" }));
        await vi.waitFor(() => expect(exporter.session.getState()).toEqual({ status: "cancelled" }));
        expect(gpuJobs.active()).toBe(false);
    });

    it("a window failure reaches the agent as an error with its code; a reload ends the job as an error, never running", async () => {
        const failing = await setup(async () => {
            throw Object.assign(new Error("a video could not be decoded"), { code: "media-read-failed" });
        });
        const failed = await failing.assemble();
        await vi.waitFor(async () => expect((await failing.status(failed)).job).toEqual({ ok: true, jobId: failed, status: "error", code: "media-read-failed", message: "a video could not be decoded" }));

        const stuck = await setup(() => new Promise(() => undefined));
        const jobId = await stuck.assemble();
        await vi.waitFor(async () => expect((await stuck.status(jobId)).job).toMatchObject({ status: "running" }));
        await stuck.gpuJobs.abortAll("The editor window reloaded during the export.");
        expect((await stuck.status(jobId)).job).toEqual({ ok: true, jobId, status: "error", code: "unknown", message: "The editor window reloaded during the export." });
    });

    it("a GPU job that falls back keeps its id: the agent follows main's native export (here refused: no ffmpeg in this build)", async () => {
        const { assemble, status, jobs } = await setup(async () => ({ kind: "fallback", reason: "WebGL2 is not available" }));
        const jobId = await assemble();
        await vi.waitFor(async () => expect((await status(jobId)).job).toMatchObject({ status: "error", message: expect.stringContaining("ffmpeg") }));
        expect(jobs.isBusy()).toBe(false);
    });
});
