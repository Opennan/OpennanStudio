// opennan-studio CLI. No side effects: bin.ts runs it, and hosts or tests import
// runCli without starting anything. COMMANDS lists the commands for --help.
import { randomUUID } from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { createEmptyProject } from "@opennan/timeline-core";
import { createOpenNanProvider } from "@opennan/provider-opennan";
import { ProviderRegistry } from "@opennan/provider-sdk";
import { TOKEN_ENV, isValidToken } from "./auth";
import { isLoopbackHttpUrl, startBridge } from "./bridge";
import { AccountUsageError, cliSession, login, logout, whoami } from "./login";
import { FFMPEG_ENV, FFPROBE_ENV, openHeadlessProject, type HeadlessOptions } from "./headless";
import { createHeadlessMediaPreparer } from "./headless-media";
import { DEFAULT_HTTP_PORT, startHttpServer } from "./http";
import { MCP_CLIENTS, buildMcpConfig, mergeMcpConfig, type McpClient, type McpLaunch } from "./mcp-config";
import { PrivateFileError, writePrivateFile } from "./private-file";
import { mediaDirFor, serializeProjectFile } from "./project-file";
import { toolsForPreset, type StudioMcpServerOptions } from "./server";
import { serveStdio } from "./stdio";
import { MCP_VERSION } from "./version";

export interface CliIo {
    /** Opens a URL in the default browser (login); false when it could not. */
    openUrl?(url: string): boolean;
    stdout(text: string): void;
    stderr(text: string): void;
    cwd: string;
    home: string;
    env: Record<string, string | undefined>;
    /** Node binary and this CLI's file, used in generated stdio configs. */
    nodePath: string;
    cliPath: string;
    /** Resolves when the process should stop serving (signal or closed stdin). */
    waitForShutdown(transport: "stdio" | "http"): Promise<void>;
}

const COMMANDS = [
    "opennan-studio mcp serve --project <file> [--http] [--port <n>] [--token-file <path>] [--allow-dir <dir>]... [--read-only]",
    "                         [--ffmpeg <path> [--ffprobe <path>]] [--export-dir <dir>] [--tools all|offline]",
    "opennan-studio mcp bridge [--url <loopback url> | --port <n>] [--token-file <path>]",
    "opennan-studio mcp-config --client claude|codex|gemini|opencode|antigravity [--transport stdio|http|bridge] [--project <file>]",
    "                          [--url <url>] [--port <n>] [--token-env <NAME>] [--token-file <path>] [--write] [--config <path>]",
    "opennan-studio project new <file> [--name <name>] [--aspect <ratio>]",
    "opennan-studio login [--no-browser] [--api <url>]",
    "opennan-studio logout",
    "opennan-studio whoami",
];

function usage(): string {
    return `opennan-studio ${MCP_VERSION}\n\nUsage:\n${COMMANDS.map((line) => `  ${line}`).join("\n")}\n`;
}

class UsageError extends Error {}

function portOption(value: string | undefined, fallback: number): number {
    if (value === undefined) return fallback;
    const port = Number(value);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new UsageError(`--port must be 0-65535, got ${value}`);
    return port;
}

/** Where `mcp serve --http` writes the token unless --token-file names another file. */
export function defaultTokenFile(projectFile: string): string {
    return `${projectFile}.mcp-token`;
}

/** Writes the token readable by this user only (private-file.ts). */
async function writeTokenFile(file: string, token: string): Promise<void> {
    try {
        await writePrivateFile(file, `${token}\n`);
    } catch (error) {
        if (error instanceof PrivateFileError) throw new UsageError(error.message.replace("write through it", "write the token through it"));
        throw error;
    }
}

export interface ServeValues {
    project?: string;
    "read-only"?: boolean;
    "allow-dir"?: string[];
    ffmpeg?: string;
    ffprobe?: string;
    "export-dir"?: string;
}

/**
 * Headless options of `mcp serve`. The ffmpeg comes from --ffmpeg or OPENNAN_FFMPEG (a bare
 * name is looked up on PATH when it runs); ffprobe from --ffprobe, OPENNAN_FFPROBE, or the
 * ffprobe next to that ffmpeg. Without either, exports and preview frames stay unavailable.
 */
