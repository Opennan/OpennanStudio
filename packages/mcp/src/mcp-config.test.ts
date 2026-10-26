import { buildMcpConfig, mergeMcpConfig } from "./mcp-config";

const where = { cwd: "/work/film", home: "/home/ana" };
const stdio = { transport: "stdio" as const, command: "/usr/bin/node", args: ["/opt/studio/cli.js", "mcp", "serve", "--project", "/work/film/film.opennan.json"] };
const httpLaunch = { transport: "http" as const, url: "http://127.0.0.1:4319/mcp" };

describe("buildMcpConfig", () => {
    it("writes OpenCode entries using a command array and preserves other provider settings", () => {
        const snippet = buildMcpConfig("opencode", stdio, where);
        expect(snippet.path).toBe("/work/film/opencode.json");
        const entry = JSON.parse(snippet.text).mcp["opennan-studio"];
        expect(entry).toEqual({ type: "local", command: [stdio.command, ...stdio.args], enabled: true });
        const merged = JSON.parse(mergeMcpConfig(snippet, JSON.stringify({ model: "openai/default", mcp: { other: { type: "local", command: ["other"] } } })));
        expect(merged.model).toBe("openai/default");
        expect(merged.mcp.other.command).toEqual(["other"]);
        expect(merged.mcp["opennan-studio"]).toEqual(entry);
        expect(JSON.parse(buildMcpConfig("opencode", httpLaunch, where).text).mcp["opennan-studio"].headers.Authorization).toBe("Bearer {env:OPENNAN_STUDIO_MCP_TOKEN}");
    });

    it("writes Antigravity workspace configs and uses its HTTP serverUrl field", () => {
        const snippet = buildMcpConfig("antigravity", stdio, where);
        expect(snippet.path).toBe("/work/film/.agents/mcp_config.json");
        expect(JSON.parse(snippet.text).mcpServers["opennan-studio"]).toEqual({ command: stdio.command, args: stdio.args });
        expect(JSON.parse(buildMcpConfig("antigravity", httpLaunch, where).text).mcpServers["opennan-studio"].serverUrl).toBe(httpLaunch.url);
    });
    it("writes a Claude Code .mcp.json entry", () => {
        const snippet = buildMcpConfig("claude", stdio, where);
        expect(snippet.path).toBe("/work/film/.mcp.json");
        expect(JSON.parse(snippet.text)).toEqual({ mcpServers: { "opennan-studio": { type: "stdio", command: "/usr/bin/node", args: stdio.args, env: {} } } });
        expect(JSON.parse(buildMcpConfig("claude", httpLaunch, where).text).mcpServers["opennan-studio"]).toEqual({
            type: "http", url: "http://127.0.0.1:4319/mcp", headers: { Authorization: "Bearer ${OPENNAN_STUDIO_MCP_TOKEN}" },
        });
    });

    it("writes a Gemini CLI settings entry", () => {
        const snippet = buildMcpConfig("gemini", httpLaunch, where);
        expect(snippet.path).toBe("/work/film/.gemini/settings.json");
        expect(JSON.parse(snippet.text).mcpServers["opennan-studio"]).toEqual({
            httpUrl: "http://127.0.0.1:4319/mcp", headers: { Authorization: "Bearer ${OPENNAN_STUDIO_MCP_TOKEN}" },
        });
        expect(JSON.parse(buildMcpConfig("gemini", stdio, where).text).mcpServers["opennan-studio"]).toEqual({ command: "/usr/bin/node", args: stdio.args });
    });

    it("writes a Codex CLI config.toml table", () => {
        const snippet = buildMcpConfig("codex", stdio, where);
        expect(snippet.path).toBe("/home/ana/.codex/config.toml");
        expect(snippet.text).toBe([
            "# >>> opennan-studio (managed by opennan-studio mcp-config)",
            "[mcp_servers.opennan-studio]",
            "command = \"/usr/bin/node\"",
            "args = [\"/opt/studio/cli.js\", \"mcp\", \"serve\", \"--project\", \"/work/film/film.opennan.json\"]",
            "# <<< opennan-studio",
            "",
        ].join("\n"));
        expect(buildMcpConfig("codex", httpLaunch, { ...where, codexHome: "/cx" })).toMatchObject({
            path: "/cx/config.toml",
            text: expect.stringContaining("url = \"http://127.0.0.1:4319/mcp\"\nbearer_token_env_var = \"OPENNAN_STUDIO_MCP_TOKEN\""),
        });
    });
});

describe("mergeMcpConfig", () => {
    it("keeps other JSON servers and replaces ours", () => {
        const snippet = buildMcpConfig("claude", stdio, where);
        const existing = JSON.stringify({ mcpServers: { other: { command: "x" }, "opennan-studio": { command: "old" } }, extra: true });
        expect(JSON.parse(mergeMcpConfig(snippet, existing))).toEqual({
            mcpServers: { other: { command: "x" }, "opennan-studio": JSON.parse(snippet.text).mcpServers["opennan-studio"] },
            extra: true,
        });
        expect(() => mergeMcpConfig(snippet, "{nope")).toThrow(/is not valid JSON/);
    });

    it("appends or replaces the managed TOML block only", () => {
        const first = buildMcpConfig("codex", stdio, where);
        const merged = mergeMcpConfig(first, "model = \"o3\"\n");
        expect(merged).toBe(`model = "o3"\n\n${first.text}`);
        const second = buildMcpConfig("codex", httpLaunch, where);
        expect(mergeMcpConfig(second, `${merged}[other]\nx = 1\n`)).toBe(`model = "o3"\n\n${second.text}[other]\nx = 1\n`);
        expect(() => mergeMcpConfig(first, "[mcp_servers.opennan-studio]\ncommand = \"x\"\n")).toThrow(/already defines/);
    });

    it("refuses an unmanaged opennan-studio entry in every TOML form", () => {
        const first = buildMcpConfig("codex", stdio, where);
        for (const existing of [
            "[mcp_servers.\"opennan-studio\"]\ncommand = \"x\"\n",
            "[ mcp_servers . 'opennan-studio' ]\ncommand = \"x\"\n",
            "[mcp_servers.opennan-studio.env]\nA = \"1\"\n",
            "mcp_servers.opennan-studio.command = \"x\"\n",
            "[mcp_servers]\nopennan-studio = { command = \"x\" }\n",
            "[mcp_servers]\n\"opennan-studio\".command = \"x\"\n",
        ]) {
            expect(() => mergeMcpConfig(first, existing), existing).toThrow(/already defines/);
        }
        // An unmanaged entry next to the managed block is refused as well.
        expect(() => mergeMcpConfig(first, `${first.text}[mcp_servers.opennan-studio.env]\nA = "1"\n`)).toThrow(/already defines/);
        expect(mergeMcpConfig(first, "[mcp_servers.opennan-studio-old]\ncommand = \"x\"\n")).toContain(first.text);
    });
});
