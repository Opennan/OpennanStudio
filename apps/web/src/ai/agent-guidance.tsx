export function AgentGuidance() {
    return <div className="agent-guidance" data-testid="director-local" style={{ padding: 16, overflow: "auto" }}>
        <h2 style={{ fontSize: 16 }}>Chat with your AI subscription</h2>
        <p>Use the desktop app to chat with Claude Code or Codex through your own CLI login. Agents edit the local timeline through MCP.</p>
        <p className="muted small">A browser cannot start installed CLIs. OpenNan provides optional AI tools; your project stays on this device.</p>
    </div>;
}
