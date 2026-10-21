// Typed errors of the OpenNan provider. The API answers {"error":{"type","message","code"}}; Studio reads `code`
// (never null since opennan.com's phase 11.1 contract fixes) and shows its own words for it (OPENNAN_ERROR_COPY),
// never raw server text that could carry internals: server text is shown only where the server writes customer text
// on purpose, and only when safeServerText lets it through.
import { CapabilityUnavailableError, JobFailedError, type ProviderCapability } from "@opennan/provider-sdk";

/** Removes anything shaped like an OpenNan API key, so no message, log line, or status can carry one. */
export function redactKeys(text: string): string {
    return text.replace(/sk-[A-Za-z0-9_-]{6,}/g, "sk-…");
}

/** An HTTP or network failure of the opennan.com API. `status` 0 means the request never got an answer. */
export class OpenNanApiError extends Error {
    readonly status: number;
    readonly code: string;
    /** The server's error type (invalid_request_error, conflict, ...); absent when Studio made the error itself. */
    readonly type?: string;
    /** From Retry-After on 429, 503, and busy 409 answers. */
    readonly retryAfterSeconds?: number;
    /** The message is the server's own text (from the error envelope), not Studio's: shown only through the copy table. */
    readonly fromServer: boolean;
    /** The envelope's error.details: what a refusal names ({kind, ids}, {path}, {revision}); absent when it sent none. */
    readonly details?: Record<string, unknown>;

    constructor(status: number, code: string, message: string, options: { retryAfterSeconds?: number; cause?: unknown; type?: string; fromServer?: boolean; details?: Record<string, unknown> } = {}) {
        super(redactKeys(message), options.cause === undefined ? undefined : { cause: options.cause });
        this.name = "OpenNanApiError";
        this.status = status;
        this.code = code;
        this.fromServer = options.fromServer ?? false;
        if (options.type !== undefined) this.type = options.type;
        if (options.retryAfterSeconds !== undefined) this.retryAfterSeconds = options.retryAfterSeconds;
        if (options.details !== undefined) this.details = options.details;
    }
}

/** The codes opennan.com's /v1 errors carry (each type's default code and the specific ones Studio meets). */
export type OpenNanErrorCode =
    | "invalid_request" | "invalid_api_key" | "insufficient_balance" | "permission_denied" | "not_found" | "idempotency_key_reused" | "conflict"
    | "precondition_failed" | "not_ready" | "rate_limit_exceeded" | "server_error" | "unavailable" | "busy" | "request_too_large"
    | "task_not_cancellable" | "task_busy_retry" | "task_already_finished"
    | "upload_not_found" | "upload_not_received" | "upload_size_mismatch" | "upload_type_mismatch"
    | "tier_not_offered" | "clip_locked" | "id_in_use" | "timeline_changed" | "invalid_change" | "model_unavailable"
    | "upload_url_used" | "storage_quota_exceeded" | "upload_daily_limit" | "temp_storage_exceeded" | "free_storage_pool_full" | "upload_gateway_unavailable"
    | "multipart_required" | "upload_parts_invalid" | "project_data_quota_exceeded" | "project_too_large";

export const UPLOAD_AGAIN = "The upload didn't arrive intact. Run it again.";
export const TIER_NOT_OFFERED_MESSAGE = "This quality isn't available, pick another.";

