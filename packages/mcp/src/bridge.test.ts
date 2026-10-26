// End to end: an SDK client spawns `opennan-studio mcp bridge` over stdio; the
// bridge forwards to a streamable-HTTP server hosting the session in this process.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ToolListChangedNotificationSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { toolsForPreset } from "./server";
import { startBridge, type BridgeOptions } from "./bridge";
import { createSessionToken } from "./auth";
import { startHttpServer, type StudioHttpServer } from "./http";
import { SERVER_INSTRUCTIONS } from "./server";
import { createFixtureStudio } from "./testing/fixture";

const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BIN = path.join(PACKAGE_DIR, "src/bin.ts");

async function spawnBridge(url: string, token: string) {
    const dir = await mkdtemp(path.join(os.tmpdir(), "opennan-bridge-"));
    const tokenFile = path.join(dir, "token");
    await writeFile(tokenFile, `${token}\n`, { mode: 0o600 });
    const client = new Client({ name: "bridge-test", version: "0.0.0" });
    await client.connect(new StdioClientTransport({
        command: process.execPath,
        args: ["--import", "tsx", BIN, "mcp", "bridge", "--url", url, "--token-file", tokenFile],
        cwd: PACKAGE_DIR,
        stderr: "pipe",
    }));
    return { client, dir };
}

const clipIds = (result: CallToolResult) => (result.structuredContent as { clipIds: string[] }).clipIds;
const text = (result: CallToolResult) => result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Fast retries so the tests stay short; the budget is bounded by `attempts`. */
const FAST_RETRY = { attempts: 40, initialDelayMs: 25, maxDelayMs: 100 };

/** A bridge in this process (agent side over an in-memory transport) in front of `url`. */
async function bridgeInProcess(options: Omit<BridgeOptions, "transport">) {
    const [agentSide, bridgeSide] = InMemoryTransport.createLinkedPair();
    const bridge = await startBridge({ ...options, transport: bridgeSide });
    const client = new Client({ name: "bridge-test", version: "0.0.0" });
    await client.connect(agentSide);
    let closed = false;
    void bridge.closed.then(() => {
        closed = true;
    });
    return {
        client,
        bridge,
        isClosed: () => closed,
        async close() {
            await client.close();
            await bridge.close();
        },
    };
}

/** A port nothing listens on: bound once by the OS, then released. */
async function refusedPort(): Promise<number> {
    const probe = http.createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const { port } = probe.address() as AddressInfo;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    return port;
}

/**
 * Forwards to `upstream` but answers every GET with 405 (no server event stream), so the
 * bridge holds no long-lived request and the server's idle timer really runs out.
 */
async function noEventStreamProxy(upstream: string) {
    let initializes = 0;
    const proxy = http.createServer((req, res) => {
        if (req.method === "GET") {
            res.writeHead(405).end();
            return;
        }
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
            const body = Buffer.concat(chunks);
            if (body.includes('"method":"initialize"')) initializes += 1;
            const headers = Object.fromEntries(Object.entries(req.headers).filter(([name]) => !["host", "connection", "content-length"].includes(name))) as Record<string, string>;
            fetch(upstream, { method: req.method, headers, body: req.method === "POST" ? body : undefined }).then(async (response) => {
                res.writeHead(response.status, Object.fromEntries(response.headers));
                res.end(Buffer.from(await response.arrayBuffer()));
            }, () => res.writeHead(502).end());
        });
    });
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    const { port } = proxy.address() as AddressInfo;
    return {
        url: `http://127.0.0.1:${port}/mcp`,
        initializes: () => initializes,
        close: () => new Promise<void>((resolve) => {
            proxy.close(() => resolve());
            proxy.closeAllConnections();
        }),
    };
}

async function waitFor(condition: () => boolean, timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!condition()) {
        if (Date.now() > deadline) throw new Error("condition not met in time");
        await sleep(10);
    }
}

