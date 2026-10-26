import { chatArgs, createAgentChat, subscriptionEnv } from "./agent-chat";
import { IPC, PAYLOADS } from "../../shared/ipc";

const bridge = { transport: "stdio" as const, command: "/Apps/Studio", args: ["--mcp-bridge", "--token-file", "/private/token"] };

describe("subscription CLI boundary", () => {
    it("does not inject API credentials into subscription sessions", () => {
        const env = subscriptionEnv({ PATH: "/bin", HOME: "/user", ANTHROPIC_API_KEY: "secret", ANTHROPIC_AUTH_TOKEN: "secret", OPENAI_API_KEY: "secret", CODEX_API_KEY: "secret", CLAUDE_CODE_OAUTH_TOKEN: "secret", ELECTRON_RUN_AS_NODE: "1", OPENNAN_API_KEY: "secret" });
        expect(env.HOME).toBe("/user");
        expect(env.PATH).toBe("/bin");
        expect(Object.keys(env).some((key) => /API_KEY|AUTH_TOKEN|OAUTH_TOKEN|ELECTRON_RUN_AS_NODE/.test(key))).toBe(false);
    });

    it("connects through the file-based MCP bridge and confines Claude to editor tools", () => {
        const args = chatArgs("claude", bridge, "conversation");
        expect(args).toContain("--resume");
        expect(args).not.toContain("--dangerously-skip-permissions");
        expect(args.slice(args.indexOf("--tools"), args.indexOf("--tools") + 2)).toEqual(["--tools", ""]);
        const config = JSON.parse(args[args.indexOf("--mcp-config") + 1]);
        expect(config.mcpServers["opennan-studio"]).toEqual({ command: bridge.command, args: bridge.args });
    });

    it("forces Codex ChatGPT login and keeps sandboxing on, including resumed turns", () => {
        const args = chatArgs("codex", bridge, "conversation");
        expect(args).toContain('forced_login_method="chatgpt"');
        expect(args).toContain('sandbox_mode="read-only"');
        expect(args).toContain("resume");
        expect(args.at(-1)).toBe("-");
        expect(args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
    });

    it("rejects unbound projects and invalid renderer requests", async () => {
        const chat = createAgentChat({ projectDir: () => "/unused", currentProject: () => null, bridge: () => bridge, changed: () => undefined });
        await expect(chat.send("project", "claude", "Hello")).rejects.toThrow("Open this project");
        const projectId = "3f2b8c1e-1d2a-4c3b-9e8f-0a1b2c3d4e5f";
        expect(PAYLOADS[IPC.chatSend].safeParse({ projectId, profile: "codex", message: "Hello" }).success).toBe(true);
        for (const request of [{ projectId: "../../elsewhere", profile: "claude", message: "Hi" }, { projectId, profile: "shell", message: "Hi" }, { projectId, profile: "codex", message: " " }, { projectId, profile: "codex", message: "a".repeat(12_001) }, { projectId, profile: "claude", message: "Hi", command: "custom" }]) expect(PAYLOADS[IPC.chatSend].safeParse(request).success).toBe(false);
    });
});
