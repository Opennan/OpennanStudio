import { useEffect, useRef, useState } from "react";
import type { McpInfo } from "../shared/bridge";
import { CHAT_PROFILES, type ChatAvailability, type ChatProfile, type ChatState } from "../shared/agent-chat";

const LABELS: Record<ChatProfile, string> = { claude: "Claude Code", codex: "Codex" };
const PROFILE_KEY = "opennan-studio:chat-profile";
const draftKey = (project: string, profile: ChatProfile) => `opennan-studio:chat-draft:${project}:${profile}`;
function read(storage: Storage | undefined, key: string): string {
    try { return storage?.getItem(key) ?? ""; } catch { return ""; }
}
function chatError(error: unknown): string {
    const message = error instanceof Error ? error.message : "Could not send. Check your CLI login and retry.";
    return message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "");
}
function write(storage: Storage | undefined, key: string, value: string): void {
    try { storage?.setItem(key, value); } catch { /* Storage is optional. */ }
}

export function externalMcpConfig(info: McpInfo, client: string): string {
    if (client === "opencode" && info.configs.opencode) return info.configs.opencode;
    if (client === "antigravity" && info.configs.antigravity) return info.configs.antigravity;
    if (client === "codex") return info.configs.codex;
    if (client === "gemini") return info.configs.gemini;
    if (client !== "opencode") return info.configs.claude;
    try {
        const entry = JSON.parse(info.configs.claude).mcpServers["opennan-studio"];
        return JSON.stringify({ mcp: { "opennan-studio": { type: "local", command: [entry.command, ...entry.args], enabled: true } } }, null, 2);
    } catch { return "Open a project to get its MCP connection configuration."; }
}

export function AgentChatPanel({ projectId, projectName }: { projectId: string; projectName: string }) {
    const bridge = window.opennan;
    const [profile, setProfile] = useState<ChatProfile>(() => read(window.localStorage, PROFILE_KEY) === "codex" ? "codex" : "claude");
    const [state, setState] = useState<ChatState | null>(null);
    const [editorReady, setEditorReady] = useState(false);
    const [available, setAvailable] = useState<ChatAvailability[] | null>(null);
    const [refreshing, setRefreshing] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [draft, setDraft] = useState(() => read(window.sessionStorage, draftKey(projectId, profile)));
    const [submitting, setSubmitting] = useState(false);
    const submittingRef = useRef(false);
    const list = useRef<HTMLDivElement>(null);
    const stick = useRef(true);
    const input = useRef<HTMLTextAreaElement>(null);
    const refresh = async () => {
        setRefreshing(true);
        try { setAvailable(await bridge.chat.availability()); }
        catch { setError("Could not check the installed CLIs. Try refreshing the connection."); }
        finally { setRefreshing(false); }
    };
    useEffect(() => { void refresh(); }, [bridge]);
    useEffect(() => {
        let alive = true;
        let timer: ReturnType<typeof setTimeout>;
        setEditorReady(false);
        const check = async () => {
            try {
                const info = await bridge.mcp.info();
                if (!alive) return;
                if (info.running && info.projectId === projectId) { setEditorReady(true); return; }
            } catch { /* The editor may still be attaching its session. */ }
            if (alive) timer = setTimeout(() => void check(), 250);
        };
        void check();
        return () => { alive = false; clearTimeout(timer); };
    }, [bridge, projectId]);
    useEffect(() => {
        let alive = true;
        let changed = false;
        setState(null);
        setError(null);
        setDraft(read(window.sessionStorage, draftKey(projectId, profile)));
        const unsubscribe = bridge.chat.onChanged((next) => {
            if (alive && next.projectId === projectId && next.profile === profile) { changed = true; setState(next); }
        });
        void bridge.chat.state(projectId, profile).then((next) => { if (alive && !changed) setState(next); }).catch(() => { if (alive) setError("Could not load this chat. Reopen the AI tab to retry."); });
        return () => { alive = false; unsubscribe(); };
    }, [bridge, projectId, profile]);
    useEffect(() => {
        if (stick.current && list.current) list.current.scrollTop = list.current.scrollHeight;
    }, [state]);
    const connection = available?.find((item) => item.profile === profile);
    const busy = Boolean(state?.running || submitting);
    const updateDraft = (value: string) => {
        setDraft(value);
        write(window.sessionStorage, draftKey(projectId, profile), value);
    };
    const send = async () => {
        if (!draft.trim() || draft.length > 12_000 || busy || submittingRef.current || !state || !editorReady) return;
        submittingRef.current = true;
        setSubmitting(true);
        setError(null);
        stick.current = true;
        try {
            await bridge.chat.send(projectId, profile, draft);
            updateDraft("");
            input.current?.focus();
        } catch (e) { setError(chatError(e)); }
        finally { submittingRef.current = false; setSubmitting(false); }
    };
    const reset = async () => {
        setError(null);
        try { await bridge.chat.reset(projectId, profile); }
        catch { setError("Could not start a new chat. Stop the current reply and try again."); }
    };
    const stop = async () => {
        try { await bridge.chat.stop(projectId, profile); }
        catch { setError("Could not stop the agent. Try again."); }
    };
    return (
        <section className="agent-chat" data-testid="agent-chat" aria-label="AI chat">
            <header className="agent-chat-head">
                <label className="sr-only" htmlFor="chat-agent">AI agent</label>
                <select id="chat-agent" className="input" value={profile} disabled={busy} onChange={(e) => {
                    const next = e.target.value as ChatProfile;
                    write(window.localStorage, PROFILE_KEY, next);
                    setProfile(next);
                }}>
                    {CHAT_PROFILES.map((id) => <option key={id} value={id}>{LABELS[id]}</option>)}
                </select>
                <button type="button" className="button ghost small" onClick={() => void reset()} disabled={busy || !state}>New chat</button>
            </header>
            <div className="agent-chat-connection">
                <p className="small" role="status">{refreshing ? "Checking CLI login…" : connection?.message ?? "Uses your CLI subscription login"}</p>
                <button type="button" className="button ghost small" onClick={() => void refresh()} disabled={refreshing || busy}>Refresh connection</button>
            </div>
            <div ref={list} className="agent-chat-messages" role="log" aria-label="Conversation" aria-live="polite" aria-relevant="additions text" onScroll={() => {
                const el = list.current;
                if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
            }}>
                {!state?.messages.length && (
                    <div className="agent-chat-empty">
                        <h2>Edit with your AI agent</h2>
                        <p>Chat about <strong>{projectName}</strong>. Your agent can inspect the timeline, add titles, trim clips and use editor tools through MCP.</p>
                        <p className="muted small">Sign in to {LABELS[profile]} on this computer with your own subscription. Your plan’s usage limits apply. Projects stay local; OpenNan supplies optional AI tools.</p>
                        <p className="small">First time? Run <code>{profile === "claude" ? "claude auth login" : "codex login"}</code> in your terminal, then refresh the connection.</p>
                    </div>
                )}
                {state?.messages.map((message) => <article key={message.id} className={`agent-chat-message agent-chat-${message.role}`}>
                    <span className="agent-chat-who">{message.role === "user" ? "You" : message.role === "tool" ? "Editor tool" : LABELS[profile]}</span>
                    <p>{message.text}</p>
                </article>)}
                {busy && <p className="muted small" role="status">{state?.stopping ? "Stopping…" : `${LABELS[profile]} is working…`}</p>}
            </div>
            {(error || state?.error) && <p className="agent-chat-error small" role="alert">{error || state?.error}</p>}
            <form className="agent-chat-composer" onSubmit={(e) => { e.preventDefault(); void send(); }}>
                <label className="sr-only" htmlFor="chat-message">Message your AI agent</label>
                <textarea id="chat-message" ref={input} className="input" rows={3} value={draft} disabled={!state || !editorReady} maxLength={12_000} placeholder={state && editorReady ? "Ask for an edit…" : "Connecting to the editor…"} onChange={(e) => updateDraft(e.target.value)} onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); }
                    e.stopPropagation();
                }} />
                <div className="agent-chat-send-row">
                    <span className="muted small">Shift+Enter for a new line</span>
                    {busy ? <button type="button" className="button small" disabled={state?.stopping || submitting} onClick={() => void stop()}>Stop</button>
                        : <button type="submit" className="button primary small" disabled={!draft.trim() || !state || !editorReady || !connection?.subscription}>Send</button>}
                </div>
            </form>
            <McpConnection projectId={projectId} />
        </section>
    );
}

