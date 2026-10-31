// Account and provider IPC: sender check and schemas first; no answer ever carries a key; real services behind.
import { startFakeOpenNan, type FakeOpenNan } from "@opennan/provider-opennan/testing";
import { IPC } from "../../shared/ipc";
import type { IpcEventLike, IpcMainLike } from "../ipc/handle";
import { openDatabase } from "../store/database";
import { createSecretStore } from "../store/secrets";
import { createProviderHost } from "../providers/provider-host";
import { registerProvidersIpc } from "../providers/providers-ipc";
import { createAccountService } from "./account-service";
import { registerAccountIpc } from "./account-ipc";

let fake: FakeOpenNan;
beforeAll(async () => {
    fake = await startFakeOpenNan({ intervalSeconds: 1 });
});
afterAll(() => fake.close());

const PROJECT = "11111111-2222-4333-8444-555555555555";

function setup() {
    const handlers = new Map<string, (event: IpcEventLike, payload: unknown) => unknown>();
    const ipc: IpcMainLike = { handle: (channel, listener) => void handlers.set(channel, listener) };
    const top = { url: "opennan-app://app/" } as { url: string; top?: unknown };
    top.top = top;
    const sent: unknown[] = [];
    const opened: string[] = [];
    const secrets = createSecretStore({
        db: openDatabase(":memory:"), platform: "darwin",
        safeStorage: { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(s, "utf8"), decryptString: (b) => b.toString("utf8") },
    });
    const account = createAccountService({
        apiBase: fake.url, consoleBase: fake.url, secrets, deviceName: "Mac", focusWindow: () => undefined,
        openExternal: (url) => void opened.push(url), send: (_c, payload) => void sent.push(payload),
    });
    const host = createProviderHost({
        session: account.session, allowLoopbackDownloads: true, send: (_c, payload) => void sent.push(payload),
        mediaStore: { importBytes: async ({ name, mimeType, bytes }) => ({ id: "x", url: "opennan-local://media/3f2b8c1e-1d2a-4c3b-9e8f-0a1b2c3d4e5f", name, mimeType, size: bytes.byteLength }) },
    });
    registerAccountIpc(ipc, { account });
    registerProvidersIpc(ipc, { host });
    const answers: unknown[] = [];
    const invoke = async (channel: string, payload: unknown = {}, frame: unknown = top) => {
        const answer = await handlers.get(channel)!({ senderFrame: frame as never }, payload);
        answers.push(answer);
        return answer;
    };
    return { invoke, account, sent, opened, answers, handlers };
}

describe("account and provider IPC", () => {
    it("runs sign-in, account actions, and a provider job without a key in any answer or event", async () => {
        const { invoke, account, sent, opened, answers } = setup();
        await account.ready;
        expect(await invoke(IPC.accountStatus)).toEqual({ state: "signed-out" });
        await invoke(IPC.accountStart, { signup: true });
        expect(opened).toHaveLength(1);
        await invoke(IPC.accountReopen);
        expect(opened).toHaveLength(2);
        fake.approve();
        await vi.waitFor(() => expect(account.status().state).toBe("signed-in"), { timeout: 5000 });
        await invoke(IPC.accountRefresh);
        await invoke(IPC.accountOpenConsole, { page: "usage" });
        expect(opened.at(-1)).toBe(`${fake.url}/console/usage`);
        expect(await invoke(IPC.providersList)).toEqual([expect.objectContaining({ id: "opennan", name: "OpenNan" })]);
        expect(await invoke(IPC.providersModels, { providerId: "opennan", capability: "video.text-to-video" })).toEqual([expect.objectContaining({ id: "kling-3", label: "Kling 3", default: true }), expect.objectContaining({ id: "seedance-2" }), expect.objectContaining({ id: "seedance-2-mini", qualities: ["720p", "1080p"] }), expect.objectContaining({ id: "kling-o3" })]);
        expect(await invoke(IPC.providersVoices, { providerId: "opennan" })).toEqual(expect.arrayContaining([expect.objectContaining({ id: expect.any(String), name: expect.any(String) })]));
        expect(await invoke(IPC.providersPrice, { providerId: "opennan", request: { capability: "audio.isolate-voice", input: {}, units: { seconds: 10 } } })).toMatchObject({ kind: "estimate" });
        const { jobId } = (await invoke(IPC.providersRun, { providerId: "opennan", capability: "image.generate", input: { description: "a cat" }, projectId: PROJECT })) as { jobId: string };
        await vi.waitFor(() => expect(sent.some((e) => (e as { jobId?: string; status?: string }).jobId === jobId && (e as { status: string }).status === "succeeded")).toBe(true), { timeout: 5000 });
        await invoke(IPC.accountSwitch);
        expect(account.status().state).toBe("waiting");
        await invoke(IPC.accountCancel);
        await invoke(IPC.accountConnectKey, { key: fake.mintKey() });
        expect(account.status().state).toBe("signed-in");
        await invoke(IPC.accountSignOut);
        for (const value of [...answers, ...sent]) expect(JSON.stringify(value ?? null)).not.toMatch(/sk-/);
    });

    it("refuses foreign senders and bad payloads before anything runs", async () => {
        const { invoke, opened } = setup();
        const foreign = { url: "https://evil.example/" } as { url: string; top?: unknown };
        foreign.top = foreign;
        await expect(invoke(IPC.accountStart, {}, foreign)).rejects.toThrow("Untrusted IPC sender");
        await expect(invoke(IPC.accountOpenConsole, { page: "../../etc" })).rejects.toThrow(/Invalid/);
        await expect(invoke(IPC.accountOpenConsole, { page: "billing", url: "https://evil" })).rejects.toThrow(/Invalid/);
        await expect(invoke(IPC.accountConnectKey, { key: "not-a-key" })).rejects.toThrow(/Invalid/);
        await expect(invoke(IPC.accountStart, { signup: "yes" })).rejects.toThrow(/Invalid/);
        await expect(invoke(IPC.providersRun, { providerId: "evil", capability: "image.generate", input: {}, projectId: PROJECT })).rejects.toThrow(/Invalid/);
        await expect(invoke(IPC.providersRun, { providerId: "opennan", capability: "image.everything", input: {}, projectId: PROJECT })).rejects.toThrow(/Invalid/);
        await expect(invoke(IPC.providersRun, { providerId: "opennan", capability: "image.generate", input: { d: "x".repeat(70_000) }, projectId: PROJECT })).rejects.toThrow(/Invalid/);
        await expect(invoke(IPC.providersCancel, { jobId: "../x" })).rejects.toThrow(/Invalid/);
        await expect(invoke(IPC.providersTranscribe, { providerId: "opennan", audio: { kind: "media", url: "https://cdn.example/a.wav" } })).rejects.toThrow(/Invalid/);
        await expect(invoke(IPC.providersTranscribe, { providerId: "opennan", audio: { kind: "media", url: "file:///etc/passwd" } })).rejects.toThrow(/Invalid/);
        await expect(invoke(IPC.providersPrice, { providerId: "opennan", request: { capability: "audio.isolate-voice", input: {}, units: { seconds: -1 } } })).rejects.toThrow(/Invalid/);
        await expect(invoke(IPC.providersPrice, { providerId: "opennan", request: { capability: "audio.isolate-voice", input: {}, units: { dollars: 1 } } })).rejects.toThrow(/Invalid/);
        await expect(invoke(IPC.providersVoices, { providerId: "elsewhere" })).rejects.toThrow(/Invalid/);
        expect(opened).toEqual([]);
    });
});
