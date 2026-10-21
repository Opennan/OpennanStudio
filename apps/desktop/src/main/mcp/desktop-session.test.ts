import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createStudioExporter, createStudioMcpServer } from "@opennan/mcp";
import { STUDIO_TOOLS } from "@opennan/mcp-schema";
import { ProviderRegistry, createAiRunner, createJob } from "@opennan/provider-sdk";
import { LocalBackend, TimelineController, createEditorStore, createMemoryPersistence, type TimelineControllerOptions } from "@opennan/timeline-core";
import { CLOUD_SIGN_IN, createSessionResponder, type ResponderCloud } from "../../renderer/session-responder";
import { openDatabase, type DesktopDatabase } from "../store/database";
import { createMediaStore } from "../store/media-store";
import { AI_RUN_TIMEOUT_MS, CLOUD_SAVE_TIMEOUT_MS, PIPELINE_RUN_TIMEOUT_MS, SHARE_CONFIRM_TIMEOUT_MS, createDesktopSession, createShareConsent, type ShareConsent } from "./desktop-session";
import type { ShareQuestion } from "../../renderer/session-responder";
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
        onAiRun?: TimelineControllerOptions["onAiRun"]; callTimeoutMs?: number; providers?: ProviderRegistry; captionsRoute?: () => string | null; cloud?: ResponderCloud; openProject?(id: string): void; projectId?: string; notify?(message: string): void;
        confirmShare?(question: ShareQuestion): Promise<"allow" | "allow-session" | "deny">; shareConfirmMs?: number; shareConsent?: ShareConsent; shareConfirmTimeoutMs?: number; projectName?: string;
    } = {}) {
        const projectId = options.projectId ?? ID;
        const backend = new LocalBackend({ persistence: createMemoryPersistence() });
        await backend.seedProject(projectId, options.projectName ? { meta: { name: options.projectName } } : {});
        const store = createEditorStore();
        const controller = new TimelineController({ backend, store, projectId, onAiRun: options.onAiRun });
        await controller.load();
        // An agent's share link is allowed by default in these tests (the person's answer is tested on its own).
        const confirmShare = options.confirmShare ?? (async () => "allow" as const);
        const respond = createSessionResponder({
            projectId, controller, store, backend, ...(options.cloud ? { cloud: options.cloud } : {}), ...(options.openProject ? { openProject: options.openProject } : {}), ...(options.notify ? { notify: options.notify } : {}),
            confirmShare, ...(options.shareConfirmMs !== undefined ? { shareConfirmMs: options.shareConfirmMs } : {}),
        });
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
            ...(options.shareConsent ? { shareConsent: options.shareConsent } : {}), ...(options.shareConfirmTimeoutMs !== undefined ? { shareConfirmTimeoutMs: options.shareConfirmTimeoutMs } : {}),
        });
        const server = createStudioMcpServer(session, options.callTimeoutMs ? { callTimeoutMs: options.callTimeoutMs } : undefined);
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await server.connect(serverTransport);
        const client = new Client({ name: "test", version: "1.0.0" });
        await client.connect(clientTransport);
        return { client, controller, backend, execute, projectDir, exporter, call };
    }

    it("answers the cloud project tools from the renderer's cloud runtime (phase 9a)", async () => {
        const summary = { id: "cloud-srv1", name: "Trip", aspectRatio: "9:16", createdAt: 1, updatedAt: Date.parse("2026-10-20T10:00:00Z"), durationSeconds: 75, mediaCount: 0, kind: "cloud" as const, origin: "studio" as const, mediaBytes: 5 * 1024 ** 2, lastEditedDevice: "Studio laptop", thumbnailUrl: null, deletedAt: null };
        const cloudBackend = {
            listCloudProjects: vi.fn(async () => ({ projects: [summary], nextCursor: null })),
            saveLocalProject: vi.fn(async () => ({ ...summary, id: "cloud-new", name: "Mine" })),
            hasProject: vi.fn(async () => true),
            loadProject: vi.fn(async (id: string) => ({ id, name: "Trip" })),
            syncState: vi.fn(() => ({ kind: "saved", at: 1 })),
        };
        const openProject = vi.fn();
        const { client, call } = await setup({ cloud: { backend: () => cloudBackend as never, local: {} as never, syncLabel: () => "Saved" }, openProject });
        const listed = await client.callTool({ name: "list_cloud_projects", arguments: {} });
        expect(listed.isError, text(listed)).toBeFalsy();
        expect(text(listed)).toContain("Trip (cloud-srv1)");
        const saved = await client.callTool({ name: "save_project_to_cloud", arguments: {} });
        expect(text(saved)).toContain("cloud-new");
        expect(call).toHaveBeenCalledWith("cloud.save", [{}], { timeoutMs: CLOUD_SAVE_TIMEOUT_MS });
        const opened = await client.callTool({ name: "open_cloud_project", arguments: { project_id: "cloud-srv1" } });
        expect(text(opened)).toContain("Opened \"Trip\"");
        await vi.waitFor(() => expect(openProject).toHaveBeenCalledWith("cloud-srv1"));
        const status = await client.callTool({ name: "get_cloud_sync_status", arguments: { project_id: "cloud-srv1" } });
        expect(text(status)).toContain("Saved");
    });

    it("runs OpenNan project pipelines of a cloud project through the renderer's cloud runtime (phase 9b)", async () => {
        const requests: Array<{ method: string; path: string; body?: unknown }> = [];
        const api = {
            baseUrl: "https://api.opennan.test",
            async request(method: string, path: string, request: { body?: unknown } = {}) {
                requests.push({ method, path, ...(request.body !== undefined ? { body: request.body } : {}) });
                // The task is already done when the submit answers (no long poll); a no-charge edit is the next revision.
                if (method === "PUT") revision += 1;
                if (method === "POST" && path !== "/v1/quotes") revision = 4;
                const body = path === "/v1/quotes" ? { price_usd: 0.31, hold_usd: 0.31 }
                    : method === "POST" ? { id: "task_1", status: "succeeded", price_usd: 0.3, project_revision: 4 } : {};
                return { status: 200, body, etag: null };
            },
        };
        let revision = 3;
        const cloudBackend = {
            api, serverId: (id: string) => id.slice("cloud-".length), revision: async () => revision, waitForRevision: async (_id: string, wanted: number) => revision >= wanted, setAiActive: vi.fn(),
            beginRemoteGroup: async () => 1, endRemoteGroup: async () => undefined,
            recordRemoteGroup: vi.fn(async () => ({ stepId: 2, label: "AI: Storyboard of scene 1", before: { tracks: [], clips: [], scenes: [] }, after: { tracks: [], clips: [], scenes: [{ id: "s1", order: 0, caption: "Drawn", status: "ready" }] }, changed: { scenes: ["s1"], clips: [] } })),
        };
        const { client, controller, call } = await setup({ projectId: "cloud-srv1", cloud: { backend: () => cloudBackend as never, local: {} as never } });
        await controller.execute({ type: "scene.add", input: { afterOrder: -1, caption: "Opening" } });
        const sceneId = controller.snapshot().scenes[0]!.id;

        const over = await client.callTool({ name: "generate_storyboard", arguments: { scene_order: 1, accept_max_usd: 0.1 } });
        expect(over.isError).toBe(true);
        expect(text(over)).toContain("OpenNan quotes ≈ $0.31");
        expect(requests.map((r) => r.path)).toEqual(["/v1/quotes"]);

        const ran = await client.callTool({ name: "generate_storyboard", arguments: { scene_order: 1 } });
        expect(ran.isError).toBe(false);
        expect(ran.structuredContent).toMatchObject({ quoted: true, holdUsd: 0.31, status: "succeeded", chargedUsd: 0.3, projectRevision: 4, synced: true, undoable: true });
        expect(requests.filter((r) => r.method === "POST" && r.path !== "/v1/quotes")).toEqual([{ method: "POST", path: `/v1/projects/srv1/scenes/${sceneId}/storyboard`, body: {} }]);
        expect(cloudBackend.recordRemoteGroup).toHaveBeenCalledWith("cloud-srv1", 1, expect.objectContaining({ label: "AI: Storyboard of scene 1", toRevision: 4 }), { timeoutMs: 0 });
        expect(call).toHaveBeenCalledWith("cloud.run", [expect.objectContaining({ step: expect.objectContaining({ tool: "storyboard", sceneId }) })], { timeoutMs: PIPELINE_RUN_TIMEOUT_MS });

        const script = await client.callTool({ name: "set_project_script", arguments: { script_text: "Hello there.", srt_content: null } });
        expect(script.isError).toBe(false);
        expect(requests.at(-1)).toEqual({ method: "PATCH", path: "/v1/projects/srv1", body: { script_text: "Hello there.", srt_content: null } });

        const source = await client.callTool({ name: "set_copy_video_source", arguments: { scene_id: sceneId, video_url: "https://cdn.example.com/v.mp4" } });
        expect(source.isError).toBe(false);
        expect(requests.at(-1)).toEqual({ method: "PUT", path: `/v1/projects/srv1/scenes/${sceneId}/copy-video/source`, body: { video_url: "https://cdn.example.com/v.mp4" } });
        expect(source.structuredContent).toMatchObject({ synced: true });
    });

    it("manages the cloud project's share links through the renderer's cloud runtime (phase 9c)", async () => {
        const TOKEN = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKL";
        const shareJson = (overrides: Record<string, unknown> = {}) => ({
            object: "project_share", id: "shr_0123456789abcdef01234567", project_id: "srv1", token: TOKEN, url: `https://evil.example/s/${TOKEN}`, status: "active",
            allow_download: false, expires_at: "2026-10-28T10:00:00Z", created_at: "2026-10-21T10:00:00Z", revoked_at: null, views: 2, last_viewed_at: null, ...overrides,
        });
        const requests: Array<{ method: string; path: string; body?: unknown }> = [];
        let refuse: { status: number; code: string } | null = null;
        const api = {
            baseUrl: "https://api.opennan.test",
            async request(method: string, path: string, request: { body?: unknown } = {}) {
                requests.push({ method, path, ...(request.body !== undefined ? { body: request.body } : {}) });
                if (refuse) {
                    const { CloudApiError } = await import("@opennan/cloud-backend");
                    throw new CloudApiError(refuse.status, refuse.code, "refused", { fromServer: true });
                }
                const body = method === "POST" ? { ...shareJson(), replaced: [] }
                    : method === "GET" ? { object: "list", data: [shareJson()] }
                    : path.endsWith("/shares") ? { object: "list", data: [shareJson({ status: "revoked", revoked_at: "2026-10-21T11:00:00Z" })] }
                    : shareJson({ status: "revoked", revoked_at: "2026-10-21T11:00:00Z" });
                return { status: 200, body, etag: null };
            },
        };
        const cloudBackend = { api, serverId: (id: string) => id.slice("cloud-".length) };
        const notify = vi.fn();
        const { client, call } = await setup({ projectId: "cloud-srv1", cloud: { backend: () => cloudBackend as never, local: {} as never }, notify });
        const created = await client.callTool({ name: "create_share_link", arguments: { expires_in_days: 7 } });
        expect(created.isError).toBe(false);
        expect(requests[0]).toEqual({ method: "POST", path: "/v1/projects/srv1/shares", body: { expires_in_days: 7, allow_download: false } });
        // The link an agent gets is the checked one (opennan.com), never a URL from elsewhere.
        expect(text(created)).toContain(`https://opennan.com/s/${TOKEN}`);
        expect(text(created)).not.toContain("evil.example");
        expect(call).toHaveBeenCalledWith("cloud.shareCreate", [{ expiresInDays: 7 }]);
        // The person sees in Studio that an agent shared the project (never the link itself in the notice).
        expect(notify).toHaveBeenCalledWith(expect.stringMatching(/agent made a view-only share link/i));
        expect(notify.mock.calls.flat().join()).not.toContain(TOKEN);
        const listed = await client.callTool({ name: "list_share_links", arguments: {} });
        expect(listed.structuredContent).toMatchObject({ links: [{ share_id: "shr_0123456789abcdef01234567", status: "active", views: 2 }] });
        const one = await client.callTool({ name: "revoke_share_link", arguments: { share_id: "shr_0123456789abcdef01234567" } });
        expect(one.isError).toBe(false);
        expect(requests.at(-1)).toEqual({ method: "DELETE", path: "/v1/projects/srv1/shares/shr_0123456789abcdef01234567" });
        await client.callTool({ name: "revoke_share_link", arguments: {} });
        expect(requests.at(-1)).toEqual({ method: "DELETE", path: "/v1/projects/srv1/shares" });
        refuse = { status: 409, code: "share_nothing_to_show" };
        const nothing = await client.callTool({ name: "create_share_link", arguments: {} });
        expect(nothing.isError).toBe(true);
        expect(text(nothing)).toContain("nothing to show");
    });

    describe("an agent's share link needs the person's yes (9c.1)", () => {
        const TOKEN = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKL";
        function shareCloud() {
            const requests: Array<{ method: string; path: string }> = [];
            const shareJson = (overrides: Record<string, unknown> = {}) => ({
                object: "project_share", id: "shr_0123456789abcdef01234567", project_id: "srv1", token: TOKEN, url: `https://opennan.com/s/${TOKEN}`, share_base_url: "https://opennan.com/s",
                status: "active", allow_download: false, expires_at: "2026-10-28T10:00:00Z", created_at: "2026-10-21T10:00:00Z", revoked_at: null, views: 0, last_viewed_at: null, ...overrides,
            });
            const api = {
                baseUrl: "https://api.opennan.test",
                async request(method: string, path: string) {
                    requests.push({ method, path });
                    const body = method === "POST" ? { ...shareJson(), replaced: [] } : method === "GET" ? { object: "list", data: [shareJson()] }
                        : path.endsWith("/shares") ? { object: "list", data: [shareJson({ status: "revoked", revoked_at: "2026-10-21T11:00:00Z" })] } : shareJson({ status: "revoked", revoked_at: "2026-10-21T11:00:00Z" });
                    return { status: 200, body, etag: null };
                },
            };
            const posts = () => requests.filter((r) => r.method === "POST");
            return { cloud: { backend: () => ({ api, serverId: (id: string) => id.slice("cloud-".length) }) as never, local: {} as never }, requests, posts };
        }

        it("asks with the project's name before every link (Allow makes it), and never for listing or turning off", async () => {
            const { cloud, posts, requests } = shareCloud();
            const confirmShare = vi.fn(async (_question: ShareQuestion) => "allow" as const);
            const { client, call } = await setup({ projectId: "cloud-srv1", projectName: "Holiday", cloud, confirmShare });
            const created = await client.callTool({ name: "create_share_link", arguments: {} });
            expect(created.isError, text(created)).toBe(false);
            expect(confirmShare).toHaveBeenCalledTimes(1);
            expect(confirmShare.mock.calls[0]![0]).toMatchObject({ projectName: "Holiday" });
            expect(call.mock.calls.map((c) => c[0]).filter((m) => m === "confirmShare" || m === "cloud.shareCreate")).toEqual(["confirmShare", "cloud.shareCreate"]);
            expect(posts()).toHaveLength(1);
            // A rotation is a new public link: asked again.
            await client.callTool({ name: "create_share_link", arguments: {} });
            expect(confirmShare).toHaveBeenCalledTimes(2);
            await client.callTool({ name: "list_share_links", arguments: {} });
            await client.callTool({ name: "revoke_share_link", arguments: {} });
            expect(confirmShare).toHaveBeenCalledTimes(2);
            expect(requests.map((r) => r.method)).toEqual(["POST", "POST", "GET", "DELETE"]);
        });

        it("Deny is a clear tool error and nothing is sent; Allow for this project lasts the app's session for that project only", async () => {
            const consent = createShareConsent(() => false);
            const denied = shareCloud();
            const no = await setup({ projectId: "cloud-srv1", cloud: denied.cloud, confirmShare: async () => "deny", shareConsent: consent });
            const refused = await no.client.callTool({ name: "create_share_link", arguments: {} });
            expect(refused.isError).toBe(true);
            expect(text(refused)).toMatch(/declined.*no share link was made/i);
            expect(refused.structuredContent).toMatchObject({ declined: true, reason: "declined" });
            expect(denied.posts()).toEqual([]);

            const always = shareCloud();
            const confirmShare = vi.fn(async () => "allow-session" as const);
            const yes = await setup({ projectId: "cloud-srv1", cloud: always.cloud, confirmShare, shareConsent: consent });
            await yes.client.callTool({ name: "create_share_link", arguments: {} });
            await yes.client.callTool({ name: "create_share_link", arguments: {} });
            expect(confirmShare).toHaveBeenCalledTimes(1);
            expect(always.posts()).toHaveLength(2);
            // The same app session, another project: asked.
            const other = shareCloud();
            const asked = vi.fn(async () => "deny" as const);
            const second = await setup({ projectId: "cloud-srv2", cloud: other.cloud, confirmShare: asked, shareConsent: consent });
            expect((await second.client.callTool({ name: "create_share_link", arguments: {} })).isError).toBe(true);
            expect(asked).toHaveBeenCalledTimes(1);
            // A new app session (a fresh consent) asks again for the first project.
            const fresh = vi.fn(async () => "deny" as const);
            const later = await setup({ projectId: "cloud-srv1", cloud: shareCloud().cloud, confirmShare: fresh, shareConsent: createShareConsent(() => false) });
            await later.client.callTool({ name: "create_share_link", arguments: {} });
            expect(fresh).toHaveBeenCalledTimes(1);
        });

        it("no answer within the time counts as deny: the question closes and nothing is sent", async () => {
            const { cloud, posts } = shareCloud();
            let closed = false;
            const confirmShare = vi.fn((question: ShareQuestion) => new Promise<"allow">((resolve) => {
                question.signal.addEventListener("abort", () => { closed = true; });
                setTimeout(() => resolve("allow"), 5_000);
            }));
            const { client } = await setup({ projectId: "cloud-srv1", cloud, confirmShare, shareConfirmMs: 30 });
            const answer = await client.callTool({ name: "create_share_link", arguments: {} });
            expect(answer.isError).toBe(true);
            expect(text(answer)).toMatch(/within 2 minutes.*no share link was made/i);
            expect(answer.structuredContent).toMatchObject({ declined: true, reason: "unanswered" });
            expect(closed).toBe(true);
            expect(posts()).toEqual([]);
            expect(SHARE_CONFIRM_TIMEOUT_MS).toBeGreaterThan(2 * 60_000);
        });

        it("a renderer that never answers is unanswered too (main's own deadline)", async () => {
            const { cloud, posts } = shareCloud();
            const { client } = await setup({ projectId: "cloud-srv1", cloud, confirmShare: () => new Promise(() => undefined), shareConfirmMs: 60_000, shareConfirmTimeoutMs: 40 });
            const answer = await client.callTool({ name: "create_share_link", arguments: {} });
            expect(answer.structuredContent).toMatchObject({ declined: true, reason: "unanswered" });
            expect(posts()).toEqual([]);
        });

        it("a call the client stops while the question is open closes it, and a late Allow makes nothing (review 9c.1)", async () => {
            const { cloud, posts } = shareCloud();
            let question: ShareQuestion | null = null;
            let allow: (() => void) | null = null;
            const confirmShare = vi.fn((q: ShareQuestion) => new Promise<"allow" | "deny">((resolve) => {
                question = q;
                allow = () => resolve("allow");
                q.signal.addEventListener("abort", () => resolve("deny"));
            }));
            const { client } = await setup({ projectId: "cloud-srv1", cloud, confirmShare });
            const stop = new AbortController();
            const pending = client.callTool({ name: "create_share_link", arguments: {} }, undefined, { signal: stop.signal }).catch((error: unknown) => error);
            await vi.waitFor(() => expect(question).not.toBeNull());
            stop.abort();
            await pending;
            await vi.waitFor(() => expect(question!.signal.aborted).toBe(true));
            allow!();
            await new Promise((r) => setTimeout(r, 50));
            expect(posts()).toEqual([]);
        });

        it("Settings → Let agents create share links without asking skips the question", async () => {
            const { cloud, posts } = shareCloud();
            let withoutAsking = true;
            const confirmShare = vi.fn(async () => "deny" as const);
            const { client } = await setup({ projectId: "cloud-srv1", cloud, confirmShare, shareConsent: createShareConsent(() => withoutAsking) });
            expect((await client.callTool({ name: "create_share_link", arguments: {} })).isError).toBe(false);
            expect(confirmShare).not.toHaveBeenCalled();
            withoutAsking = false;
            expect((await client.callTool({ name: "create_share_link", arguments: {} })).isError).toBe(true);
            expect(confirmShare).toHaveBeenCalledTimes(1);
            expect(posts()).toHaveLength(1);
        });

        it("a signed-out cloud project is told to sign in without a question", async () => {
            const confirmShare = vi.fn(async () => "allow" as const);
            const { client } = await setup({ projectId: "cloud-srv1", cloud: { backend: () => null, local: {} as never }, confirmShare });
            const answer = await client.callTool({ name: "create_share_link", arguments: {} });
            expect(answer.isError).toBe(true);
            expect(text(answer)).toContain(CLOUD_SIGN_IN);
            expect(confirmShare).not.toHaveBeenCalled();
        });
    });

    it("share links on a local project ask to save it to OpenNan first and send nothing (phase 9c)", async () => {
        const backend = vi.fn(() => null);
        const { client, call } = await setup({ cloud: { backend, local: {} as never } });
        const answer = await client.callTool({ name: "create_share_link", arguments: {} });
        expect(answer.isError).toBe(true);
        expect(text(answer)).toContain("save it to OpenNan first");
        expect(call).not.toHaveBeenCalledWith("cloud.shareCreate", expect.anything());
    });

    it("project pipelines on a local project ask to save it to OpenNan first and send nothing (phase 9b)", async () => {
        const backend = vi.fn(() => null);
        const { client, call } = await setup({ cloud: { backend, local: {} as never } });
        const answer = await client.callTool({ name: "plan_scenes", arguments: {} });
        expect(answer.isError).toBe(true);
        expect(text(answer)).toBe("This needs an OpenNan cloud project: save it to OpenNan first (save_project_to_cloud).");
        expect(call.mock.calls.filter(([method]) => String(method).startsWith("cloud."))).toEqual([]);
        expect(backend).not.toHaveBeenCalled();
    });

    it("cloud tools while signed out answer with the sign-in message", async () => {
        const { client } = await setup({ cloud: { backend: () => null, local: {} as never } });
        const listed = await client.callTool({ name: "list_cloud_projects", arguments: {} });
        expect(listed.isError).toBe(true);
        expect(text(listed)).toContain(CLOUD_SIGN_IN);
    });

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
