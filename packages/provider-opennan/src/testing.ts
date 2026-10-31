// A fake OpenNan server for tests (Node only, subpath @opennan/provider-opennan/testing): the device flow, account,
// key revocation, models with price blocks, generation tasks, uploads, the phase 11 media tool tasks, GET /v1/tools,
// voices, a tiny approval page, and control endpoints (/__test/*) that let tests approve, deny, or expire codes,
// force a 429, set the balance, fail the next task of a tool, mark a tool's paid step as started (cancel → 409),
// take a tool off line, slow tasks down, and mint keys with fewer scopes. Phase 11.1: every error carries a code (its
// own, or its type's default, as on the server), cancel refusals carry task_not_cancellable /
// task_busy_retry (Retry-After: 1) / task_already_finished, uploads their codes, and POST /v1/quotes answers from a
// mirror of the server's pricing functions (fakeQuote, fakeToolSettle; knob /__test/quotes for 404/429/503). Phase
// 9b (testing-director.ts): AI director turns over SSE with scripted steps, the director-turn and project tool
// quotes, and the project pipeline task routes (/__test/director/* knobs, FakeOpenNan.director in process). Unit
// tests, the web and desktop e2e suites, and the CLI tests all drive Studio against it; nothing here talks to
// opennan.com.
import { randomBytes } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createFakeCloud, type CloudAnswer, type FakeCloud } from "./testing-cloud";
import { createFakeDirector, FAKE_PROJECT_TOOL_IDS, fakeDirectorTurnQuote, type FakeDirector } from "./testing-director";
import { FAKE_WEBM_BASE64 } from "./testing-fixtures";

export {
    FAKE_STORAGE_DEFAULTS, FAKE_UPLOAD_LIMITS, FakeCloudError, type FakeCloud, type FakeCloudAssetState, type FakeCloudUploadState, type FakeStorageSettings, type FakeUploadLimits, type FakeCloudState, type FakeCloudProjectState, type FakeChangeFailure, type FakeChangeRecord, type FakeOfflineMode,
    type FakeEffect, type FakeTrack, type FakeProjectFacts,
} from "./testing-cloud";
export {
    FAKE_DIRECTOR_DEVICE, FAKE_DIRECTOR_HEARTBEAT_MS, FAKE_DIRECTOR_HOLD_USD, FAKE_DIRECTOR_LIMITS, FAKE_DIRECTOR_ROUND_USD, FAKE_DIRECTOR_TYPICAL_USD,
    FAKE_PROJECT_TOOL_IDS, FAKE_PROJECT_TOOL_PRICES, fakeDirectorTurnQuote, fakeProjectToolHold,
    type FakeDirector, type FakeDirectorPaidTool, type FakeDirectorState, type FakeDirectorStep, type FakeDirectorTurnState, type FakeProjectToolId, type FakeTurnStatus,
} from "./testing-director";

export interface FakeOpenNanOptions {
    port?: number;
    host?: string;
    intervalSeconds?: number;
    expiresInSeconds?: number;
}

interface Device {
    deviceCode: string;
    userCode: string;
    status: "pending" | "approved" | "denied" | "expired" | "consumed";
    client: string | null;
    signup: boolean;
    deviceName: string;
    expiresAt: number;
    polls: number[];
}

interface Key {
    id: string;
    name: string;
    revoked: boolean;
    expiresAt: string | null;
    scopes: string[];
}

/** Tools with a task on the phase 11 endpoints ("separation" is the demucs model's task). */
export type FakeToolId = "transcribe" | "caption-translate" | "voice-isolation" | "video-upscale" | "remove-background" | "lipsync" | "separation";

interface Task {
    id: string;
    kind: "image" | "video" | "audio";
    step: number;
    cancelled: boolean;
    price: number;
    /** Phase 11 tool tasks. */
    tool?: FakeToolId;
    body?: Record<string, unknown>;
    fail?: string;
    paidStarted?: boolean;
    dropLine?: boolean;
    queuedSteps?: number;
}

export interface FakeRequest {
    method: string;
    path: string;
    at: number;
    /** Whether a bearer token came with it (never the token). */
    authorized: boolean;
    body?: unknown;
    /** The Idempotency-Key header, when one came. */
    idempotencyKey?: string;
}

export interface FakeUpload {
    id: string;
    contentType: string;
    sizeBytes: number;
    filename: string;
    put: boolean;
    completed: boolean;
}

export interface FakeOpenNanState {
    requests: FakeRequest[];
    devices: Array<{ userCode: string; status: string; client: string | null; signup: boolean; deviceName: string; pollSpacingsMs: number[] }>;
    revokedKeyIds: string[];
    balanceUsd: number;
    latestUserCode: string | null;
    /** Uploads (never their bytes). */
    uploads: FakeUpload[];
}

export interface FakeOpenNan {
    url: string;
    state(): FakeOpenNanState;
    reset(): void;
    approve(userCode?: string): boolean;
    deny(userCode?: string): boolean;
    expire(userCode?: string): boolean;
    setBalance(usd: number): void;
    /** Mints a key directly (tests of a pasted key or OPENNAN_API_KEY), with the scopes /__test/key-scopes set. */
    mintKey(name?: string): string;
    /** The cloud project routes' knobs in process (the same as POST /__test/cloud/*). */
    readonly cloud: FakeCloud;
    /** The AI director and project pipelines' knobs in process (the same as /__test/director/*). */
    readonly director: FakeDirector;
    /** The next POST /v1/chat/completions answers (in order; the same as POST /__test/chat-reply). Without one it echoes, and a cast check passes. */
    queueChatReply(text: string): void;
    close(): Promise<void>;
}

const LETTERS = "BCDFGHJKLMNPQRSTVWXZ";
export const FAKE_ACCOUNT = { email: "ada@example.com", display_name: "Ada Lovelace", photo_url: null } as const;
/** The account's stable id /v1/account answers (phase 9a.1; /__test/account?id=none hides it, as a server before it). */
export const FAKE_ACCOUNT_ID = "usr_ada_7f3k";
export const FAKE_BALANCE_USD = 12.4;
/** The scopes the server grants a Studio device-flow key. */
export const FAKE_STUDIO_SCOPES = ["api:opennan", "api:project", "api:video", "api:image", "api:text", "api:voice", "api:music", "api:3d"] as const;
/** What one unit of each tool costs (GET /v1/tools); a successful task is charged one unit. */
export const FAKE_TOOL_PRICES = {
    transcribe: 0.004768,
    "caption-translate": 0.00591,
    "voice-isolation": 0.13,
    "video-upscale": { "1080p": 0.00936, "2k": 0.01872, "4k": 0.03744 },
    "remove-background": 0.0026,
    lipsync: 0.013,
    "sound-effects": 0.0026,
    separation: 0.01,
} as const;
/**
 * What one unit really costs before the server rounds the published price to $0.000001 (transcription's published
 * 0.004768 is 0.0047683 here), so N units can settle a few micro-dollars above N × the published price, as on the
 * server (it rounds N × its unit cost once). The other tools' unit costs are their published prices.
 */
const FAKE_UNIT_COSTS: Record<string, number> = { transcribe: 0.0047683 };
/** The longest input each per-unit tool takes (the most seconds a quote takes) and its billed unit in seconds. */
export const FAKE_TOOL_UNITS: Readonly<Record<string, { maxSeconds: number; unitSeconds: number }>> = {
    transcribe: { maxSeconds: 1800, unitSeconds: 60 },
    "voice-isolation": { maxSeconds: 600, unitSeconds: 60 },
    "remove-background": { maxSeconds: 120, unitSeconds: 1 },
    lipsync: { maxSeconds: 60, unitSeconds: 1 },
    "video-upscale": { maxSeconds: 60, unitSeconds: 1 },
};
export type FakePricedTool = "transcribe" | "voice-isolation" | "remove-background" | "lipsync" | "video-upscale" | "caption-translate" | "sound-effects";
const round6 = (usd: number) => Math.round(usd * 1_000_000) / 1_000_000;

function unitCost(tool: string, resolution?: string): number {
    if (tool === "video-upscale") return FAKE_TOOL_PRICES["video-upscale"][(resolution ?? "1080p") as "1080p" | "2k" | "4k"];
    return FAKE_UNIT_COSTS[tool] ?? (FAKE_TOOL_PRICES[tool as keyof typeof FAKE_TOOL_PRICES] as number);
}

/** Billed characters of caption lines (as the server bills them): code points + 10 a line. */
export function fakeCaptionCharacters(segments: ReadonlyArray<{ text: string }>): number {
    return segments.reduce((sum, segment) => sum + [...segment.text].length + 10, 0);
}

/**
 * What a tool run that read these units settles at (as the server reprices it): unit cost × started units of the
 * length rounded to the millisecond, rounded to $0.000001 once, never above the hold (its longest input). Caption
 * translation per started 1,000 billed characters; sound effects per started second.
 */
export function fakeToolSettle(tool: FakePricedTool, units: { seconds?: number; resolution?: string; segments?: ReadonlyArray<{ text: string }> }): number {
    if (tool === "caption-translate") return round6(Math.max(1, Math.ceil(fakeCaptionCharacters(units.segments ?? []) / 1000)) * unitCost(tool));
    if (tool === "sound-effects") return round6(Math.max(1, Math.ceil(Math.round((units.seconds ?? 22) * 1000) / 1000 - 1e-9)) * unitCost(tool));
    const { maxSeconds, unitSeconds } = FAKE_TOOL_UNITS[tool]!;
    const hold = round6(Math.ceil(maxSeconds / unitSeconds) * unitCost(tool, units.resolution));
    if (units.seconds === undefined) return hold;
    const millis = Math.round(units.seconds * 1000);
    const started = Math.max(1, Math.ceil(millis / (unitSeconds * 1000)));
    return Math.min(hold, round6(started * unitCost(tool, units.resolution)));
}

export interface FakeQuoteAnswer {
    status: number;
    body: Record<string, unknown>;
}

