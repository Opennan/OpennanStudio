// Sign in with OpenNan: the device authorization flow (RFC 8628 in spirit) on opennan.com's public API.
// POST /v1/auth/device starts it; POST /v1/auth/device/token is polled every `interval` seconds until the person
// approves on opennan.com. Error codes come in {"error":{"code"}} (not RFC 8628's flat shape): authorization_pending,
// slow_down (+5 s), expired_token / invalid_grant (expired), access_denied (denied).
import type { OpenNanApi } from "./api";
import { DeviceFlowError, OpenNanApiError, openNanErrorMessage } from "./errors";

export const DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
/** Consecutive network failures (or 5xx answers) after which polling gives up. */
export const MAX_NETWORK_FAILURES = 3;

export type DeviceClient = "desktop" | "web" | "cli";

export interface DeviceStart {
    deviceCode: string;
    userCode: string;
    verificationUri: string;
    verificationUriComplete: string;
    /** Epoch milliseconds. */
    expiresAt: number;
    intervalSeconds: number;
}

export interface DeviceToken {
    apiKey: string;
    keyId: string;
    keyName: string;
    scopes: string[];
    /** ISO time for expiring (web) keys, else null. */
    expiresAt: string | null;
}

interface StartAnswer {
    device_code?: unknown;
    user_code?: unknown;
    verification_uri?: unknown;
    verification_uri_complete?: unknown;
    expires_in?: unknown;
    interval?: unknown;
}

const text = (value: unknown) => (typeof value === "string" && value !== "" ? value : null);

function withSignup(uri: string): string {
    if (/[?&]signup=1(&|$)/.test(uri)) return uri;
    return `${uri}${uri.includes("?") ? "&" : "?"}signup=1`;
}

function flowError(error: unknown): DeviceFlowError {
    if (error instanceof DeviceFlowError) return error;
    if (error instanceof OpenNanApiError) {
        // Studio's words for the server's code (never its raw text).
        if (error.status === 429) return new DeviceFlowError("rate-limited", openNanErrorMessage(error), error.retryAfterSeconds ?? 30);
        if (error.code === "network") return new DeviceFlowError("network", error.message);
        return new DeviceFlowError("unknown", openNanErrorMessage(error));
    }
    return new DeviceFlowError("unknown", error instanceof Error ? error.message : String(error));
}

export async function startDeviceSignIn(
    api: OpenNanApi,
    options: { deviceName: string; client: DeviceClient; signup?: boolean; signal?: AbortSignal },
    now: () => number = Date.now,
): Promise<DeviceStart> {
    const body: Record<string, unknown> = { device_name: options.deviceName, client: options.client };
    if (options.signup) body.signup = true;
    let answer: StartAnswer;
    try {
        answer = await api.request<StartAnswer>("POST", "/v1/auth/device", { body, signal: options.signal });
    } catch (error) {
        if ((error as { name?: string }).name === "AbortError") throw error;
        throw flowError(error);
    }
    const deviceCode = text(answer.device_code);
    const userCode = text(answer.user_code);
    const verificationUri = text(answer.verification_uri);
    const complete = text(answer.verification_uri_complete) ?? (verificationUri && userCode ? `${verificationUri}?code=${encodeURIComponent(userCode)}` : null);
    const expiresIn = Number(answer.expires_in);
    const interval = Number(answer.interval);
    if (!deviceCode || !userCode || !verificationUri || !complete) throw new DeviceFlowError("unknown", "OpenNan sent an incomplete sign-in code.");
    return {
        deviceCode,
        userCode,
        verificationUri,
        verificationUriComplete: options.signup ? withSignup(complete) : complete,
        expiresAt: now() + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 600) * 1000,
        intervalSeconds: Number.isFinite(interval) && interval >= 1 ? interval : 5,
    };
}

export interface DevicePoller {
    /** Resolves the key; rejects with DeviceFlowError, or an AbortError after cancel(). */
    result: Promise<DeviceToken>;
    /**
     * Poll now (window focus, tab visible) once the interval (and any Retry-After) since the last poll has passed:
     * background tabs throttle timers, so the scheduled poll may be late, but this never polls early (RFC 8628).
     */
    pollNow(): void;
    cancel(): void;
}

export interface PollerOptions {
    onReconnecting?(reconnecting: boolean): void;
    now?(): number;
}

