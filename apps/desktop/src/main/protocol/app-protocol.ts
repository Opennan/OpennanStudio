// opennan-app://app/<path>: the renderer's own files from dist/renderer. Only that folder, only real files
// inside it (symlinks resolved), only GET/HEAD; every response carries the CSP.
import fs from "node:fs";
import path from "node:path";
import { APP_HOST, CONTENT_SECURITY_POLICY } from "./csp";

const TYPES: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".woff2": "font/woff2",
    ".wasm": "application/wasm",
    ".map": "application/json; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
};

const notFound = () => new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });

const isInside = (file: string, root: string) => file.startsWith(root.endsWith(path.sep) ? root : root + path.sep);

/** Resolves a request URL to a file inside `realRoot`, or null. */
export function resolveAppFile(url: string, realRoot: string): string | null {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return null;
    }
    if (parsed.host !== APP_HOST) return null;
    let pathname: string;
    try {
        pathname = decodeURIComponent(parsed.pathname);
    } catch {
        return null;
    }
    if (pathname.includes("\\") || pathname.includes("\0")) return null;
    if (pathname === "" || pathname === "/") pathname = "/index.html";
    const candidate = path.resolve(realRoot, `.${pathname}`);
    if (!isInside(candidate, realRoot)) return null;
    let real: string;
    try {
        real = fs.realpathSync(candidate);
    } catch {
        return null;
    }
    if (!isInside(real, realRoot)) return null;
    try {
        return fs.statSync(real).isFile() ? real : null;
    } catch {
        return null;
    }
}

export function createAppProtocolHandler(root: string): (request: Request) => Promise<Response> {
    const realRoot = fs.realpathSync(root);
    return async (request) => {
        if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405 });
        const file = resolveAppFile(request.url, realRoot);
        if (!file) return notFound();
        const headers = {
            "Content-Type": TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream",
            "Content-Security-Policy": CONTENT_SECURITY_POLICY,
            "X-Content-Type-Options": "nosniff",
            "Cross-Origin-Resource-Policy": "same-origin",
            "Cache-Control": "no-cache",
        };
        if (request.method === "HEAD") return new Response(null, { status: 200, headers });
        return new Response(await fs.promises.readFile(file), { status: 200, headers });
    };
}