export function headlessOptionsFor(values: ServeValues, io: Pick<CliIo, "cwd" | "env">): HeadlessOptions {
    if (!values.project) throw new UsageError("mcp serve needs --project <file>");
    const binary = (file: string) => (/[\\/]/.test(file) ? path.resolve(io.cwd, file) : file);
    const ffmpeg = values.ffmpeg ?? io.env[FFMPEG_ENV];
    const ffprobe = values.ffprobe ?? io.env[FFPROBE_ENV]
        ?? (ffmpeg ? path.join(path.dirname(ffmpeg), path.basename(ffmpeg).replace(/ffmpeg/i, "ffprobe")) : undefined);
    if (values.ffprobe && !ffmpeg) throw new UsageError("--ffprobe needs --ffmpeg (or OPENNAN_FFMPEG)");
    return {
        projectFile: path.resolve(io.cwd, values.project),
        readOnly: values["read-only"],
        allowDirs: (values["allow-dir"] ?? []).map((dir) => path.resolve(io.cwd, dir)),
        ffmpeg: ffmpeg && ffprobe ? { ffmpegPath: binary(ffmpeg), ffprobePath: binary(ffprobe) } : undefined,
        exportDir: values["export-dir"] ? path.resolve(io.cwd, values["export-dir"]) : undefined,
    };
}

/** `--tools offline` lists only the tools that run without a provider (less agent context). */
export function serverOptionsFor(tools: string | undefined): StudioMcpServerOptions {
    if (tools === undefined || tools === "all") return {};
    if (tools === "offline") return { tools: toolsForPreset("offline") };
    throw new UsageError(`--tools must be all or offline, got ${tools}`);
}

async function serve(argv: string[], io: CliIo): Promise<number> {
    const { values } = parseArgs({
        args: argv,
        options: {
            project: { type: "string" }, http: { type: "boolean" }, port: { type: "string" },
            "token-file": { type: "string" }, "allow-dir": { type: "string", multiple: true }, "read-only": { type: "boolean" },
            ffmpeg: { type: "string" }, ffprobe: { type: "string" }, "export-dir": { type: "string" }, tools: { type: "string" },
        },
    });
    const serverOptions = serverOptionsFor(values.tools);
    const options = headlessOptionsFor(values, io);
    const projectFile = options.projectFile;
    // Generation tools use the signed-in account (opennan-studio login, or OPENNAN_API_KEY); signed out they answer
    // with the sign-in guidance.
    const account = await cliSession(io).catch(() => null);
    const providers = new ProviderRegistry();
    if (account) {
        // Media tools upload a trim of the project's own media, made with --ffmpeg (without it they answer unavailable).
        providers.register(createOpenNanProvider(account.session, { prepareMedia: createHeadlessMediaPreparer({ mediaDir: mediaDirFor(projectFile), ffmpeg: options.ffmpeg }) }));
        await Promise.race([account.session.restore().catch(() => undefined), new Promise((resolve) => setTimeout(resolve, 3000))]);
    }
    const studio = await openHeadlessProject({ ...options, providers, allowLoopbackDownloads: account ? /^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(account.apiBase) : false });
    try {
        if (!values.http) {
            const stdio = await serveStdio(studio.session, serverOptions);
            await io.waitForShutdown("stdio");
            await stdio.close();
            return 0;
        }
        const envToken = io.env[TOKEN_ENV];
        if (envToken !== undefined && !isValidToken(envToken)) throw new UsageError(`${TOKEN_ENV} must be at least 24 URL-safe characters`);
        const server = await startHttpServer(studio.session, { port: portOption(values.port, DEFAULT_HTTP_PORT), token: envToken, server: serverOptions });
        try {
            io.stdout(`OPENNAN_STUDIO_MCP_URL=${server.url}\n`);
            // The token is never printed: it goes to a 0600 file unless it came from the environment.
            if (envToken === undefined || values["token-file"]) {
                const tokenFile = path.resolve(io.cwd, values["token-file"] ?? defaultTokenFile(projectFile));
                await writeTokenFile(tokenFile, server.token);
                io.stdout(`OPENNAN_STUDIO_MCP_TOKEN_FILE=${tokenFile}\n`);
            }
            await io.waitForShutdown("http");
        } finally {
            await server.close();
        }
        return 0;
    } finally {
        await studio.close();
    }
}

interface LaunchValues {
    project?: string;
    url?: string;
    port?: string;
    "token-env"?: string;
    "token-file"?: string;
}

/** How the agent starts (stdio) or reaches (http) the server. */
function launchFor(transport: string, values: LaunchValues, io: CliIo): McpLaunch {
    const url = values.url ?? `http://127.0.0.1:${portOption(values.port, DEFAULT_HTTP_PORT)}/mcp`;
    if (transport === "stdio") {
        if (!values.project) throw new UsageError("--transport stdio needs --project <file>");
        return { transport: "stdio", command: io.nodePath, args: [io.cliPath, "mcp", "serve", "--project", path.resolve(io.cwd, values.project)] };
    }
    if (transport === "http") return { transport: "http", url, tokenEnv: values["token-env"] };
    if (transport === "bridge") {
        if (!values["token-file"]) throw new UsageError("--transport bridge needs --token-file <file> (written by the desktop app or `mcp serve --http`)");
        return { transport: "stdio", command: io.nodePath, args: [io.cliPath, "mcp", "bridge", "--url", url, "--token-file", path.resolve(io.cwd, values["token-file"])] };
    }
    throw new UsageError("--transport must be stdio, http, or bridge");
}

