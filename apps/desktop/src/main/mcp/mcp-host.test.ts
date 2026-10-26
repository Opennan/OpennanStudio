import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { StudioHttpServer, StudioSession } from "@opennan/mcp";
import { createMcpHost } from "./mcp-host";
import { parseBridgeArgs, readBridgeToken } from "./bridge-mode";

const fakeSession = (projectId: string) => ({
    projectId, host: {},
    execute: async () => ({ ok: true, changed: {} }),
    snapshot: async () => ({ projectId, project: { id: projectId, name: "P", aspectRatio: "16:9" }, tracks: [], clips: [], scenes: [], markers: [], currentTime: 0 }),
    describeTimeline: async () => `Project ${projectId}: empty`,
    previewFrame: async (seconds: number) => ({ ok: false, seconds, error: "none", unavailable: true }),
    uiState: async () => ({ currentTime: 0, isPlaying: false, shuttleSpeed: 1, zoom: 1, toolMode: "select", snapEnabled: true, selection: { clipIds: [], sceneId: null, transition: null, audioTarget: null, markerId: null }, markers: [], canUndo: false, canRedo: false, activePanel: null }),
}) as unknown as StudioSession;

describe("MCP host", () => {
    let dir: string;
    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "opennan-mcp-"));
    });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    it("writes a private token file once per run", () => {
        const tokenFile = path.join(dir, "mcp", "token");
        const host = createMcpHost({ tokenFile, preferredPort: 4319, startHttpServer: vi.fn() });
        const token = host.token();
        expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(host.token()).toBe(token);
        expect(fs.readFileSync(tokenFile, "utf8").trim()).toBe(token);
        if (process.platform !== "win32") expect(fs.statSync(tokenFile).mode & 0o777).toBe(0o600);
    });

    it("restarts on the same port with the same token when the project changes; falls back once when the port is busy", async () => {
        const calls: Array<{ port?: number; token?: string; projectId: string }> = [];
        let assigned = 50001;
        const start = vi.fn(async (session: StudioSession, options: { port?: number; token?: string }) => {
            calls.push({ port: options.port, token: options.token, projectId: session.projectId });
            if (options.port === 4319) throw Object.assign(new Error("listen EADDRINUSE"), { code: "EADDRINUSE" });
            const port = options.port === 0 ? assigned++ : options.port!;
            return { url: `http://127.0.0.1:${port}/mcp`, port, address: "127.0.0.1", token: options.token!, sessionCount: () => 0, close: vi.fn(async () => undefined) } as StudioHttpServer;
        });
        const host = createMcpHost({ tokenFile: path.join(dir, "token"), preferredPort: 4319, startHttpServer: start as never });
        await host.open(fakeSession("a"));
        await host.open(fakeSession("b"));
        expect(calls.map((c) => c.port)).toEqual([4319, 0, 50001]);
        expect(new Set(calls.map((c) => c.token)).size).toBe(1);
        expect(host.info()).toEqual({ running: true, url: "http://127.0.0.1:50001/mcp", port: 50001, projectId: "b" });
        expect(host.bridgeLaunch({ execPath: "/Apps/OpenNan Studio", appPath: "/app.asar", isPackaged: true, platform: "darwin" }))
            .toEqual({ transport: "stdio", command: "/Apps/OpenNan Studio", args: ["--mcp-bridge", "--url", "http://127.0.0.1:50001/mcp", "--token-file", path.join(dir, "token")] });
        expect(host.bridgeLaunch({ execPath: "/electron", appPath: "/repo/apps/desktop", isPackaged: false, platform: "darwin" }).args.slice(0, 2)).toEqual(["/repo/apps/desktop", "--mcp-bridge"]);
        const linux = host.bridgeLaunch({ execPath: "/electron", appPath: "/app", isPackaged: false, platform: "linux" });
        expect(linux.args.slice(0, 3)).toEqual(["--ozone-platform=headless", "/app", "--mcp-bridge"]);
        const windows = host.bridgeLaunch({ execPath: "studio.exe", appPath: "/app", isPackaged: true, platform: "win32" });
        expect(windows.env).toEqual({ ELECTRON_NO_ATTACH_CONSOLE: "1" });
        await host.close();
        expect(host.info().running).toBe(false);
        expect(() => host.bridgeLaunch({ execPath: "/e", appPath: "/a", isPackaged: true })).toThrow("not running");
    });

    it("moves to a fresh port when its remembered port was taken", async () => {
        let attempts = 0;
        const start = vi.fn(async (_session: StudioSession, options: { port?: number; token?: string }) => {
            attempts += 1;
            if (attempts === 2) throw Object.assign(new Error("listen EADDRINUSE"), { code: "EADDRINUSE" });
            const port = options.port === 0 ? 50100 + attempts : options.port!;
            return { url: `http://127.0.0.1:${port}/mcp`, port, address: "127.0.0.1", token: options.token!, sessionCount: () => 0, close: vi.fn(async () => undefined) } as StudioHttpServer;
        });
        const host = createMcpHost({ tokenFile: path.join(dir, "token"), preferredPort: 4400, startHttpServer: start as never });
        await host.open(fakeSession("a"));
        await host.open(fakeSession("b"));
        expect(start.mock.calls.map(([, options]) => options.port)).toEqual([4400, 4400, 0]);
        expect(host.bridgeLaunch({ execPath: "/e", appPath: "/a", isPackaged: true }).args).toContain("http://127.0.0.1:50103/mcp");
    });

    it("serves read_timeline over real HTTP with the token", async () => {
        const host = createMcpHost({ tokenFile: path.join(dir, "token"), preferredPort: 0 });
        const info = await host.open(fakeSession("p"));
        const client = new Client({ name: "t", version: "1" });
        await client.connect(new StreamableHTTPClientTransport(new URL(info.url!), { requestInit: { headers: { Authorization: `Bearer ${host.token()}` } } }));
        const result = await client.callTool({ name: "read_timeline", arguments: {} });
        expect(JSON.stringify(result.content)).toContain("Project p");
        await client.close();
        const refused = await fetch(info.url!, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
        expect(refused.status).toBe(401);
        await host.close();
    });
});