const QUOTE_FIELDS = {
    video: ["prompt", "image", "end_image", "reference_images", "duration", "quality", "aspect_ratio", "generate_audio", "negative_prompt"],
    videoReference: ["prompt", "image", "end_image", "reference_images", "reference_videos", "reference_mode", "seconds", "duration", "quality", "aspect_ratio", "generate_audio", "negative_prompt"],
    image: ["prompt", "image", "images", "quality", "size", "aspect_ratio"],
    voice: ["input", "characters"],
    music: ["duration"],
    separation: ["seconds"],
    unit: ["seconds"],
    upscale: ["seconds", "resolution"],
    captions: ["segments"],
} as const;

const quoteError = (status: number, type: string, message: string, code?: string): FakeQuoteAnswer => ({ status, body: { error: { type, message, code: code ?? FAKE_DEFAULT_CODES[type] ?? type } } });
const quoteAnswer = (target: { model?: string; tool?: string }, price: number, hold: number, priced: Record<string, unknown>): FakeQuoteAnswer => ({
    status: 200, body: { object: "quote", model: target.model ?? null, tool: target.tool ?? null, currency: "usd", price_usd: round6(price), hold_usd: round6(hold), priced },
});

/** The video price of a model row set: the quality's row for that length, else its per-second price × the length. */
function videoPrice(model: Record<string, unknown>, quality: string | undefined, duration: number | undefined): { price: number; quality: string; duration: number } | { notOffered: string } {
    const matrix = ((model.price as { matrix?: Array<{ quality: string; duration: number; ours_usd: number; ours_usd_per_second: number }> })?.matrix) ?? [];
    const chosen = quality ?? matrix[0]?.quality ?? "720p";
    const rows = matrix.filter((row) => row.quality === chosen);
    if (rows.length === 0) return { notOffered: `${model.id} does not offer ${chosen}: try ${matrix[0]?.quality ?? "720p"}.` };
    const length = duration ?? (model.durations as number[] | undefined)?.[0] ?? 5;
    const exact = rows.find((row) => row.duration === length);
    return { price: exact ? exact.ours_usd : rows[0]!.ours_usd_per_second * length, quality: chosen, duration: length };
}

/**
 * The price of a call with reference videos, as the server works it out: output seconds plus the references' seconds
 * (rounded up to whole seconds; a quote without `seconds` is the 30-second worst case) at the quality's per-second
 * price. Its refusals use the server's words.
 */
export function fakeReferencePrice(model: Record<string, unknown>, body: Record<string, unknown>, quality: string, duration: number): { price: number; seconds: number; count: number; mode: string } | { error: string } {
    const limits = model.reference_videos as typeof FAKE_REFERENCE_VIDEOS | undefined;
    if (!limits) return { error: `${String(model.id)} does not take reference_videos.` };
    const videos = body.reference_videos;
    if (!Array.isArray(videos) || videos.length === 0) return { error: body.seconds !== undefined ? "reference video seconds need reference_videos" : "reference_mode needs reference_videos" };
    if (videos.length > limits.max_count) return { error: `reference_videos: at most ${limits.max_count}.` };
    if (!videos.every((v) => typeof v === "string" && /^(https:\/\/|http:\/\/127\.0\.0\.1[:/])/.test(v))) return { error: "reference_videos: send public https links." };
    if (body.image !== undefined || body.end_image !== undefined) return { error: "reference_videos can't be sent with image / end_image; send reference_images instead" };
    const mode = body.reference_mode === undefined ? "reference" : body.reference_mode;
    if (typeof mode !== "string" || !(limits.modes as readonly string[]).includes(mode)) return { error: `reference_mode: one of ${limits.modes.join(", ")}.` };
    const asked = body.seconds === undefined ? limits.max_total_seconds : body.seconds;
    if (typeof asked !== "number" || !Number.isFinite(asked) || asked < limits.min_seconds || asked > limits.max_total_seconds) return { error: "reference videos must total 2-30 seconds" };
    const seconds = Math.ceil(asked - 1e-9);
    const rate = SEEDANCE_25_REFERENCE_RATES[quality];
    if (rate === undefined) return { error: `${String(model.id)} does not offer ${quality} with reference videos.` };
    // An edit's output is as long as its videos, whatever duration says (the server's rule).
    return { price: round6(rate * ((mode === "editing" ? seconds : duration) + seconds)), seconds, count: videos.length, mode };
}

/** An MP4's length (its mvhd box) and picture size (the first video tkhd box), read the way the server's probe reads them. */
export function fakeMp4Facts(bytes: Buffer): { seconds?: number; width?: number; height?: number } {
    const facts: { seconds?: number; width?: number; height?: number } = {};
    const mvhd = bytes.indexOf("mvhd", 0, "ascii");
    if (mvhd >= 4) {
        const version = bytes[mvhd + 4];
        const at = mvhd + 4 + 4 + (version === 1 ? 16 : 8);
        if (at + (version === 1 ? 12 : 8) <= bytes.length) {
            const timescale = bytes.readUInt32BE(at);
            const duration = version === 1 ? Number(bytes.readBigUInt64BE(at + 4)) : bytes.readUInt32BE(at + 4);
            if (timescale > 0) facts.seconds = duration / timescale;
        }
    }
    for (let from = 0; ;) {
        const tkhd = bytes.indexOf("tkhd", from, "ascii");
        if (tkhd < 4) break;
        const version = bytes[tkhd + 4];
        const end = tkhd + 4 + (version === 1 ? 96 : 84);
        if (end > bytes.length) break;
        const width = bytes.readUInt32BE(end - 8) / 65536;
        const height = bytes.readUInt32BE(end - 4) / 65536;
        if (width > 0 && height > 0) {
            facts.width = Math.round(width);
            facts.height = Math.round(height);
            break;
        }
        from = tkhd + 4;
    }
    return facts;
}

/** Tests: a minimal MP4 (an mvhd box with the length, a tkhd box with the picture size), what fakeMp4Facts reads. */
export function fakeMp4(seconds: number, width: number, height: number): Uint8Array {
    const mvhd = Buffer.alloc(8 + 100);
    mvhd.writeUInt32BE(mvhd.length, 0);
    mvhd.write("mvhd", 4, "ascii");
    mvhd.writeUInt32BE(1000, 8 + 12);
    mvhd.writeUInt32BE(Math.round(seconds * 1000), 8 + 16);
    const tkhd = Buffer.alloc(8 + 84);
    tkhd.writeUInt32BE(tkhd.length, 0);
    tkhd.write("tkhd", 4, "ascii");
    tkhd.writeUInt32BE(width * 65536, 8 + 76);
    tkhd.writeUInt32BE(height * 65536, 8 + 80);
    return new Uint8Array(Buffer.concat([Buffer.from("\0\0\0\x10ftypisom\0\0\0\0", "binary"), mvhd, tkhd]));
}

