// An MCP SDK client connected to createStudioMcpServer over an in-memory transport.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createStudioMcpServer, type StudioMcpServerOptions } from "../server";
import type { StudioSession } from "../session";

export async function connectInMemory(session: StudioSession, options?: StudioMcpServerOptions): Promise<{ client: Client; close(): Promise<void> }> {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const server = createStudioMcpServer(session, options);
    await server.connect(serverSide);
    const client = new Client({ name: "fixture-client", version: "0.0.0" });
    await client.connect(clientSide);
    return {
        client,
        async close() {
            await client.close();
            await server.close();
        },
    };
}
