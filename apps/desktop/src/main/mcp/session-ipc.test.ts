import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EVENTS, IPC } from "../../shared/ipc";
import type { IpcEventLike, IpcMainLike } from "../ipc/handle";
import { registerSessionIpc } from "./session-ipc";

const A = "3f2b8c1e-1d2a-4c3b-9e8f-0a1b2c3d4e5f";
const B = "4f2b8c1e-1d2a-4c3b-9e8f-0a1b2c3d4e5f";

describe("session IPC", () => {
    it("serves one project at a time and routes renderer answers", async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opennan-sipc-"));
        const handlers = new Map<string, (event: IpcEventLike, payload: unknown) => unknown>();
        const ipc: IpcMainLike = { handle: (channel, listener) => void handlers.set(channel, listener) };
        const top = { url: "opennan-app://app/" } as { url: string; top?: unknown };
        top.top = top;
        const invoke = async (channel: string, payload: unknown) => handlers.get(channel)!({ senderFrame: top }, payload);
        const host = { open: vi.fn(async (session: { projectId: string }) => ({ running: true, url: "u", port: 1, projectId: session.projectId })), close: vi.fn(async () => undefined) };
        const sent: Array<[string, { id: number; method: string }]> = [];
        const sessions = registerSessionIpc(ipc, {
            host: host as never, exporter: {} as never, mediaStore: {} as never,
            projectDir: (id) => path.join(dir, id), send: (channel, payload) => sent.push([channel, payload as never]),
        });
        await invoke(IPC.sessionAttach, { projectId: A });
        expect(fs.statSync(path.join(dir, A)).isDirectory()).toBe(true);
        expect(host.open).toHaveBeenCalledWith(expect.objectContaining({ projectId: A }));
        const pending = sessions.current()!.rpc.call("describeTimeline");
        const [channel, request] = sent[0];
        expect(channel).toBe(EVENTS.sessionRequest);
        await invoke(IPC.sessionResponse, { id: request.id, ok: true, value: "empty" });
        await expect(pending).resolves.toBe("empty");

        const orphan = expect(sessions.current()!.rpc.call("snapshot")).rejects.toThrow("opened another project");
        await invoke(IPC.sessionAttach, { projectId: B });
        await orphan;
        expect(sessions.current()?.projectId).toBe(B);
        await invoke(IPC.sessionDetach, { projectId: A });
        expect(sessions.current()?.projectId).toBe(B);
        await invoke(IPC.sessionDetach, { projectId: B });
        expect(sessions.current()).toBeNull();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it("keeps an agent's \"Allow for this project during this session\" for the app's run, across reopening, and reads the setting each time (9c.1)", async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opennan-sipc-"));
        const handlers = new Map<string, (event: IpcEventLike, payload: unknown) => unknown>();
        const ipc: IpcMainLike = { handle: (channel, listener) => void handlers.set(channel, listener) };
        const top = { url: "opennan-app://app/" } as { url: string; top?: unknown };
        top.top = top;
        const invoke = async (channel: string, payload: unknown) => handlers.get(channel)!({ senderFrame: top }, payload);
        let opened: { cloud: { shares: { create(options: object): Promise<unknown> } } } | null = null;
        const host = { open: vi.fn(async (session: never) => { opened = session; return { running: true, url: "u", port: 1, projectId: "x" }; }), close: vi.fn(async () => undefined) };
        const link = { id: "shr_0123456789abcdef01234567", url: "https://opennan.com/s/abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKL", status: "active", allowDownload: false, expiresAt: 1, createdAt: 1, revokedAt: null, views: 0, lastViewedAt: null };
        let withoutAsking = false;
        const methods: string[] = [];
        let answer: (request: { id: number; method: string }) => unknown = () => undefined;
        registerSessionIpc(ipc, {
            host: host as never, exporter: {} as never, mediaStore: {} as never, projectDir: (id) => path.join(dir, id), shareWithoutAsking: () => withoutAsking,
            send: (_channel, payload) => {
                const request = payload as { id: number; method: string };
                methods.push(request.method);
                queueMicrotask(() => void invoke(IPC.sessionResponse, { id: request.id, ok: true, value: answer(request) }));
            },
        });
        answer = (request) => (request.method === "confirmShare" ? "allow-session" : link);
        await invoke(IPC.sessionAttach, { projectId: "cloud-a" });
        await opened!.cloud.shares.create({});
        expect(methods).toEqual(["confirmShare", "cloud.shareCreate"]);
        // Reopened in the same run: not asked again.
        await invoke(IPC.sessionAttach, { projectId: "cloud-b" });
        await invoke(IPC.sessionAttach, { projectId: "cloud-a" });
        methods.length = 0;
        await opened!.cloud.shares.create({});
        expect(methods).toEqual(["cloud.shareCreate"]);
        // Another project is asked; with the setting on, nothing is asked.
        await invoke(IPC.sessionAttach, { projectId: "cloud-b" });
        methods.length = 0;
        answer = (request) => (request.method === "confirmShare" ? "deny" : link);
        await expect(opened!.cloud.shares.create({})).rejects.toThrow(/declined/);
        expect(methods).toEqual(["confirmShare"]);
        withoutAsking = true;
        methods.length = 0;
        await opened!.cloud.shares.create({});
        expect(methods).toEqual(["cloud.shareCreate"]);
        fs.rmSync(dir, { recursive: true, force: true });
    });
});
