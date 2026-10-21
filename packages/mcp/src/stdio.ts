// stdio host: the MCP protocol owns stdout, so nothing in this path may log to it.
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createStudioMcpServer, type StudioMcpServerOptions } from "./server";
import type { StudioSession } from "./session";

export async function serveStdio(session: StudioSession, options: StudioMcpServerOptions = {}): Promise<{ server: Server; close(): Promise<void> }> {
    const server = createStudioMcpServer(session, options);
    await server.connect(new StdioServerTransport());
    return { server, close: () => server.close() };
}
