import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as nodePty from "node-pty";
import { createPtyManager, type PtyLike, type PtySpawn } from "./pty-manager";
import type { TerminalLaunch } from "./profiles";
import { posixLaunch } from "./shell-command";

function fakeSpawn() {
    const ptys: Array<PtyLike & { emitData(d: string): void; emitExit(c: number): void; written: string[]; killed: boolean; size: [number, number] }> = [];
    const calls: Array<Parameters<PtySpawn>> = [];
    const spawn: PtySpawn = (file, args, options) => {
        calls.push([file, args, options]);
        let onData: (d: string) => void = () => undefined;
        let onExit: (e: { exitCode: number }) => void = () => undefined;
        const pty = {
            written: [] as string[], killed: false, size: [options.cols, options.rows] as [number, number],
            onData: (l: (d: string) => void) => { onData = l; }, onExit: (l: (e: { exitCode: number }) => void) => { onExit = l; },
            write(d: string) { this.written.push(d); }, resize(c: number, r: number) { this.size = [c, r]; }, kill() { this.killed = true; },
            emitData: (d: string) => onData(d), emitExit: (c: number) => onExit({ exitCode: c }),
        };
        ptys.push(pty);
        return pty;
    };
    return { spawn, ptys, calls };
}

describe("pty manager", () => {
    let dir: string;
    let launch: TerminalLaunch;
    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "opennan-pty-"));
        launch = { file: "/bin/zsh", args: ["-l"], cwd: dir, env: { TERM: "xterm-256color" }, writes: [{ path: path.join(dir, ".mcp.json"), content: "{}" }] };
    });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    it("starts, forwards data, takes input, resizes, and forgets on exit", () => {
        const { spawn, ptys, calls } = fakeSpawn();
        const send = vi.fn();
        const manager = createPtyManager({ spawn, send });
        const id = manager.start(launch, 80, 24);
        expect(fs.readFileSync(path.join(dir, ".mcp.json"), "utf8")).toBe("{}");
        expect(calls[0]).toEqual(["/bin/zsh", ["-l"], { name: "xterm-256color", cols: 80, rows: 24, cwd: dir, env: { TERM: "xterm-256color" } }]);
        ptys[0].emitData("hi");
        expect(send).toHaveBeenCalledWith("data", { terminalId: id, data: "hi" });
        manager.input(id, "ls\r");
        manager.input("unknown", "x");
        expect(ptys[0].written).toEqual(["ls\r"]);
        manager.resize(id, 5000, 1);
        expect(ptys[0].size).toEqual([1000, 2]);
        ptys[0].emitExit(3);
        expect(send).toHaveBeenCalledWith("exit", { terminalId: id, code: 3 });
        expect(manager.count()).toBe(0);
    });

    it("caps sessions and kills them all", () => {
        const { spawn, ptys } = fakeSpawn();
        const manager = createPtyManager({ spawn, send: vi.fn(), maxSessions: 2 });
        manager.start({ ...launch, writes: [] }, 80, 24);
        const second = manager.start({ ...launch, writes: [] }, 80, 24);
        expect(() => manager.start({ ...launch, writes: [] }, 80, 24)).toThrow("At most 2");
        manager.kill(second);
        expect(ptys[1].killed).toBe(true);
        manager.killAll();
        expect(ptys[0].killed).toBe(true);
        expect(manager.count()).toBe(0);
    });

    it("runs a real pty", async () => {
        const output: string[] = [];
        let done!: () => void;
        const exited = new Promise<void>((resolve) => { done = resolve; });
        const manager = createPtyManager({
            spawn: nodePty.spawn as unknown as PtySpawn,
            send: (channel, payload) => (channel === "data" ? output.push(payload.data!) : done()),
        });
        const real = process.platform === "win32"
            ? { file: "cmd.exe", args: ["/d", "/c", "echo hi-from-pty"] }
            : posixLaunch("/bin/sh", ["echo", "hi-from-pty"]);
        manager.start({ ...real, args: real.args.filter((a) => a !== "-l"), cwd: dir, env: { PATH: process.env.PATH ?? "" }, writes: [] }, 80, 24);
        await exited;
        expect(output.join("")).toContain("hi-from-pty");
    });
});