/** POST /v1/quotes, worked out by the server's rules on the fake's catalog (no HTTP: tests call it too). */
export function fakeQuote(body: Record<string, unknown>): FakeQuoteAnswer {
    const invalid = (message: string, code?: string) => quoteError(400, "invalid_request_error", message, code);
    const hasModel = typeof body.model === "string";
    const hasTool = typeof body.tool === "string";
    if (hasModel === hasTool) return invalid("Send exactly one of model or tool.");
    const only = (allowed: readonly string[], target: string): FakeQuoteAnswer | null => {
        const extra = Object.keys(body).filter((k) => k !== "model" && k !== "tool" && !allowed.includes(k)).sort();
        return extra.length > 0 ? invalid(`${extra.join(", ")}: not a field of ${target}. It takes: ${[...allowed].sort().join(", ")}.`) : null;
    };
    if (hasModel) {
        const id = (body.model as string).trim();
        const find = (category: string) => (MODELS[category] ?? []).find((m) => m.id === id);
        const video = find("video");
        if (video) {
            const takesVideos = Boolean(video.reference_videos);
            const refused = only(takesVideos ? QUOTE_FIELDS.videoReference : QUOTE_FIELDS.video, id);
            if (refused) return refused;
            const priced = videoPrice(video, typeof body.quality === "string" ? body.quality : undefined, typeof body.duration === "number" ? body.duration : undefined);
            if ("notOffered" in priced) return invalid(priced.notOffered, "tier_not_offered");
            const audio = body.generate_audio === true;
            if (body.reference_videos !== undefined || body.seconds !== undefined || body.reference_mode !== undefined) {
                const reference = fakeReferencePrice(video, body, priced.quality, priced.duration);
                if ("error" in reference) return invalid(reference.error);
                return quoteAnswer({ model: id }, reference.price, reference.price, {
                    quality: priced.quality, duration: priced.duration, generate_audio: audio, reference_videos: reference.count, reference_mode: reference.mode, reference_video_seconds: reference.seconds,
                });
            }
            return quoteAnswer({ model: id }, priced.price, priced.price, { quality: priced.quality, duration: priced.duration, generate_audio: audio });
        }
        const image = find("image");
        if (image) {
            const refused = only(QUOTE_FIELDS.image, id);
            if (refused) return refused;
            const count = (typeof body.image === "string" ? 1 : 0) + (Array.isArray(body.images) ? body.images.length : 0);
            const price = image.price as { from_usd: number; per_input_image_usd?: number; tiers?: Array<{ quality: string | null; size: string | null; usd: number }> };
            let base = price.from_usd;
            if (body.size !== undefined || body.quality !== undefined) {
                const tier = (price.tiers ?? []).find((t) => t.size === (body.size ?? null) && t.quality === (body.quality ?? null));
                if (!tier) return invalid(`${id} does not offer that quality or size.`, "tier_not_offered");
                base = tier.usd;
            }
            const usd = base + (price.per_input_image_usd ?? 0) * count;
            return quoteAnswer({ model: id }, usd, usd, { quality: body.quality ?? null, size: body.size ?? null, input_images: count });
        }
        const voice = find("voice");
        if (voice) {
            const refused = only(QUOTE_FIELDS.voice, id);
            if (refused) return refused;
            if (body.input !== undefined && body.characters !== undefined) return invalid("Send input or characters, not both.");
            const characters = typeof body.input === "string" ? [...body.input].length : typeof body.characters === "number" ? body.characters : 0;
            if (!characters) return invalid("input: send the text to speak (or characters: its length).");
            const price = voice.price as { billing_block_characters: number; minimum_usd: number };
            const usd = Math.ceil(characters / price.billing_block_characters) * price.minimum_usd;
            return quoteAnswer({ model: id }, usd, usd, { characters });
        }
        const music = find("music");
        if (music && music.endpoint === "/v1/audio/separations") {
            const refused = only(QUOTE_FIELDS.separation, id);
            if (refused) return refused;
            const seconds = body.seconds;
            if (typeof seconds !== "number" || !(seconds > 0 && seconds <= 900)) return invalid("seconds: the song's length, more than 0 and at most 900.");
            const price = music.price as { minimum_usd: number; base_usd: number; per_minute_usd: number };
            const usd = Math.max(price.minimum_usd, round6(price.base_usd + (price.per_minute_usd * seconds) / 60));
            return quoteAnswer({ model: id }, usd, usd, { seconds });
        }
        if (music) {
            const refused = only(QUOTE_FIELDS.music, id);
            if (refused) return refused;
            // The server's music limits: 10 to 240 seconds, 30 when the call sends none.
            const seconds = typeof body.duration === "number" ? body.duration : 30;
            if (seconds < 10 || seconds > 240) return invalid("duration: 10-240 seconds.");
            const usd = round6(((music.price as { from_usd: number }).from_usd * seconds) / 60);
            return quoteAnswer({ model: id }, usd, usd, { duration: seconds });
        }
        return quoteError(404, "not_found", `Unknown model ${id}.`);
    }
    const tool = (body.tool as string).trim().toLowerCase();
    if (tool === "director-turn") {
        const refused = only([], tool);
        return refused ?? { status: 200, body: fakeDirectorTurnQuote() };
    }
    if (tool === "sound-effects") {
        const refused = only(QUOTE_FIELDS.unit, tool);
        if (refused) return refused;
        // The server's limits (sound_effects.MIN/MAX_SECONDS); without seconds the quote is the longest (its hold).
        const seconds = typeof body.seconds === "number" ? body.seconds : 22;
        if (seconds < 0.5 || seconds > 22) return invalid("seconds: 0.5 to 22.");
        const usd = fakeToolSettle("sound-effects", { seconds });
        return quoteAnswer({ tool }, usd, usd, { seconds });
    }
    if (tool === "caption-translate") {
        const refused = only(QUOTE_FIELDS.captions, tool);
        if (refused) return refused;
        const segments = body.segments;
        if (!Array.isArray(segments) || segments.length === 0 || segments.length > 2000 || !segments.every((s) => typeof (s as { text?: unknown })?.text === "string")) {
            return invalid("segments: send the caption lines you will translate.");
        }
        const lines = segments as Array<{ text: string }>;
        if (lines.reduce((n, s) => n + s.text.length, 0) > 30000) return invalid("segments: the captions hold more than 30,000 characters.");
        const usd = fakeToolSettle("caption-translate", { segments: lines });
        return quoteAnswer({ tool }, usd, usd, { segments: lines.length, billed_characters: fakeCaptionCharacters(lines) });
    }
    const units = FAKE_TOOL_UNITS[tool];
    if (!units) return invalid(`No quote for tool '${tool}': quotes cover caption-translate, lipsync, remove-background, transcribe, video-upscale, voice-isolation and sound-effects (and the video, image, voice and music models).`);
    const upscale = tool === "video-upscale";
    const refused = only(upscale ? QUOTE_FIELDS.upscale : QUOTE_FIELDS.unit, tool);
    if (refused) return refused;
    const resolution = upscale ? (typeof body.resolution === "string" ? body.resolution : "1080p") : undefined;
    if (resolution !== undefined && !["1080p", "2k", "4k"].includes(resolution)) return invalid("resolution: one of 1080p, 2k, 4k.");
    let seconds: number | undefined;
    if (body.seconds !== undefined && body.seconds !== null) {
        if (typeof body.seconds !== "number" || !(body.seconds > 0 && body.seconds <= units.maxSeconds)) {
            return invalid(`seconds: more than 0 and at most ${units.maxSeconds} (the longest input ${tool} takes).`);
        }
        seconds = body.seconds;
    }
    const priced = tool as FakePricedTool;
    const hold = fakeToolSettle(priced, { ...(resolution ? { resolution } : {}) });
    const price = fakeToolSettle(priced, { ...(seconds !== undefined ? { seconds } : {}), ...(resolution ? { resolution } : {}) });
    return quoteAnswer({ tool }, price, hold, { seconds: seconds ?? null, ...(resolution ? { resolution } : {}) });
}

/** The server's default code of each error type (as the server documents them): a /v1 error's code is never null. */
export const FAKE_DEFAULT_CODES: Readonly<Record<string, string>> = {
    invalid_request_error: "invalid_request", authentication_error: "invalid_api_key", insufficient_balance: "insufficient_balance",
    permission_error: "permission_denied", not_found: "not_found", idempotency_error: "idempotency_key_reused", conflict: "conflict",
    not_ready: "not_ready", precondition_failed: "precondition_failed", rate_limit_error: "rate_limit_exceeded", server_error: "server_error",
    unavailable: "unavailable", busy: "busy", api_error: "server_error",
};

/** The public texts the server gives failed tasks (the ones the media tools use). */
export const FAKE_PUBLIC_ERRORS: Record<string, string> = {
    pipeline_failed: "The run failed. You were not charged.",
    run_interrupted: "The run was interrupted. You were not charged.",
    input_fetch_video: "The video could not be read: send a public https link to an MP4, MOV or WEBM file. You were not charged.",
    input_fetch_audio: "The audio could not be read: send a public https link to an MP3, WAV, M4A, OGG or FLAC file. You were not charged.",
    input_too_large: "The file is too large for this tool. You were not charged.",
    input_already_large: "The video is already at or above the size asked for: ask for a larger size. You were not charged.",
    input_too_long_media: "The file is longer than this tool takes (its limits are in GET /v1/tools). You were not charged.",
    provider_failed: "The generation failed. You were not charged.",
    timeout: "The generation timed out. You were not charged.",
    internal: "Internal error. You were not charged.",
};
const CANCELLED_MESSAGE = "Cancelled. You were not charged.";
const CANCEL_CONFLICT = "This task can't be cancelled: it has finished or already started work that is charged.";
const CANCEL_BUSY = "This task is busy and could not be cancelled right now. Try again.";
/** 2x2 black PNG. */
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAC0lEQVR4nGNgQAYAAA4AAamRc7EAAAAASUVORK5CYII=", "base64");
const WEBM = Buffer.from(FAKE_WEBM_BASE64, "base64");
function wav(seconds = 0.5, rate = 8000): Buffer {
    const samples = Math.round(seconds * rate);
    const buffer = Buffer.alloc(44 + samples * 2);
    buffer.write("RIFF", 0);
    buffer.writeUInt32LE(36 + samples * 2, 4);
    buffer.write("WAVEfmt ", 8);
    buffer.writeUInt32LE(16, 16);
    buffer.writeUInt16LE(1, 20);
    buffer.writeUInt16LE(1, 22);
    buffer.writeUInt32LE(rate, 24);
    buffer.writeUInt32LE(rate * 2, 28);
    buffer.writeUInt16LE(2, 32);
    buffer.writeUInt16LE(16, 34);
    buffer.write("data", 36);
    buffer.writeUInt32LE(samples * 2, 40);
    return buffer;
}

/** The error type the server gives each status (the fake's own short refusals). */
function typeOf(status: number): string {
    switch (status) {
        case 401: return "authentication_error";
        case 402: return "insufficient_balance";
        case 403: return "permission_error";
        case 404: return "not_found";
        case 409: return "conflict";
        case 429: return "rate_limit_error";
        case 503: return "unavailable";
        default: return status >= 500 ? "server_error" : "invalid_request_error";
    }
}

/** The fields of a generation body a quote prices (the quote of exactly the call). */
function quoteFieldsOf(category: string, model: string, body: Record<string, unknown>): Record<string, unknown> {
    const fields = category === "video" ? QUOTE_FIELDS.videoReference : category === "image" ? QUOTE_FIELDS.image : QUOTE_FIELDS.music;
    const picked: Record<string, unknown> = { model };
    for (const name of fields) if (body[name] !== undefined && body[name] !== null && name !== "prompt") picked[name] = body[name];
    return picked;
}

function userCode(): string {
    const bytes = randomBytes(8);
    const letters = [...bytes].map((b) => LETTERS[b % LETTERS.length]).join("");
    return `${letters.slice(0, 4)}-${letters.slice(4)}`;
}

