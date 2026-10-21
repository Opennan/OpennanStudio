// `OpenNan Studio --mcp-bridge --url <loopback url> --token-file <file>`: the stdio MCP server child CLIs
// launch from their config. It forwards to the app's HTTP server (startBridge) and does nothing else: no
// window, no IPC, loopback URLs only, a small regular token file only. This keeps the RunAsNode fuse off
// (a general-purpose Node runtime inside the signed app) while CLIs still get a stdio entry.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isLoopbackHttpUrl, startBridge } from "@opennan/mcp";

export const BRIDGE_FLAG = "--mcp-bridge";

export function isBridgeMode(argv: readonly string[]): boolean {
    return argv.includes(BRIDGE_FLAG);
}

function valueOf(argv: readonly string[], name: string): string | null {
    const index = argv.indexOf(name);
    return index >= 0 && index + 1 < argv.length ? argv[index + 1] : null;
}

export function parseBridgeArgs(argv: readonly string[]): { url: string; tokenFile: string } {
    const url = valueOf(argv, "--url");
    const tokenFile = valueOf(argv, "--token-file");
    if (!url || !tokenFile) throw new Error("usage: --mcp-bridge --url <http://127.0.0.1:port/mcp> --token-file <file>");
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        throw new Error("--url is not a URL");
    }
    if (!isLoopbackHttpUrl(parsed)) throw new Error("--url must be an http URL on 127.0.0.1 or localhost");
    if (!path.isAbsolute(tokenFile)) throw new Error("--token-file must be an absolute path");
    const stat = fs.statSync(tokenFile, { throwIfNoEntry: false });
    if (!stat || !stat.isFile()) throw new Error("--token-file is not a file");
    if (stat.size > 1024) throw new Error("--token-file is too large to be a token");
    return { url, tokenFile };
}

/** The token file must hold one session token (createSessionToken: 43 base64url characters), nothing else. */
export function readBridgeToken(tokenFile: string): string {
    const token = fs.readFileSync(tokenFile, "utf8").trim();
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error("--token-file does not hold an OpenNan Studio token");
    return token;
}

export interface BridgeApp {
    dock?: { hide(): void };
    disableHardwareAcceleration(): void;
    setPath(name: "userData", value: string): void;
    quit(): void;
    exit(code: number): void;
}

export async function runBridgeMode(argv: readonly string[], app: BridgeApp): Promise<void> {
    app.dock?.hide();
    app.disableHardwareAcceleration();
    app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "opennan-bridge-")));
    try {
        const { url, tokenFile } = parseBridgeArgs(argv);
        readBridgeToken(tokenFile);
        // Read again before every connection attempt: the app writes a new token each time it starts.
        const bridge = await startBridge({ url, token: () => readBridgeToken(tokenFile) });
        await bridge.closed;
        app.quit();
    } catch (error) {
        process.stderr.write(`opennan-studio bridge: ${error instanceof Error ? error.message : String(error)}\n`);
        app.exit(1);
    }
}
