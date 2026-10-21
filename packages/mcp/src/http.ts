// Streamable HTTP host bound to 127.0.0.1 with a per-session bearer token.
// One MCP Server per MCP session; all of them share one StudioSession.
import { randomUUID } from "node:crypto";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { bearerMatches, createSessionToken, isAllowedHost, isAllowedOrigin, isValidToken } from "./auth";
import { createStudioMcpServer, type StudioMcpServerOptions } from "./server";
import type { StudioSession } from "./session";

export const DEFAULT_HTTP_PORT = 4319;
export const LOOPBACK_HOST = "127.0.0.1";
export const MCP_PATH = "/mcp";

export interface HttpServerOptions {
    /** Default 4319; 0 picks a free port. A busy port is an error, never a fallback. */
    port?: number;
    /** Default: a new random token. */
    token?: string;
    maxBodyBytes?: number;
    /** Open MCP sessions allowed at once (default 32); more get 503. */
    maxSessions?: number;
    /** A session with no open request for this long is closed (default 30 minutes). An open GET event stream counts as a request. */
    idleTimeoutMs?: number;
    server?: StudioMcpServerOptions;
}

export interface StudioHttpServer {
    url: string;
    /** The bound address, always 127.0.0.1. */
    address: string;
    port: number;
    token: string;
    sessionCount(): number;
    close(): Promise<void>;
}

class HttpError extends Error {
    constructor(readonly status: number, message: string) {
        super(message);
    }
}

function sendError(res: ServerResponse, status: number, message: string, headers: Record<string, string> = {}): void {
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }));
}

async function readJson(req: IncomingMessage, maxBytes: number): Promise<unknown> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
        size += (chunk as Buffer).length;
        if (size > maxBytes) throw new HttpError(413, "Request body too large");
        chunks.push(chunk as Buffer);
    }
    try {
        return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
        throw new HttpError(400, "Request body is not JSON");
    }
}

export async function startHttpServer(session: StudioSession, options: HttpServerOptions = {}): Promise<StudioHttpServer> {
    const token = options.token ?? createSessionToken();
    if (!isValidToken(token)) throw new Error("The MCP token must be at least 24 URL-safe characters");
    const maxBodyBytes = options.maxBodyBytes ?? 8 * 1024 * 1024;
    const maxSessions = options.maxSessions ?? 32;
    const idleTimeoutMs = options.idleTimeoutMs ?? 30 * 60_000;
    // `open` counts the session's requests in flight, including a client's long-lived GET event stream.
    const sessions = new Map<string, { transport: StreamableHTTPServerTransport; server: Server; open: number; timer?: NodeJS.Timeout }>();
    let port = 0;
    /** Initialize requests admitted but not yet registered as sessions; they count against maxSessions. */
    let pendingSessions = 0;

    async function closeSession(id: string): Promise<void> {
        const entry = sessions.get(id);
        if (!entry) return;
        sessions.delete(id);
        clearTimeout(entry.timer);
        await entry.transport.close();
        await entry.server.close();
    }

    /** A request of the session started: no idle timer while any request (or event stream) is open. */
    function requestStarted(id: string): void {
        const entry = sessions.get(id);
        if (!entry) return;
        entry.open += 1;
        clearTimeout(entry.timer);
    }

    /** A request of the session ended; the idle timer starts when none is left open. */
    function requestEnded(id: string): void {
        const entry = sessions.get(id);
        if (!entry) return;
        entry.open = Math.max(0, entry.open - 1);
        if (entry.open > 0) return;
        clearTimeout(entry.timer);
        entry.timer = setTimeout(() => {
            void closeSession(id);
        }, idleTimeoutMs);
        entry.timer.unref();
    }

    async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
        if (!isAllowedHost(req.headers.host, port) || !isAllowedOrigin(req.headers.origin, port)) {
            sendError(res, 403, "Forbidden host or origin");
            return;
        }
        if (new URL(req.url ?? "/", `http://${LOOPBACK_HOST}`).pathname !== MCP_PATH) {
            sendError(res, 404, "Not found");
            return;
        }
        if (!bearerMatches(req.headers.authorization, token)) {
            sendError(res, 401, "Missing or invalid bearer token", { "www-authenticate": 'Bearer realm="opennan-studio"' });
            return;
        }
        const sessionId = req.headers["mcp-session-id"];
        if (typeof sessionId === "string") {
            const entry = sessions.get(sessionId);
            if (!entry) {
                sendError(res, 404, "Unknown MCP session");
                return;
            }
            requestStarted(sessionId);
            res.once("close", () => requestEnded(sessionId));
            await entry.transport.handleRequest(req, res);
            return;
        }
        if (req.method !== "POST") {
            sendError(res, 400, "Missing mcp-session-id header");
            return;
        }
        if (sessions.size + pendingSessions >= maxSessions) {
            sendError(res, 503, `Too many MCP sessions (${maxSessions}); close one first`);
            return;
        }
        // Claimed before the first await, so a burst of initialize requests cannot pass the cap together.
        pendingSessions += 1;
        let pending = true;
        const settle = () => {
            if (!pending) return;
            pending = false;
            pendingSessions -= 1;
        };
        try {
            await initializeSession(req, res, settle);
        } finally {
            settle();
        }
    }

    /** `registered` runs when the session joins `sessions` (it stops counting as pending then). */
    async function initializeSession(req: IncomingMessage, res: ServerResponse, registered: () => void): Promise<void> {
        const body = await readJson(req, maxBodyBytes);
        if (!isInitializeRequest(body)) {
            sendError(res, 400, "The first request of a session must be initialize");
            return;
        }
        const server = createStudioMcpServer(session, options.server);
        const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (id) => {
                // The initialize request itself is the session's first open request.
                sessions.set(id, { transport, server, open: 1 });
                registered();
                res.once("close", () => requestEnded(id));
            },
        });
        transport.onclose = () => {
            const id = transport.sessionId;
            if (id) {
                clearTimeout(sessions.get(id)?.timer);
                sessions.delete(id);
            }
        };
        await server.connect(transport);
        await transport.handleRequest(req, res, body);
    }

    const httpServer = http.createServer((req, res) => {
        handle(req, res).catch((error: unknown) => {
            if (res.headersSent) {
                res.end();
                return;
            }
            if (error instanceof HttpError) sendError(res, error.status, error.message);
            else sendError(res, 500, "Internal error");
        });
    });
    const requestedPort = options.port ?? DEFAULT_HTTP_PORT;
    await new Promise<void>((resolve, reject) => {
        const onError = (error: NodeJS.ErrnoException) => {
            reject(error.code === "EADDRINUSE"
                ? new Error(`Port ${requestedPort} on ${LOOPBACK_HOST} is in use. Stop the other server or pass --port with a free port; the MCP server never moves to another port on its own.`)
                : error);
        };
        httpServer.once("error", onError);
        httpServer.listen(requestedPort, LOOPBACK_HOST, () => {
            httpServer.off("error", onError);
            resolve();
        });
    });
    const bound = httpServer.address() as AddressInfo;
    port = bound.port;

    return {
        url: `http://${LOOPBACK_HOST}:${port}${MCP_PATH}`,
        address: bound.address,
        port,
        token,
        sessionCount: () => sessions.size,
        async close() {
            for (const id of [...sessions.keys()]) await closeSession(id);
            await new Promise<void>((resolve) => {
                httpServer.close(() => resolve());
                httpServer.closeAllConnections();
            });
        },
    };
}
