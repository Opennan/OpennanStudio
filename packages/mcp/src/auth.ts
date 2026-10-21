// Localhost HTTP guard (spec §5.7, §7.2): per-session bearer token, Host and
// Origin limited to 127.0.0.1/localhost on the bound port.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** Environment variable the generated client configs read the token from. */
export const TOKEN_ENV = "OPENNAN_STUDIO_MCP_TOKEN";

export function createSessionToken(): string {
    return randomBytes(32).toString("base64url");
}

export function isValidToken(token: string): boolean {
    return token.length >= 24 && /^[A-Za-z0-9._~+/=-]+$/.test(token);
}

const digest = (value: string) => createHash("sha256").update(value).digest();

/** Constant-time check of an `Authorization: Bearer <token>` header. */
export function bearerMatches(header: string | undefined, token: string): boolean {
    const match = header ? /^Bearer\s+(\S+)\s*$/i.exec(header) : null;
    if (!match) return false;
    return timingSafeEqual(digest(match[1]), digest(token));
}

export function isAllowedHost(host: string | undefined, port: number): boolean {
    return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

/** Requests without Origin (CLIs) pass; browser origins must be this server. */
export function isAllowedOrigin(origin: string | undefined, port: number): boolean {
    return origin === undefined || origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
}
