// Runs the user's unmodified CLI. No provider keys are injected and no OAuth tokens are read by Studio.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { promisify } from "node:util";
import { DEFAULT_SERVER_NAME, type McpLaunch } from "@opennan/mcp";
import { redactKeys } from "@opennan/provider-opennan";
import { CHAT_PROFILES, type ChatAvailability, type ChatProfile, type ChatState } from "../../shared/agent-chat";
import { posixLaunch } from "../terminal/shell-command";
import { terminalEnv } from "../terminal/profiles";

const exec = promisify(execFile);
const MAX_HISTORY = 200;
const MAX_TEXT = 64_000;
const MAX_LINE = 2 * 1024 * 1024;
const INSTRUCTIONS = "You are helping edit the open OpennanStudio timeline. Use the opennan-studio MCP tools to inspect and edit it. Read the timeline before editing. Projects are local; OpenNan offers AI tools only, not cloud projects. Do not create cloud projects or use project/director endpoints. Use the editor's undo history. Do not run shell commands. Run paid generation tools only when the user requests generation. Explain your changes briefly.";

export function subscriptionEnv(env: NodeJS.ProcessEnv): Record<string, string> {
    const clean = terminalEnv({ env, profile: "shell", projectDir: "", secret: () => null });
    for (const key of Object.keys(clean)) {
        if (/^(ANTHROPIC_(API_KEY|AUTH_TOKEN|BASE_URL)|OPENAI_(API_KEY|BASE_URL)|CODEX_API_KEY|CLAUDE_CODE_(OAUTH_TOKEN|USE_.*)|CLAUDECODE)$/.test(key)) delete clean[key];
    }
    return clean;
}

/** Argument arrays only; prompts go to stdin and never through the shell parser. */
export function chatArgs(profile: ChatProfile, bridge: Extract<McpLaunch, { transport: "stdio" }>, sessionId?: string): string[] {
    if (profile === "claude") return [
        "-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
        "--strict-mcp-config", "--mcp-config", JSON.stringify({ mcpServers: { [DEFAULT_SERVER_NAME]: { command: bridge.command, args: bridge.args, ...(bridge.env ? { env: bridge.env } : {}) } } }),
        "--tools", "", "--allowedTools", `mcp__${DEFAULT_SERVER_NAME}`,
        "--append-system-prompt", INSTRUCTIONS, ...(sessionId ? ["--resume", sessionId] : []),
    ];
    const name = `mcp_servers.${DEFAULT_SERVER_NAME}`;
    return [
        "-c", "forced_login_method=\"chatgpt\"", "-c", "approval_policy=\"never\"", "-c", "sandbox_mode=\"read-only\"",
        "-c", `${name}.command=${JSON.stringify(bridge.command)}`, "-c", `${name}.args=${JSON.stringify(bridge.args)}`,
        ...Object.entries(bridge.env ?? {}).flatMap(([key, value]) => ["-c", `${name}.env.${key}=${JSON.stringify(value)}`]),
        "exec", ...(sessionId ? ["resume", sessionId] : ["--color", "never"]), "--json", "--skip-git-repo-check", "-",
    ];
}

interface Conversation {
    state: ChatState;
    sessionId?: string;
    child?: ChildProcessWithoutNullStreams;
    killTimer?: ReturnType<typeof setTimeout>;
}
export interface AgentChatOptions {
    projectDir(projectId: string): string;
    currentProject(): string | null;
    bridge(): Extract<McpLaunch, { transport: "stdio" }>;
    changed(state: ChatState): void;
    env?: NodeJS.ProcessEnv;
    /** Explicit binaries for isolated integration tests; never supplied by renderer IPC. */
    commands?: Partial<Record<ChatProfile, string>>;
}

