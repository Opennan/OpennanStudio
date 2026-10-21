// View-only share links of a cloud project (phase 9c; opennan.com's cloud projects design §12): create (or rotate:
// a new link revokes the project's active one in the same step), list, revoke one, and stop sharing. The server's
// project_share answers are parsed defensively. A link is `<share_base_url>/<token>` (phase 9c.1: the server sends
// share_base_url on every project_share and on GET /v1/account); Studio shows or copies the server's url only when it
// is exactly that on a checked base (https on opennan.com or one of its subdomains, or this machine's loopback for the
// e2e fake), else builds it from the base, so a wrong or tampered answer can never make Studio show or copy a link to
// another site. Older servers send no base: https://opennan.com/s. Only an active link carries a URL. Tokens and URLs
// are never logged or stored here.
import type { CloudApi } from "./api";

export type ShareStatus = "active" | "expired" | "revoked";

export interface ShareLink {
    id: string;
    token: string;
    /** The share page (`<share_base_url>/<token>`) for an active link; null otherwise. */
    url: string | null;
    status: ShareStatus;
    allowDownload: boolean;
    /** Epoch ms (null when the server sent none it could read). */
    expiresAt: number | null;
    createdAt: number | null;
    revokedAt: number | null;
    views: number;
    lastViewedAt: number | null;
}

/** Where share pages live for this account: GET /v1/account's share_base_url (absent or null on older servers). */
export interface ShareSite {
    shareBaseUrl?: string | null;
    /**
     * A loopback base (the e2e fake) may be used: the calls below set it when the API itself is loopback; a host whose
     * API has no address of its own (desktop's proxy) sets it in its e2e runs only.
     */
    allowLoopback?: boolean;
}

export const SHARE_DEFAULT_DAYS = 30;
export const SHARE_MIN_DAYS = 1;
export const SHARE_MAX_DAYS = 365;
/** The expiries the Share dialog offers (any whole number of days 1–365 is accepted). */
export const SHARE_DAY_CHOICES: readonly number[] = Object.freeze([1, 7, 30, 90, 365]);
export const OPENNAN_SITE = "https://opennan.com";
/** Where share pages live when the server names no base (servers before 9c.1). */
export const SHARE_FALLBACK_BASE = `${OPENNAN_SITE}/s`;

const SHARE_ID = /^shr_[0-9a-f]{24}$/;
const TOKEN = /^[A-Za-z0-9_-]{20,64}$/;
const SERVER_ID = /^[A-Za-z0-9_-]{1,36}$/;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

type Raw = Record<string, unknown>;

function isRecord(value: unknown): value is Raw {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function time(value: unknown): number | null {
    if (typeof value !== "string") return null;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
}

/**
 * A share_base_url Studio builds links on, without a trailing slash: `https://opennan.com/s` or `https://<sub>.opennan.com/s`
 * (a staging site), or with `allowLoopback` `http(s)://<loopback>[:port]/s` (the e2e fake on this machine); nothing else
 * (no other host, port, path, query, fragment or credentials). null when it is not one.
 */
export function checkShareBase(value: unknown, allowLoopback = false): string | null {
    if (typeof value !== "string" || value.length > 200) return null;
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        return null;
    }
    if (url.username || url.password || url.search || url.hash || value.includes("?") || value.includes("#")) return null;
    if (url.pathname.replace(/\/$/, "") !== "/s") return null;
    const host = url.hostname.toLowerCase();
    const opennan = url.protocol === "https:" && url.port === "" && (host === "opennan.com" || /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+opennan\.com$/.test(host));
    const loopback = allowLoopback && (url.protocol === "http:" || url.protocol === "https:") && LOOPBACK.has(host);
    return opennan || loopback ? `${url.origin}/s` : null;
}

/**
 * The share page of `token`: `<base>/<token>` on the first checked base of the share answer's share_base_url, the
 * account's, or https://opennan.com/s (older servers). The server's `url` is used as given when it is exactly that.
 * null for a malformed token.
 */
export function shareUrlOf(token: string, serverUrl: unknown, site: ShareSite, serverBase?: unknown): string | null {
    if (typeof token !== "string" || !TOKEN.test(token)) return null;
    const loopback = site.allowLoopback === true;
    const base = checkShareBase(serverBase, loopback) ?? checkShareBase(site.shareBaseUrl, loopback) ?? SHARE_FALLBACK_BASE;
    const expected = `${base}/${token}`;
    return typeof serverUrl === "string" && serverUrl === expected ? serverUrl : expected;
}