const VIDEO_MATRIX = [
    { quality: "720p", duration: 5, ours_usd: 0.4, ours_usd_per_second: 0.08, audio: false },
    { quality: "1080p", duration: 5, ours_usd: 0.7, ours_usd_per_second: 0.14, audio: false },
];
/** Story film's models (2026-10-31 catalog): the 2K image model that takes reference images, and its default video model. */
const PRO_IMAGE_TIERS = [
    { quality: null, size: null, usd: 0.05 }, { quality: null, size: "1K", usd: 0.05 }, { quality: null, size: "2K", usd: 0.05 }, { quality: null, size: "4K", usd: 0.09 },
];
const MINI_MATRIX = [
    { quality: "720p", duration: 5, ours_usd: 0.26, ours_usd_per_second: 0.052, audio: false },
    { quality: "1080p", duration: 5, ours_usd: 0.6, ours_usd_per_second: 0.12, audio: false },
];
// Seedance 2.5 as /v1 sells it (per 5 s, no sound): story film's default video model.
const SEEDANCE_25_MATRIX = [
    { quality: "480p", duration: 5, ours_usd: 1.43325, ours_usd_per_second: 0.28665, audio: false },
    { quality: "720p", duration: 5, ours_usd: 3.0745, ours_usd_per_second: 0.6149, audio: false },
    { quality: "1080p", duration: 5, ours_usd: 7.566, ours_usd_per_second: 1.5132, audio: false },
];
/** Seedance 2.5's reference videos as /v1 publishes them (GET /v1/models `reference_videos`, 2026-10-31). */
export const FAKE_REFERENCE_VIDEOS = Object.freeze({
    max_count: 3, min_seconds: 2.0, max_seconds: 30.0, max_total_seconds: 30.0, max_mb: 60, formats: ["mp4", "mov"],
    min_side: 300, max_side: 6000, min_pixels: 409600, min_fps: 24.0, max_fps: 60.0, modes: ["reference", "editing", "extension"],
    billed_on: "reference video seconds + output seconds", edit_min_seconds: 4.0,
});
/** Per second of output plus reference with reference videos, per quality (the live rows: usd ÷ (4 + reference seconds)). */
const SEEDANCE_25_REFERENCE_RATES: Record<string, number> = { "480p": 0.17199, "720p": 0.36894, "1080p": 0.90792 };
const SEEDANCE_25_REFERENCE_ROWS = Object.entries(SEEDANCE_25_REFERENCE_RATES).flatMap(([quality, rate]) => [2, 5, 10, 15, 30].map((seconds) => ({
    quality, duration: 4, reference_video_seconds: seconds, usd: Math.round(rate * (4 + seconds) * 1e6) / 1e6,
})));
const MODELS: Record<string, Array<Record<string, unknown>>> = {
    image: [
        { id: "nano-banana-2", name: "Nano Banana 2", price: { from_usd: 0.039, per_input_image_usd: 0.002, unit: "image" } },
        { id: "seedream-4", name: "Seedream 4", price: { from_usd: 0.03, unit: "image" } },
        { id: "nano-banana-pro", name: "Nano Banana Pro", sizes: ["1K", "2K", "4K"], price: { from_usd: 0.05, per_input_image_usd: 0.002, unit: "image", tiers: PRO_IMAGE_TIERS } },
    ],
    video: [
        { id: "kling-3", name: "Kling 3", durations: [5, 10], price: { from_usd: 0.4, matrix: VIDEO_MATRIX } },
        { id: "seedance-2", name: "Seedance 2", durations: [5, 10], price: { from_usd: 0.5, matrix: [{ quality: "720p", duration: 5, ours_usd: 0.5, ours_usd_per_second: 0.1, audio: false }] } },
        { id: "seedance-2-mini", name: "Seedance 2 Mini", durations: [4, 5, 6, 8, 10, 12, 15], qualities: ["720p", "1080p"], price: { from_usd: 0.26, matrix: MINI_MATRIX } },
        {
            id: "seedance-2-5", name: "Seedance 2.5", durations: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], qualities: ["480p", "720p", "1080p"],
            inputs: ["text", "image", "start_end", "reference_images", "reference_videos"], reference_videos: FAKE_REFERENCE_VIDEOS,
            price: { from_usd: 1.43325, matrix: SEEDANCE_25_MATRIX, reference_videos: SEEDANCE_25_REFERENCE_ROWS },
        },
        { id: "kling-o3", name: "Kling O3", durations: [5, 10], qualities: ["720p", "1080p"], price: { from_usd: 0.6, matrix: [{ quality: "720p", duration: 5, ours_usd: 0.6, ours_usd_per_second: 0.12, audio: false }, { quality: "1080p", duration: 5, ours_usd: 0.9, ours_usd_per_second: 0.18, audio: false }] } },
    ],
    text: [
        { id: "text-fast", name: "Text Fast", vision: false, price: { unit: "tokens", input_usd: 0.1, output_usd: 0.4 } },
        { id: "text-vision", name: "Text Vision", vision: true, price: { unit: "tokens", input_usd: 1, output_usd: 5 } },
    ],
    voice: [{ id: "kokoro", name: "Kokoro", price: { billing_block_characters: 1000, minimum_usd: 0.026 } }],
    music: [
        { id: "ace-step", name: "ACE-Step", endpoint: "/v1/music/generations", price: { from_usd: 0.0156 } },
        { id: "demucs", name: "Demucs", endpoint: "/v1/audio/separations", capabilities: ["edit"], price: { minimum_usd: 0.01, base_usd: 0.0115, per_minute_usd: 0.0023 } },
    ],
};

const VOICES = [
    { id: "heart", object: "voice", model: "kokoro", name: "Heart", language: "en-US", gender: "female", preview_url: null },
    { id: "adam", object: "voice", model: "kokoro", name: "Adam", language: "en-US", gender: "male", preview_url: null },
    { id: "emma", object: "voice", model: "kokoro", name: "Emma", language: "en-GB", gender: "female", preview_url: null },
];

interface ToolRow {
    id: string;
    category: string;
    path: string;
    mcp: string;
    summary: string;
    price: Record<string, unknown>;
    /** The tool's fixed stage list, shown while it runs. */
    stages: string[];
    scope: string;
}

const TOOL_ROWS: ToolRow[] = [
    {
        id: "transcribe", category: "voice", path: "/v1/audio/transcriptions", mcp: "transcribe_audio", scope: "api:voice", stages: ["reading", "transcribing"],
        summary: "Transcribe the speech in an audio or video file: text, language, timed segments, word timings and SRT (paid per started minute)",
        price: { unit: "source_minute", per: "minute", usd: FAKE_TOOL_PRICES.transcribe, max_minutes: 30 },
    },
    {
        id: "caption-translate", category: "voice", path: "/v1/captions/translations", mcp: "translate_captions", scope: "api:voice", stages: ["translating"],
        summary: "Translate timed captions into another language, keeping every line's timing (paid per 1,000 characters)",
        price: { unit: "thousand_characters", per: "1000 characters", usd: FAKE_TOOL_PRICES["caption-translate"], max_characters: 30000, max_segments: 2000, segment_overhead_characters: 10 },
    },
    {
        id: "voice-isolation", category: "voice", path: "/v1/audio/isolations", mcp: "isolate_voice", scope: "api:voice", stages: ["reading", "isolating"],
        summary: "Keep the voice in an audio or video file and remove the noise, music and room around it (paid per started minute)",
        price: { unit: "source_minute", per: "minute", usd: FAKE_TOOL_PRICES["voice-isolation"], max_minutes: 10 },
    },
    {
        id: "video-upscale", category: "video", path: "/v1/videos/upscales", mcp: "upscale_video", scope: "api:video", stages: ["reading", "upscaling"],
        summary: "Upscale a video to 1080p, 2K or 4K with sharper detail (paid per second of video, by size)",
        price: {
            unit: "video_second", per: "second", usd: FAKE_TOOL_PRICES["video-upscale"]["1080p"], max_seconds: 60,
            tiers: (["1080p", "2k", "4k"] as const).map((resolution) => ({ resolution, usd: FAKE_TOOL_PRICES["video-upscale"][resolution] })),
        },
    },
    {
        id: "remove-background", category: "video", path: "/v1/videos/background-removals", mcp: "remove_background", scope: "api:video", stages: ["reading", "matting"],
        summary: "Keep the people in a video and remove the background, as transparent video or a solid colour (paid per second of video)",
        price: { unit: "video_second", per: "second", usd: FAKE_TOOL_PRICES["remove-background"], max_seconds: 120 },
    },
    {
        id: "lipsync", category: "video", path: "/v1/videos/lipsync", mcp: "lipsync_video", scope: "api:video", stages: ["reading", "syncing"],
        summary: "Make the mouth in a video follow a new speech track (paid per second of audio)",
        price: { unit: "audio_second", per: "second", usd: FAKE_TOOL_PRICES.lipsync, max_seconds: 60 },
    },
    {
        id: "sound-effects", category: "music", path: "/v1/audio/sound-effects", mcp: "generate_sfx", scope: "api:music", stages: [],
        summary: "A sound effect from a description: footsteps, rain, a door, a whoosh (paid per second of sound)",
        price: { unit: "sound_second", per: "second", usd: FAKE_TOOL_PRICES["sound-effects"], max_seconds: 22, max_usd: 0.0572 },
    },
];
const SEPARATION_ROW = { id: "separation", path: "/v1/audio/separations", scope: "api:music", stages: ["separation"] };
const TASK_TOOLS: Array<{ id: FakeToolId; path: string; scope: string; stages: string[] }> = [
    ...TOOL_ROWS.filter((row) => row.id !== "sound-effects").map((row) => ({ id: row.id as FakeToolId, path: row.path, scope: row.scope, stages: row.stages })),
    SEPARATION_ROW as { id: FakeToolId; path: string; scope: string; stages: string[] },
];

const TRANSCRIPT = {
    text: "Hello there. How are you?",
    duration_s: 2.4,
    segments: [{ start: 0.1, end: 1.0, text: "Hello there." }, { start: 1.2, end: 2.3, text: "How are you?" }],
    words: [
        { text: "Hello", start: 0.1, end: 0.4 }, { text: "there.", start: 0.5, end: 1.0 },
        { text: "How", start: 1.2, end: 1.5 }, { text: "are", start: 1.6, end: 1.8 }, { text: "you?", start: 1.9, end: 2.3 },
    ],
    srt: "1\n00:00:00,100 --> 00:00:01,000\nHello there.\n\n2\n00:00:01,200 --> 00:00:02,300\nHow are you?\n",
};

function isLoopbackOrigin(origin: string | undefined): origin is string {
    return typeof origin === "string" && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin);
}