export function createAgentChat(options: AgentChatOptions) {
    const env = subscriptionEnv(options.env ?? process.env);
    const conversations = new Map<string, Conversation>();
    const launch = (profile: ChatProfile, args: string[]) => {
        const command = options.commands?.[profile] ?? profile;
        // The login shell supplies the PATH of Finder-launched apps. Every argument is positional.
        if (process.platform !== "win32") return posixLaunch(env.SHELL && path.isAbsolute(env.SHELL) ? env.SHELL : process.platform === "darwin" ? "/bin/zsh" : "/bin/bash", [command, ...args]);
        // Windows native CLI installs provide .exe launchers; no cmd.exe or shell interpolation.
        return { file: options.commands?.[profile] ?? `${profile}.exe`, args };
    };
    const status = async (profile: ChatProfile): Promise<ChatAvailability> => {
        const command = launch(profile, profile === "claude" ? ["auth", "status", "--json"] : ["login", "status"]);
        try {
            const { stdout, stderr } = await exec(command.file, command.args, { env, timeout: 15_000, maxBuffer: 64_000, windowsHide: true });
            let subscription = false;
            if (profile === "claude") {
                const auth = JSON.parse(stdout);
                subscription = auth.loggedIn === true && auth.authMethod === "claude.ai";
            } else subscription = /logged in using chatgpt/i.test(`${stdout}\n${stderr}`);
            return { profile, installed: true, subscription, message: subscription ? "Signed in with your subscription" : `Sign in with your subscription using ${profile === "claude" ? "claude auth login" : "codex login"}.` };
        } catch (error) {
            const code = (error as { code?: unknown }).code;
            const missing = code === "ENOENT" || code === 127;
            return { profile, installed: !missing, subscription: false, message: missing ? `Install ${profile === "claude" ? "Claude Code" : "Codex CLI"} to use it here.` : `Sign in using ${profile === "claude" ? "claude auth login" : "codex login"}, then refresh.` };
        }
    };
    const get = (projectId: string, profile: ChatProfile): Conversation => {
        const key = `${projectId}:${profile}`;
        let conversation = conversations.get(key);
        if (!conversation) {
            conversation = { state: { projectId, profile, messages: [], running: false, stopping: false, error: null } };
            const file = path.join(options.projectDir(projectId), `chat-${profile}.json`);
            try {
                const stat = fs.lstatSync(file);
                if (stat.isFile() && stat.size < MAX_LINE * 8) {
                    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
                    if (Array.isArray(saved.messages)) conversation.state.messages = saved.messages.filter((m: { id?: unknown; role?: unknown; text?: unknown }) => typeof m?.id === "string" && ["user", "assistant", "tool"].includes(String(m.role)) && typeof m.text === "string").slice(-MAX_HISTORY).map((m: { id: string; role: "user"; text: string }) => ({ id: m.id.slice(0, 100), role: m.role, text: m.text.slice(0, MAX_TEXT) }));
                    if (typeof saved.sessionId === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(saved.sessionId)) conversation.sessionId = saved.sessionId;
                }
            } catch { /* No saved conversation, or an unreadable file: start empty. */ }
            conversations.set(key, conversation);
        }
        return conversation;
    };
    const save = (c: Conversation) => {
        const dir = options.projectDir(c.state.projectId);
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        const file = path.join(dir, `chat-${c.state.profile}.json`);
        const temp = `${file}.${process.pid}.tmp`;
        fs.rmSync(temp, { force: true });
        fs.writeFileSync(temp, JSON.stringify({ messages: c.state.messages, sessionId: c.sessionId }), { mode: 0o600, flag: "wx" });
        fs.renameSync(temp, file);
    };
    const notify = (c: Conversation) => options.changed(structuredClone(c.state));
    const add = (c: Conversation, role: "user" | "assistant" | "tool", text: string, id = randomUUID()) => {
        const existing = c.state.messages.find((m) => m.id === id);
        const clean = redactKeys(text).slice(0, MAX_TEXT);
        if (existing) existing.text = clean;
        else c.state.messages.push({ id, role, text: clean });
        c.state.messages = c.state.messages.slice(-MAX_HISTORY);
    };
    const stop = (c: Conversation) => {
        const child = c.child;
        if (!child || c.state.stopping) return;
        c.state.stopping = true;
        const kill = (signal: NodeJS.Signals) => {
            try {
                if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
                else child.kill(signal);
            } catch { /* Process already exited. */ }
        };
        kill("SIGTERM");
        c.killTimer = setTimeout(() => kill("SIGKILL"), 3000);
        c.killTimer.unref();
        notify(c);
    };
    return {
        availability: () => Promise.all(CHAT_PROFILES.map(status)),
        state: (projectId: string, profile: ChatProfile) => structuredClone(get(projectId, profile).state),
        async send(projectId: string, profile: ChatProfile, message: string) {
            if (options.currentProject() !== projectId) throw new Error("Open this project in the editor before chatting.");
            const c = get(projectId, profile);
            if (c.state.running) throw new Error("Wait for the current reply or stop it first.");
            if (!message.trim() || message.length > 12_000) throw new Error("Enter a message of at most 12,000 characters.");
            // Reserve before awaiting authentication so two sends cannot start two agents.
            c.state.running = true;
            c.state.stopping = false;
            c.state.error = null;
            notify(c);
            try {
                const available = await status(profile);
                if (!available.subscription) throw new Error(available.message);
                if (c.state.stopping || options.currentProject() !== projectId) throw new Error("The project was closed before the agent started.");
                const command = launch(profile, chatArgs(profile, options.bridge(), c.sessionId));
                const dir = options.projectDir(projectId);
                fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
                add(c, "user", message);
                save(c);
                const child = spawn(command.file, command.args, { cwd: dir, env, windowsHide: true, detached: process.platform !== "win32", stdio: "pipe" });
                c.child = child;
                const turnId = randomUUID();
                let partial = "";
                let assistantId = turnId;
                let buffer = "";
                let stderr = "";
                let completed = false;
                const fail = (text: string) => { c.state.error = redactKeys(text).slice(0, 2000); };
                const event = (e: any) => {
                    if (e.type === "thread.started" && typeof e.thread_id === "string") c.sessionId = e.thread_id;
                    if (e.type === "system" && typeof e.session_id === "string") c.sessionId = e.session_id;
                    if (e.type === "stream_event" && e.event?.type === "message_start") {
                        assistantId = `${turnId}:${e.event.message?.id ?? randomUUID()}`;
                        partial = "";
                    }
                    if (e.type === "stream_event" && e.event?.type === "content_block_delta" && e.event.delta?.type === "text_delta") {
                        partial = (partial + e.event.delta.text).slice(0, MAX_TEXT);
                        add(c, "assistant", partial, assistantId);
                    }
                    if (e.type === "assistant") {
                        const blocks = Array.isArray(e.message?.content) ? e.message.content : [];
                        const text = blocks.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
                        if (text) { add(c, "assistant", text, e.message?.id ? `${turnId}:${e.message.id}` : assistantId); partial = text; }
                        for (const b of blocks) if (b.type === "tool_use") add(c, "tool", `Using ${b.name}`, `${turnId}:${b.id}`);
                    }
                    if (e.type === "item.completed" && e.item?.type === "agent_message") add(c, "assistant", e.item.text, `${turnId}:${e.item.id}`);
                    if (e.type === "item.started" && e.item?.type === "mcp_tool_call") add(c, "tool", `Using ${e.item.tool}`, `${turnId}:${e.item.id}`);
                    if (e.type === "item.completed" && e.item?.type === "mcp_tool_call") add(c, "tool", `${e.item.error ? "Failed" : "Finished"}: ${e.item.tool}`, `${turnId}:${e.item.id}`);
                    if (e.type === "result") {
                        completed = !e.is_error;
                        if (e.is_error) fail(e.result || e.errors?.join("\n") || "The CLI could not finish. Check its login and usage limit.");
                        else if (e.result && !partial) add(c, "assistant", e.result, turnId);
                        if (Array.isArray(e.permission_denials) && e.permission_denials.length) fail("The CLI needs permission for this tool. Open its terminal to approve the action, or start a new chat and try an editor tool.");
                    }
                    if (e.type === "turn.completed") completed = true;
                    if (e.type === "error" || e.type === "turn.failed") fail(e.message || e.error?.message || "The agent could not finish this turn.");
                    notify(c);
                };
                child.stdout.setEncoding("utf8");
                child.stdout.on("data", (chunk: string) => {
                    buffer += chunk;
                    if (buffer.length > MAX_LINE) { fail("The CLI response was too large. Start a new chat and try a smaller request."); stop(c); return; }
                    let newline: number;
                    while ((newline = buffer.indexOf("\n")) >= 0) {
                        const line = buffer.slice(0, newline);
                        buffer = buffer.slice(newline + 1);
                        try { event(JSON.parse(line)); } catch { /* CLI diagnostics are not chat messages. */ }
                    }
                });
                child.stderr.setEncoding("utf8");
                child.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-4000); });
                child.on("error", () => { fail(`Could not start ${profile}. Check that the CLI is installed and signed in.`); });
                child.on("close", (code) => {
                    if (buffer.trim()) { try { event(JSON.parse(buffer)); } catch { /* incomplete final line */ } }
                    clearTimeout(c.killTimer);
                    c.child = undefined;
                    if (c.state.stopping) add(c, "tool", "Stopped. Edits already made remain in the timeline; use Undo to revert them.");
                    else if (!c.state.error && (code !== 0 || !completed)) fail(stderr || `The CLI exited before completing its reply (code ${code}). Check its login and usage limit, then retry.`);
                    c.state.running = false;
                    c.state.stopping = false;
                    try { save(c); } catch { fail("Could not save the chat on this device."); }
                    notify(c);
                });
                child.stdin.on("error", () => { /* Early CLI failures are reported by close. */ });
                child.stdin.end(profile === "codex" ? `${INSTRUCTIONS}\n\n${message}` : message);
                notify(c);
            } catch (error) {
                c.state.running = false;
                c.state.stopping = false;
                c.state.error = error instanceof Error ? error.message : "Could not start the agent.";
                notify(c);
                throw new Error(c.state.error);
            }
        },
        stop(projectId: string, profile: ChatProfile) {
            const c = get(projectId, profile);
            if (c.state.running && !c.child) c.state.stopping = true;
            else stop(c);
        },
        reset(projectId: string, profile: ChatProfile) {
            const c = get(projectId, profile);
            if (c.state.running) throw new Error("Stop the reply before starting a new chat.");
            c.state.messages = [];
            c.sessionId = undefined;
            c.state.error = null;
            save(c);
            notify(c);
        },
        stopAll() {
            for (const c of conversations.values()) {
                if (c.state.running && !c.child) c.state.stopping = true;
                else stop(c);
            }
        },
    };
}