/** A project_share as Studio uses it; null when the answer has no usable id or token. */
export function parseShare(value: unknown, site: ShareSite): ShareLink | null {
    if (!isRecord(value)) return null;
    const id = typeof value.id === "string" && SHARE_ID.test(value.id) ? value.id : null;
    const token = typeof value.token === "string" && TOKEN.test(value.token) ? value.token : null;
    if (!id || !token) return null;
    // An unknown status is treated as not active (never offered as a link to copy).
    const status: ShareStatus = value.status === "active" || value.status === "revoked" ? value.status : "expired";
    return {
        id, token, status, url: status === "active" ? shareUrlOf(token, value.url, site, value.share_base_url) : null,
        allowDownload: value.allow_download === true, expiresAt: time(value.expires_at), createdAt: time(value.created_at), revokedAt: time(value.revoked_at),
        views: typeof value.views === "number" && Number.isInteger(value.views) && value.views >= 0 ? value.views : 0, lastViewedAt: time(value.last_viewed_at),
    };
}

/** The site with loopback bases allowed only against a loopback API (the e2e fake), never in production. */
function siteFor(api: CloudApi, site: ShareSite): ShareSite {
    let loopback = false;
    try {
        loopback = LOOPBACK.has(new URL(api.baseUrl).hostname);
    } catch {
        loopback = false;
    }
    return { shareBaseUrl: site.shareBaseUrl ?? null, allowLoopback: loopback || site.allowLoopback === true };
}

function sharesPath(serverId: string): string {
    if (!SERVER_ID.test(serverId)) throw new Error("Not an OpenNan project id.");
    return `/v1/projects/${serverId}/shares`;
}

function listOf(body: unknown, site: ShareSite): ShareLink[] {
    const data = isRecord(body) && Array.isArray(body.data) ? body.data : [];
    return data.map((row) => parseShare(row, site)).filter((s): s is ShareLink => s !== null);
}

export interface ShareOptions {
    /** 1–365 whole days (default 30). */
    expiresInDays?: number;
    /** Let viewers download the video (default off). */
    allowDownload?: boolean;
}

/** Creates the project's link, or rotates it (the active link is revoked in the same step: `replaced`). */
export async function createShare(api: CloudApi, serverId: string, options: ShareOptions, given: ShareSite): Promise<{ link: ShareLink; replaced: string[] }> {
    const site = siteFor(api, given);
    const days = options.expiresInDays ?? SHARE_DEFAULT_DAYS;
    if (!(Number.isInteger(days) && days >= SHARE_MIN_DAYS && days <= SHARE_MAX_DAYS)) throw new Error(`A share link works for ${SHARE_MIN_DAYS} to ${SHARE_MAX_DAYS} days.`);
    const answer = await api.request<unknown>("POST", sharesPath(serverId), { body: { expires_in_days: days, allow_download: options.allowDownload === true } });
    const link = parseShare(answer.body, site);
    if (!link) throw new Error("OpenNan made the link but sent an answer Studio cannot read: open Share again to see it.");
    const replaced = isRecord(answer.body) && Array.isArray(answer.body.replaced) ? answer.body.replaced.filter((id): id is string => typeof id === "string" && SHARE_ID.test(id)) : [];
    return { link, replaced };
}

/** The project's links, newest first (at most 20: active, expired and revoked). */
export async function listShares(api: CloudApi, serverId: string, given: ShareSite, signal?: AbortSignal): Promise<ShareLink[]> {
    const site = siteFor(api, given);
    const answer = await api.request<unknown>("GET", sharesPath(serverId), signal ? { signal } : {});
    return listOf(answer.body, site);
}

/** Turns one link off (again: no change). */
export async function revokeShare(api: CloudApi, serverId: string, shareId: string, given: ShareSite): Promise<ShareLink> {
    const site = siteFor(api, given);
    if (!SHARE_ID.test(shareId)) throw new Error("Not a share link id.");
    const answer = await api.request<unknown>("DELETE", `${sharesPath(serverId)}/${shareId}`);
    const link = parseShare(answer.body, site);
    if (!link) throw new Error("OpenNan turned the link off but sent an answer Studio cannot read.");
    return link;
}

/**
 * Stops sharing the project: exactly the links it changed (they were active and are now revoked; none when nothing
 * was shared). Expired links stay expired and are not in the answer.
 */
export async function stopSharing(api: CloudApi, serverId: string, given: ShareSite): Promise<ShareLink[]> {
    const site = siteFor(api, given);
    const answer = await api.request<unknown>("DELETE", sharesPath(serverId));
    return listOf(answer.body, site);
}