/** What Studio says for each code (the server's message is never shown for these). */
export const OPENNAN_ERROR_COPY: Readonly<Record<OpenNanErrorCode, string>> = {
    invalid_request: "OpenNan could not take this request.",
    invalid_api_key: "Your OpenNan sign-in has ended. Sign in again.",
    insufficient_balance: "Not enough credits. Buy credits on opennan.com to continue.",
    permission_denied: "This OpenNan sign-in isn't allowed to do that. Sign in again with OpenNan.",
    not_found: "OpenNan could not find that. It may have expired.",
    idempotency_key_reused: "This run was already sent once. Check your jobs before running it again.",
    conflict: "OpenNan couldn't do that right now. Try again.",
    precondition_failed: "OpenNan's copy changed meanwhile. Reload and try again.",
    not_ready: "That isn't ready on OpenNan yet. Try again in a moment.",
    rate_limit_exceeded: "OpenNan is busy right now. Try again in a moment.",
    server_error: "OpenNan had a problem. Try again later.",
    unavailable: "OpenNan can't run this right now. Try again later.",
    busy: "OpenNan is busy. Try again in a moment.",
    request_too_large: "This is too large to send to OpenNan.",
    task_not_cancellable: "Already running: it will finish and be charged.",
    task_busy_retry: "OpenNan is busy. Try again in a moment.",
    task_already_finished: "It had already finished.",
    upload_not_found: "The upload expired before it finished. Run it again.",
    upload_not_received: "The file didn't reach OpenNan's storage. Run it again.",
    upload_size_mismatch: UPLOAD_AGAIN,
    upload_type_mismatch: UPLOAD_AGAIN,
    tier_not_offered: TIER_NOT_OFFERED_MESSAGE,
    clip_locked: "That clip is locked on OpenNan.",
    id_in_use: "That id is already in use on OpenNan.",
    timeline_changed: "The cloud timeline changed meanwhile. Reload it and try again.",
    invalid_change: "OpenNan couldn't apply that change.",
    model_unavailable: "This model can't run on OpenNan right now. Try another.",
    upload_url_used: "The upload link was already used. Run it again.",
    storage_quota_exceeded: "Your OpenNan cloud storage is full.",
    upload_daily_limit: "You reached today's upload limit. Try again tomorrow.",
    temp_storage_exceeded: "Too many uploads are waiting for running jobs. Try again in a few minutes.",
    free_storage_pool_full: "OpenNan cloud storage is busy right now. Try again later.",
    upload_gateway_unavailable: "OpenNan can't take uploads right now. Try again later.",
    multipart_required: "This file is too large to upload in one piece.",
    upload_parts_invalid: UPLOAD_AGAIN,
    project_data_quota_exceeded: "Your OpenNan cloud has no room for more project data.",
    project_too_large: "This project is too large for OpenNan cloud.",
};

/** Words that mark internals (stack traces, code, suppliers, infrastructure): text holding one is never shown. */
const INTERNAL = /traceback|exception|\b[a-z_]+error\b|\.py\b|file "|sqlalchemy|asyncpg|psycopg|httpx|pydantic|\bfal\b|fal\.ai|replicate|elevenlabs|dashscope|gemini|openai|runpod|modal\.com|\bgpu\b|internal|:\/\/|[\\{}<>`]|(?:\/[a-z0-9_.-]+){3,}/i;

/**
 * The server's text when it reads like customer text: one line, at most 300 characters, no stack traces, code, paths,
 * links, supplier or infrastructure names, and no keys; otherwise null (show Studio's own words).
 */
export function safeServerText(text: string): string | null {
    const clean = redactKeys(text).trim();
    if (!clean || clean.length > 300 || /[\r\n\t]/.test(clean) || clean.includes("sk-…")) return null;
    if (INTERNAL.test(clean)) return null;
    return clean;
}

const isKnownCode = (code: string): code is OpenNanErrorCode => Object.prototype.hasOwnProperty.call(OPENNAN_ERROR_COPY, code);

/**
 * What to show for an API error. Studio's own errors (no answer, a file it refused) keep their words; a server error
 * is shown by its code. An invalid request may show the server's field message when it is safe (it says what to fix).
 */
