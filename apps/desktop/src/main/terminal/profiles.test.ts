import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyWrites, buildLaunch, readConfig, type LaunchInput } from "./profiles";

const bridge = { transport: "stdio" as const, command: "/Applications/OpenNan Studio.app/Contents/MacOS/OpenNan Studio", args: ["--mcp-bridge", "--url", "http://127.0.0.1:4319/mcp", "--token-file", "/Users/me/Library/Application Support/OpenNan Studio/mcp/token"] };

function input(overrides: Partial<LaunchInput> = {}): LaunchInput {
    return {
        profile: "claude", settings: { terminalCustomCommand: "" }, projectDir: "/u/projects/p", bridge: () => bridge, platform: "darwin",
        env: { PATH: "/usr/bin", SHELL: "/bin/zsh", HOME: "/Users/me", ELECTRON_RUN_AS_NODE: "1", NODE_OPTIONS: "--inspect", OPENNAN_STUDIO_E2E: "1", OPENAI_API_KEY: "leak" },
        home: "/Users/me", secret: (name) => ({ ANTHROPIC_API_KEY: "sk-ant", OPENAI_API_KEY: "sk-oai", GEMINI_API_KEY: "g", OPENNAN_API_KEY: null, FAL_KEY: "fal-secret" } as Record<string, string | null>)[name] ?? null,
        readFile: () => null, ...overrides,
    };
}

describe("buildLaunch", () => {
    it("never hands the fal.ai provider key to a terminal", () => {
        for (const profile of ["claude", "codex", "gemini", "shell"] as const) {
            const launch = buildLaunch(input({ profile, env: { PATH: "/usr/bin", SHELL: "/bin/zsh", HOME: "/Users/me", FAL_KEY: "inherited" } }));
            expect(launch.env.FAL_KEY).toBeUndefined();
            expect(JSON.stringify(launch)).not.toContain("fal-secret");
        }
    });

    it("claude: login shell exec, .mcp.json with the bridge entry, only its own key", () => {
        const launch = buildLaunch(input({ readFile: () => JSON.stringify({ mcpServers: { other: { command: "x" } } }) }));
        expect(launch.file).toBe("/bin/zsh");
        expect(launch.args).toEqual(["-l", "-c", "exec \"$0\" \"$@\"", "claude"]);
        expect(launch.cwd).toBe("/u/projects/p");
        expect(launch.writes).toHaveLength(1);
        expect(launch.writes[0].path).toBe(path.join("/u/projects/p", ".mcp.json"));
        const config = JSON.parse(launch.writes[0].content);
        expect(config.mcpServers.other).toEqual({ command: "x" });
        expect(config.mcpServers["opennan-studio"]).toMatchObject({ type: "stdio", command: bridge.command, args: bridge.args });
        expect(launch.env.ANTHROPIC_API_KEY).toBe("sk-ant");
        expect(launch.env.OPENAI_API_KEY).toBeUndefined();
        for (const key of ["ELECTRON_RUN_AS_NODE", "NODE_OPTIONS", "OPENNAN_STUDIO_E2E"]) expect(launch.env[key]).toBeUndefined();
        expect(launch.env.TERM).toBe("xterm-256color");
        expect(JSON.stringify(launch)).not.toMatch(/token":|Bearer/);
    });

    it("codex: -c overrides with TOML strings, no file written", () => {
        const launch = buildLaunch(input({ profile: "codex", bridge: () => ({ ...bridge, command: "C:\\Program Files\\OpenNan \"Studio\"\\app.exe" }) }));
        expect(launch.writes).toEqual([]);
        expect(launch.args.slice(3)).toEqual([
            "codex", "-c", "mcp_servers.opennan-studio.command=\"C:\\\\Program Files\\\\OpenNan \\\"Studio\\\"\\\\app.exe\"",
            "-c", `mcp_servers.opennan-studio.args=[${bridge.args.map((a) => JSON.stringify(a)).join(", ")}]`,
        ]);
        expect(launch.env.OPENAI_API_KEY).toBe("sk-oai");
        expect(launch.env.ANTHROPIC_API_KEY).toBeUndefined();
    });

    it("gemini writes .gemini/settings.json", () => {
        const launch = buildLaunch(input({ profile: "gemini" }));
        expect(launch.writes[0].path).toBe(path.join("/u/projects/p", ".gemini", "settings.json"));
        expect(JSON.parse(launch.writes[0].content).mcpServers["opennan-studio"]).toMatchObject({ command: bridge.command });
    });

    it("agent profiles need a running MCP server; shell and custom do not", () => {
        const down = () => { throw new Error("The MCP server is not running"); };
        expect(() => buildLaunch(input({ profile: "claude", bridge: down }))).toThrow("not running");
        expect(() => buildLaunch(input({ profile: "codex", bridge: down }))).toThrow("not running");
        expect(buildLaunch(input({ profile: "shell", bridge: down })).args).toEqual(["-l"]);
    });

    it("shell and custom", () => {
        expect(buildLaunch(input({ profile: "shell" }))).toMatchObject({ file: "/bin/zsh", args: ["-l"], writes: [] });
        expect(buildLaunch(input({ profile: "custom", settings: { terminalCustomCommand: "aider --yes; rm -rf /" } })).args)
            .toEqual(["-l", "-c", "exec \"$0\" \"$@\"", "aider", "--yes;", "rm", "-rf", "/"]);
        expect(() => buildLaunch(input({ profile: "custom" }))).toThrow("Set a command");
        expect(buildLaunch(input({ profile: "shell", env: { SHELL: "relative" }, platform: "linux" })).file).toBe("/bin/bash");
    });

    it("Windows resolves on PATH and refuses missing commands", () => {
        const exists = (file: string) => file.toLowerCase() === "c:\\npm\\claude.cmd"; // Windows paths are case-insensitive
        const launch = buildLaunch(input({ platform: "win32", env: { PATH: "C:\\npm", PATHEXT: ".EXE;.CMD", SystemRoot: "D:\\Win" }, exists, projectDir: "C:\\u\\p" }));
        expect(launch.file).toBe("D:\\Win\\System32\\cmd.exe");
        expect(launch.args).toBe("/d /v:off /s /c \"C:\\npm\\claude.CMD\"");
        expect(() => buildLaunch(input({ platform: "win32", profile: "gemini", env: { PATH: "C:\\npm" }, exists, projectDir: "C:\\u\\p" }))).toThrow("not installed");
    });
});

describe("applyWrites", () => {
    it("writes inside the project folder only", () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opennan-writes-"));
        applyWrites([{ path: path.join(dir, ".gemini", "settings.json"), content: "{}" }], dir);
        expect(fs.readFileSync(path.join(dir, ".gemini", "settings.json"), "utf8")).toBe("{}");
        if (process.platform !== "win32") expect(fs.statSync(path.join(dir, ".gemini", "settings.json")).mode & 0o777).toBe(0o600);
        expect(() => applyWrites([{ path: path.join(dir, "..", "evil.json"), content: "{}" }], dir)).toThrow("outside the project folder");
        fs.rmSync(dir, { recursive: true, force: true });
    });
});

