// The signed-in account (GET /v1/account) and revoking the calling key (DELETE /v1/auth/key). Neither result
// ever carries the key itself.
import type { OpenNanApi } from "./api";

export interface AccountInfo {
    email: string;
    displayName: string;
    /** https only. */
    photoUrl: string | null;
    /** null when the server sent no usable number. */
    balanceUsd: number | null;
    keyId: string | null;
    keyName: string | null;
    keyExpiresAt: string | null;
    /** https only; hosts fall back to <console>/console/billing. */
    billingUrl: string | null;
    /** The account's stable id (phase 9a.1: on-device cloud state is keyed by it), or null when the server sends none. */
    accountId?: string | null;
    /**
     * Where this deployment's share link pages live (9c.1: a link is `<shareBaseUrl>/<token>`), an http(s) URL as sent,
     * or null when the server sends none (older servers). Hosts check it before building a link on it.
     */
    shareBaseUrl?: string | null;
}

const ACCOUNT_ID = /^[A-Za-z0-9._:-]{1,128}$/;

const https = (value: unknown): string | null => {
    if (typeof value !== "string") return null;
    try {
        return new URL(value).protocol === "https:" ? value : null;
    } catch {
        return null;
    }
};
const webUrl = (value: unknown): string | null => {
    if (typeof value !== "string" || value.length > 200) return null;
    try {
        const protocol = new URL(value).protocol;
        return protocol === "https:" || protocol === "http:" ? value : null;
    } catch {
        return null;
    }
};
const str = (value: unknown): string | null => (typeof value === "string" && value.trim() !== "" ? value : null);

export function parseAccount(body: unknown): AccountInfo | null {
    if (typeof body !== "object" || body === null) return null;
    const value = body as Record<string, unknown>;
    const email = str(value.email);
    if (!email) return null;
    const key = (typeof value.key === "object" && value.key !== null ? value.key : {}) as Record<string, unknown>;
    const balance = typeof value.balance_usd === "number" && Number.isFinite(value.balance_usd) ? value.balance_usd : null;
    return {
        email,
        displayName: str(value.display_name) ?? email.split("@")[0]!,
        photoUrl: https(value.photo_url),
        balanceUsd: balance,
        keyId: str(key.id),
        keyName: str(key.name),
        keyExpiresAt: str(key.expires_at),
        billingUrl: https(value.billing_url),
        accountId: typeof value.account_id === "string" && ACCOUNT_ID.test(value.account_id) ? value.account_id : null,
        shareBaseUrl: webUrl(value.share_base_url),
    };
}

/** The account of `apiKey`. Rejects with OpenNanApiError (401 when the key is revoked or expired). */
export async function getAccount(api: OpenNanApi, apiKey: string, signal?: AbortSignal): Promise<AccountInfo> {
    const account = parseAccount(await api.request("GET", "/v1/account", { apiKey, signal }));
    if (!account) throw new Error("OpenNan sent an account without an email.");
    return account;
}

/** Revokes the calling key. Best effort: false when the server did not confirm (offline, already revoked). */
export async function revokeKey(api: OpenNanApi, apiKey: string, signal?: AbortSignal): Promise<boolean> {
    try {
        const answer = await api.request<{ revoked?: unknown }>("DELETE", "/v1/auth/key", { apiKey, signal });
        return answer.revoked === true;
    } catch {
        return false;
    }
}
