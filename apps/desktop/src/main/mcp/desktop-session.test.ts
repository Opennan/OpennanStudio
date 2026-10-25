import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createStudioExporter, createStudioMcpServer } from "@opennan/mcp";
import { STUDIO_TOOLS } from "@opennan/mcp-schema";
import { ProviderRegistry, createAiRunner, createJob } from "@opennan/provider-sdk";
import { LocalBackend, TimelineController, createEditorStore, createMemoryPersistence, type TimelineControllerOptions } from "@opennan/timeline-core";
import { createSessionResponder } from "../../renderer/session-responder";
import { openDatabase, type DesktopDatabase } from "../store/database";
import { createMediaStore } from "../store/media-store";
import { AI_RUN_TIMEOUT_MS, createDesktopSession } from "./desktop-session";
import { createRendererRpc, type SessionRequest } from "./renderer-rpc";

const ID = "3f2b8c1e-1d2a-4c3b-9e8f-0a1b2c3d4e5f";

function text(result: unknown): string {
    return ((result as { content: Array<{ text?: string }> }).content ?? []).map((c) => c.text ?? "").join("\n");
}

describe("desktop session over the renderer controller", () => {
    let dir: string;
    let db: DesktopDatabase;
    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "opennan-session-"));
        db = openDatabase(":memory:");
    });
    afterEach(() => {
        db.close();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    async function setup(options: {
        onAiRun?: TimelineControllerOptions["onAiRun"]; callTimeoutMs?: number; providers?: ProviderRegistry; captionsRoute?: () => string | null; projectId?: string; projectName?: string;
    } = {}) {
        const projectId = options.projectId ?? ID;
        const backend = new LocalBackend({ persistence: createMemoryPersistence() });
        await backend.seedProject(projectId, options.projectName ? { meta: { name: options.projectName } } : {});
        const store = createEditorStore();
        const controller = new TimelineController({ backend, store, projectId, onAiRun: options.onAiRun });
        await controller.load();
        const respond = createSessionResponder({ projectId, controller, store, backend });
        const execute = vi.fn();
        const rpc = createRendererRpc({
            send: (request: SessionRequest) => {
                if (request.method === "execute") execute(request.args[0]);
                void respond(request.method, request.args).then(
                    (value) => rpc.receive({ id: request.id, ok: true, value }),
                    (error: Error) => rpc.receive({ id: request.id, ok: false, error: error.message }),
                );
            },
        });
        const frame = { mimeType: "image/png" as const, data: new Uint8Array([137, 80, 78, 71]), width: 2, height: 2 };
        const exporter = { ...createStudioExporter({ runner: { kind: "node", supportsGl: false, maxResolution: "1080p" } as never }), frameRenderer: { renderFrame: vi.fn(async () => frame) } };
        const projectDir = path.join(dir, "project");
        fs.mkdirSync(projectDir, { recursive: true });
        const mediaStore = createMediaStore({ db, root: path.join(dir, "media") });
        const call = vi.spyOn(rpc, "call");
        const session = await createDesktopSession({
            projectId, rpc, exporter, mediaStore, projectDir, ...(options.providers ? { providers: options.providers } : {}), ...(options.captionsRoute ? { captionsRoute: options.captionsRoute } : {}),
        });
        const server = createStudioMcpServer(session, options.callTimeoutMs ? { callTimeoutMs: options.callTimeoutMs } : undefined);
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await server.connect(serverTransport);
        const client = new Client({ name: "test", version: "1.0.0" });
        await client.connect(clientTransport);
        return { client, controller, backend, execute, projectDir, exporter, call };
    }

    it("lists tools and edits the renderer's timeline", async () => {
        const { client, controller } = await setup();
        expect((await client.listTools()).tools.length).toBe(STUDIO_TOOLS.length);
        const created = await client.callTool({ name: "create_timeline_clip", arguments: { track_type: "text", track_index: 1, start_time: 0, end_time: 2, text_content: "from agent" } });
        expect(created.isError, text(created)).toBeFalsy();
        expect(controller.snapshot().clips.map((c) => c.textContent)).toEqual(["from agent"]);
        const timeline = text(await client.callTool({ name: "read_timeline", arguments: {} }));
        expect(timeline).toContain(controller.snapshot().clips[0].id);
        await client.callTool({ name: "undo_last_edit", arguments: {} });
        expect(controller.snapshot().clips).toHaveLength(0);
    });

    it("runs auto_captions on the renderer's controller with the long ai.run timeout", async () => {
        const registry = new ProviderRegistry();
        registry.register({
            info: { id: "local", name: "On this device", capabilities: ["audio.transcribe"] },
            audio: { transcribe: () => createJob(async () => ({ language: "en", segments: [{ start: 0, end: 2, text: "Hello there" }] })) },
        });
        const { client, controller, call } = await setup({ onAiRun: createAiRunner(registry) });
        const result = await client.callTool({ name: "auto_captions", arguments: { model: "tiny" } });
        expect(result.isError, text(result)).toBeFalsy();
        expect(controller.snapshot().clips.map((c) => c.textContent)).toEqual(["Hello there"]);
        const executeCall = call.mock.calls.find(([method, args]) => method === "execute" && (args?.[0] as { type?: string })?.type === "ai.run");
        expect(executeCall?.[2]).toEqual({ timeoutMs: AI_RUN_TIMEOUT_MS });
        const edit = call.mock.calls.find(([method, args]) => method === "execute" && (args?.[0] as { type?: string })?.type !== "ai.run");
        expect(edit?.[2]).toBeUndefined();
    });

    it("asks the renderer to cancel an agent's job when the tool call times out", async () => {
        const registry = new ProviderRegistry();
        const aborted: boolean[] = [];
        registry.register({
            info: { id: "local", name: "On this device", capabilities: ["audio.transcribe"] },
            audio: {
                transcribe: () => createJob(({ signal }) => new Promise((resolve) => signal.addEventListener("abort", () => {
                    aborted.push(true);
                    resolve({ language: "en", segments: [{ start: 0, end: 1, text: "late" }] });
                }, { once: true }))),
            },
        });
        const { client, controller, call } = await setup({ onAiRun: createAiRunner(registry), callTimeoutMs: 100 });
        const result = await client.callTool({ name: "auto_captions", arguments: {} });
        expect(result.isError).toBe(true);
        await vi.waitFor(() => expect(call.mock.calls.some(([method]) => method === "cancelAiRun")).toBe(true));
        await vi.waitFor(() => expect(aborted).toEqual([true]));
        await new Promise((resolve) => setTimeout(resolve, 30));
        expect(controller.snapshot().clips).toEqual([]);
    });

    it("answers auto_captions as unavailable when the renderer has no provider", async () => {
        const { client } = await setup();
        const result = await client.callTool({ name: "auto_captions", arguments: {} });
        expect(result.isError).toBe(true);
        expect(result.structuredContent).toMatchObject({ unavailable: true, capability: "audio.transcribe" });
    });

    it("refuses an ai.run that names media it does not serve", async () => {
        const { client, execute } = await setup();
        const result = await client.callTool({ name: "run_editor_command", arguments: { command: { type: "ai.run", capability: "audio.transcribe", input: { source: { mediaUrl: "file:///etc/passwd" } } } } });
        expect(result.isError).toBe(true);
        expect(execute.mock.calls.some(([command]) => JSON.stringify(command).includes("passwd"))).toBe(false);
    });

    it("refuses remote media before the renderer sees the command", async () => {
        const { client, execute, controller } = await setup();
        const result = await client.callTool({ name: "create_timeline_clip", arguments: { track_type: "video", track_index: 2, start_time: 0, end_time: 2, media_url: "https://evil.test/a.mp4" } });
        expect(result.isError).toBe(true);
        expect(text(result)).toContain("only uses media imported into the project");
        expect(execute.mock.calls.some(([command]) => JSON.stringify(command).includes("evil.test"))).toBe(false);
        expect(controller.snapshot().clips).toHaveLength(0);
    });

    it("renders preview frames in main and reports unknown export jobs", async () => {
        const { client, exporter } = await setup();
        const frame = await client.callTool({ name: "preview_timeline_frame", arguments: { time_seconds: 0 } });
        expect(frame.isError, text(frame)).toBeFalsy();
        expect(JSON.stringify(frame.content)).toContain("image/png");
        expect(exporter.frameRenderer.renderFrame).toHaveBeenCalled();
        const status = await client.callTool({ name: "get_export_status", arguments: { job_id: "nope" } });
        expect(status.isError).toBe(true);
    });

    it("publishes files from the project folder into the media library and refuses others", async () => {
        const { client, backend, projectDir } = await setup();
        fs.writeFileSync(path.join(projectDir, "take.mp4"), "video bytes");
        const published = await client.callTool({ name: "publish_video_to_timeline", arguments: { local_path: "take.mp4", start_time: 0, duration: 2 } });
        expect(published.isError, text(published)).toBeFalsy();
        const library = await backend.listLibrary(ID);
        expect(library).toHaveLength(1);
        expect(library[0].url).toMatch(/^opennan-local:\/\/media\/[0-9a-f-]{36}$/);
        const refused = await client.callTool({ name: "publish_video_to_timeline", arguments: { local_path: "/etc/hosts", start_time: 0, duration: 2 } });
        expect(refused.isError).toBe(true);
    });

    it("prices runs and lists voices through main's providers, and records the agent's ai.run jobs", async () => {
        const main = new ProviderRegistry();
        main.register({
            info: { id: "opennan", name: "OpenNan", capabilities: ["video.text-to-video", "audio.tts", "audio.transcribe"] },
            price: async () => ({ kind: "estimate", estimate: { microUsd: 46801, usd: 0.046801, label: "≈ $0.047", units: 5, capped: false } }),
            voices: async () => [{ id: "heart", name: "Heart", language: "en-US" }],
        });
        const renderer = new ProviderRegistry();
        renderer.register({
            info: { id: "local", name: "On this device", capabilities: ["audio.transcribe"] },
            audio: { transcribe: () => createJob(async () => ({ language: "en", segments: [{ start: 0, end: 2, text: "Hi" }], costUsd: 0 })) },
        });
        const { client } = await setup({ onAiRun: createAiRunner(renderer), providers: main });
        const estimate = await client.callTool({ name: "estimate_cost", arguments: { tool: "generate_video_h3", duration_seconds: 5 } });
        expect(estimate.structuredContent).toMatchObject({ estimate: { label: "≈ $0.047" }, provider: "OpenNan" });
        const voices = await client.callTool({ name: "list_voices", arguments: {} });
        expect(text(voices)).toContain("heart: Heart (en-US)");
        expect(text(await client.callTool({ name: "check_generation_status", arguments: {} }))).toBe("No AI jobs have run in this editor session.");
        await client.callTool({ name: "auto_captions", arguments: {} });
        // Captions run on the device here unless the cloud is asked for.
        const captions = await client.callTool({ name: "estimate_cost", arguments: { tool: "transcribe_audio" } });
        expect(captions.structuredContent).toMatchObject({ estimate: null, free: true });
        const status = await client.callTool({ name: "check_generation_status", arguments: {} });
        expect((status.structuredContent as { jobs: Array<Record<string, unknown>> }).jobs).toEqual([
            expect.objectContaining({ capability: "audio.transcribe", status: "succeeded", jobId: expect.stringMatching(/^job-/), cancellable: false }),
        ]);
    });

    it("prices captions without an engine when the user routed captions to the cloud (review finding A)", async () => {
        const main = new ProviderRegistry();
        main.register({
            info: { id: "opennan", name: "OpenNan", capabilities: ["audio.transcribe"] },
            price: async () => ({ kind: "estimate", estimate: { microUsd: 4769, usd: 0.004769, label: "≈ $0.005", units: 1, capped: false } }),
        });
        let route: string | null = "opennan";
        const { client } = await setup({ providers: main, captionsRoute: () => route });
        await client.callTool({ name: "create_timeline_clip", arguments: { track_type: "audio", track_index: 1, start_time: 0, end_time: 3, media_url: "opennan-local://media/00000000-0000-4000-8000-000000000001" } }).catch(() => undefined);
        const routed = await client.callTool({ name: "estimate_cost", arguments: { tool: "transcribe_audio" } });
        expect(routed.structuredContent).not.toMatchObject({ free: true });
        route = "local";
        const local = await client.callTool({ name: "estimate_cost", arguments: { tool: "transcribe_audio" } });
        expect(local.structuredContent).toMatchObject({ estimate: null, free: true });
    });
});
