import { IPC, importBytesSchema, projectStateSchema, PAYLOADS } from "../../shared/ipc";
import { handle, isTrustedSender, type IpcEventLike, type IpcMainLike } from "./handle";

const ID = "3f2b8c1e-1d2a-4c3b-9e8f-0a1b2c3d4e5f";

function fakeIpc() {
    const handlers = new Map<string, (event: IpcEventLike, payload: unknown) => unknown>();
    const ipc: IpcMainLike = { handle: (channel, listener) => void handlers.set(channel, listener) };
    const top = { url: "opennan-app://app/index.html" } as { url: string; top?: unknown };
    top.top = top;
    const invoke = (channel: string, payload: unknown, frame: unknown = top) => handlers.get(channel)!({ senderFrame: frame as never }, payload);
    return { ipc, invoke, top };
}

describe("isTrustedSender", () => {
    it("accepts only the app's top frame", () => {
        const top = { url: "opennan-app://app/index.html#/p/x" } as { url: string; top?: unknown };
        top.top = top;
        expect(isTrustedSender(top)).toBe(true);
        expect(isTrustedSender({ url: "https://evil.test/", top: undefined })).toBe(false);
        expect(isTrustedSender({ url: "file:///Users/x/index.html" })).toBe(false);
        expect(isTrustedSender({ url: "opennan-app://app/index.html", top: {} })).toBe(false);
        expect(isTrustedSender({ url: "not a url" })).toBe(false);
        expect(isTrustedSender(null)).toBe(false);
    });
});

describe("handle", () => {
    it("parses the payload and passes the stripped value", async () => {
        const { ipc, invoke } = fakeIpc();
        const run = vi.fn(async (payload) => payload);
        handle(ipc, IPC.persistenceLoad, run);
        await expect(invoke(IPC.persistenceLoad, { projectId: ID })).resolves.toEqual({ projectId: ID });
    });

    it("refuses untrusted senders before parsing or running", async () => {
        const { ipc, invoke } = fakeIpc();
        const run = vi.fn();
        handle(ipc, IPC.persistenceLoad, run);
        await expect(invoke(IPC.persistenceLoad, { projectId: ID }, { url: "https://evil.test/" })).rejects.toThrow("Untrusted IPC sender");
        await expect(invoke(IPC.persistenceLoad, { projectId: ID }, { url: "opennan-app://app/", top: {} })).rejects.toThrow("Untrusted IPC sender");
        expect(run).not.toHaveBeenCalled();
    });

    it("refuses invalid payloads without echoing them", async () => {
        const { ipc, invoke } = fakeIpc();
        const run = vi.fn();
        handle(ipc, IPC.persistenceLoad, run);
        const error = await (invoke(IPC.persistenceLoad, { projectId: "../../etc/passwd-secret-value" }) as Promise<unknown>).catch((e: Error) => e);
        expect(String(error)).toContain("Invalid opennan:persistence:load payload: projectId");
        expect(String(error)).not.toContain("secret-value");
        await expect(invoke(IPC.persistenceLoad, { projectId: ID, extra: 1 })).rejects.toThrow("Invalid");
        expect(run).not.toHaveBeenCalled();
    });
});

describe("payload schemas", () => {
    const ok = (channel: keyof typeof PAYLOADS, payload: unknown) => PAYLOADS[channel].safeParse(payload).success;

    it("accepts the documented shapes", () => {
        expect(ok(IPC.mediaImportPath, { projectId: ID, path: "/Users/me/clip.mp4", kind: "video" })).toBe(true);
        expect(ok(IPC.terminalStart, { projectId: ID, profile: "claude", cols: 80, rows: 24 })).toBe(true);
        expect(ok(IPC.secretsSet, { name: "OPENAI_API_KEY", value: "sk-1" })).toBe(true);
        expect(ok(IPC.exportStart, { options: { resolution: "4k" }, snapshot: { tracks: [], clips: [], scenes: [], project: null } })).toBe(true);
        expect(ok(IPC.sessionResponse, { id: 1, ok: false, error: "boom" })).toBe(true);
        expect(ok(IPC.persistenceSave, { projectId: ID, state: { meta: { id: ID, name: "x", aspectRatio: "16:9" }, tracks: [], clips: [], scenes: [] } })).toBe(true);
    });

    it.each([
        [IPC.persistenceLoad, { projectId: "../x" }], [IPC.persistenceLoad, { projectId: "" }], [IPC.persistenceLoad, { projectId: ID.toUpperCase() }],
        [IPC.mediaImportPath, { projectId: ID, path: "/x.mp4", kind: "exe" }], [IPC.mediaImportPath, { projectId: ID, path: "/x\0.mp4", kind: "video" }],
        [IPC.terminalStart, { projectId: ID, profile: "rm -rf /", cols: 80, rows: 24 }], [IPC.terminalStart, { projectId: ID, profile: "shell", cols: 1e9, rows: 24 }],
        [IPC.terminalStart, { projectId: ID, profile: "shell", cols: 80, rows: 24, command: "sh" }],
        [IPC.secretsSet, { name: "PATH", value: "x" }], [IPC.settingsUpdate, { evil: 1 }], [IPC.settingsUpdate, { mcpPort: 22 }],
        [IPC.exportStart, { options: { resolution: "8k" }, snapshot: { tracks: [], clips: [], scenes: [] } }],
        [IPC.exportStart, { options: { output: "/etc/x" }, snapshot: { tracks: [], clips: [], scenes: [] } }],
        [IPC.persistenceSave, { projectId: ID, state: { meta: { id: "x", name: "x" }, tracks: [], clips: [], scenes: [] } }],
    ])("%s refuses %j", (channel, payload) => {
        expect(ok(channel as keyof typeof PAYLOADS, payload)).toBe(false);
    });

    it("bounds bytes and state size", () => {
        expect(importBytesSchema(4).safeParse({ projectId: ID, name: "a.png", mimeType: "image/png", kind: "image", bytes: new Uint8Array(5) }).success).toBe(false);
        expect(importBytesSchema(4).safeParse({ projectId: ID, name: "a.png", mimeType: "image/png", kind: "image", bytes: new Uint8Array(3) }).success).toBe(true);
        const big = { meta: { id: ID, name: "x" }, tracks: [], clips: [{ text: "x".repeat(200) }], scenes: [] };
        expect(projectStateSchema(100).safeParse(big).success).toBe(false);
        expect(projectStateSchema(10_000).safeParse(big).success).toBe(true);
    });
});
