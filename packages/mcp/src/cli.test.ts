import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { headlessOptionsFor, runCli, serverOptionsFor, type CliIo } from "./cli";
import { readProjectFile, writeProjectFile } from "./project-file";
import { fixtureProject } from "./testing/fixture";

let dir: string;

beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "opennan-cli-"));
});

afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
});

function io(overrides: Partial<CliIo> = {}) {
    const out: string[] = [];
    const err: string[] = [];
    const value: CliIo = {
        stdout: (text) => out.push(text),
        stderr: (text) => err.push(text),
        cwd: dir,
        home: path.join(dir, "home"),
        env: {},
        nodePath: "/usr/bin/node",
        cliPath: "/opt/studio/cli.js",
        waitForShutdown: async () => undefined,
        ...overrides,
    };
    return { io: value, out, err };
}

describe("opennan-studio CLI", () => {
    it("prints usage and rejects unknown commands", async () => {
        const help = io();
        expect(await runCli(["--help"], help.io)).toBe(0);
        expect(help.out.join("")).toContain("opennan-studio mcp serve --project <file>");
        const bad = io();
        expect(await runCli(["frobnicate"], bad.io)).toBe(2);
        expect(bad.err[0]).toBe("Unknown command: frobnicate\n");
        expect(await runCli(["mcp", "serve"], io().io)).toBe(2);
        expect(await runCli(["mcp", "serve", "--project", "f.json", "--tools", "some"], io().io)).toBe(2);
        expect(serverOptionsFor(undefined)).toEqual({});
        expect(serverOptionsFor("offline").tools).toHaveLength(71);
        expect(() => serverOptionsFor("generation")).toThrow("--tools must be all or offline");
    });

    it("passes an ffmpeg for exports and preview frames to headless mode", () => {
        expect(headlessOptionsFor({ project: "film.opennan.json", ffmpeg: "/opt/ff/bin/ffmpeg" }, { cwd: dir, env: {} })).toMatchObject({
            projectFile: path.join(dir, "film.opennan.json"),
            ffmpeg: { ffmpegPath: "/opt/ff/bin/ffmpeg", ffprobePath: "/opt/ff/bin/ffprobe" },
        });
        expect(headlessOptionsFor({ project: "f.json" }, { cwd: dir, env: { OPENNAN_FFMPEG: "/a/ffmpeg", OPENNAN_FFPROBE: "/b/ffprobe" } }).ffmpeg)
            .toEqual({ ffmpegPath: "/a/ffmpeg", ffprobePath: "/b/ffprobe" });
        expect(headlessOptionsFor({ project: "f.json", ffmpeg: "ffmpeg" }, { cwd: dir, env: {} }).ffmpeg).toEqual({ ffmpegPath: "ffmpeg", ffprobePath: "ffprobe" });
        expect(headlessOptionsFor({ project: "f.json" }, { cwd: dir, env: {} }).ffmpeg).toBeUndefined();
        expect(headlessOptionsFor({ project: "f.json", "export-dir": "out" }, { cwd: dir, env: {} }).exportDir).toBe(path.join(dir, "out"));
        expect(() => headlessOptionsFor({ project: "f.json", ffprobe: "/b/ffprobe" }, { cwd: dir, env: {} })).toThrow("--ffprobe needs --ffmpeg");
    });

    it("serves a project over HTTP until shutdown, with the token only in a 0600 file", async () => {
        const file = path.join(dir, "fixture.opennan.json");
        await writeProjectFile(file, fixtureProject());
        let stop!: () => void;
        const stopped = new Promise<void>((resolve) => {
            stop = resolve;
        });
        const t = io({ waitForShutdown: () => stopped });
        const running = runCli(["mcp", "serve", "--project", file, "--http", "--port", "0"], t.io);
        await expect.poll(() => t.out.length).toBe(2);
        const url = t.out[0].trim().replace("OPENNAN_STUDIO_MCP_URL=", "");
        const tokenFile = `${file}.mcp-token`;
        expect(t.out[1]).toBe(`OPENNAN_STUDIO_MCP_TOKEN_FILE=${tokenFile}\n`);
        expect((await stat(tokenFile)).mode & 0o777).toBe(0o600);
        const token = (await readFile(tokenFile, "utf8")).trim();
        expect(t.out.join("")).not.toContain(token);
        const client = new Client({ name: "cli-test", version: "0.0.0" });
        await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
        expect((await client.callTool({ name: "delete_timeline_clip", arguments: { clip_id: "title" } })).isError).toBe(false);
        await client.close();
        stop();
        expect(await running).toBe(0);
        expect((await readProjectFile(file)).project.clips.map((c) => c.id)).toEqual(["music"]);
    });

    it("replaces an existing token file with a 0600 one and refuses symlinks", async () => {
        const file = path.join(dir, "fixture.opennan.json");
        await writeProjectFile(file, fixtureProject());
        const tokenFile = path.join(dir, "token.txt");
        await writeFile(tokenFile, "old\n");
        await chmod(tokenFile, 0o644);
        const serveArgs = (target: string) => ["mcp", "serve", "--project", file, "--http", "--port", "0", "--token-file", target];
        expect(await runCli(serveArgs("token.txt"), io().io)).toBe(0);
        expect((await stat(tokenFile)).mode & 0o777).toBe(0o600);
        expect((await readFile(tokenFile, "utf8")).trim()).not.toBe("old");
        await symlink(path.join(dir, "elsewhere.txt"), path.join(dir, "link.txt"));
        const linked = io();
        expect(await runCli(serveArgs("link.txt"), linked.io)).toBe(2);
        expect(linked.err[0]).toMatch(/link\.txt is a symlink/);
    });

    it("creates an empty project file", async () => {
        const t = io();
        expect(await runCli(["project", "new", "film.opennan.json", "--aspect", "9:16"], t.io)).toBe(0);
        const { project } = await readProjectFile(path.join(dir, "film.opennan.json"));
        expect(project.meta).toMatchObject({ name: "film", aspectRatio: "9:16" });
        expect(await runCli(["project", "new", "film.opennan.json"], io().io)).toBe(2);
    });

    it("prints a stdio config for Claude Code", async () => {
        const t = io();
        expect(await runCli(["mcp-config", "--client", "claude", "--project", "film.opennan.json"], t.io)).toBe(0);
        expect(JSON.parse(t.out.join("")).mcpServers["opennan-studio"]).toEqual({
            type: "stdio", command: "/usr/bin/node", args: ["/opt/studio/cli.js", "mcp", "serve", "--project", path.join(dir, "film.opennan.json")], env: {},
        });
        expect(t.err.join("")).toBe(`Add this to ${path.join(dir, ".mcp.json")}, or run again with --write.\n`);
    });

    it("writes an HTTP config for Gemini and Codex, keeping other entries", async () => {
        await writeFile(path.join(dir, "existing.json"), JSON.stringify({ mcpServers: { other: { command: "x" } } }));
        expect(await runCli(["mcp-config", "--client", "gemini", "--transport", "http", "--port", "5000", "--write", "--config", "existing.json"], io().io)).toBe(0);
        const gemini = JSON.parse(await readFile(path.join(dir, "existing.json"), "utf8"));
        expect(Object.keys(gemini.mcpServers)).toEqual(["other", "opennan-studio"]);
        expect(gemini.mcpServers["opennan-studio"].httpUrl).toBe("http://127.0.0.1:5000/mcp");
        const codex = io({ env: { CODEX_HOME: path.join(dir, "codex") } });
        expect(await runCli(["mcp-config", "--client", "codex", "--transport", "http", "--write"], codex.io)).toBe(0);
        expect(await readFile(path.join(dir, "codex", "config.toml"), "utf8")).toContain('bearer_token_env_var = "OPENNAN_STUDIO_MCP_TOKEN"');
    });

    it("lists mcp-config in the usage and rejects a missing client or project", async () => {
        const help = io();
        await runCli(["--help"], help.io);
        expect(help.out.join("")).toContain("opennan-studio mcp-config --client claude|codex|gemini|opencode|antigravity");
        expect(await runCli(["mcp-config", "--client", "cursor"], io().io)).toBe(2);
        expect(await runCli(["mcp-config", "--client", "claude"], io().io)).toBe(2);
    });

    it("prints a bridge config for sessions hosted by another process", async () => {
        const t = io();
        expect(await runCli(["mcp-config", "--client", "claude", "--transport", "bridge", "--port", "4400", "--token-file", "token.txt"], t.io)).toBe(0);
        expect(JSON.parse(t.out.join("")).mcpServers["opennan-studio"]).toEqual({
            type: "stdio", command: "/usr/bin/node", env: {},
            args: ["/opt/studio/cli.js", "mcp", "bridge", "--url", "http://127.0.0.1:4400/mcp", "--token-file", path.join(dir, "token.txt")],
        });
        expect(await runCli(["mcp-config", "--client", "claude", "--transport", "bridge"], io().io)).toBe(2);
        expect(await runCli(["mcp", "bridge", "--url", "https://evil.test/mcp", "--token-file", "token.txt"], io().io)).toBe(2);
    });
});