function McpConnection({ projectId }: { projectId: string }) {
    const [info, setInfo] = useState<McpInfo | null>(null);
    const [client, setClient] = useState("claude");
    const [copied, setCopied] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const load = async () => {
        try { setInfo(await window.opennan.mcp.info()); setError(null); }
        catch { setError("Could not read the MCP connection. Try again."); }
    };
    const ready = info?.running && info.projectId === projectId;
    return <details className="agent-chat-mcp" onToggle={(e) => { if (e.currentTarget.open) void load(); }}>
        <summary>Connect another app with MCP</summary>
        <p className="muted small">Connect Claude Desktop, Antigravity, OpenCode or another MCP client to this timeline. Each app uses its own supported login.</p>
        <label className="small" htmlFor="mcp-client">MCP client</label>
        <select id="mcp-client" className="input" value={client} onChange={(e) => { setClient(e.target.value); setCopied(false); }}>
            <option value="claude">Claude Desktop / Claude Code</option>
            <option value="codex">Codex</option>
            <option value="antigravity">Antigravity</option>
            <option value="opencode">OpenCode</option>
            <option value="gemini">Gemini CLI</option>
            <option value="other">Other MCP client</option>
        </select>
        {ready ? <>
            <pre className="desktop-mcp-config" tabIndex={0} aria-label="MCP configuration">{externalMcpConfig(info, client)}</pre>
            <button type="button" className="button small" onClick={async () => {
                try { await navigator.clipboard.writeText(externalMcpConfig(info, client)); setCopied(true); }
                catch { setError("Copy was unavailable. Select and copy the configuration above."); }
            }}>{copied ? "Copied" : "Copy configuration"}</button>
            <p className="muted small">Merge this entry into your app’s MCP settings and reconnect it. Keep Studio and this project open while using the agent.</p>
        </> : <button type="button" className="button small" onClick={() => void load()}>Refresh MCP connection</button>}
        {error && <p role="alert" className="small">{error}</p>}
    </details>;
}