async function mcpConfig(argv: string[], io: CliIo): Promise<number> {
    const { values } = parseArgs({
        args: argv,
        options: {
            client: { type: "string" }, transport: { type: "string" }, project: { type: "string" }, url: { type: "string" },
            port: { type: "string" }, "token-env": { type: "string" }, "token-file": { type: "string" },
            write: { type: "boolean" }, config: { type: "string" },
        },
    });
    const client = values.client as McpClient | undefined;
    if (!client || !MCP_CLIENTS.includes(client)) throw new UsageError(`--client must be one of ${MCP_CLIENTS.join(", ")}`);
    const launch = launchFor(values.transport ?? "stdio", values, io);
    const snippet = buildMcpConfig(client, launch, { cwd: io.cwd, home: io.home, codexHome: io.env.CODEX_HOME });
    if (!values.write) {
        io.stdout(snippet.text);
        io.stderr(`Add this to ${snippet.path}, or run again with --write.\n`);
        return 0;
    }
    const target = values.config ? path.resolve(io.cwd, values.config) : snippet.path;
    const existing = existsSync(target) ? await fs.readFile(target, "utf8") : null;
    const next = mergeMcpConfig({ ...snippet, path: target }, existing);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, next);
    io.stdout(`Wrote ${target}\n`);
    return 0;
}

async function projectNew(argv: string[], io: CliIo): Promise<number> {
    const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { name: { type: "string" }, aspect: { type: "string" } } });
    if (positionals.length !== 1) throw new UsageError("project new needs exactly one <file>");
    const file = path.resolve(io.cwd, positionals[0]);
    if (existsSync(file)) throw new UsageError(`${file} already exists`);
    const project = createEmptyProject(randomUUID());
    project.meta.name = values.name ?? path.basename(file).replace(/\.opennan\.json$|\.json$/, "");
    if (values.aspect) project.meta.aspectRatio = values.aspect;
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, serializeProjectFile(project));
    io.stdout(`Created ${file}\n`);
    return 0;
}

async function bridge(argv: string[], io: CliIo): Promise<number> {
    const { values } = parseArgs({ args: argv, options: { url: { type: "string" }, port: { type: "string" }, "token-file": { type: "string" } } });
    const url = new URL(values.url ?? `http://127.0.0.1:${portOption(values.port, DEFAULT_HTTP_PORT)}/mcp`);
    // The bearer token is sent to this URL, so only this machine's loopback is accepted.
    if (!isLoopbackHttpUrl(url)) {
        throw new UsageError(`mcp bridge connects only to http://127.0.0.1 or http://localhost, got ${url.href}`);
    }
    const tokenFile = values["token-file"] ? path.resolve(io.cwd, values["token-file"]) : null;
    const readToken = async () => (tokenFile ? (await fs.readFile(tokenFile, "utf8")).trim() : io.env[TOKEN_ENV]);
    const token = await readToken();
    if (!token || !isValidToken(token)) throw new UsageError(`mcp bridge needs --token-file <file> or ${TOKEN_ENV} with the server's token`);
    // The token file is read again before every connection attempt: a restarted server may write a new token.
    const running = await startBridge({ url: url.href, token: tokenFile ? async () => (await readToken()) ?? token : token });
    await Promise.race([io.waitForShutdown("stdio"), running.closed]);
    await running.close();
    return 0;
}

export async function runCli(argv: string[], io: CliIo): Promise<number> {
    try {
        const [command, sub, ...rest] = argv;
        if (command === "--version") {
            io.stdout(`${MCP_VERSION}\n`);
            return 0;
        }
        if (command === "mcp" && sub === "serve") return await serve(rest, io);
        if (command === "mcp" && sub === "bridge") return await bridge(rest, io);
        if (command === "mcp-config") return await mcpConfig(argv.slice(1), io);
        if (command === "project" && sub === "new") return await projectNew(rest, io);
        if (command === "login" || command === "logout" || command === "whoami") {
            const { values } = parseArgs({ args: argv.slice(1), options: { api: { type: "string" }, "no-browser": { type: "boolean" } } });
            if (command === "login") return await login(io, { api: values.api, noBrowser: values["no-browser"] });
            return await (command === "logout" ? logout : whoami)(io, { api: values.api });
        }
        if (command === undefined || command === "--help" || command === "help") {
            io.stdout(usage());
            return 0;
        }
        throw new UsageError(`Unknown command: ${argv.join(" ")}`);
    } catch (error) {
        io.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
        const usageError = error instanceof UsageError || error instanceof AccountUsageError;
        if (usageError) io.stderr(usage());
        return usageError ? 2 : 1;
    }
}