interface TokenAnswer {
    api_key?: unknown;
    key_id?: unknown;
    name?: unknown;
    scopes?: unknown;
    expires_at?: unknown;
}

function abortError(): Error {
    const error = new Error("Sign-in was cancelled");
    error.name = "AbortError";
    return error;
}

export function createDevicePoller(api: OpenNanApi, start: DeviceStart, options: PollerOptions = {}): DevicePoller {
    const now = options.now ?? Date.now;
    const controller = new AbortController();
    let interval = start.intervalSeconds;
    let lastPoll = now();
    let wake: (() => void) | null = null;
    let reconnecting = false;
    const setReconnecting = (value: boolean) => {
        if (value === reconnecting) return;
        reconnecting = value;
        options.onReconnecting?.(value);
    };
    /** No poll, scheduled or on demand, before this time (Retry-After after a 429). */
    let notBefore = 0;

    /** Resolves at `at`, or earlier when pollNow() wakes it; rejects when cancelled. */
    const waitUntil = (at: number) => new Promise<void>((resolve, reject) => {
        if (controller.signal.aborted) {
            reject(abortError());
            return;
        }
        const done = () => {
            clearTimeout(timer);
            controller.signal.removeEventListener("abort", onAbort);
            wake = null;
            resolve();
        };
        const onAbort = () => {
            clearTimeout(timer);
            wake = null;
            reject(abortError());
        };
        const timer = setTimeout(done, Math.max(0, at - now()));
        controller.signal.addEventListener("abort", onAbort, { once: true });
        wake = done;
    });

    const run = async (): Promise<DeviceToken> => {
        let nextAt = lastPoll + interval * 1000;
        let failures = 0;
        for (;;) {
            if (nextAt >= start.expiresAt) {
                await waitUntil(Math.min(nextAt, start.expiresAt));
                if (now() >= start.expiresAt) throw new DeviceFlowError("expired", "The code expired.");
            } else {
                await waitUntil(nextAt);
            }
            if (now() >= start.expiresAt) throw new DeviceFlowError("expired", "The code expired.");
            lastPoll = now();
            nextAt = lastPoll + interval * 1000;
            try {
                const token = await api.request<TokenAnswer>("POST", "/v1/auth/device/token", {
                    body: { device_code: start.deviceCode, grant_type: DEVICE_GRANT_TYPE }, signal: controller.signal,
                });
                const apiKey = text(token.api_key);
                const keyId = text(token.key_id);
                if (!apiKey || !keyId) throw new DeviceFlowError("unknown", "OpenNan approved the sign-in but sent no key.");
                setReconnecting(false);
                return {
                    apiKey, keyId, keyName: text(token.name) ?? "OpenNan Studio",
                    scopes: Array.isArray(token.scopes) ? token.scopes.filter((s): s is string => typeof s === "string") : [],
                    expiresAt: text(token.expires_at),
                };
            } catch (error) {
                if (controller.signal.aborted) throw abortError();
                if (error instanceof DeviceFlowError) throw error;
                if (!(error instanceof OpenNanApiError)) throw flowError(error);
                if (error.code === "authorization_pending") {
                    failures = 0;
                    setReconnecting(false);
                    continue;
                }
                if (error.code === "slow_down") {
                    failures = 0;
                    setReconnecting(false);
                    interval += 5;
                    nextAt = lastPoll + interval * 1000;
                    continue;
                }
                if (error.code === "expired_token" || error.code === "invalid_grant") throw new DeviceFlowError("expired", "The code expired.");
                if (error.code === "access_denied") throw new DeviceFlowError("denied", "Sign-in was denied.");
                if (error.status === 429) {
                    nextAt = lastPoll + Math.max(error.retryAfterSeconds ?? interval, interval) * 1000;
                    notBefore = nextAt;
                    continue;
                }
                if (error.code === "network" || error.status >= 500) {
                    failures += 1;
                    setReconnecting(true);
                    if (failures >= MAX_NETWORK_FAILURES) throw new DeviceFlowError("network", "Can't reach OpenNan.");
                    continue;
                }
                throw flowError(error);
            }
        }
    };

    const result = run();
    result.catch(() => undefined);
    return {
        result,
        pollNow() {
            if (wake && now() >= Math.max(lastPoll + interval * 1000, notBefore)) wake();
        },
        cancel() {
            controller.abort();
        },
    };
}