function approvalPage(base: string, code: string, signup: boolean): string {
    const safe = code.replace(/[^A-Z-]/g, "");
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Approve OpenNan Studio</title>
<style>body{font:15px system-ui;background:#0a0c0f;color:#eef;display:grid;place-items:center;height:100vh;margin:0}main{text-align:center}code{font-size:28px;letter-spacing:.2em}button{font:inherit;padding:8px 18px;margin:6px;border-radius:999px;cursor:pointer}</style></head>
<body><main><h1>${signup ? "Create your OpenNan account" : "Approve OpenNan Studio"}</h1><p>Check that the code matches the one in Studio.</p><p><code id="code">${safe}</code></p>
<button id="approve">Approve</button><button id="deny">Deny</button><p id="done" hidden>Return to OpenNan Studio: it connects automatically. You can close this tab.</p></main>
<script>
const act = (what) => fetch(${JSON.stringify(base)} + "/__test/" + what + "/" + ${JSON.stringify(safe)}, { method: "POST" }).then(() => { document.getElementById("done").hidden = false; });
document.getElementById("approve").onclick = () => act("approve");
document.getElementById("deny").onclick = () => act("deny");
</script></body></html>`;
}

// ── strict bodies (like the server's pydantic models: unknown fields are a 400) ─────────────────────────────────

class BodyError extends Error {}

function strict(body: Record<string, unknown>, allowed: string[]): void {
    for (const key of Object.keys(body)) if (!allowed.includes(key)) throw new BodyError(`${key}: extra inputs are not permitted`);
}

const LANGUAGE = /^[A-Za-z]{2,3}$/;
const CAPTION_LANGUAGE = /^[A-Za-z]{2,3}(-([A-Za-z]{2}|[0-9]{3}|[A-Za-z]{4}))?$/;

function checkBody(tool: FakeToolId, body: Record<string, unknown>, base: string): void {
    const url = (name: string, required = true) => {
        const value = body[name];
        if (value === undefined && !required) return;
        if (typeof value !== "string" || value.length > 2048) throw new BodyError(`${name}: field required (an https URL)`);
        if (!value.startsWith("https://") && !value.startsWith(`${base}/`)) throw new BodyError(`${name}: must be an https URL`);
    };
    const oneOf = (name: string, values: string[]) => {
        if (body[name] !== undefined && !values.includes(body[name] as string)) throw new BodyError(`${name}: must be one of ${values.join(", ")}`);
    };
    url("callback_url", false);
    switch (tool) {
        case "transcribe":
            strict(body, ["audio_url", "language", "callback_url"]);
            url("audio_url");
            if (body.language !== undefined && body.language !== null && (typeof body.language !== "string" || !LANGUAGE.test(body.language))) {
                throw new BodyError("language: must be a 2- or 3-letter language code, e.g. en, th, ja");
            }
            return;
        case "voice-isolation":
            strict(body, ["audio_url", "callback_url"]);
            url("audio_url");
            return;
        case "video-upscale":
            strict(body, ["video_url", "resolution", "callback_url"]);
            url("video_url");
            oneOf("resolution", ["1080p", "2k", "4k"]);
            return;
        case "remove-background":
            strict(body, ["video_url", "background", "callback_url"]);
            url("video_url");
            oneOf("background", ["transparent", "green", "blue", "black", "white"]);
            return;
        case "lipsync":
            strict(body, ["video_url", "audio_url", "callback_url"]);
            url("video_url");
            url("audio_url");
            return;
        case "separation":
            strict(body, ["model", "audio_url", "stems", "callback_url"]);
            url("audio_url");
            oneOf("model", ["demucs"]);
            oneOf("stems", ["vocals", "all"]);
            return;
        case "caption-translate": {
            strict(body, ["segments", "target_language", "source_language", "callback_url"]);
            const segments = body.segments;
            if (!Array.isArray(segments) || segments.length < 1 || segments.length > 2000) throw new BodyError("segments: 1 to 2,000 lines");
            let total = 0;
            for (const segment of segments as Array<Record<string, unknown>>) {
                if (typeof segment !== "object" || segment === null) throw new BodyError("segments: each line is { start, end, text }");
                strict(segment, ["start", "end", "text"]);
                const { start, end, text } = segment;
                if (typeof start !== "number" || typeof end !== "number" || start < 0 || end < 0 || start > 86400 || end > 86400) throw new BodyError("segments: start and end are seconds");
                if (end < start) throw new BodyError("segments: end must not come before start");
                if (typeof text !== "string" || text.length < 1 || [...text].length > 500 || !text.trim()) throw new BodyError("segments: text is 1 to 500 characters");
                total += text.length;
            }
            if (total > 30000) throw new BodyError("segments: the captions hold more than 30,000 characters");
            for (const name of ["target_language", "source_language"]) {
                const value = body[name];
                if (value === undefined && name === "source_language") continue;
                if (typeof value !== "string" || value.length > 16 || !CAPTION_LANGUAGE.test(value)) throw new BodyError(`${name}: must be a language code, e.g. th, ja, zh-TW, pt-BR`);
            }
            return;
        }
    }
}

function captionLanguage(value: string): string {
    const [lang, region] = value.split("-");
    if (!region) return lang!.toLowerCase();
    return `${lang!.toLowerCase()}-${region.length === 4 ? region[0]!.toUpperCase() + region.slice(1).toLowerCase() : region.toUpperCase()}`;
}

/**
 * Story film's cast check (a system message that starts "Check one keyframe") without a queued reply: every listed
 * character ("- id (image n)") matches its sheet. Queue a reply to make one miss.
 */
function castCheckReply(messages: Array<{ content?: unknown }>, prompt: string): string | null {
    const system = messages.find((m) => typeof m.content === "string" && m.content.startsWith("Check one keyframe"));
    if (!system) return null;
    const ids = [...prompt.matchAll(/^- ([a-z0-9_-]+) \(image \d+\)/gm)].map((m) => m[1]);
    return JSON.stringify({ characters: ids.map((id) => ({ id, match: true, reason: "" })) });
}

export async function startFakeOpenNan(options: FakeOpenNanOptions = {}): Promise<FakeOpenNan> {
    const interval = options.intervalSeconds ?? 3;
    const expiresIn = options.expiresInSeconds ?? 600;
    let devices: Device[] = [];
    let keys = new Map<string, Key>();
    let tasks = new Map<string, Task>();
    let requests: FakeRequest[] = [];
    let balance = FAKE_BALANCE_USD;
    let accountId: string | null = FAKE_ACCOUNT_ID;
    let start429: number | null = null;
    let serial = 0;
    let base = "";
    // ── knobs ──
    let keyScopes: string[] = [...FAKE_STUDIO_SCOPES];
    let failNext = new Map<string, string>();
    let paidStarted = new Set<string>();
    let toolStatus = new Map<string, string>();
    let dropTranslatedLine = false;
    let taskSteps = 1;
    let quotesStatus: "live" | "404" | "429" | "503" = "live";
    let cancelBusy = 0;
    let chatReplies: string[] = [];

    const mint = (name: string, expiresAt: string | null = null) => {
        const key = `sk-fake_${randomBytes(24).toString("hex")}`;
        keys.set(key, { id: `key_${++serial}`, name, revoked: false, expiresAt, scopes: [...keyScopes] });
        return key;
    };
    const find = (code?: string) => (code ? devices.find((d) => d.userCode === code) : devices[devices.length - 1]);
    const setStatus = (status: Device["status"], code?: string) => {
        const device = find(code);
        if (!device || device.status !== "pending") return false;
        device.status = status;
        return true;
    };

    const cloudServer = createFakeCloud(() => base, { ownerName: () => FAKE_ACCOUNT.display_name });
    const directorServer = createFakeDirector({
        base: () => base,
        cloud: cloudServer,
        balance: () => balance,
        charge(usd) {
            balance = round6(balance - usd);
        },
        nextTaskId: () => `task_${++serial}`,
        taskSteps: () => taskSteps,
        takeFail(tool) {
            const kind = failNext.get(tool);
            failNext.delete(tool);
            return kind;
        },
        paidStarted: (tool) => paidStarted.has(tool),
        takeCancelBusy() {
            if (cancelBusy <= 0) return false;
            cancelBusy -= 1;
            return true;
        },
        publicErrors: FAKE_PUBLIC_ERRORS,
        texts: { cancelled: CANCELLED_MESSAGE, cancelConflict: CANCEL_CONFLICT, cancelBusy: CANCEL_BUSY },
    });

    const server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
            const delayMs = cloudServer.network(new URL(req.url ?? "/", base).pathname).delayMs;
            if (delayMs > 0) setTimeout(respond, delayMs);
            else respond();
        });

        function respond() {
            const url = new URL(req.url ?? "/", base);
            const origin = req.headers.origin;
            const cors: Record<string, string> = isLoopbackOrigin(origin)
                ? {
                    "access-control-allow-origin": origin, "access-control-allow-headers": "authorization, content-type, idempotency-key, if-match, if-none-match",
                    "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS", "access-control-expose-headers": "etag, retry-after", vary: "Origin",
                }
                : {};
            const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
                res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...cors, ...headers });
                res.end(JSON.stringify(body));
            };
            const raw = (status: number, body: Buffer | string, type: string) => {
                res.writeHead(status, { "content-type": type, "cache-control": "no-store", ...cors });
                res.end(body);
            };
            const fail = (status: number, code: string, message = code, headers: Record<string, string> = {}) => send(status, { error: { type: typeOf(status), message, code } }, headers);
            // Like the server: an error without a code of its own carries its type's default.
            const refuse = (status: number, type: string, message: string, code: string | null = null, headers: Record<string, string> = {}) => send(status, { error: { type, message, code: code ?? FAKE_DEFAULT_CODES[type] ?? type } }, headers);
            if (req.method === "OPTIONS") {
                res.writeHead(204, cors);
                res.end();
                return;
            }
            const path = url.pathname;
            const bearer = req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice(7) : null;
            const idempotency = typeof req.headers["idempotency-key"] === "string" ? req.headers["idempotency-key"] : undefined;
            const answer = (a: CloudAnswer) => {
                const headers = { "cache-control": "no-store", ...cors, ...(a.headers ?? {}) };
                if (a.bytes) {
                    res.writeHead(a.status, { "content-type": a.contentType ?? "application/octet-stream", ...headers });
                    res.end(a.bytes);
                } else if (a.json !== undefined) {
                    res.writeHead(a.status, { "content-type": "application/json", ...headers });
                    res.end(JSON.stringify(a.json));
                } else {
                    res.writeHead(a.status, headers);
                    res.end();
                }
            };

            // ── the network knobs (offline, latency) of /v1, /u and /files ──
            const offline = cloudServer.network(path).offline;
            if (offline !== null) {
                requests.push({ method: req.method ?? "GET", path, at: Date.now(), authorized: req.headers.authorization !== undefined });
                if (offline === "drop") {
                    req.socket.destroy();
                    return;
                }
                return refuse(503, "unavailable", "OpenNan is not reachable right now.");
            }

            // ── the upload gateway and the old presigned storage path (bytes, not JSON; the key never comes here) ──
            if (req.method === "PUT" && (path.startsWith("/u/") || path.startsWith("/__uploads/"))) {
                requests.push({ method: "PUT", path, at: Date.now(), authorized: req.headers.authorization !== undefined });
                const stored = cloudServer.gateway({ method: "PUT", path, query: url.searchParams, headers: req.headers, body: undefined, raw: Buffer.concat(chunks) });
                return stored ? answer(stored) : fail(404, "not_found");
            }

            let body: Record<string, unknown> = {};
            if (chunks.length > 0) {
                try {
                    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
                } catch {
                    fail(400, "invalid_json");
                    return;
                }
            }
            if (!path.startsWith("/__test/")) {
                requests.push({
                    method: req.method ?? "GET", path, at: Date.now(), authorized: bearer !== null,
                    ...(path.startsWith("/v1/auth") || chunks.length === 0 ? {} : { body }), ...(idempotency !== undefined ? { idempotencyKey: idempotency } : {}),
                });
            }
            const keyOf = () => {
                const key = bearer ? keys.get(bearer) : undefined;
                return key && !key.revoked ? key : null;
            };

            // ── control ──
            const control = /^\/__test\/(approve|deny|expire)\/([A-Z-]+)$/.exec(path);
            if (control) {
                const ok = setStatus(control[1] === "approve" ? "approved" : control[1] === "deny" ? "denied" : "expired", control[2]);
                send(ok ? 200 : 404, { ok });
                return;
            }
            if (path === "/__test/approve-latest") return send(200, { ok: setStatus("approved") });
            if (path === "/__test/start-429") {
                start429 = Number(url.searchParams.get("retry") ?? "3");
                return send(200, { ok: true });
            }
            if (path === "/__test/account") {
                const id = url.searchParams.get("id");
                accountId = id === null ? FAKE_ACCOUNT_ID : id === "none" ? null : id.slice(0, 200);
                return send(200, { ok: true, accountId });
            }
            if (path === "/__test/balance") {
                balance = Number(url.searchParams.get("usd") ?? FAKE_BALANCE_USD);
                return send(200, { ok: true, balanceUsd: balance });
            }
            if (path === "/__test/key-scopes") {
                const scopes = url.searchParams.get("scopes");
                keyScopes = scopes === null ? [...FAKE_STUDIO_SCOPES] : scopes.split(",").map((s) => s.trim()).filter(Boolean);
                return send(200, { ok: true, scopes: keyScopes });
            }
            if (path === "/__test/fail-next") {
                const tool = url.searchParams.get("tool") ?? "";
                const kind = url.searchParams.get("kind") ?? "pipeline_failed";
                if (!TASK_TOOLS.some((t) => t.id === tool) && !(FAKE_PROJECT_TOOL_IDS as readonly string[]).includes(tool)) return send(400, { ok: false, error: `unknown tool ${tool}` });
                failNext.set(tool, kind);
                return send(200, { ok: true });
            }
            if (path === "/__test/paid-started") {
                const tool = url.searchParams.get("tool") ?? "";
                if (url.searchParams.get("off") === "1") paidStarted.delete(tool);
                else paidStarted.add(tool);
                return send(200, { ok: true });
            }
            if (path === "/__test/tool-status") {
                const id = url.searchParams.get("id") ?? "";
                const status = url.searchParams.get("status") ?? "live";
                if (!TOOL_ROWS.some((row) => row.id === id) || !["live", "unavailable", "soon"].includes(status)) return send(400, { ok: false });
                if (status === "live") toolStatus.delete(id);
                else toolStatus.set(id, status);
                return send(200, { ok: true });
            }
            if (path === "/__test/drop-translated-line") {
                dropTranslatedLine = true;
                return send(200, { ok: true });
            }
            if (path === "/__test/task-steps") {
                const n = Number(url.searchParams.get("n") ?? "1");
                taskSteps = Number.isInteger(n) && n >= 1 && n <= 1000 ? n : 1;
                return send(200, { ok: true, steps: taskSteps });
            }
            if (path === "/__test/quotes") {
                const status = url.searchParams.get("status") ?? "live";
                if (!["live", "404", "429", "503"].includes(status)) return send(400, { ok: false });
                quotesStatus = status as typeof quotesStatus;
                return send(200, { ok: true, status });
            }
            if (path === "/__test/cancel-busy") {
                const n = Number(url.searchParams.get("n") ?? "1");
                cancelBusy = Number.isInteger(n) && n >= 0 && n <= 100 ? n : 1;
                return send(200, { ok: true, n: cancelBusy });
            }
            if (path === "/__test/chat-reply") {
                if (typeof body.text !== "string") return send(400, { ok: false });
                chatReplies.push(body.text);
                return send(200, { ok: true, queued: chatReplies.length });
            }
            if (path === "/__test/reset") {
                handle.reset();
                return send(200, { ok: true });
            }
            if (path === "/__test/state") return send(200, handle.state());
            if (path.startsWith("/__test/director/") || path === "/__test/tasks/finish") {
                const knobAnswer = directorServer.knob(path, url.searchParams, chunks.length > 0 ? body : undefined);
                return knobAnswer ? answer(knobAnswer) : send(404, { ok: false, error: `unknown director knob ${path}` });
            }
            const cloudKnob = /^\/__test\/cloud\/([a-z0-9-]+)$/.exec(path);
            if (cloudKnob) {
                const knobAnswer = cloudServer.knob(cloudKnob[1]!, req.method ?? "GET", chunks.length > 0 ? body : undefined);
                return knobAnswer ? answer(knobAnswer) : send(404, { ok: false, error: `unknown cloud knob ${cloudKnob[1]}` });
            }

            // ── console pages and files ──
            if (path === "/console/device") {
                const code = url.searchParams.get("code") ?? "";
                return raw(200, approvalPage(base, code, url.searchParams.get("signup") === "1"), "text/html; charset=utf-8");
            }
            const page = /^\/console\/(billing|usage|keys)$/.exec(path);
            if (page) return raw(200, `<!doctype html><title>OpenNan ${page[1]}</title><h1>OpenNan ${page[1]}</h1>`, "text/html; charset=utf-8");
            if (path === "/files/generated.png") return raw(200, PNG, "image/png");
            if (path === "/files/generated.wav") return raw(200, wav(), "audio/wav");
            if (path === "/files/generated.mp4") return raw(200, PNG, "video/mp4");
            if (path === "/files/generated.webm") return raw(200, WEBM, "video/webm");
            const stored = cloudServer.file(path, req.method ?? "GET", typeof req.headers.range === "string" ? req.headers.range : undefined);
            if (stored) return answer(stored);

            // ── device flow ──
            if (path === "/v1/auth/device" && req.method === "POST") {
                if (start429 !== null) {
                    const retry = start429;
                    start429 = null;
                    return fail(429, "rate_limit_exceeded", "Too many sign-in attempts.", { "retry-after": String(retry) });
                }
                const extra = Object.keys(body).filter((k) => !["device_name", "client", "signup"].includes(k));
                if (extra.length > 0) return fail(400, "invalid_request", `Unknown field ${extra[0]}`);
                const device: Device = {
                    deviceCode: randomBytes(16).toString("hex"), userCode: userCode(), status: "pending",
                    client: typeof body.client === "string" ? body.client : null, signup: body.signup === true,
                    deviceName: typeof body.device_name === "string" ? body.device_name : "this device", expiresAt: Date.now() + expiresIn * 1000, polls: [],
                };
                devices.push(device);
                const uri = `${base}/console/device`;
                return send(200, {
                    device_code: device.deviceCode, user_code: device.userCode, verification_uri: uri,
                    verification_uri_complete: `${uri}?code=${device.userCode}${device.signup ? "&signup=1" : ""}`, expires_in: expiresIn, interval,
                });
            }
            if (path === "/v1/auth/device/token" && req.method === "POST") {
                const device = devices.find((d) => d.deviceCode === body.device_code);
                if (!device || device.status === "consumed") return fail(400, "invalid_grant");
                const now = Date.now();
                const last = device.polls[device.polls.length - 1];
                device.polls.push(now);
                if (device.status === "expired" || now > device.expiresAt) return fail(400, "expired_token");
                if (device.status === "denied") return fail(400, "access_denied");
                if (last !== undefined && now - last < (interval - 1) * 1000) return fail(400, "slow_down");
                if (device.status === "pending") return fail(400, "authorization_pending");
                device.status = "consumed";
                const expiresAt = device.client === "web" ? new Date(now + 30 * 86_400_000).toISOString() : null;
                const name = `OpenNan Studio (${device.deviceName})`;
                const key = mint(name, expiresAt);
                const record = keys.get(key)!;
                return send(200, { object: "api_key", token_type: "Bearer", api_key: key, key_id: record.id, name, scopes: [...record.scopes], expires_at: expiresAt });
            }

            // ── public lists (no key) ──
            if (path === "/v1/models" && req.method === "GET") {
                return send(200, { object: "list", data: MODELS[url.searchParams.get("category") ?? ""] ?? [] });
            }
            if (path === "/v1/tools" && req.method === "GET") {
                return send(200, {
                    object: "list",
                    data: [
                        ...TOOL_ROWS.map((row) => {
                            const status = toolStatus.get(row.id) ?? "live";
                            return {
                                id: row.id, object: "tool", kind: "pipeline", category: row.category, method: "POST", path: row.path, status, mcp_tool: row.mcp,
                                free: false, price: status === "live" ? row.price : null, limits: null, summary: row.summary,
                            };
                        }),
                        ...directorServer.toolRows(),
                    ],
                });
            }
            if (path === "/v1/audio/voices" && req.method === "GET") return send(200, { object: "list", data: VOICES });
            if (path === "/v1/quotes" && req.method === "POST") {
                if (quotesStatus === "404") return send(404, { detail: "Not Found" }); // an older server: FastAPI's bare 404
                if (quotesStatus === "429") return refuse(429, "rate_limit_error", "Too many quote requests: at most 120 per minute. Try again in 30 seconds.", null, { "retry-after": "30" });
                if (quotesStatus === "503") return refuse(503, "unavailable", "Quotes are unavailable right now.");
                const directed = directorServer.quote(body, keyOf()?.scopes ?? null);
                if (directed) return answer(directed);
                const quoted = fakeQuote(body);
                return send(quoted.status, quoted.body);
            }

            // ── share links' public routes (phase 9c: the share page, no key) ──
            if (path.startsWith("/v1/shares/")) {
                const shared = cloudServer.publicShares({ method: req.method ?? "GET", path, query: url.searchParams, headers: req.headers, body: chunks.length > 0 ? body : undefined, raw: Buffer.concat(chunks) });
                if (shared) return answer(shared);
            }

            // ── authenticated API ──
            const key = keyOf();
            if (path.startsWith("/v1/") && !key) return refuse(401, "authentication_error", "Invalid or revoked API key.", "invalid_api_key");
            if (path.startsWith("/v1/") && cloudServer.takeExpiredKey()) return refuse(401, "authentication_error", "Invalid or revoked API key.", "invalid_api_key");

            // ── cloud projects and storage (scope api:project) ──
            if (path === "/v1/projects" || path.startsWith("/v1/projects/") || path === "/v1/storage" || path === "/v1/uploads" || path.startsWith("/v1/uploads/")) {
                if (!key!.scopes.includes("api:project")) return refuse(403, "permission_error", "This API key is not allowed to use cloud projects (scope api:project).");
                const cloudAnswer = cloudServer.api({ method: req.method ?? "GET", path, query: url.searchParams, headers: req.headers, body: chunks.length > 0 ? body : undefined, raw: Buffer.concat(chunks) });
                if (cloudAnswer) return answer(cloudAnswer);
                const directed = directorServer.api({
                    method: req.method ?? "GET", path, query: url.searchParams, headers: req.headers, body: chunks.length > 0 ? body : undefined, scopes: key!.scopes, req, res, cors,
                });
                if (directed === "streamed") return;
                if (directed instanceof Promise) {
                    directed.then(answer, () => fail(500, "server_error"));
                    return;
                }
                if (directed) return answer(directed);
            }
            if (path === "/v1/account" && req.method === "GET") {
                const shareBase = cloudServer.shareBaseUrl();
                return send(200, {
                    object: "account", ...(accountId ? { account_id: accountId } : {}), ...FAKE_ACCOUNT, balance_usd: balance,
                    key: { id: key!.id, name: key!.name, scopes: [...key!.scopes], expires_at: key!.expiresAt }, billing_url: `${base}/console/billing`,
                    ...(shareBase !== null ? { share_base_url: shareBase } : {}),
                });
            }
            if (path === "/v1/auth/key" && req.method === "DELETE") {
                key!.revoked = true;
                return send(200, { object: "api_key", id: key!.id, revoked: true });
            }

            // ── phase 11 tool tasks ──
            const tool = req.method === "POST" ? TASK_TOOLS.find((t) => t.path === path) : undefined;
            if (tool) {
                if (!key!.scopes.includes(tool.scope)) return refuse(403, "permission_error", `This API key is not allowed to use this tool (scope ${tool.scope}).`);
                // "soon": the server has no route yet (404); "unavailable": mounted, its backend off (503).
                if (toolStatus.get(tool.id) === "soon") return fail(404, "not_found");
                if (toolStatus.has(tool.id)) return refuse(503, "unavailable", "This tool is temporarily unavailable. You were not charged.");
                try {
                    checkBody(tool.id, body, base);
                } catch (error) {
                    if (error instanceof BodyError) return refuse(400, "invalid_request_error", error.message);
                    throw error;
                }
                if (balance <= 0) return refuse(402, "insufficient_balance", "Your balance is too low for this request.");
                const price = toolPrice(tool.id, body);
                const task: Task = { id: `task_${++serial}`, kind: tool.id === "separation" ? "audio" : "video", step: 0, cancelled: false, price, tool: tool.id, body, queuedSteps: taskSteps };
                const failure = failNext.get(tool.id);
                if (failure !== undefined) {
                    task.fail = failure;
                    failNext.delete(tool.id);
                }
                if (tool.id === "caption-translate" && dropTranslatedLine) {
                    task.dropLine = true;
                    dropTranslatedLine = false;
                }
                tasks.set(task.id, task);
                return send(202, taskBody(task));
            }

            // ── story film: text (one JSON answer) and the video-site download ──
            if (path === "/v1/chat/completions" && req.method === "POST") {
                if (!key!.scopes.includes("api:text")) return refuse(403, "permission_error", "This API key is not allowed to use text models (scope api:text).");
                const model = (MODELS.text ?? []).find((m) => m.id === body.model);
                if (!model) return refuse(400, "invalid_request_error", `Unknown model ${String(body.model)}.`, "model_not_found");
                const messages = Array.isArray(body.messages) ? (body.messages as Array<{ content?: unknown }>) : [];
                const parts = messages.flatMap((m) => (Array.isArray(m.content) ? (m.content as Array<Record<string, unknown>>) : [{ type: "text", text: m.content }]));
                const images = parts.filter((p) => p.type === "image_url").length;
                if (images > 0 && model.vision !== true) return refuse(400, "invalid_request_error", `${String(body.model)} does not take images.`, "images_not_supported");
                if (balance <= 0) return refuse(402, "insufficient_balance", "Your balance is too low for this request.");
                const prompt = parts.map((p) => (typeof p.text === "string" ? p.text : "")).join("\n");
                const reply = chatReplies.shift() ?? castCheckReply(messages, prompt) ?? `Echo: ${prompt.slice(0, 200)}`;
                const promptTokens = Math.ceil(prompt.length / 3) + images * 1000;
                const completionTokens = Math.ceil(reply.length / 3);
                const rate = model.price as { input_usd: number; output_usd: number };
                const cost = round6((promptTokens * rate.input_usd + completionTokens * rate.output_usd) / 1_000_000);
                balance = round6(balance - cost);
                return send(200, {
                    id: `chatcmpl_${++serial}`, object: "chat.completion", created: Math.floor(Date.now() / 1000), model: body.model,
                    choices: [{ index: 0, message: { role: "assistant", content: reply }, finish_reason: "stop" }],
                    usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens, cost_usd: cost },
                });
            }
            if (path === "/v1/media/video-download" && req.method === "POST") {
                if (typeof body.url !== "string" || !/^https:\/\/([a-z0-9-]+\.)*(youtube\.com|youtu\.be|instagram\.com|tiktok\.com|vimeo\.com|x\.com)\//.test(body.url)) {
                    return refuse(400, "invalid_request_error", "OpenNan's proxy takes supported video-site https links.", "download_unsupported");
                }
                return raw(200, WEBM, "video/mp4");
            }

            const generation = /^\/v1\/(images|videos|music)\/generations$/.exec(path);
            if (generation && req.method === "POST") {
                // The server's music limits (10 to 240 seconds).
                if (generation[1] === "music" && body.duration !== undefined && (typeof body.duration !== "number" || body.duration < 10 || body.duration > 240)) {
                    return refuse(400, "invalid_request_error", "duration: 10-240 seconds.");
                }
                if (balance <= 0) return refuse(402, "insufficient_balance", "Your balance is too low for this request.");
                const kind = generation[1] === "images" ? "image" : generation[1] === "videos" ? "video" : "audio";
                // Settles at its quote (the same function, as on the server); a tier the fake does not sell is refused.
                const category = kind === "image" ? "image" : kind === "video" ? "video" : "music";
                const model = typeof body.model === "string" ? body.model : (MODELS[category]?.[0]?.id as string);
                // Reference videos: the server measures each file it fetches (length, picture) and refuses one out of
                // the model's limits before anything is charged; the call settles on the seconds it measured.
                let measured: number | undefined;
                if (kind === "video" && body.reference_videos !== undefined) {
                    if (body.seconds !== undefined) return refuse(400, "invalid_request_error", "seconds: not a field of a generation (the server measures the reference videos).");
                    const row = (MODELS.video ?? []).find((m) => m.id === model);
                    const limits = row?.reference_videos as typeof FAKE_REFERENCE_VIDEOS | undefined;
                    if (!limits) return refuse(400, "invalid_request_error", `reference_videos: not a field of ${model}.`);
                    const links = Array.isArray(body.reference_videos) ? body.reference_videos : [];
                    let total = 0;
                    for (const link of links) {
                        const bytes = typeof link === "string" ? cloudServer.bytesAt(link) : undefined;
                        if (!bytes) continue;
                        const facts = fakeMp4Facts(bytes);
                        if (facts.seconds !== undefined && (facts.seconds < limits.min_seconds || facts.seconds > limits.max_seconds)) {
                            return refuse(400, "invalid_request_error", `Each reference video must be ${limits.min_seconds}-${limits.max_seconds} seconds.`, "input_invalid");
                        }
                        if (facts.width && facts.height && (facts.width * facts.height < limits.min_pixels || Math.min(facts.width, facts.height) < limits.min_side || Math.max(facts.width, facts.height) > limits.max_side)) {
                            return refuse(400, "invalid_request_error", `A reference video's picture is ${facts.width}x${facts.height}: it needs ${limits.min_pixels} pixels a frame and sides of ${limits.min_side}-${limits.max_side} px.`, "input_invalid");
                        }
                        total = facts.seconds === undefined ? Number.NaN : total + facts.seconds;
                    }
                    if (Number.isFinite(total) && total > limits.max_total_seconds) return refuse(400, "invalid_request_error", "reference videos must total 2-30 seconds", "input_invalid");
                    const first = typeof links[0] === "string" ? cloudServer.bytesAt(links[0]) : undefined;
                    const firstSeconds = first ? fakeMp4Facts(first).seconds : undefined;
                    if (body.reference_mode === "editing" && firstSeconds !== undefined && firstSeconds < limits.edit_min_seconds) {
                        return refuse(400, "invalid_request_error", `An edit needs a first video of at least ${limits.edit_min_seconds} seconds.`, "input_invalid");
                    }
                    if (Number.isFinite(total) && total > 0) measured = Math.max(limits.min_seconds, total);
                }
                const quoted = fakeQuote({ ...quoteFieldsOf(category, model, body), ...(measured !== undefined ? { seconds: measured } : {}) });
                if (quoted.status === 400 && kind === "video" && body.reference_videos !== undefined) return send(400, quoted.body);
                if (quoted.status === 400 && (quoted.body.error as { code?: string }).code === "tier_not_offered") return send(400, quoted.body);
                const price = quoted.status === 200 ? (quoted.body.price_usd as number) : kind === "image" ? 0.04 : 0.5;
                const task: Task = { id: `task_${++serial}`, kind, step: 0, cancelled: false, price, queuedSteps: taskSteps };
                tasks.set(task.id, task);
                return send(202, taskBody(task));
            }
            const taskPath = /^\/v1\/tasks\/([^/]+)(\/cancel)?$/.exec(path);
            if (taskPath) {
                const projectTask = directorServer.task(taskPath[1]!, taskPath[2] !== undefined);
                if (projectTask) return answer(projectTask);
                const task = tasks.get(taskPath[1]!);
                if (!task) return fail(404, "not_found");
                if (taskPath[2]) {
                    const status = statusOf(task);
                    if (status === "cancelled") return send(200, taskBody(task));
                    if (status === "succeeded" || status === "failed") return refuse(409, "conflict", CANCEL_CONFLICT, "task_already_finished");
                    if (cancelBusy > 0) {
                        cancelBusy -= 1;
                        return refuse(409, "conflict", CANCEL_BUSY, "task_busy_retry", { "retry-after": "1" });
                    }
                    // Like the server: only a video tool task whose paid step has not started. A model run pays its
                    // supplier when it routes and a separation can't be stopped: never cancellable.
                    const refusable = task.tool === undefined || task.tool === "separation" || (status === "running" && task.paidStarted);
                    if (refusable) return refuse(409, "conflict", CANCEL_CONFLICT, "task_not_cancellable");
                    task.cancelled = true;
                    return send(200, taskBody(task));
                }
                if (statusOf(task) === "queued" || statusOf(task) === "running") task.step += 1;
                if (task.tool && statusOf(task) === "running" && paidStarted.has(task.tool)) task.paidStarted = true;
                return send(200, taskBody(task));
            }
            if (path === "/v1/audio/sound-effects" && req.method === "POST" && body.duration_seconds !== undefined
                && (typeof body.duration_seconds !== "number" || body.duration_seconds < 0.5 || body.duration_seconds > 22)) {
                return refuse(400, "invalid_request_error", "duration_seconds: 0.5 to 22.");
            }
            if ((path === "/v1/audio/speech" || path === "/v1/audio/sound-effects") && req.method === "POST") {
                if (balance <= 0) return refuse(402, "insufficient_balance", "Your balance is too low for this request.");
                return raw(200, wav(), "audio/wav");
            }
            fail(404, "not_found");
        }
    });

    /** Seconds of a WAV uploaded to this fake (data bytes ÷ byte rate), or undefined for anything else. */
    function measuredSeconds(link: unknown): number | undefined {
        if (typeof link !== "string") return undefined;
        const bytes = cloudServer.bytesAt(link);
        if (!bytes || bytes.length < 44 || bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WAVE") return undefined;
        const byteRate = bytes.readUInt32LE(28);
        return byteRate > 0 ? (bytes.length - 44) / byteRate : undefined;
    }

    /**
     * What a tool task settles at: the pricing mirror on the length it reads (a WAV uploaded here) or one unit when
     * it can't measure the file (links, video), and its lines for caption translation.
     */
    function toolPrice(tool: FakeToolId, body: Record<string, unknown>): number {
        if (tool === "separation") {
            const seconds = measuredSeconds(body.audio_url);
            if (seconds === undefined) return FAKE_TOOL_PRICES.separation;
            return fakeQuote({ model: "demucs", seconds: Math.max(0.001, Math.min(900, seconds)) }).body.price_usd as number;
        }
        if (tool === "caption-translate") return fakeToolSettle(tool, { segments: body.segments as Array<{ text: string }> });
        const resolution = tool === "video-upscale" ? ((body.resolution as string | undefined) ?? "1080p") : undefined;
        const seconds = measuredSeconds(tool === "video-upscale" || tool === "remove-background" ? body.video_url : body.audio_url);
        const unit = FAKE_TOOL_UNITS[tool]!.unitSeconds;
        return fakeToolSettle(tool, { seconds: seconds ?? unit, ...(resolution ? { resolution } : {}) });
    }

    /** Steps a task spends running: its stages (one each) or the task-steps knob, whichever is more. */
    function runningSteps(task: Task): number {
        const stages = task.tool ? (TASK_TOOLS.find((t) => t.id === task.tool)?.stages.length ?? 1) : 1;
        return Math.max(task.queuedSteps ?? 1, stages);
    }

    function statusOf(task: Task): "queued" | "running" | "succeeded" | "failed" | "cancelled" {
        if (task.cancelled) return "cancelled";
        const queued = task.queuedSteps ?? 1;
        if (task.step < queued) return "queued";
        if (task.step < queued + runningSteps(task)) return "running";
        return task.fail !== undefined ? "failed" : "succeeded";
    }

    function toolResult(task: Task): unknown {
        const body = task.body ?? {};
        switch (task.tool) {
            case "transcribe":
                return { ...TRANSCRIPT, language: typeof body.language === "string" ? body.language.toLowerCase() : "en" };
            case "caption-translate": {
                const language = captionLanguage(body.target_language as string);
                const segments = body.segments as Array<{ start: number; end: number; text: string }>;
                const dropped = task.dropLine ? segments.length - 1 : -1;
                return {
                    language,
                    segments: segments.map((s, i) => ({ start: s.start, end: s.end, text: i === dropped ? s.text : `[${language}] ${s.text}` })),
                    untranslated: dropped >= 0 ? [dropped] : [],
                };
            }
            case "voice-isolation":
                return { audio_url: `${base}/files/generated.wav`, duration_s: 0.5 };
            case "video-upscale":
            case "remove-background":
            case "lipsync":
                return { video_url: `${base}/files/generated.webm` };
            default:
                return undefined;
        }
    }

    function taskBody(task: Task) {
        const status = statusOf(task);
        const legacyFile = task.kind === "image" ? "generated.png" : task.kind === "video" ? "generated.mp4" : "generated.wav";
        let outputs: unknown[] = [];
        if (status === "succeeded") {
            if (task.tool === "separation") {
                const stems = task.body?.stems === "all" ? ["vocals", "drums", "bass", "other"] : ["vocals", "instrumental"];
                outputs = stems.map((stem) => ({ type: "audio", format: "mp3", url: `${base}/files/generated.wav`, stem }));
            } else if (!task.tool) {
                outputs = [{ type: task.kind, url: `${base}/files/${legacyFile}` }];
            }
        }
        let error: { message: string; refunded: true } | null = null;
        if (status === "cancelled") error = { message: task.tool ? CANCELLED_MESSAGE : "Cancelled.", refunded: true };
        if (status === "failed") error = { message: FAKE_PUBLIC_ERRORS[task.fail ?? "internal"] ?? FAKE_PUBLIC_ERRORS.internal!, refunded: true };
        const body: Record<string, unknown> = {
            id: task.id, object: "task", model: task.tool === "separation" ? "demucs" : (task.tool ?? task.kind), status,
            progress: status === "succeeded" ? 100 : status === "running" ? runningProgress(task) : 0,
            outputs, price_usd: status === "succeeded" ? task.price : 0, created_at: new Date().toISOString(), finished_at: null, error,
        };
        if (status === "running") body.stage = task.tool ? stageOf(task) : "generating";
        if (status === "succeeded" && task.tool && task.tool !== "separation") body.result = toolResult(task);
        return body;
    }

    function runningIndex(task: Task): number {
        return task.step - (task.queuedSteps ?? 1);
    }

    function runningProgress(task: Task): number {
        return task.tool ? Math.round((100 * (runningIndex(task) + 1)) / (runningSteps(task) + 1)) : 50;
    }

    function stageOf(task: Task): string {
        const stages = TASK_TOOLS.find((t) => t.id === task.tool)?.stages ?? [];
        const index = Math.min(stages.length - 1, Math.floor((runningIndex(task) * stages.length) / runningSteps(task)));
        return stages[Math.max(0, index)] ?? "running";
    }

    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(options.port ?? 0, options.host ?? "127.0.0.1", () => resolve());
    });
    const address = server.address() as AddressInfo;
    base = `http://${options.host ?? "127.0.0.1"}:${address.port}`;

    const handle: FakeOpenNan = {
        url: base,
        state: () => ({
            requests: requests.map((r) => ({ ...r })),
            devices: devices.map((d) => ({
                userCode: d.userCode, status: d.status, client: d.client, signup: d.signup, deviceName: d.deviceName,
                pollSpacingsMs: d.polls.slice(1).map((at, i) => at - d.polls[i]!),
            })),
            revokedKeyIds: [...keys.values()].filter((k) => k.revoked).map((k) => k.id),
            balanceUsd: balance,
            latestUserCode: devices[devices.length - 1]?.userCode ?? null,
            uploads: cloudServer.legacyUploads(),
        }),
        reset() {
            devices = [];
            keys = new Map();
            tasks = new Map();
            requests = [];
            balance = FAKE_BALANCE_USD;
            accountId = FAKE_ACCOUNT_ID;
            start429 = null;
            keyScopes = [...FAKE_STUDIO_SCOPES];
            failNext = new Map();
            paidStarted = new Set();
            toolStatus = new Map();
            dropTranslatedLine = false;
            taskSteps = 1;
            quotesStatus = "live";
            cancelBusy = 0;
            chatReplies = [];
            cloudServer.reset();
            directorServer.reset();
        },
        approve: (code) => setStatus("approved", code),
        deny: (code) => setStatus("denied", code),
        expire: (code) => setStatus("expired", code),
        setBalance(usd) {
            balance = usd;
        },
        mintKey: (name = "OpenNan Studio (test)") => mint(name),
        cloud: cloudServer.cloud,
        director: directorServer.director,
        queueChatReply(text) {
            chatReplies.push(text);
        },
        close: () => new Promise<void>((resolve) => {
            directorServer.reset(); // running and held turns stop (their waits end within 50 ms)
            server.closeAllConnections?.();
            server.close(() => resolve());
        }),
    };
    return handle;
}
