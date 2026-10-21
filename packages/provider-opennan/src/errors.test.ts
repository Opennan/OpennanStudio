// Studio's words for opennan.com's error codes (phase 11.1), and the filter that keeps server internals off screen.
import { OPENNAN_ERROR_COPY, OpenNanApiError, UPLOAD_SCOPE_MESSAGE, openNanErrorMessage, safeServerText } from "./errors";

const server = (status: number, code: string, message: string, extra: { retryAfterSeconds?: number } = {}) =>
    new OpenNanApiError(status, code, message, { fromServer: true, ...extra });

describe("openNanErrorMessage", () => {
    it("shows Studio's copy for each known code, never the server's text", () => {
        expect(openNanErrorMessage(server(400, "tier_not_offered", "kling-3 does not offer 4k at 10 s via supplier-x: try 1080p."))).toBe("This quality isn't available, pick another.");
        expect(openNanErrorMessage(server(503, "unavailable", "fal queue down (internal)"))).toBe(OPENNAN_ERROR_COPY.unavailable);
        expect(openNanErrorMessage(server(409, "idempotency_key_reused", "key abc reused"))).toBe(OPENNAN_ERROR_COPY.idempotency_key_reused);
        expect(openNanErrorMessage(server(412, "timeline_changed", "rev 41 != 42"))).toBe(OPENNAN_ERROR_COPY.timeline_changed);
        expect(openNanErrorMessage(server(413, "request_too_large", "body > 1 MiB"))).toBe("This is too large to send to OpenNan.");
    });

    it("permission_denied on an upload asks to sign in again (the key lacks api:project)", () => {
        expect(openNanErrorMessage(server(403, "permission_denied", "scope api:project"), { upload: true })).toBe(UPLOAD_SCOPE_MESSAGE);
        expect(UPLOAD_SCOPE_MESSAGE).toBe("Sign in again to allow uploads.");
        expect(openNanErrorMessage(server(403, "permission_denied", "scope api:video"))).toBe(OPENNAN_ERROR_COPY.permission_denied);
    });

    it("says when to try again after a rate limit", () => {
        expect(openNanErrorMessage(server(429, "rate_limit_exceeded", "max 120 quote_ip per 60s", { retryAfterSeconds: 30 }))).toBe("OpenNan is busy right now. Try again in 30 s.");
        expect(openNanErrorMessage(server(429, "rate_limit_exceeded", "x"))).toBe(OPENNAN_ERROR_COPY.rate_limit_exceeded);
    });

    it("an invalid request may show the server's field message when it is safe, else Studio's words", () => {
        expect(openNanErrorMessage(server(400, "invalid_request", "duration: 5-10 seconds."))).toBe("duration: 5-10 seconds.");
        expect(openNanErrorMessage(server(400, "invalid_request", "Traceback (most recent call last): File \"/app/x.py\""))).toBe(OPENNAN_ERROR_COPY.invalid_request);
    });

    it("an unknown code falls back by status; Studio's own errors keep their words", () => {
        expect(openNanErrorMessage(server(500, "weird_new_code", "KeyError: 'x'"))).toBe(OPENNAN_ERROR_COPY.unavailable);
        expect(openNanErrorMessage(new OpenNanApiError(0, "network", "Can't reach OpenNan."))).toBe("Can't reach OpenNan.");
    });
});

describe("phase 9a upload and storage codes", () => {
    it.each([
        ["upload_url_used", 410, "The upload link was already used. Run it again."],
        ["storage_quota_exceeded", 403, "Your OpenNan cloud storage is full."],
        ["upload_daily_limit", 429, "You reached today's upload limit. Try again tomorrow."],
        ["temp_storage_exceeded", 429, "Too many uploads are waiting for running jobs. Try again in a few minutes."],
        ["free_storage_pool_full", 503, "OpenNan cloud storage is busy right now. Try again later."],
        ["upload_gateway_unavailable", 503, "OpenNan can't take uploads right now. Try again later."],
        ["multipart_required", 400, "This file is too large to upload in one piece."],
        ["upload_parts_invalid", 400, "The upload didn't arrive intact. Run it again."],
        ["project_data_quota_exceeded", 403, "Your OpenNan cloud has no room for more project data."],
        ["project_too_large", 403, "This project is too large for OpenNan cloud."],
    ])("%s has Studio's own words", (code, status, copy) => {
        expect(OPENNAN_ERROR_COPY[code as keyof typeof OPENNAN_ERROR_COPY]).toBe(copy);
        expect(openNanErrorMessage(server(status, code, "Not enough cloud storage: 0 bytes left of 2.0 GB (internal pool free-1)."))).toBe(copy);
    });

    it("a full storage on an upload says so, not the key's scope", () => {
        expect(openNanErrorMessage(server(403, "storage_quota_exceeded", "Not enough cloud storage"), { upload: true })).toBe("Your OpenNan cloud storage is full.");
        expect(openNanErrorMessage(server(403, "forbidden", "nope"), { upload: true })).toBe(UPLOAD_SCOPE_MESSAGE);
    });

    it("keeps every copy a short plain sentence", () => {
        for (const copy of Object.values(OPENNAN_ERROR_COPY)) {
            expect(copy.length).toBeLessThanOrEqual(80);
            expect(copy).toMatch(/^[A-Z].*[.!?]$/);
        }
    });
});

describe("safeServerText", () => {
    it("lets customer text through", () => {
        expect(safeServerText("The run failed. You were not charged.")).toBe("The run failed. You were not charged.");
        expect(safeServerText("The file is longer than this tool takes (its limits are in GET /v1/tools). You were not charged.")).not.toBeNull();
        expect(safeServerText("The video could not be read: send a public https link to an MP4, MOV or WEBM file. You were not charged.")).not.toBeNull();
    });

    it.each([
        "Traceback (most recent call last)",
        "ValueError: invalid literal",
        "fal-ai/bytedance-upscaler returned 500",
        "File \"/srv/app/api/tasks.py\", line 3",
        "connect to https://10.0.0.4:5432 failed",
        "{'detail': 'x'}",
        "line one\nline two",
        "x".repeat(301),
        "Internal error. You were not charged.",
        "key sk-live_abcdefghijklmnop leaked",
        "",
    ])("keeps internals off screen: %s", (text) => {
        expect(safeServerText(text)).toBeNull();
    });
});
