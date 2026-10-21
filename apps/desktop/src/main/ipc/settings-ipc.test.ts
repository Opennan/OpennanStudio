import { IPC } from "../../shared/ipc";
import { openDatabase } from "../store/database";
import { createSecretStore } from "../store/secrets";
import { createSettingsStore } from "../store/settings";
import type { IpcEventLike, IpcMainLike } from "./handle";
import { registerSettingsIpc } from "./settings-ipc";

describe("settings IPC", () => {
    it("never returns secret values and refuses unknown settings", async () => {
        const handlers = new Map<string, (event: IpcEventLike, payload: unknown) => unknown>();
        const ipc: IpcMainLike = { handle: (channel, listener) => void handlers.set(channel, listener) };
        const top = { url: "opennan-app://app/" } as { url: string; top?: unknown };
        top.top = top;
        const invoke = (channel: string, payload: unknown = {}) => handlers.get(channel)!({ senderFrame: top }, payload);
        const db = openDatabase(":memory:");
        const safeStorage = { isEncryptionAvailable: () => true, encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString() };
        registerSettingsIpc(ipc, { settings: createSettingsStore(db), secrets: createSecretStore({ db, safeStorage, platform: "darwin" }) });
        await invoke(IPC.secretsSet, { name: "OPENAI_API_KEY", value: "sk-secret" });
        const listed = await invoke(IPC.secretsList);
        expect(JSON.stringify(listed)).not.toContain("sk-secret");
        expect(listed).toContainEqual({ name: "OPENAI_API_KEY", set: true });
        await expect(invoke(IPC.settingsUpdate, { evil: true })).rejects.toThrow("Invalid");
        await expect(invoke(IPC.settingsUpdate, { mcpPort: 4400 })).resolves.toMatchObject({ mcpPort: 4400 });
        db.close();
    });
});
