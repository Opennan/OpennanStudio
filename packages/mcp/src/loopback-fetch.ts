// A fetch for the bridge's streamable-HTTP client over node:http, with a new TCP
// connection per request (no keep-alive pool). Fetch reuses idle sockets; when the
// server restarts, a request written on a socket the old server already closed fails
// with ECONNRESET, and the bridge cannot tell that from a server that died while it ran
// the call, so it could not retry the call safely. With one connection per request a
// stopped server shows up as ECONNREFUSED (never delivered, safe to retry) and a reset
// only ever means the request was in flight. Loopback connections cost next to nothing.
import http from "node:http";
import { Readable } from "node:stream";

const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

export function loopbackFetch(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
    const url = new URL(input instanceof Request ? input.url : input);
    const method = (init.method ?? "GET").toUpperCase();
    const body = init.body;
    if (body != null && typeof body !== "string" && !(body instanceof Uint8Array)) {
        return Promise.reject(new TypeError("loopbackFetch sends string or byte bodies only"));
    }
    return new Promise<Response>((resolve, reject) => {
        const request = http.request(url, {
            method,
            headers: Object.fromEntries(new Headers(init.headers)),
            agent: false,
            signal: init.signal ?? undefined,
        }, (response) => {
            const headers = new Headers();
            for (const [name, value] of Object.entries(response.headers)) {
                for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) headers.append(name, item);
            }
            const status = response.statusCode ?? 500;
            const hasBody = method !== "HEAD" && !NULL_BODY_STATUSES.has(status);
            if (!hasBody) response.resume();
            resolve(new Response(hasBody ? (Readable.toWeb(response) as ReadableStream<Uint8Array>) : null, {
                status,
                statusText: response.statusMessage,
                headers,
            }));
        });
        request.on("error", reject);
        request.end(body ?? undefined);
    });
}
