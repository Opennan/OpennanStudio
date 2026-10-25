// The renderer offers its open project to the MCP host (session:attach) and withdraws it (session:detach,
// page reload, window close). One project is served at a time; switching projects restarts the HTTP server
// on the same port with the same token (tool-call groups are per StudioSession object).
import fs from "node:fs";
import type { PriceRegistry, StudioExporter } from "@opennan/mcp";
import type { RenderedFrame } from "@opennan/timeline-core";
import { EVENTS, IPC } from "../../shared/ipc";
import { handle, type IpcMainLike } from "../ipc/handle";
import type { MediaStore } from "../store/media-store";
import { createDesktopSession } from "./desktop-session";
import type { McpHost } from "./mcp-host";
import { createRendererRpc, type RendererRpc, type SessionResponse } from "./renderer-rpc";

export interface SessionIpcOptions {
    host: McpHost;
    exporter: StudioExporter;
    mediaStore: Pick<MediaStore, "putBlob">;
    projectDir(projectId: string): string;
    send(channel: string, payload: unknown): void;
    capturePage?(): Promise<RenderedFrame>;
    /** Main's provider registry: estimate_cost and list_voices for agents. */
    providers?: PriceRegistry;
    /** The user's captions routing pick (see DesktopSessionOptions.captionsRoute). */
    captionsRoute?(): string | null;
}

export interface SessionIpc {
    /** The attached project's RPC (export effects ask it for the effect catalog). */
    current(): { projectId: string; rpc: RendererRpc } | null;
    detachAll(reason: string): Promise<void>;
}

export function registerSessionIpc(ipc: IpcMainLike, options: SessionIpcOptions): SessionIpc {
    let current: { projectId: string; rpc: RendererRpc } | null = null;
    const detachAll = async (reason: string) => {
        const was = current;
        current = null;
        was?.rpc.close(reason);
        await options.host.close();
    };
    handle(ipc, IPC.sessionAttach, async ({ projectId }) => {
        await detachAll("The editor opened another project");
        const dir = options.projectDir(projectId);
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        const rpc = createRendererRpc({ send: (request) => options.send(EVENTS.sessionRequest, request) });
        current = { projectId, rpc };
        const session = await createDesktopSession({ projectId, rpc, exporter: options.exporter, mediaStore: options.mediaStore, projectDir: dir, capturePage: options.capturePage, ...(options.providers ? { providers: options.providers } : {}), ...(options.captionsRoute ? { captionsRoute: options.captionsRoute } : {}) });
        await options.host.open(session);
        return { ok: true as const };
    });
    handle(ipc, IPC.sessionDetach, async ({ projectId }) => {
        if (current?.projectId === projectId) await detachAll("The project was closed in the editor");
        return { ok: true as const };
    });
    handle(ipc, IPC.sessionResponse, (response) => {
        current?.rpc.receive(response as SessionResponse);
    });
    return { current: () => current, detachAll };
}