describe("config files an agent could have tampered with", () => {
    it.skipIf(process.platform === "win32")("refuses a symlinked .gemini folder, symlinked or special config files", async () => {
        const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "opennan-tamper-")));
        const project = path.join(dir, "project");
        const elsewhere = path.join(dir, "elsewhere");
        fs.mkdirSync(project);
        fs.mkdirSync(elsewhere);
        fs.symlinkSync(elsewhere, path.join(project, ".gemini"));
        expect(() => applyWrites([{ path: path.join(project, ".gemini", "settings.json"), content: "{}" }], project)).toThrow("outside the project folder");
        expect(fs.readdirSync(elsewhere)).toEqual([]);

        fs.writeFileSync(path.join(elsewhere, "secret.json"), "{\"secret\":1}");
        fs.symlinkSync(path.join(elsewhere, "secret.json"), path.join(project, ".mcp.json"));
        expect(() => readConfig(path.join(project, ".mcp.json"))).toThrow("not a regular config file");
        const { execFileSync } = await import("node:child_process");
        execFileSync("mkfifo", [path.join(project, "fifo.json")]);
        expect(() => readConfig(path.join(project, "fifo.json"))).toThrow("not a regular config file");
        expect(readConfig(path.join(project, "missing.json"))).toBeNull();
        // A symlinked .mcp.json is replaced (rename does not follow it), never written through.
        applyWrites([{ path: path.join(project, ".mcp.json"), content: "{}" }], project);
        expect(fs.readFileSync(path.join(elsewhere, "secret.json"), "utf8")).toBe("{\"secret\":1}");
        fs.rmSync(dir, { recursive: true, force: true });
    });
});
