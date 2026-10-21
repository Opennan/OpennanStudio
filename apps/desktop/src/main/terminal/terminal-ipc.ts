// Terminal channels: start by profile id for a project, input, resize, kill.
import fs from "node:fs";
import { IPC } from "../../shared/ipc";
import type { TerminalProfileId } from "../../shared/settings";
import { handle, type IpcMainLike } from "../ipc/handle";
import type { PtyManager } from "./pty-manager";
import type { TerminalLaunch } from "./profiles";

export interface TerminalIpcOptions {
    manager: PtyManager;
    projectDir(projectId: string): string;
    launchFor(profile: TerminalProfileId, projectDir: string): TerminalLaunch;
}

export function registerTerminalIpc(ipc: IpcMainLike, { manager, projectDir, launchFor }: TerminalIpcOptions): void {
    handle(ipc, IPC.terminalStart, ({ projectId, profile, cols, rows }) => {
        const dir = projectDir(projectId);
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        return { terminalId: manager.start(launchFor(profile, dir), cols, rows) };
    });
    handle(ipc, IPC.terminalInput, ({ terminalId, data }) => manager.input(terminalId, data));
    handle(ipc, IPC.terminalResize, ({ terminalId, cols, rows }) => manager.resize(terminalId, cols, rows));
    handle(ipc, IPC.terminalKill, ({ terminalId }) => manager.kill(terminalId));
}
