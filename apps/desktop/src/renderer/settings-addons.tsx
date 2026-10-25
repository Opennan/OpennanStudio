// Desktop settings (StudioUi.SettingsAddons): API keys (write-only), the terminal's custom command and default
// profile, and the MCP server's address with the config each CLI gets. Secret values never come back.
import { useCallback, useEffect, useState } from "react";
import type { DesktopBridge, McpInfo } from "../shared/bridge";
import { PROVIDER_SECRET_NAMES, TERMINAL_PROFILES, type DesktopSettings, type SecretName, type SecretStatus } from "../shared/settings";
import { PROFILE_LABELS } from "./terminal-panel";

const KEY_LABELS: Record<SecretName, string> = {
    ANTHROPIC_API_KEY: "Anthropic (Claude Code)", OPENAI_API_KEY: "OpenAI (Codex CLI)", GEMINI_API_KEY: "Google (Gemini CLI)", OPENNAN_API_KEY: "OpenNan",
    FAL_KEY: "fal.ai",
};

const message = (error: unknown) => (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");

function SecretRow({ bridge, status, onChange }: { bridge: DesktopBridge; status: SecretStatus; onChange(): void }) {
    const [value, setValue] = useState("");
    const [error, setError] = useState<string | null>(null);
    const save = async () => {
        setError(null);
        try {
            await bridge.secrets.set(status.name, value.trim());
            setValue("");
            onChange();
        } catch (failure) {
            setError(message(failure));
        }
    };
    return (
        <li className="provider-row">
            <div>
                <h3>{KEY_LABELS[status.name]}</h3>
                <p className="muted small">{status.name} · <span data-testid={`secret-${status.name}`}>{status.set ? "Set" : "Not set"}</span></p>
                {error && <p role="alert" className="error-text small">{error}</p>}
            </div>
            <div className="desktop-secret-actions">
                <input type="password" aria-label={`${KEY_LABELS[status.name]} key`} value={value} autoComplete="off" onChange={(event) => setValue(event.target.value)} />
                <button type="button" className="button small" disabled={!value.trim()} onClick={() => void save()}>Save</button>
                {status.set && <button type="button" className="button ghost small" onClick={() => void bridge.secrets.remove(status.name).then(onChange)}>Remove</button>}
            </div>
        </li>
    );
}

export function SettingsAddonsView({ bridge }: { bridge: DesktopBridge }) {
    const [secrets, setSecrets] = useState<SecretStatus[]>([]);
    const [settings, setSettings] = useState<DesktopSettings | null>(null);
    const [command, setCommand] = useState("");
    const [mcp, setMcp] = useState<McpInfo | null>(null);
    const refresh = useCallback(() => {
        // Provider keys (fal.ai) live in Settings → AI providers above; this list is the terminal CLIs' keys.
        void bridge.secrets.list().then((list) => setSecrets(list.filter((s) => !PROVIDER_SECRET_NAMES.includes(s.name))));
        void bridge.mcp.info().then(setMcp);
    }, [bridge]);
    useEffect(() => {
        refresh();
        void bridge.settings.get().then((next) => {
            setSettings(next);
            setCommand(next.terminalCustomCommand);
        });
    }, [bridge, refresh]);
    const update = async (patch: Partial<DesktopSettings>) => setSettings(await bridge.settings.update(patch));

    return (
        <section className="desktop-settings" aria-label="Desktop">
            <h2>API keys</h2>
            <p className="muted small">Kept encrypted by the operating system. Each terminal profile gets only its own key.</p>
            <ul className="provider-list">{secrets.map((status) => <SecretRow key={status.name} bridge={bridge} status={status} onChange={refresh} />)}</ul>

            <h2>Terminal</h2>
            {settings && (
                <div className="desktop-settings-fields">
                    <label>
                        Default profile
                        <select value={settings.terminalDefaultProfile} onChange={(event) => void update({ terminalDefaultProfile: event.target.value as DesktopSettings["terminalDefaultProfile"] })}>
                            {TERMINAL_PROFILES.map((id) => <option key={id} value={id}>{PROFILE_LABELS[id]}</option>)}
                        </select>
                    </label>
                    <label>
                        Custom command
                        <input aria-label="Custom command" value={command} placeholder="aider --model sonnet" onChange={(event) => setCommand(event.target.value)} />
                    </label>
                    <button type="button" className="button small" onClick={() => void update({ terminalCustomCommand: command })}>Save command</button>
                    <p className="muted small">Arguments are split like a shell would, but nothing is expanded: no variables, globs, pipes, or chaining.</p>
                </div>
            )}

            <h2>MCP server</h2>
            {mcp && (
                <div className="desktop-mcp">
                    <p className="muted small">
                        {mcp.running ? `Serving the open project at ${mcp.url}` : "Starts when a project is open in the editor."} The access token is in {mcp.tokenFile}.
                    </p>
                    {(["claude", "codex", "gemini"] as const).map((client) => (
                        <details key={client}>
                            <summary>{PROFILE_LABELS[client]} config</summary>
                            <pre className="desktop-mcp-config">{mcp.configs[client]}</pre>
                        </details>
                    ))}
                </div>
            )}
        </section>
    );
}

export function SettingsAddons() {
    return <SettingsAddonsView bridge={window.opennan} />;
}
