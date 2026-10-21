// stdio-to-HTTP bridge: CLI agents spawn `opennan-studio mcp bridge` from their
// config and speak stdio; the bridge forwards tools/list and tools/call to a
// streamable-HTTP server (desktop, or `mcp serve --http`). The process behind the
// URL stays the only writer of the project.
//
// The bridge outlives the server: Studio may not be running yet, may restart (new
// port listener, new sessions, maybe a new token), or may close an idle session.
// The bridge never exits for any of that. It connects lazily, retries with a bounded
// backoff, and answers a tool call with a tool error when the server stays down.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { loopbackFetch } from "./loopback-fetch";
import { SERVER_INSTRUCTIONS, SERVER_NAME } from "./server";
import { MCP_VERSION } from "./version";

/** Tool calls can run long (exports, renders); the SDK default of 60 s is too short. */
export const BRIDGE_REQUEST_TIMEOUT_MS = 30 * 60_000;

/** How hard the bridge tries to reach the server before a request fails. */
export interface BridgeRetryOptions {
    /** Connection attempts per request before it reports the server unreachable (default 8, about 14 s of waiting). */
    attempts?: number;
    /** Wait before the second attempt; it doubles per attempt (default 200 ms). */
    initialDelayMs?: number;
    /** Longest wait between two attempts (default 4 s). */
    maxDelayMs?: number;
    /** Attempts at startup before the bridge serves with its own name and instructions (default 3). */
    startupAttempts?: number;
    /** One connection attempt (initialize handshake) gives up after this long (default 10 s). */
    connectTimeoutMs?: number;
}

export interface BridgeOptions {
    url: string;
    /** The server's bearer token, or a function read again before every connection attempt (Studio writes a new token when it restarts). */
    token: string | (() => string | Promise<string>);
    /** Default: stdio. */
    transport?: Transport;
    retry?: BridgeRetryOptions;
}

export interface RunningBridge {
    /** Resolves when the agent side closes. */
    closed: Promise<void>;
    close(): Promise<void>;
}

const DEFAULT_RETRY: Required<BridgeRetryOptions> = {
    attempts: 8,
    initialDelayMs: 200,
    maxDelayMs: 4000,
    startupAttempts: 3,
    connectTimeoutMs: 10_000,
};

/**
 * The server no longer knows the session (idle close, restart): it answered 404, or the
 * client transport is closed. The SDK client does not re-initialize on its own.
 */
export function sessionLost(error: unknown): boolean {
    const code = (error as { code?: unknown } | null)?.code;
    return code === 404 || (error instanceof Error && /Not connected|Unknown MCP session/.test(error.message));
}

/** Whether `error`, its causes, or the errors it aggregates carry a system error code that `match` accepts. */
function hasErrorCode(error: unknown, match: (code: string) => boolean): boolean {
    const seen = new Set<unknown>();
    const visit = (value: unknown): boolean => {
        if (!value || typeof value !== "object" || seen.has(value)) return false;
        seen.add(value);
        const { code, cause, errors } = value as { code?: unknown; cause?: unknown; errors?: unknown };
        if (typeof code === "string" && match(code)) return true;
        return visit(cause) || (Array.isArray(errors) && errors.some(visit));
    };
    return visit(error);
}

/**
 * Nothing listens on the port (the server is down, or between a close and its next listen),
 * so the request never reached a server. The bridge opens a new connection per request
 * (loopback-fetch.ts), so a refused connection is the only way a stopped server shows up.
 */
export function connectionRefused(error: unknown): boolean {
    return hasErrorCode(error, (code) => code === "ECONNREFUSED");
}

/** Any socket-level failure (refused, reset, timed out): fine to retry for a request that changes nothing. */
const networkError = (error: unknown) => error instanceof TypeError || hasErrorCode(error, (code) => /^E[A-Z]+$/.test(code) || code.startsWith("UND_ERR"));

/** The bearer token goes to this URL, so the bridge talks only to this machine's loopback over http. */
export function isLoopbackHttpUrl(url: URL): boolean {
    return url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost");
}