export function openNanErrorMessage(error: OpenNanApiError, where: { upload?: boolean } = {}): string {
    if (!error.fromServer) return error.message;
    // A 403 on an upload is the key's scope, unless its code says what it is (storage_quota_exceeded, project_too_large).
    if (where.upload && (error.code === "permission_denied" || (error.status === 403 && !isKnownCode(error.code)))) return UPLOAD_SCOPE_MESSAGE;
    // An older server's complete answered a bare 409 when nothing had arrived.
    if (where.upload && error.status === 409 && !error.code.startsWith("upload_")) return OPENNAN_ERROR_COPY.upload_not_received;
    if (error.code === "rate_limit_exceeded" && error.retryAfterSeconds !== undefined && error.retryAfterSeconds > 0) {
        return `OpenNan is busy right now. Try again in ${error.retryAfterSeconds} s.`;
    }
    if (error.code === "invalid_request") return safeServerText(error.message) ?? OPENNAN_ERROR_COPY.invalid_request;
    if (isKnownCode(error.code)) return OPENNAN_ERROR_COPY[error.code];
    if (error.status === 401) return OPENNAN_ERROR_COPY.invalid_api_key;
    if (error.status === 403) return OPENNAN_ERROR_COPY.permission_denied;
    if (error.status === 404) return OPENNAN_ERROR_COPY.not_found;
    if (error.status === 409) return OPENNAN_ERROR_COPY.conflict;
    if (error.status === 429) return OPENNAN_ERROR_COPY.rate_limit_exceeded;
    if (error.status >= 500) return OPENNAN_ERROR_COPY.unavailable;
    return safeServerText(error.message) ?? `OpenNan could not do that (${error.code}).`;
}

const NOT_CHARGED_TEXT = /not (been )?charged|refunded/i;

/**
 * An API refusal that came before anything could be charged (a task POST the server refused, an upload, a speech or
 * sound effect call), as a JobFailedError in Studio's words that says so (refunded: true). 401 and 402 are not
 * turned: the provider signs out or shows Buy credits for them.
 */
export function notChargedError(error: OpenNanApiError, where: { upload?: boolean } = {}): OpenNanApiError | JobFailedError {
    if (error.status === 401 || error.status === 402) return error;
    const text = openNanErrorMessage(error, where);
    const sentence = /[.!?]$/.test(text) ? text : `${text}.`;
    const message = NOT_CHARGED_TEXT.test(sentence) ? sentence : `${sentence} You were not charged.`;
    return new JobFailedError(message, { cause: error, code: error.code, refunded: true });
}

/** A key without api:project cannot upload (403 permission_denied on POST /v1/uploads). */
export const UPLOAD_SCOPE_MESSAGE = "Sign in again to allow uploads.";

/** 402 insufficient_balance: the account has too few credits (or a spend limit would be passed). */
export class InsufficientCreditsError extends OpenNanApiError {
    constructor(message = "Not enough credits.") {
        super(402, "insufficient_balance", message);
        this.name = "InsufficientCreditsError";
    }
}

export const SIGN_IN_GUIDANCE = "Connect OpenNan: run `opennan-studio login` or sign in from Studio's account chip.";

/** An OpenNan capability was called while signed out. A CapabilityUnavailableError, so hosts show it as guidance. */
export class OpenNanSignInRequiredError extends CapabilityUnavailableError {
    constructor(capability: ProviderCapability, feature: string = capability) {
        super(capability, feature);
        this.name = "OpenNanSignInRequiredError";
        this.message = SIGN_IN_GUIDANCE;
    }
}

export type DeviceFlowErrorKind = "expired" | "denied" | "network" | "rate-limited" | "unknown";

/** How a device sign-in ended without a key. */
export class DeviceFlowError extends Error {
    readonly kind: DeviceFlowErrorKind;
    readonly retryAfterSeconds?: number;

    constructor(kind: DeviceFlowErrorKind, message: string, retryAfterSeconds?: number) {
        super(redactKeys(message));
        this.name = "DeviceFlowError";
        this.kind = kind;
        if (retryAfterSeconds !== undefined) this.retryAfterSeconds = retryAfterSeconds;
    }
}