describe("bridge mode arguments", () => {
    let dir: string;
    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "opennan-bridge-"));
        fs.writeFileSync(path.join(dir, "token"), "abc\n");
    });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
    const args = (url: string, file: string) => ["electron", "--mcp-bridge", "--url", url, "--token-file", file];

    it("accepts a loopback URL and a small token file", () => {
        expect(parseBridgeArgs(args("http://127.0.0.1:4319/mcp", path.join(dir, "token")))).toEqual({ url: "http://127.0.0.1:4319/mcp", tokenFile: path.join(dir, "token") });
    });

    it.each([
        ["http://example.com/mcp", "token"], ["https://127.0.0.1.evil.test/mcp", "token"], ["file:///etc/passwd", "token"],
    ])("refuses url %s", (url, file) => {
        expect(() => parseBridgeArgs(args(url, path.join(dir, file)))).toThrow("--url");
    });

    it("refuses bad token files", () => {
        expect(() => parseBridgeArgs(args("http://127.0.0.1:1/mcp", "token"))).toThrow("absolute");
        expect(() => parseBridgeArgs(args("http://127.0.0.1:1/mcp", dir))).toThrow("not a file");
        fs.writeFileSync(path.join(dir, "big"), "x".repeat(2048));
        expect(() => parseBridgeArgs(args("http://127.0.0.1:1/mcp", path.join(dir, "big")))).toThrow("too large");
        expect(() => parseBridgeArgs(["electron", "--mcp-bridge"])).toThrow("usage");
    });

    it("sends only a real session token, never another small file", () => {
        fs.writeFileSync(path.join(dir, "npmrc"), "//registry.npmjs.org/:_authToken=npm_secret\n");
        expect(() => readBridgeToken(path.join(dir, "npmrc"))).toThrow("does not hold an OpenNan Studio token");
        fs.writeFileSync(path.join(dir, "good"), `${"a".repeat(43)}\n`);
        expect(readBridgeToken(path.join(dir, "good"))).toBe("a".repeat(43));
    });
});
