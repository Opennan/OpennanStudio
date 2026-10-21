// Terminal profiles (spec §7.2 terminal panel): claude, codex, gemini, the login shell, or one user-defined
// command, always started in the project folder. Before an agent CLI starts, its MCP config points at the
// app's server through the --mcp-bridge stdio entry: Claude Code's .mcp.json and Gemini CLI's
// .gemini/settings.json in the project folder (merged, other entries kept); Codex CLI gets -c overrides on its
// command line instead of an edit to the user's global config. Each CLI gets only its own stored API key.
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_SERVER_NAME, buildMcpConfig, mergeMcpConfig, type McpLaunch } from "@opennan/mcp";
import type { DesktopSettings, SecretName, TerminalProfileId } from "../../shared/settings";
import { findOnPath, parseCommandLine, posixLaunch, windowsLaunch, type Launch } from "./shell-command";

export interface FileWrite {
    path: string;
    content: string;
}

export interface TerminalLaunch extends Launch {
    cwd: string;
    env: Record<string, string>;
    writes: FileWrite[];
}

export interface LaunchInput {
    profile: TerminalProfileId;
    settings: Pick<DesktopSettings, "terminalCustomCommand">;
    projectDir: string;
    /** The --mcp-bridge stdio entry; called only for agent profiles (throws while no MCP server listens). */
    bridge(): Extract<McpLaunch, { transport: "stdio" }>;
    platform: NodeJS.Platform;
    env: Record<string, string | undefined>;
    home: string;
    secret(name: SecretName): string | null;
    readFile?(file: string): string | null;
    exists?(file: string): boolean;
}

const PROFILE_KEY: Partial<Record<TerminalProfileId, SecretName>> = { claude: "ANTHROPIC_API_KEY", codex: "OPENAI_API_KEY", gemini: "GEMINI_API_KEY" };
const DROPPED_ENV = /^(ELECTRON_RUN_AS_NODE|ELECTRON_NO_ATTACH_CONSOLE|NODE_OPTIONS|OPENNAN_STUDIO_.*|ANTHROPIC_API_KEY|OPENAI_API_KEY|GEMINI_API_KEY|OPENNAN_API_KEY|FAL_KEY)$/;

const MAX_CONFIG_BYTES = 1024 * 1024;

/** An existing CLI config: a regular file (not a symlink, FIFO, or device) of at most 1 MiB; null when absent. */
export function readConfig(file: string): string | null {
    let stat: fs.Stats;
    try {
        stat = fs.lstatSync(file);
    } catch {
        return null;
    }
    if (!stat.isFile() || stat.size > MAX_CONFIG_BYTES) throw new Error(`${file} is not a regular config file; move it away and start again`);
    return fs.readFileSync(file, "utf8");
}

/** The CLI's MCP config written into the project folder, merged with what is there. */
function configWrite(client: "claude" | "gemini", input: LaunchInput): FileWrite {
    const snippet = buildMcpConfig(client, input.bridge(), { cwd: input.projectDir, home: input.home });
    const existing = (input.readFile ?? readConfig)(snippet.path);
    return { path: snippet.path, content: mergeMcpConfig(snippet, existing) };
}

const toml = (value: string) => JSON.stringify(value);

export function terminalEnv(input: Pick<LaunchInput, "env" | "profile" | "projectDir" | "secret">): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(input.env)) if (value !== undefined && !DROPPED_ENV.test(key)) env[key] = value;
    env.TERM = "xterm-256color";
    env.COLORTERM = "truecolor";
    env.OPENNAN_STUDIO_PROJECT_DIR = input.projectDir;
    const key = PROFILE_KEY[input.profile];
    const value = key ? input.secret(key) : null;
    if (key && value) env[key] = value;
    return env;
}

export function buildLaunch(input: LaunchInput): TerminalLaunch {
    const writes: FileWrite[] = [];
    let argv: string[];
    switch (input.profile) {
        case "claude":
            argv = ["claude"];
            writes.push(configWrite("claude", input));
            break;
        case "gemini":
            argv = ["gemini"];
            writes.push(configWrite("gemini", input));
            break;
        case "codex": {
            const name = DEFAULT_SERVER_NAME;
            const bridge = input.bridge();
            argv = ["codex", "-c", `mcp_servers.${name}.command=${toml(bridge.command)}`, "-c", `mcp_servers.${name}.args=[${bridge.args.map(toml).join(", ")}]`];
            break;
        }
        case "custom":
            if (!input.settings.terminalCustomCommand.trim()) throw new Error("Set a command for the Custom profile in Settings first");
            argv = parseCommandLine(input.settings.terminalCustomCommand);
            break;
        case "shell":
            argv = [];
            break;
    }
    const env = terminalEnv(input);
    const base = { cwd: input.projectDir, env, writes };
    if (input.platform === "win32") {
        if (input.profile === "shell") return { ...base, file: `${input.env.SystemRoot || input.env.SYSTEMROOT || "C:\\Windows"}\\System32\\cmd.exe`, args: [] };
        const resolved = findOnPath(argv[0], { PATH: input.env.PATH ?? input.env.Path, PATHEXT: input.env.PATHEXT, platform: "win32", exists: input.exists });
        if (!resolved) throw new Error(`${argv[0]} is not installed or not on PATH`);
        const systemRoot = input.env.SystemRoot || input.env.SYSTEMROOT || "C:\\Windows";
        // cmd.exe by full path: a bare name is searched in the current directory before System32.
        return { ...base, ...windowsLaunch(resolved, argv.slice(1), `${systemRoot}\\System32\\cmd.exe`) };
    }
    const shell = input.env.SHELL && path.isAbsolute(input.env.SHELL) ? input.env.SHELL : input.platform === "darwin" ? "/bin/zsh" : "/bin/bash";
    if (input.profile === "shell") return { ...base, file: shell, args: ["-l"] };
    return { ...base, ...posixLaunch(shell, argv) };
}

/** Writes the configs a launch needs (atomic, 0600), creating folders inside the project folder. */
export function applyWrites(writes: FileWrite[], projectDir: string): void {
    const root = path.resolve(projectDir);
    for (const write of writes) {
        const target = path.resolve(write.path);
        if (!target.startsWith(root + path.sep)) throw new Error(`Refusing to write outside the project folder: ${write.path}`);
        fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
        // An agent may have replaced .gemini with a symlink to another folder: the real parent must stay inside.
        const realRoot = fs.realpathSync(root);
        const realParent = fs.realpathSync(path.dirname(target));
        if (realParent !== realRoot && !realParent.startsWith(realRoot + path.sep)) throw new Error(`Refusing to write outside the project folder: ${write.path}`);
        const existing = fs.lstatSync(target, { throwIfNoEntry: false });
        if (existing && !existing.isFile() && !existing.isSymbolicLink()) throw new Error(`${write.path} is not a regular file`);
        const tmp = `${target}.${process.pid}.tmp`;
        fs.rmSync(tmp, { force: true }); // a planted tmp symlink is removed, never written through ("wx" refuses links)
        fs.writeFileSync(tmp, write.content, { mode: 0o600, flag: "wx" });
        fs.renameSync(tmp, target);
    }
}
