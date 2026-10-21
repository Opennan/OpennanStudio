// The terminal panel (spec §7.2): a bottom drawer with one xterm per session. Starting a profile asks main,
// which writes that CLI's MCP config into the project folder and runs it there; the renderer only sends the
// profile id, keystrokes, and sizes.
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import type { DesktopBridge } from "../shared/bridge";
import { TERMINAL_PROFILES, type TerminalProfileId } from "../shared/settings";

export const PROFILE_LABELS: Record<TerminalProfileId, string> = {
    claude: "Claude Code", codex: "Codex CLI", gemini: "Gemini CLI", shell: "Shell", custom: "Custom command",
};

function TerminalView({ bridge, terminalId }: { bridge: DesktopBridge; terminalId: string }) {
    const host = useRef<HTMLDivElement>(null);
    useEffect(() => {
        const element = host.current;
        if (!element) return;
        const term = new Terminal({ fontSize: 12, cursorBlink: true, convertEol: false, theme: { background: "#0a0a0b" } });
        const fit = new FitAddon();
        term.loadAddon(fit);
        term.open(element);
        const resize = () => {
            try {
                fit.fit();
                bridge.terminal.resize(terminalId, term.cols, term.rows);
            } catch {
                // hidden or zero-size: nothing to fit
            }
        };
        resize();
        const input = term.onData((data) => bridge.terminal.input(terminalId, data));
        const stopData = bridge.terminal.onData((id, data) => {
            if (id === terminalId) term.write(data);
        });
        const stopExit = bridge.terminal.onExit((id, code) => {
            if (id === terminalId) term.write(`\r\n[process exited with code ${code}]\r\n`);
        });
        const observer = new ResizeObserver(resize);
        observer.observe(element);
        term.focus();
        return () => {
            observer.disconnect();
            input.dispose();
            stopData();
            stopExit();
            term.dispose();
        };
    }, [bridge, terminalId]);
    return <div ref={host} className="desktop-terminal-view" data-testid="terminal-view" />;
}

export function TerminalDock({ bridge, projectId }: { bridge: DesktopBridge; projectId: string }) {
    const [open, setOpen] = useState(false);
    const [profile, setProfile] = useState<TerminalProfileId>("shell");
    const [sessions, setSessions] = useState<Array<{ id: string; label: string }>>([]);
    const [active, setActive] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        void bridge.settings.get().then((settings) => setProfile(settings.terminalDefaultProfile)).catch(() => undefined);
    }, [bridge]);
    useEffect(() => () => {
        for (const session of sessionsRef.current) bridge.terminal.kill(session.id);
    }, [bridge]);
    const sessionsRef = useRef(sessions);
    sessionsRef.current = sessions;

    const start = async () => {
        setError(null);
        try {
            const id = await bridge.terminal.start(projectId, profile, 100, 24);
            setSessions((list) => [...list, { id, label: PROFILE_LABELS[profile] }]);
            setActive(id);
        } catch (failure) {
            setError(failure instanceof Error ? failure.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(failure));
        }
    };
    const close = (id: string) => {
        bridge.terminal.kill(id);
        setSessions((list) => list.filter((s) => s.id !== id));
        if (active === id) setActive(null);
    };

    return (
        <section className={`desktop-terminal${open ? " open" : ""}`} aria-label="Terminal">
            <header className="desktop-terminal-bar">
                <button type="button" className="button ghost small" aria-expanded={open} onClick={() => setOpen(!open)}>Terminal</button>
                {open && (
                    <>
                        <label className="desktop-terminal-profile">
                            <span className="sr-only">Profile</span>
                            <select aria-label="Terminal profile" value={profile} onChange={(event) => setProfile(event.target.value as TerminalProfileId)}>
                                {TERMINAL_PROFILES.map((id) => <option key={id} value={id}>{PROFILE_LABELS[id]}</option>)}
                            </select>
                        </label>
                        <button type="button" className="button primary small" onClick={() => void start()}>Start</button>
                        <div className="desktop-terminal-tabs" role="tablist">
                            {sessions.map((session) => (
                                <span key={session.id} className="desktop-terminal-tab" data-active={active === session.id || undefined}>
                                    <button type="button" role="tab" aria-selected={active === session.id} onClick={() => setActive(session.id)}>{session.label}</button>
                                    <button type="button" aria-label={`Close ${session.label}`} onClick={() => close(session.id)}>×</button>
                                </span>
                            ))}
                        </div>
                        {error && <span role="alert" className="error-text small">{error}</span>}
                    </>
                )}
            </header>
            {open && (
                <div className="desktop-terminal-body">
                    {sessions.length === 0 && <p className="muted small">Pick a profile and press Start. Agent CLIs start in this project's folder, connected to the editor through MCP.</p>}
                    {sessions.map((session) => (
                        <div key={session.id} hidden={active !== session.id} className="desktop-terminal-pane">
                            <TerminalView bridge={bridge} terminalId={session.id} />
                        </div>
                    ))}
                </div>
            )}
        </section>
    );
}
