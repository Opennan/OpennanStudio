// Config snippets that register the OpenNan Studio MCP server with CLI agents
// (spec §5.7): Claude Code (.mcp.json), Codex CLI (config.toml), Gemini CLI
// (.gemini/settings.json). HTTP configs read the token from an env variable.
import path from "node:path";
import { TOKEN_ENV } from "./auth";

export const MCP_CLIENTS = ["claude", "codex", "gemini", "opencode", "antigravity"] as const;
export type McpClient = (typeof MCP_CLIENTS)[number];

export type McpLaunch =
    | { transport: "stdio"; command: string; args: string[]; env?: Record<string, string> }
    | { transport: "http"; url: string; tokenEnv?: string };

export interface ConfigSnippet {
    client: McpClient;
    format: "json" | "toml";
    /** Default file the snippet belongs in. */
    path: string;
    /** The entry, ready to print. */
    text: string;
}

export interface ConfigLocation {
    cwd: string;
    home: string;
    codexHome?: string;
    serverName?: string;
}

export const DEFAULT_SERVER_NAME = "opennan-studio";
const BEGIN = (name: string) => `# >>> ${name} (managed by opennan-studio mcp-config)`;
const END = (name: string) => `# <<< ${name}`;

function jsonEntry(client: McpClient, launch: McpLaunch): Record<string, unknown> {
    if (client === "opencode") return launch.transport === "stdio"
        ? { type: "local", command: [launch.command, ...launch.args], enabled: true, ...(launch.env ? { environment: launch.env } : {}) }
        : { type: "remote", url: launch.url, headers: { Authorization: `Bearer {env:${launch.tokenEnv ?? TOKEN_ENV}}` }, enabled: true };
    if (launch.transport === "stdio") {
        return client === "claude" ? { type: "stdio", command: launch.command, args: launch.args, env: launch.env ?? {} } : { command: launch.command, args: launch.args, ...(launch.env ? { env: launch.env } : {}) };
    }
    const authorization = `Bearer \${${launch.tokenEnv ?? TOKEN_ENV}}`;
    if (client === "antigravity") return { serverUrl: launch.url, headers: { Authorization: authorization } };
    return client === "claude"
        ? { type: "http", url: launch.url, headers: { Authorization: authorization } }
        : { httpUrl: launch.url, headers: { Authorization: authorization } };
}

function tomlEntry(name: string, launch: McpLaunch): string {
    const lines = [BEGIN(name), `[mcp_servers.${name}]`];
    if (launch.transport === "stdio") {
        lines.push(`command = ${JSON.stringify(launch.command)}`, `args = [${launch.args.map((a) => JSON.stringify(a)).join(", ")}]`);
        if (launch.env) {
            lines.push(`[mcp_servers.${name}.env]`);
            for (const [key, value] of Object.entries(launch.env)) lines.push(`${JSON.stringify(key)} = ${JSON.stringify(value)}`);
        }
    } else {
        lines.push(`url = ${JSON.stringify(launch.url)}`, `bearer_token_env_var = ${JSON.stringify(launch.tokenEnv ?? TOKEN_ENV)}`);
    }
    lines.push(END(name));
    return `${lines.join("\n")}\n`;
}

export function configPath(client: McpClient, location: ConfigLocation): string {
    if (client === "claude") return path.join(location.cwd, ".mcp.json");
    if (client === "gemini") return path.join(location.cwd, ".gemini", "settings.json");
    if (client === "opencode") return path.join(location.cwd, "opencode.json");
    if (client === "antigravity") return path.join(location.cwd, ".agents", "mcp_config.json");
    return path.join(location.codexHome ?? path.join(location.home, ".codex"), "config.toml");
}

export function buildMcpConfig(client: McpClient, launch: McpLaunch, location: ConfigLocation): ConfigSnippet {
    const name = location.serverName ?? DEFAULT_SERVER_NAME;
    const file = configPath(client, location);
    if (client === "codex") return { client, format: "toml", path: file, text: tomlEntry(name, launch) };
    const key = client === "opencode" ? "mcp" : "mcpServers";
    return { client, format: "json", path: file, text: `${JSON.stringify({ [key]: { [name]: jsonEntry(client, launch) } }, null, 2)}\n` };
}

/** Returns the config file content with this server's entry added or replaced. Other entries are kept. */
export function mergeMcpConfig(snippet: ConfigSnippet, existing: string | null, serverName = DEFAULT_SERVER_NAME): string {
    if (snippet.format === "json") {
        let doc: Record<string, unknown> = {};
        if (existing && existing.trim()) {
            try {
                doc = JSON.parse(existing);
            } catch {
                throw new Error(`${snippet.path} is not valid JSON; fix it or remove it first`);
            }
        }
        const key = snippet.client === "opencode" ? "mcp" : "mcpServers";
        const entry = JSON.parse(snippet.text)[key][serverName];
        const servers = (doc[key] && typeof doc[key] === "object" ? doc[key] : {}) as Record<string, unknown>;
        return `${JSON.stringify({ ...doc, [key]: { ...servers, [serverName]: entry } }, null, 2)}\n`;
    }
    const current = existing ?? "";
    const begin = current.indexOf(BEGIN(serverName));
    const endMarker = END(serverName);
    const end = current.indexOf(endMarker);
    const managed = begin >= 0 && end > begin;
    const before = managed ? current.slice(0, begin) : current;
    const after = managed ? current.slice(end + endMarker.length).replace(/^\n/, "") : "";
    if (definesTomlServer(`${before}\n${after}`, serverName)) {
        // A second definition would make Codex reject config.toml.
        throw new Error(`${snippet.path} already defines the ${serverName} MCP server outside the managed block; remove it so mcp-config can manage the entry`);
    }
    if (managed) return `${before}${snippet.text}${after}`;
    const separator = current.length === 0 || current.endsWith("\n\n") ? "" : current.endsWith("\n") ? "\n" : "\n\n";
    return `${current}${separator}${snippet.text}`;
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");

/**
 * True when the TOML text defines mcp_servers.<name> in any form: a table header
 * (bare or quoted key, with subtables like .env), a dotted key at the root, or a
 * key inside an [mcp_servers] table. Line-based; enough to avoid duplicate tables.
 */
export function definesTomlServer(toml: string, name: string): boolean {
    const key = `(?:${escapeRegExp(name)}|"${escapeRegExp(name)}"|'${escapeRegExp(name)}')`;
    const header = new RegExp(`^\\[\\[?\\s*mcp_servers\\s*\\.\\s*${key}\\s*[.\\]]`);
    const rootDotted = new RegExp(`^mcp_servers\\s*\\.\\s*${key}\\s*[.=]`);
    const inServersTable = new RegExp(`^${key}\\s*[.=]`);
    let table = "";
    for (const raw of toml.split("\n")) {
        const line = raw.trim();
        if (line.startsWith("#") || line.length === 0) continue;
        if (line.startsWith("[")) {
            if (header.test(line)) return true;
            table = line.replace(/\s+/g, "");
            continue;
        }
        if (table === "" && rootDotted.test(line)) return true;
        if (table === "[mcp_servers]" && inServersTable.test(line)) return true;
    }
    return false;
}