/** The server stayed unreachable for the whole retry budget. */
class ServerUnreachableError extends Error {}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export async function startBridge(options: BridgeOptions): Promise<RunningBridge> {
    const target = new URL(options.url);
    if (!isLoopbackHttpUrl(target)) throw new Error(`mcp bridge connects only to http://127.0.0.1 or http://localhost, got ${target.href}`);
    const retry = { ...DEFAULT_RETRY, ...options.retry };
    const readToken = typeof options.token === "function" ? options.token : () => options.token as string;
    const stopping = new AbortController();

    let remote: Client | null = null;
    let connecting: Promise<Client> | null = null;
    /** A tools/list failed while the server was unreachable: tell the agent to list again once it is back. */
    let offerToolsAgain = false;

    /** Drops a remote client whose session or server is gone; requests still waiting on it fail with "Connection closed". */
    function discard(client: Client): void {
        if (remote === client) remote = null;
        void client.close().catch(() => undefined);
    }

    async function connectOnce(): Promise<Client> {
        const client = new Client({ name: "opennan-studio-bridge", version: MCP_VERSION });
        const token = (await readToken()).trim();
        await client.connect(new StreamableHTTPClientTransport(new URL(options.url), {
            requestInit: { headers: { Authorization: `Bearer ${token}` } },
            fetch: loopbackFetch,
        }), { timeout: retry.connectTimeoutMs, signal: stopping.signal });
        // A broken response stream, a server event stream (GET) that the server forgot (404), or one that
        // could not be reopened means the server closed the session or stopped: requests in flight on it
        // can never get an answer (the server keeps no event store to resume from), so the client goes
        // now and they fail at once instead of after BRIDGE_REQUEST_TIMEOUT_MS. Deferred, so a POST that
        // got 404 reaches `forward` with its own error and is retried there.
        client.onerror = (error) => {
            const text = message(error);
            const lostStream = /SSE stream disconnected|Maximum reconnection attempts/.test(text) || (sessionLost(error) && /SSE stream/.test(text));
            if (lostStream) setImmediate(() => discard(client));
        };
        client.onclose = () => {
            if (remote === client) remote = null;
        };
        return client;
    }

    const sleep = (ms: number) => new Promise<void>((resolve, reject) => {
        if (stopping.signal.aborted) {
            reject(new Error("The bridge is closing"));
            return;
        }
        const timer = setTimeout(() => {
            stopping.signal.removeEventListener("abort", onAbort);
            resolve();
        }, ms);
        const onAbort = () => {
            clearTimeout(timer);
            reject(new Error("The bridge is closing"));
        };
        stopping.signal.addEventListener("abort", onAbort, { once: true });
    });

    /** Connects with a doubling backoff; every attempt reads the token again. */
    async function connectWithRetry(attempts: number): Promise<Client> {
        const started = Date.now();
        let lastError: unknown;
        for (let attempt = 0; attempt < attempts; attempt += 1) {
            if (attempt > 0) await sleep(Math.min(retry.initialDelayMs * 2 ** (attempt - 1), retry.maxDelayMs));
            if (stopping.signal.aborted) break;
            try {
                return await connectOnce();
            } catch (error) {
                lastError = error;
            }
        }
        const seconds = ((Date.now() - started) / 1000).toFixed(1);
        throw new ServerUnreachableError(
            `OpenNan Studio is not reachable at ${options.url} (${attempts} attempts over ${seconds} s; last error: ${message(lastError)}). `
            + "Open the project in OpenNan Studio (or start `opennan-studio mcp serve --http`) and try again.",
        );
    }

    /** The live remote client, connecting it first (one connection for all waiting requests). */
    function ensureRemote(attempts = retry.attempts): Promise<Client> {
        if (remote) return Promise.resolve(remote);
        connecting ??= connectWithRetry(attempts).then((client) => {
            if (stopping.signal.aborted) {
                void client.close().catch(() => undefined);
                throw new Error("The bridge is closing");
            }
            remote = client;
            if (offerToolsAgain) {
                offerToolsAgain = false;
                void server.sendToolListChanged().catch(() => undefined);
            }
            return client;
        }).finally(() => {
            connecting = null;
        });
        return connecting;
    }

