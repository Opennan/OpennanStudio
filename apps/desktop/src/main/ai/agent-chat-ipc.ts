import { IPC } from "../../shared/channels";
import { handle, type IpcMainLike } from "../ipc/handle";
import type { createAgentChat } from "./agent-chat";

export function registerAgentChatIpc(ipc: IpcMainLike, chat: ReturnType<typeof createAgentChat>): void {
    handle(ipc, IPC.chatAvailability, () => chat.availability());
    handle(ipc, IPC.chatState, ({ projectId, profile }) => chat.state(projectId, profile));
    handle(ipc, IPC.chatSend, ({ projectId, profile, message }) => chat.send(projectId, profile, message));
    handle(ipc, IPC.chatStop, ({ projectId, profile }) => chat.stop(projectId, profile));
    handle(ipc, IPC.chatReset, ({ projectId, profile }) => chat.reset(projectId, profile));
}
