// Terminal sessions on node-pty. The renderer chooses a profile id; main builds the command (profiles.ts),
// so no command line, path, or environment ever comes from the renderer.
import { randomUUID } from "node:crypto";
import { applyWrites, type TerminalLaunch } from "./profiles";

export interface PtyLike {
    onData(listener: (data: string) => void): unknown;
    onExit(listener: (event: { exitCode: number }) => void): unknown;
    write(data: string): void;
    resize(cols: number, rows: number): void;
    kill(): void;
}

export type PtySpawn = (file: string, args: string[] | string, options: { name: string; cols: number; rows: number; cwd: string; env: Record<string, string> }) => PtyLike;

export interface PtyManager {
    start(launch: TerminalLaunch, cols: number, rows: number): string;
    input(terminalId: string, data: string): void;
    resize(terminalId: string, cols: number, rows: number): void;
    kill(terminalId: string): void;
    killAll(): void;
    count(): number;
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, Math.round(value)));

export function createPtyManager({ spawn, send, maxSessions = 8 }: { spawn: PtySpawn; send(channel: "data" | "exit", payload: { terminalId: string; data?: string; code?: number }): void; maxSessions?: number }): PtyManager {
    const sessions = new Map<string, PtyLike>();
    return {
        start(launch, cols, rows) {
            if (sessions.size >= maxSessions) throw new Error(`At most ${maxSessions} terminals can run at once`);
            applyWrites(launch.writes, launch.cwd);
            const terminalId = randomUUID();
            const pty = spawn(launch.file, launch.args, { name: "xterm-256color", cols: clamp(cols, 2, 1000), rows: clamp(rows, 2, 500), cwd: launch.cwd, env: launch.env });
            sessions.set(terminalId, pty);
            pty.onData((data) => send("data", { terminalId, data }));
            pty.onExit(({ exitCode }) => {
                sessions.delete(terminalId);
                send("exit", { terminalId, code: exitCode });
            });
            return terminalId;
        },
        input(terminalId, data) {
            sessions.get(terminalId)?.write(data);
        },
        resize(terminalId, cols, rows) {
            sessions.get(terminalId)?.resize(clamp(cols, 2, 1000), clamp(rows, 2, 500));
        },
        kill(terminalId) {
            const pty = sessions.get(terminalId);
            sessions.delete(terminalId);
            pty?.kill();
        },
        killAll() {
            for (const pty of sessions.values()) pty.kill();
            sessions.clear();
        },
        count: () => sessions.size,
    };
}