    /** Waits for `promise`, but gives up when the agent cancels the request. */
    const untilCancelled = <T>(promise: Promise<T>, signal: AbortSignal): Promise<T> => new Promise<T>((resolve, reject) => {
        if (signal.aborted) {
            reject(new McpError(ErrorCode.ConnectionClosed, "Request was cancelled"));
            return;
        }
        const onAbort = () => reject(new McpError(ErrorCode.ConnectionClosed, "Request was cancelled"));
        signal.addEventListener("abort", onAbort, { once: true });
        promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
    });

    /**
     * Runs a request on the remote session. When the server never got the request (the session
     * is unknown, or nothing listens on the port) it reconnects and runs it again, so an edit
     * is never applied twice. `idempotent` requests are also retried after any connection error.
     */
    async function forward<T>(run: (client: Client) => Promise<T>, signal: AbortSignal, idempotent: boolean): Promise<T> {
        let sessionRetried = false;
        for (let pass = 0; ; pass += 1) {
            const client = await untilCancelled(ensureRemote(), signal);
            try {
                return await run(client);
            } catch (error) {
                // 401 on a live session: the server restarted with a new token; it checked the token before running anything.
                const lost = sessionLost(error) || (error as { code?: unknown }).code === 401;
                const refused = connectionRefused(error);
                const retryable = lost || refused || (idempotent && networkError(error));
                // A server that flaps between accepting the handshake and refusing requests gets a few passes, not forever.
                if (!retryable || signal.aborted || pass >= retry.attempts) throw error;
                if (lost) {
                    if (sessionRetried) throw error;
                    sessionRetried = true;
                }
                discard(client);
            }
        }
    }

    // The server's own name, version, and instructions when it answers at startup; this package's otherwise.
    let first: Client | null = null;
    try {
        first = await ensureRemote(Math.max(1, retry.startupAttempts));
    } catch {
        // Not running yet: the first request connects (and offers tools/list again when it does).
    }
    const info = first?.getServerVersion();
    const server = new Server(
        { name: info?.name ?? SERVER_NAME, version: info?.version ?? MCP_VERSION },
        { capabilities: { tools: { listChanged: true } }, instructions: first ? first.getInstructions() : SERVER_INSTRUCTIONS },
    );
    server.setRequestHandler(ListToolsRequestSchema, async (request, extra) => {
        try {
            return await forward((client) => client.listTools(request.params, { signal: extra.signal, timeout: BRIDGE_REQUEST_TIMEOUT_MS }), extra.signal, true);
        } catch (error) {
            if (!(error instanceof ServerUnreachableError)) throw error;
            offerToolsAgain = true;
            throw new McpError(ErrorCode.InternalError, error.message);
        }
    });
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
        try {
            return (await forward((client) => client.callTool(request.params, undefined, { signal: extra.signal, timeout: BRIDGE_REQUEST_TIMEOUT_MS }), extra.signal, false)) as CallToolResult;
        } catch (error) {
            if (error instanceof ServerUnreachableError) return { content: [{ type: "text", text: error.message }], isError: true };
            if (error instanceof McpError && error.code === ErrorCode.ConnectionClosed && !extra.signal.aborted) {
                return {
                    content: [{ type: "text", text: `The connection to OpenNan Studio was lost while ${request.params.name} was running, so it may or may not have been applied. Check the project (read_timeline) before calling it again.` }],
                    isError: true,
                };
            }
            throw error;
        }
    });
    let resolveClosed!: () => void;
    const closed = new Promise<void>((resolve) => {
        resolveClosed = resolve;
    });
    server.onclose = () => resolveClosed();
    await server.connect(options.transport ?? new StdioServerTransport());
    return {
        closed,
        async close() {
            stopping.abort();
            await server.close();
            const client = remote;
            remote = null;
            await client?.close();
        },
    };
}