describe("stdio bridge", () => {
    it("refuses to send the token anywhere but this machine's loopback", async () => {
        const token = "t".repeat(43);
        await expect(startBridge({ url: "https://evil.test/mcp", token })).rejects.toThrow(/connects only to http:\/\/127\.0\.0\.1 or http:\/\/localhost/);
        await expect(startBridge({ url: "http://127.0.0.1.evil.test:4319/mcp", token })).rejects.toThrow(/connects only to/);
    });

    it("forwards tools and edits to a session hosted over HTTP", async () => {
        const studio = await createFixtureStudio();
        const http = await startHttpServer(studio.session, { port: 0 });
        const { client, dir } = await spawnBridge(http.url, http.token);
        expect(client.getServerVersion()?.name).toBe("opennan-studio");
        expect(client.getInstructions()).toBe(SERVER_INSTRUCTIONS);
        expect((await client.listTools()).tools).toHaveLength(toolsForPreset().length);
        const deleted = (await client.callTool({ name: "delete_timeline_clip", arguments: { clip_id: "title" } })) as CallToolResult;
        expect(deleted.isError).toBe(false);
        expect(studio.controller.snapshot().clips.map((clip) => clip.id)).toEqual(["music"]);
        await client.close();
        await http.close();
        await rm(dir, { recursive: true, force: true });
    });

    it("keeps working after an idle timeout and after the server restarts", async () => {
        const studio = await createFixtureStudio();
        let http = await startHttpServer(studio.session, { port: 0, idleTimeoutMs: 100 });
        const { client, dir } = await spawnBridge(http.url, http.token);
        expect(clipIds((await client.callTool({ name: "find_clip", arguments: {} })) as CallToolResult)).toEqual(["title", "music"]);
        // Well past the idle timeout: the session is either kept by the bridge's event stream or reopened.
        await new Promise((resolve) => setTimeout(resolve, 300));
        const deleted = (await client.callTool({ name: "delete_timeline_clip", arguments: { clip_id: "title" } })) as CallToolResult;
        expect(deleted.isError).toBe(false);
        // A restart on the same port and token forgets every session: the next call gets 404 and the bridge reconnects.
        const { port, token } = http;
        await http.close();
        http = await startHttpServer(studio.session, { port, token });
        expect(clipIds((await client.callTool({ name: "find_clip", arguments: {} })) as CallToolResult)).toEqual(["music"]);
        expect(studio.controller.snapshot().clips.map((clip) => clip.id)).toEqual(["music"]);
        await client.close();
        await http.close();
        await rm(dir, { recursive: true, force: true });
    }, 20_000);

    it("survives a session that idles out during its own handshake (the server is slow to get notifications/initialized)", async () => {
        // A 1 ms idle timeout closes the session between the initialize response and the
        // initialized notification, so the notification gets 404. The bridge used to exit
        // on that (startBridge threw, the CLI returned 1): the agent saw "Connection closed".
        const studio = await createFixtureStudio();
        let server = await startHttpServer(studio.session, { port: 0, idleTimeoutMs: 1 });
        const { client, dir } = await spawnBridge(server.url, server.token);
        expect(client.getServerVersion()?.name).toBe("opennan-studio");
        expect(client.getInstructions()).toBe(SERVER_INSTRUCTIONS);
        const { port, token } = server;
        await server.close();
        server = await startHttpServer(studio.session, { port, token });
        expect(clipIds((await client.callTool({ name: "find_clip", arguments: {} })) as CallToolResult)).toEqual(["title", "music"]);
        await client.close();
        await server.close();
        await rm(dir, { recursive: true, force: true });
    }, 20_000);
});

