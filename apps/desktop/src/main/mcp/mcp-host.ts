// The built-in MCP server (spec §5.7, §7.2): streamable HTTP on 127.0.0.1 with a bearer token per app run,
// serving the project open in the editor. The token lives in <userData>/mcp/token (0600) and nowhere else:
// child CLIs reach the server through the app binary in --mcp-bridge mode, which reads that file.
import fs from "node:fs";
import path from "node:path";
import { createSessionToken, startHttpServer as defaultStartHttpServer, type HttpServerOptions, type StudioHttpServer, type StudioSession } from "@opennan/mcp";
import type { McpLaunch } from "@opennan/mcp";

export interface McpHostOptions {
    tokenFile: string;
    preferredPort: number;
    startHttpServer?(session: StudioSession, options: HttpServerOptions): Promise<StudioHttpServer>;
}

export interface McpHostInfo {
    running: boolean;
    url: string | null;
    port: number | null;
    projectId: string | null;
}

export interface McpHost {
    token(): string;
    open(session: StudioSession): Promise<McpHostInfo>;
    close(): Promise<void>;
    info(): McpHostInfo;
    /** The stdio entry CLIs launch: this app's binary in bridge mode. */
    bridgeLaunch(app: { execPath: string; appPath: string; isPackaged: boolean; platform?: NodeJS.Platform }): Extract<McpLaunch, { transport: "stdio" }>;
}

export function writeTokenFile(file: string, token: string): void {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${token}\n`, { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
}

const isAddressInUse = (error: unknown) => (error as { code?: string } | null)?.code === "EADDRINUSE" || /EADDRINUSE|address already in use/i.test(String(error));

export function createMcpHost(options: McpHostOptions): McpHost {
    const start = options.startHttpServer ?? defaultStartHttpServer;
    let token: string | null = null;
    let port: number | null = null;
    let server: StudioHttpServer | null = null;
    let projectId: string | null = null;
    const ensureToken = () => {
        if (!token) {
            token = createSessionToken();
            writeTokenFile(options.tokenFile, token);
        }
        return token;
    };
    const host: McpHost = {
        token: ensureToken,
        async open(session) {
            await host.close();
            const secret = ensureToken();
            const listen = (at: number) => start(session, { port: at, token: secret });
            if (port !== null) {
                // Same port for configs written earlier in this run; if anything took it meanwhile (a squatter
                // would receive bridges' bearer tokens), move to a fresh port instead of failing.
                try {
                    server = await listen(port);
                } catch {
                    server = await listen(0);
                    port = server.port;
                }
            } else {
                try {
                    server = await listen(options.preferredPort);
                } catch (error) {
                    if (!isAddressInUse(error)) throw error;
                    server = await listen(0);
                }
                port = server.port;
            }
            projectId = session.projectId;
            return host.info();
        },
        async close() {
            const running = server;
            server = null;
            projectId = null;
            await running?.close();
        },
        info: () => ({ running: server !== null, url: server?.url ?? (port ? `http://127.0.0.1:${port}/mcp` : null), port, projectId }),
        bridgeLaunch({ execPath, appPath, isPackaged, platform = process.platform }) {
            // Only the URL of a server this app is listening on: never a remembered port someone else may hold.
            if (!server) throw new Error("The MCP server is not running: open a project in the editor first");
            const url = server.url;
            return {
                transport: "stdio",
                command: execPath,
                args: [...(platform === "linux" ? ["--ozone-platform=headless"] : []), ...(isPackaged ? [] : [appPath]), "--mcp-bridge", "--url", url, "--token-file", options.tokenFile],
                ...(platform === "win32" ? { env: { ELECTRON_NO_ATTACH_CONSOLE: "1" } } : {}),
            };
        },
    };
    return host;
}
