// End to end over streamable HTTP with the MCP SDK client, plus auth refusals.
import http from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { toolsForPreset } from "./server";
import { startHttpServer, type StudioHttpServer } from "./http";
import { createFixtureStudio, type FixtureStudio } from "./testing/fixture";

let studio: FixtureStudio;
let server: StudioHttpServer;

beforeEach(async () => {
    studio = await createFixtureStudio();
    server = await startHttpServer(studio.session, { port: 0 });
});

afterEach(async () => {
    await server.close();
});

function client(token: string | null, target: StudioHttpServer = server) {
    const c = new Client({ name: "http-test", version: "0.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(target.url), token ? { requestInit: { headers: { Authorization: `Bearer ${token}` } } } : {});
    return { c, transport };
}

const INIT = JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "0" } },
});

function rawPost(headers: Record<string, string>, body = INIT, target: StudioHttpServer = server): Promise<{ status: number; headers: http.IncomingHttpHeaders }> {
    return new Promise((resolve, reject) => {
        const req = http.request(target.url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers } }, (res) => {
            res.resume();
            res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers }));
        });
        req.on("error", reject);
        req.end(body);
    });
}

describe("streamable HTTP transport", () => {
    it("binds to 127.0.0.1 and serves the tools to an authorized SDK client", async () => {
        expect(server.address).toBe("127.0.0.1");
        expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
        const { c, transport } = client(server.token);
        await c.connect(transport);
        expect((await c.listTools()).tools).toHaveLength(toolsForPreset().length);
        const created = (await c.callTool({ name: "add_text_overlay", arguments: { text: "Hi", start_time: 5, end_time: 7 } })) as CallToolResult;
        expect(created.isError).toBe(false);
        expect(studio.controller.snapshot().clips).toHaveLength(3);
        const undone = (await c.callTool({ name: "undo_last_edit", arguments: {} })) as CallToolResult;
        expect(undone.isError).toBe(false);
        expect(studio.controller.snapshot().clips).toHaveLength(2);
        await transport.terminateSession();
        await c.close();
    });

    it("lets two clients edit the same timeline", async () => {
        const a = client(server.token);
        const b = client(server.token);
        await a.c.connect(a.transport);
        await b.c.connect(b.transport);
        await a.c.callTool({ name: "delete_timeline_clip", arguments: { clip_id: "title" } });
        const read = (await b.c.callTool({ name: "find_clip", arguments: {} })) as CallToolResult;
        expect((read.structuredContent as { clipIds: string[] }).clipIds).toEqual(["music"]);
        await a.c.close();
        await b.c.close();
    });

    it("refuses an SDK client without the token", async () => {
        const { c, transport } = client(null);
        await expect(c.connect(transport)).rejects.toMatchObject({ code: 401, message: expect.stringContaining("Missing or invalid bearer token") });
        const wrong = client("x".repeat(43));
        await expect(wrong.c.connect(wrong.transport)).rejects.toMatchObject({ code: 401 });
    });

    it("answers 401 with a Bearer challenge and 403 for foreign hosts and origins", async () => {
        const unauthorized = await rawPost({});
        expect(unauthorized.status).toBe(401);
        expect(unauthorized.headers["www-authenticate"]).toBe('Bearer realm="opennan-studio"');
        expect((await rawPost({ authorization: `Bearer ${server.token}`, host: `evil.test:${server.port}` })).status).toBe(403);
        expect((await rawPost({ authorization: `Bearer ${server.token}`, origin: "https://evil.test" })).status).toBe(403);
        expect((await rawPost({ authorization: `Bearer ${server.token}` }, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }))).status).toBe(400);
    });

    it("rejects tokens that are too short", async () => {
        await expect(startHttpServer(studio.session, { port: 0, token: "short" })).rejects.toThrow(/at least 24/);
    });

    it("caps MCP sessions and closes idle ones, but never one with an open event stream", async () => {
        // The idle timeout leaves the SDK client time to open its event stream even under a loaded full-repo run.
        const limited = await startHttpServer(studio.session, { port: 0, maxSessions: 2, idleTimeoutMs: 1000 });
        const auth = { authorization: `Bearer ${limited.token}` };
        // The SDK client opens a GET event stream after initialize and keeps it open while connected.
        const streaming = client(limited.token, limited);
        await streaming.c.connect(streaming.transport);
        // A raw initialize opens a session with no stream.
        const raw = await rawPost(auth, INIT, limited);
        expect(raw.status).toBe(200);
        const rawSession = raw.headers["mcp-session-id"] as string;
        expect(limited.sessionCount()).toBe(2);
        const third = client(limited.token, limited);
        await expect(third.c.connect(third.transport)).rejects.toMatchObject({ code: 503 });
        await expect.poll(() => limited.sessionCount(), { timeout: 5000 }).toBe(1);
        const list = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" });
        expect((await rawPost({ ...auth, "mcp-session-id": rawSession }, list, limited)).status).toBe(404);
        // Well past the idle timeout, the streaming client still works.
        await new Promise((resolve) => setTimeout(resolve, 1500));
        expect((await streaming.c.listTools()).tools).toHaveLength(toolsForPreset().length);
        await streaming.c.close();
        await expect.poll(() => limited.sessionCount(), { timeout: 2000 }).toBe(0);
        await limited.close();
    });

    it("enforces the session cap for concurrent initialize requests", async () => {
        const limited = await startHttpServer(studio.session, { port: 0, maxSessions: 1 });
        const auth = { authorization: `Bearer ${limited.token}` };
        // Headers first, bodies later: every request passes the door before any session exists.
        const slowPost = () => new Promise<number>((resolve, reject) => {
            const req = http.request(limited.url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...auth } }, (res) => {
                res.resume();
                res.on("end", () => resolve(res.statusCode ?? 0));
            });
            req.on("error", reject);
            req.flushHeaders();
            setTimeout(() => req.end(INIT), 100);
        });
        const statuses = (await Promise.all([1, 2, 3, 4].map(slowPost))).sort();
        expect(statuses).toEqual([200, 503, 503, 503]);
        expect(limited.sessionCount()).toBe(1);
        await limited.close();
    });

    it("fails on a busy port instead of picking another one", async () => {
        await expect(startHttpServer(studio.session, { port: server.port })).rejects.toThrow(
            `Port ${server.port} on 127.0.0.1 is in use`,
        );
    });
});