describe("stdio bridge reconnects", () => {
    let server: StudioHttpServer | null = null;
    afterEach(async () => {
        await server?.close();
        server = null;
    });

    it("waits out a restart whose gap refuses connections, then runs the call on the new server", async () => {
        const studio = await createFixtureStudio();
        server = await startHttpServer(studio.session, { port: 0 });
        const { port, token } = server;
        const agent = await bridgeInProcess({ url: server.url, token, retry: FAST_RETRY });
        expect(clipIds((await agent.client.callTool({ name: "find_clip", arguments: {} })) as CallToolResult)).toEqual(["title", "music"]);
        await server.close();
        server = null;
        let settled = false;
        const call = agent.client.callTool({ name: "delete_timeline_clip", arguments: { clip_id: "title" } }).finally(() => {
            settled = true;
        });
        await sleep(400);
        // Nothing listens on the port now: the call waits for the server instead of failing.
        expect(settled).toBe(false);
        server = await startHttpServer(studio.session, { port, token });
        const deleted = (await call) as CallToolResult;
        expect(deleted.isError).toBe(false);
        expect(studio.controller.snapshot().clips.map((clip) => clip.id)).toEqual(["music"]);
        expect(agent.isClosed()).toBe(false);
        await agent.close();
    });

    it("opens a new session after the server closed the idle one", async () => {
        const studio = await createFixtureStudio();
        server = await startHttpServer(studio.session, { port: 0, idleTimeoutMs: 100 });
        const proxy = await noEventStreamProxy(server.url);
        const agent = await bridgeInProcess({ url: proxy.url, token: server.token, retry: FAST_RETRY });
        expect(clipIds((await agent.client.callTool({ name: "find_clip", arguments: {} })) as CallToolResult)).toEqual(["title", "music"]);
        // Under a loaded machine the 100 ms idle session can already have been replaced once by now: count from here.
        expect(proxy.initializes()).toBeGreaterThanOrEqual(1);
        const live = server;
        await waitFor(() => live.sessionCount() === 0);
        const before = proxy.initializes();
        const deleted = (await agent.client.callTool({ name: "delete_timeline_clip", arguments: { clip_id: "title" } })) as CallToolResult;
        expect(deleted.isError).toBe(false);
        // At least one new session: under heavy load the 100 ms idle timeout can close one again during the call.
        expect(proxy.initializes()).toBeGreaterThan(before);
        expect(studio.controller.snapshot().clips.map((clip) => clip.id)).toEqual(["music"]);
        await agent.close();
        await proxy.close();
    });

    it("answers with a tool error while the server stays down past the retry budget, stays up, and recovers", async () => {
        const studio = await createFixtureStudio();
        server = await startHttpServer(studio.session, { port: 0 });
        const { port, token, url } = server;
        const agent = await bridgeInProcess({ url, token, retry: { attempts: 3, initialDelayMs: 20, maxDelayMs: 40 } });
        let listChanged = 0;
        agent.client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
            listChanged += 1;
        });
        await server.close();
        server = null;
        const down = (await agent.client.callTool({ name: "find_clip", arguments: {} })) as CallToolResult;
        expect(down.isError).toBe(true);
        expect(text(down)).toMatch(/OpenNan Studio is not reachable at http:\/\/127\.0\.0\.1:\d+\/mcp/);
        expect(text(down)).toMatch(/3 attempts/);
        await expect(agent.client.listTools()).rejects.toThrow(/OpenNan Studio is not reachable/);
        expect(agent.isClosed()).toBe(false);
        server = await startHttpServer(studio.session, { port, token });
        expect(clipIds((await agent.client.callTool({ name: "find_clip", arguments: {} })) as CallToolResult)).toEqual(["title", "music"]);
        // The failed tools/list is offered again once the server is back.
        await waitFor(() => listChanged === 1);
        expect((await agent.client.listTools()).tools).toHaveLength(toolsForPreset().length);
        await agent.close();
    });

    it("fails a call in flight with a tool error when the server stops under it, instead of hanging", async () => {
        const studio = await createFixtureStudio();
        let started!: () => void;
        const inFlight = new Promise<void>((resolve) => {
            started = resolve;
        });
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const session = { ...studio.session, snapshot: async () => {
            started();
            await gate;
            return studio.session.snapshot();
        } };
        server = await startHttpServer(session, { port: 0 });
        const agent = await bridgeInProcess({ url: server.url, token: server.token, retry: FAST_RETRY });
        const call = agent.client.callTool({ name: "find_clip", arguments: {} });
        await inFlight;
        await server.close();
        server = null;
        const result = (await call) as CallToolResult;
        expect(result.isError).toBe(true);
        expect(text(result)).toMatch(/lost while find_clip was running, so it may or may not have been applied/);
        expect(agent.isClosed()).toBe(false);
        release();
        await agent.close();
    });

    it("starts while nothing listens yet and serves the local name and instructions", async () => {
        const studio = await createFixtureStudio();
        const port = await refusedPort();
        const token = createSessionToken();
        const agent = await bridgeInProcess({ url: `http://127.0.0.1:${port}/mcp`, token, retry: FAST_RETRY });
        expect(agent.client.getServerVersion()?.name).toBe("opennan-studio");
        expect(agent.client.getInstructions()).toBe(SERVER_INSTRUCTIONS);
        server = await startHttpServer(studio.session, { port, token });
        expect(clipIds((await agent.client.callTool({ name: "find_clip", arguments: {} })) as CallToolResult)).toEqual(["title", "music"]);
        await agent.close();
    });

    it("reads the token again when the server comes back with a new one", async () => {
        const studio = await createFixtureStudio();
        server = await startHttpServer(studio.session, { port: 0 });
        const { port, url } = server;
        let current = server.token;
        const agent = await bridgeInProcess({ url, token: () => current, retry: FAST_RETRY });
        expect(clipIds((await agent.client.callTool({ name: "find_clip", arguments: {} })) as CallToolResult)).toEqual(["title", "music"]);
        await server.close();
        current = createSessionToken();
        server = await startHttpServer(studio.session, { port, token: current });
        expect(clipIds((await agent.client.callTool({ name: "find_clip", arguments: {} })) as CallToolResult)).toEqual(["title", "music"]);
        await agent.close();
    });
});
