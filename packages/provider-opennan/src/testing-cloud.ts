// The fake OpenNan server's cloud project routes (phase 9a), Node only, wired into startFakeOpenNan (testing.ts):
// POST/GET/PATCH/DELETE /v1/projects[/{id}], restore, import, GET .../document (ETag "r<rev>", 304), POST
// .../changes (one atomic changeset: Idempotency-Key replay, If-Match 412, refusals with details, server
// normalisation), uploads v2 (POST /v1/uploads with sha256 / scope / project_id / multipart, dedup per account,
// quota refusals, /complete), the upload gateway (PUT /u/<token>: single use, a second PUT is 410), the CDN
// (GET /files/<key> with ranges), GET /v1/storage, and the /__test/cloud/* knobs Studio's sync tests drive (remote
// edits, locks, deletes, offline, latency, injected failures, 412 storms, storage limits, an expiring key). Bodies,
// ranges, max lengths and nullable sets follow opennan.com's published API contracts for cloud projects, uploads,
// storage and the upload gateway: this fake is how Studio's contract with the server is tested, so it must not drift.
// The fake has one account: every key belongs to it. The fake acts as if the upload gateway is configured.
import { createFakeShares, type FakeShareState } from "./testing-shares";
import { createHash, randomBytes, randomUUID } from "node:crypto";

export interface CloudRequest {
    method: string;
    path: string;
    query: URLSearchParams;
    headers: Record<string, string | string[] | undefined>;
    /** The parsed JSON body (undefined when none came). */
    body: unknown;
    /** The raw body bytes. */
    raw: Buffer;
}

export interface CloudAnswer {
    status: number;
    /** A JSON body (absent for bytes, and for an empty answer such as a 304). */
    json?: unknown;
    bytes?: Buffer;
    contentType?: string;
    headers?: Record<string, string>;
}

/** A refusal of the fake, in the server's error envelope. */
export class FakeCloudError extends Error {
    readonly status: number;
    readonly type: string;
    readonly code: string;
    readonly details?: Record<string, unknown>;
    readonly headers?: Record<string, string>;

    constructor(status: number, type: string, message: string, code: string, details?: Record<string, unknown>, headers?: Record<string, string>) {
        super(message);
        this.name = "FakeCloudError";
        this.status = status;
        this.type = type;
        this.code = code;
        if (details !== undefined) this.details = details;
        if (headers !== undefined) this.headers = headers;
    }

    answer(): CloudAnswer {
        return {
            status: this.status,
            json: { error: { type: this.type, message: this.message, code: this.code, ...(this.details ? { details: this.details } : {}) } },
            ...(this.headers ? { headers: this.headers } : {}),
        };
    }
}

const invalid = (message: string, code = "invalid_request", details?: Record<string, unknown>) => new FakeCloudError(400, "invalid_request_error", message, code, details);
const notFound = (message = "No such project on this account.", code = "not_found", details?: Record<string, unknown>) => new FakeCloudError(404, "not_found", message, code, details);

/** The error type the server gives a status (fail-next-change knob). */
function typeOfStatus(status: number): string {
    switch (status) {
        case 401: return "authentication_error";
        case 402: return "insufficient_balance";
        case 403: return "permission_error";
        case 404: return "not_found";
        case 409: return "conflict";
        case 412: return "precondition_failed";
        case 429: return "rate_limit_error";
        case 503: return "unavailable";
        default: return status >= 500 ? "server_error" : "invalid_request_error";
    }
}

// ── strict bodies: a small transcription of the Pydantic models ──────────────────────────────────────────────────

type Loc = Array<string | number>;
type Kind =
    | { k: "str"; min?: number; max?: number; re?: RegExp }
    | { k: "num"; ge?: number; gt?: number; le?: number }
    | { k: "int"; ge?: number; le?: number }
    | { k: "bool" }
    | { k: "lit"; of: readonly string[] }
    | { k: "media" }
    | { k: "json"; max: number }
    | { k: "list"; of: Kind; max: number; min?: number }
    | { k: "obj"; model: Model };

interface Field {
    kind: Kind;
    /** No default: absent is "Field required". */
    required?: boolean;
    /** Typed `X | None`: null passes the type check (a model's nulls rule may still refuse it). */
    nullable?: boolean;
}

interface Model {
    fields: Record<string, Field>;
    /** _nulls_only: the fields that may be sent as null (the others refuse an explicit null). */
    nulls?: ReadonlySet<string>;
    after?(value: Record<string, unknown>, loc: Loc): void;
}

class BodyError extends Error {}

const where = (loc: Loc) => loc.map(String).join(".");
const fail = (loc: Loc, message: string): never => {
    const at = where(loc);
    throw new BodyError(at ? `${at}: ${message}` : message);
};
const valueError = (loc: Loc, message: string): never => fail(loc, `Value error, ${message}`);
const chars = (value: string) => [...value].length;
const num = (n: number) => String(n);

const str = (max?: number, re?: RegExp, min?: number): Kind => ({ k: "str", ...(max !== undefined ? { max } : {}), ...(re ? { re } : {}), ...(min !== undefined ? { min } : {}) });
const range = (ge?: number, le?: number, gt?: number): Kind => ({ k: "num", ...(ge !== undefined ? { ge } : {}), ...(le !== undefined ? { le } : {}), ...(gt !== undefined ? { gt } : {}) });
const int = (ge?: number, le?: number): Kind => ({ k: "int", ...(ge !== undefined ? { ge } : {}), ...(le !== undefined ? { le } : {}) });
const BOOL: Kind = { k: "bool" };
const MEDIA: Kind = { k: "media" };
const lit = (...of: string[]): Kind => ({ k: "lit", of });
const json = (max: number): Kind => ({ k: "json", max });
const list = (of: Kind, max: number, min?: number): Kind => ({ k: "list", of, max, ...(min !== undefined ? { min } : {}) });
const obj = (model: Model): Kind => ({ k: "obj", model });
const opt = (kind: Kind): Field => ({ kind, nullable: true });
const req = (kind: Kind): Field => ({ kind, required: true });
const def = (kind: Kind): Field => ({ kind });

/** The body model builders, for the fake's other routes (testing-director.ts) that check bodies like the server. */
export const bodyKinds = { str, range, int, BOOL, lit, list, obj, opt, req, def, valueError } as const;
export type BodyModel = Model;
export type BodyLoc = Loc;

export function makeValidator(cdn: () => string) {
    function check(kind: Kind, value: unknown, loc: Loc): unknown {
        switch (kind.k) {
            case "str":
            case "media": {
                if (typeof value !== "string") return fail(loc, "Input should be a valid string");
                const max = kind.k === "media" ? 512 : kind.max;
                const min = kind.k === "str" ? kind.min : undefined;
                if (min !== undefined && chars(value) < min) fail(loc, `String should have at least ${min} character${min === 1 ? "" : "s"}`);
                if (max !== undefined && chars(value) > max) fail(loc, `String should have at most ${max} characters`);
                if (kind.k === "str" && kind.re && !kind.re.test(value)) fail(loc, `String should match pattern '${kind.re.source}'`);
                if (kind.k === "media") {
                    if (!value.startsWith(`${cdn()}/files/`)) valueError(loc, "must be a media_url from POST /v1/uploads or a result URL on our storage");
                    if (value.includes("/uploads/temp/")) valueError(loc, "is a temporary upload: upload it with a project_id (or scope account) to use it in a project");
                }
                return value;
            }
            case "json": {
                if (typeof value !== "string") return fail(loc, "Input should be a valid string");
                if (chars(value) > kind.max) fail(loc, `String should have at most ${kind.max} characters`);
                if (Buffer.byteLength(value) > kind.max) valueError(loc, `must be at most ${kind.max} bytes`);
                let parsed: unknown;
                try {
                    parsed = JSON.parse(value);
                } catch {
                    return valueError(loc, "must be a JSON object");
                }
                if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) valueError(loc, "must be a JSON object");
                return value;
            }
            case "num": {
                if (typeof value !== "number" || !Number.isFinite(value)) return fail(loc, "Input should be a valid number");
                if (kind.gt !== undefined && !(value > kind.gt)) fail(loc, `Input should be greater than ${num(kind.gt)}`);
                if (kind.ge !== undefined && value < kind.ge) fail(loc, `Input should be greater than or equal to ${num(kind.ge)}`);
                if (kind.le !== undefined && value > kind.le) fail(loc, `Input should be less than or equal to ${num(kind.le)}`);
                return value;
            }
            case "int": {
                if (typeof value !== "number" || !Number.isInteger(value)) return fail(loc, "Input should be a valid integer");
                if (kind.ge !== undefined && value < kind.ge) fail(loc, `Input should be greater than or equal to ${kind.ge}`);
                if (kind.le !== undefined && value > kind.le) fail(loc, `Input should be less than or equal to ${kind.le}`);
                return value;
            }
            case "bool":
                if (typeof value !== "boolean") fail(loc, "Input should be a valid boolean");
                return value;
            case "lit":
                if (typeof value !== "string" || !kind.of.includes(value)) {
                    const quoted = kind.of.map((v) => `'${v}'`);
                    fail(loc, `Input should be ${quoted.length > 1 ? `${quoted.slice(0, -1).join(", ")} or ${quoted[quoted.length - 1]}` : quoted[0]}`);
                }
                return value;
            case "list": {
                if (!Array.isArray(value)) return fail(loc, "Input should be a valid list");
                if (value.length > kind.max) fail(loc, `List should have at most ${kind.max} item${kind.max === 1 ? "" : "s"} after validation, not ${value.length}`);
                if (kind.min !== undefined && value.length < kind.min) fail(loc, `List should have at least ${kind.min} item${kind.min === 1 ? "" : "s"} after validation, not ${value.length}`);
                return value.map((item, i) => check(kind.of, item, [...loc, i]));
            }
            case "obj":
                return model(kind.model, value, loc);
        }
    }

    function model(m: Model, value: unknown, loc: Loc): Record<string, unknown> {
        if (typeof value !== "object" || value === null || Array.isArray(value)) return fail(loc, "Input should be a valid dictionary or object to extract fields from");
        const input = value as Record<string, unknown>;
        const out: Record<string, unknown> = {};
        for (const [name, field] of Object.entries(m.fields)) {
            if (!(name in input)) {
                if (field.required) fail([...loc, name], "Field required");
                continue;
            }
            const given = input[name];
            if (given === null) {
                if (!field.nullable) check(field.kind, given, [...loc, name]);
                out[name] = null;
                continue;
            }
            out[name] = check(field.kind, given, [...loc, name]);
        }
        for (const name of Object.keys(input)) {
            if (!(name in m.fields)) throw new BodyError(`Unknown field ${where([...loc, name])}: check its spelling against the endpoint's fields (GET /v1/openapi.json).`);
        }
        if (m.nulls) {
            const bad = Object.keys(out).filter((name) => out[name] === null && !m.nulls!.has(name)).sort();
            if (bad.length > 0) valueError(loc, `${bad[0]} can't be null`);
        }
        m.after?.(out, loc);
        return out;
    }

    return {
        body(m: Model, value: unknown): Record<string, unknown> {
            try {
                return model(m, value ?? undefined, []);
            } catch (error) {
                if (error instanceof BodyError) throw invalid(error.message);
                throw error;
            }
        },
    };
}

// ── the models ───────────────────────────────────────────────────────────

export const CLIENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const PROJECT_ID = /^[A-Za-z0-9_-]{1,36}$/;
const BODY_ID = str(undefined, ID_PATTERN);
const TRACK_TYPES = ["video", "audio", "text", "sticker", "effect", "remotion"] as const;
const ASPECT_RATIOS = ["16:9", "9:16", "1:1", "4:3", "3:4", "4:5", "21:9", "9:21"] as const;
const PRODUCT_TYPES = ["music_video", "podcast", "movie", "short_clip", "youtube_video"] as const;
const QUALITIES = ["480p", "720p", "1080p", "4K"] as const;
const CARD_TYPE = str(undefined, /^[a-z_]{1,30}$/);
const SRT_TIME = str(20, /^[0-9:,.]{1,20}$/);
const MAX_ITEMS = 500;
const MAX_EFFECTS = 50;
export const MAX_PROJECT_SCENES = 1_000;
export const MAX_PROJECT_CLIPS = 5_000;
const MAX_PROJECT_CLIP_TEXT = 32 * 1024 * 1024;
const MAX_IMPORT_SCENES = 500;
const MAX_IMPORT_CLIPS = 5_000;
const MAX_KEY_CHARS = 64;
const MB = 1024 * 1024;
const GB = 1024 * MB;
const PROJECT_DOCUMENT_MAX_BYTES = 8 * MB;
const NEW_PROJECT_MIN_DATA_BYTES = 1 * MB;
const ROW_OVERHEAD = 512;
const CHANGES_MAX_BODY_BYTES = 2 * MB;
const IMPORT_MAX_BODY_BYTES = 8 * MB;

const EFFECT: Model = {
    fields: {
        effect_id: req(str(undefined, /^[A-Za-z0-9_.:-]{1,64}$/)),
        order: def(int(0, 1_000)),
        enabled: def(BOOL),
        params_json: opt(json(8_192)),
    },
};
const EFFECTS = list(obj(EFFECT), MAX_EFFECTS);

/** The clip fields: [name, kind, default, nullable]. The order is ClipView's. */
const CLIP_COLUMNS: ReadonlyArray<readonly [string, Kind, unknown, boolean]> = [
    ["media_url", MEDIA, null, true],
    ["media_type", str(undefined, /^[a-z_]{1,20}$/), "uploaded", false],
    ["scene_id", BODY_ID, null, true],
    ["label", str(255), null, true],
    ["thumbnail_url", MEDIA, null, true],
    ["locked", BOOL, false, false],
    ["volume", range(0, 4), 1.0, false],
    ["audio_pan", range(-1, 1), 0.0, false],
    ["audio_pitch", range(-24, 24), 0.0, false],
    ["audio_eq", str(20), "none", false],
    ["audio_denoise", BOOL, false, false],
    ["audio_normalize", BOOL, false, false],
    ["playback_speed", range(undefined, 100, 0), 1.0, false],
    ["speed_ramp", str(20), "none", false],
    ["reverse_playback", BOOL, false, false],
    ["freeze_frame", BOOL, false, false],
    ["fade_in_duration", range(0, 3_600), 0.0, false],
    ["fade_out_duration", range(0, 3_600), 0.0, false],
    ["transition_type", str(20), "none", false],
    ["transition_duration", range(0, 60), 0.0, false],
    ["opacity", range(0, 1), 1.0, false],
    ["scale", range(undefined, 100, 0), 1.0, false],
    ["position_x", range(-10, 10), 0.5, false],
    ["position_y", range(-10, 10), 0.5, false],
    ["horizontal_flip", BOOL, false, false],
    ["vertical_flip", BOOL, false, false],
    ["crop_left", range(0, 1), 0.0, false],
    ["crop_right", range(0, 1), 0.0, false],
    ["crop_top", range(0, 1), 0.0, false],
    ["crop_bottom", range(0, 1), 0.0, false],
    ["brightness", range(-1, 1), 0.0, false],
    ["contrast", range(0, 4), 1.0, false],
    ["saturation", range(0, 4), 1.0, false],
    ["visual_filter", str(20), "none", false],
    ["motion_preset", str(20), "none", false],
    ["blur_strength", range(0, 100), 0.0, false],
    ["chroma_key_enabled", BOOL, false, false],
    ["chroma_key_color", str(16), "0x00FF00", false],
    ["chroma_key_similarity", range(0, 1), 0.1, false],
    ["chroma_key_blend", range(0, 1), 0.0, false],
    ["blend_mode", str(20), "normal", false],
    ["mosaic_strength", range(0, 100), 0.0, false],
    ["rotation_degrees", range(-3_600, 3_600), 0.0, false],
    ["keyframes_json", str(65_536), null, true],
    ["text_content", str(5_000), null, true],
    ["text_style", str(8_192), null, true],
    ["trim_start", range(0), null, true],
    ["trim_end", range(0), null, true],
    ["remotion_template_id", str(64), null, true],
    ["remotion_props_json", str(65_536), null, true],
    ["transition_params_json", json(8_192), null, true],
    ["custom_graphic_id", str(36, /^[A-Za-z0-9_-]{1,36}$/), null, true],
    ["extras_json", json(65_536), null, true],
];
export const CLIP_NULLABLE: ReadonlySet<string> = new Set(CLIP_COLUMNS.filter(([, , , nullable]) => nullable).map(([name]) => name));
const CLIP_TEXT_FIELDS = ["keyframes_json", "remotion_props_json", "text_style", "text_content"] as const;
const CLIP_DATA_TEXT = ["keyframes_json", "text_content", "text_style", "remotion_props_json", "transition_params_json", "extras_json"] as const;
/** The clip columns a patch writes when not null (ps.COMMAND_UPDATE_FIELDS that /v1 can send). */
const CLIP_UPDATE_FIELDS = ["start_time", "end_time", "track_type", "track_index", ...CLIP_COLUMNS.map(([name]) => name).filter((name) => name !== "scene_id")];

const clipFields = (nullableOnly: boolean): Record<string, Field> =>
    Object.fromEntries(CLIP_COLUMNS.map(([name, kind, , nullable]) => [name, nullableOnly || nullable ? opt(kind) : def(kind)]));

const endAfterStart = (value: Record<string, unknown>, loc: Loc) => {
    if ((value.end_time as number) <= (value.start_time as number)) valueError(loc, "end_time must be after start_time");
};
const clientId = (value: Record<string, unknown>, loc: Loc) => {
    if (typeof value.id === "string" && !CLIENT_ID.test(value.id)) valueError(loc, "id must be a lowercase UUID");
};

const CHANGE_CLIP_CREATE: Model = {
    fields: {
        ...clipFields(false),
        id: req(str()),
        track_type: req(lit(...TRACK_TYPES)),
        track_index: req(int(1, 99)),
        start_time: req(range(0, 86_400)),
        end_time: req(range(undefined, 86_400, 0)),
        effects: opt(EFFECTS),
    },
    after(value, loc) {
        clientId(value, loc);
        endAfterStart(value, loc);
    },
};

const CLIP_PATCH: Model = {
    fields: {
        id: req(BODY_ID),
        start_time: opt(range(0, 86_400)),
        end_time: opt(range(undefined, 86_400, 0)),
        track_type: opt(lit(...TRACK_TYPES)),
        track_index: opt(int(1, 99)),
        ...clipFields(true),
        effects: opt(EFFECTS),
    },
    nulls: new Set([...CLIP_NULLABLE, "id", "effects"]),
};

const SCENE_S4: Record<string, Field> = {
    start_time: opt(SRT_TIME),
    end_time: opt(SRT_TIME),
    card_config: opt(json(16_384)),
    fit_mode: opt(lit("contain", "cover", "fill")),
    transform_scale: opt(range(undefined, 100, 0)),
    transform_offset_x: opt(range(-10, 10)),
    transform_offset_y: opt(range(-10, 10)),
    source_width: opt(int(1, 32_768)),
    source_height: opt(int(1, 32_768)),
    extras_json: opt(json(65_536)),
};

const SCENE_FIELDS: Record<string, Field> = {
    ...SCENE_S4,
    timeline_position_seconds: opt(range(0, 86_400)),
    track_index: opt(int(1, 99)),
    caption: opt(str(5_000)),
    card_type: opt(CARD_TYPE),
    duration: opt(range(undefined, 3_600, 0)),
    visual_transition: opt(str(30)),
    visual_transition_duration: opt(range(0, 10)),
    scene_location: opt(str(100)),
    objects_in_scene: opt(list(str(255), 50)),
    overlay_text: opt(str(2_000)),
    audio_text: opt(str(5_000)),
    music_enabled: opt(BOOL),
    start_image_url: opt(MEDIA),
    end_image_url: opt(MEDIA),
    video_url: opt(MEDIA),
    audio_url: opt(MEDIA),
    source_video_url: opt(MEDIA),
    background_url: opt(MEDIA),
    effects: opt(EFFECTS),
};

export const SCENE_NULLABLE: ReadonlySet<string> = new Set(["overlay_text", "audio_text", "scene_location", "start_image_url", "end_image_url", "video_url", "audio_url",
    "source_video_url", "background_url", "card_config", "extras_json", "source_width", "source_height"]);
export const SCENE_PATCH_NULLABLE: ReadonlySet<string> = new Set([...SCENE_NULLABLE, "video_url", "effects", "start_time", "end_time", "fit_mode", "transform_scale",
    "transform_offset_x", "transform_offset_y"]);

const SCENE_CREATE: Model = {
    fields: { ...SCENE_FIELDS, id: req(str()), order: opt(int(0, 100_000)) },
    after: clientId,
};
const SCENE_PATCH: Model = {
    fields: {
        ...SCENE_FIELDS, id: req(BODY_ID),
        // Phase 9c (director design §11.1.4): a client only clears a scene's shots or puts back a version the document showed.
        shots_version: def(str(undefined, /^sv_[0-9a-f]{24}$/)), clear_shots: def(BOOL),
    },
    nulls: new Set([...SCENE_PATCH_NULLABLE, "id"]),
    after(value, loc) {
        if (value.clear_shots === false) valueError(loc, "clear_shots can only be true (leave it out to keep the shots)");
        if (value.clear_shots === true && value.shots_version !== undefined) valueError(loc, "send clear_shots or shots_version, not both");
    },
};

const TRACK_BODY: Model = {
    fields: { type: req(lit(...TRACK_TYPES)), index: req(int(1, 99)), label: opt(str(40)), muted: def(BOOL), locked: def(BOOL), visible: def(BOOL), volume: def(range(0, 4)) },
};
const TRACK_REF: Model = { fields: { type: req(lit(...TRACK_TYPES)), index: req(int(1, 99)) } };

const PROJECT_CHANGES: Model = {
    fields: {
        name: opt(str(255, undefined, 1)), description: opt(str(2_000)), aspect_ratio: opt(lit(...ASPECT_RATIOS)), music_url: opt(MEDIA),
        music_filename: opt(str(255)), music_volume: opt(range(0, 2)), default_audio_on: opt(BOOL), extras_json: opt(json(65_536)),
        // Phase 9c: the project's latest export (Studio's own, uploaded with the project's id): what its share link plays.
        final_video_url: opt(MEDIA),
    },
    nulls: new Set(["description", "music_url", "music_filename", "extras_json", "final_video_url"]),
};

const CHANGESET: Model = {
    fields: {
        label: def(str(200)),
        device: opt(str(80)),
        project: opt(obj(PROJECT_CHANGES)),
        tracks: opt(obj({ fields: { put: def(list(obj(TRACK_BODY), 200)), removed: def(list(obj(TRACK_REF), 200)) } })),
        scenes: def(obj({ fields: { create: def(list(obj(SCENE_CREATE), MAX_ITEMS)), patch: def(list(obj(SCENE_PATCH), MAX_ITEMS)), delete: def(list(BODY_ID, MAX_ITEMS)) } })),
        clips: def(obj({ fields: { create: def(list(obj(CHANGE_CLIP_CREATE), MAX_ITEMS)), patch: def(list(obj(CLIP_PATCH), MAX_ITEMS)), delete: def(list(BODY_ID, MAX_ITEMS)) } })),
        media: def(obj({ fields: { add: def(list(BODY_ID, MAX_ITEMS)), remove: def(list(BODY_ID, MAX_ITEMS)) } })),
    },
};

const PROJECT_CREATE: Model = {
    fields: {
        name: req(str(255, undefined, 1)), description: opt(str(2_000)), product_type: opt(lit(...PRODUCT_TYPES)), aspect_ratio: opt(lit(...ASPECT_RATIOS)),
        visual_style: opt(str(40)), camera_type: opt(str(40)), default_video_quality: opt(lit(...QUALITIES)), music_url: opt(MEDIA), music_filename: opt(str(255)),
        script_text: opt(str(20_000)), srt_content: opt(str(200_000)),
    },
    after(value, loc) {
        srtCues(value.srt_content, loc);
    },
};

/** projects_router.srt_cues: the cues of a project's subtitles (0 for none); throws the server's refusal. */
function srtCues(srt: unknown, loc: Loc): number {
    if (typeof srt !== "string" || !srt) return 0;
    const cues = parseSrt(srt);
    if (cues === null) valueError(loc, "srt_content is not valid SRT (a cue's first line must be its number)");
    if (cues!.length > MAX_IMPORT_SCENES) valueError(loc, `srt_content has more than ${MAX_IMPORT_SCENES} cues; a project starts with at most ${MAX_IMPORT_SCENES} scenes`);
    return cues!.length;
}

const PROJECT_PATCH: Model = {
    fields: {
        name: opt(str(255, undefined, 1)), description: opt(str(2_000)), product_type: opt(lit(...PRODUCT_TYPES)), aspect_ratio: opt(lit(...ASPECT_RATIOS)),
        visual_style: opt(str(40)), camera_type: opt(str(40)), default_video_quality: opt(lit(...QUALITIES)), default_audio_on: opt(BOOL), music_url: opt(MEDIA),
        music_filename: opt(str(255)), music_volume: opt(range(0, 2)),
        // Phase 9b (S14): stored only, no scene is made or deleted; null clears.
        script_text: opt(str(20_000)), srt_content: opt(str(200_000)),
    },
    nulls: new Set(["description", "music_url", "music_filename", "script_text", "srt_content"]),
    after(value, loc) {
        srtCues(value.srt_content, loc);
    },
};

const IMPORT_SCENE: Model = {
    fields: {
        ...SCENE_S4,
        id: req(str(64, undefined, 1)), effects: opt(EFFECTS), background_url: opt(MEDIA), caption: opt(str(5_000)), card_type: opt(CARD_TYPE),
        duration: opt(range(undefined, 3_600, 0)), timeline_position_seconds: opt(range(0, 86_400)), track_index: opt(int(1, 99)), visual_transition: opt(str(30)),
        visual_transition_duration: opt(range(0, 10)), scene_location: opt(str(100)), overlay_text: opt(str(2_000)), audio_text: opt(str(5_000)), music_enabled: opt(BOOL),
        start_image_url: opt(MEDIA), end_image_url: opt(MEDIA), video_url: opt(MEDIA), audio_url: opt(MEDIA), source_video_url: opt(MEDIA),
    },
};

const IMPORT_CLIP: Model = {
    fields: {
        ...clipFields(false),
        id: req(str(64, undefined, 1)), effects: opt(EFFECTS), scene_id: opt(str(64)), track_type: req(lit(...TRACK_TYPES)), track_index: req(int(1, 99)),
        start_time: req(range(0, 86_400)), end_time: req(range(undefined, 86_400, 0)),
    },
    after: endAfterStart,
};

const IMPORT_BODY: Model = {
    fields: {
        project: req(obj({
            fields: {
                name: req(str(255, undefined, 1)), extras_json: opt(json(65_536)), description: opt(str(2_000)), product_type: opt(lit(...PRODUCT_TYPES)),
                aspect_ratio: opt(lit(...ASPECT_RATIOS)), visual_style: opt(str(40)), camera_type: opt(str(40)), default_video_quality: opt(lit(...QUALITIES)),
                music_url: opt(MEDIA), music_filename: opt(str(255)),
            },
        })),
        scenes: def(list(obj(IMPORT_SCENE), MAX_IMPORT_SCENES)),
        timeline: def(obj({ fields: { tracks: def(list(obj(TRACK_BODY), 200)), clips: def(list(obj(IMPORT_CLIP), MAX_IMPORT_CLIPS)) } })),
    },
    after(value, loc) {
        const scenes = ((value.scenes as Array<{ id: string }> | undefined) ?? []).map((s) => s.id);
        const clips = (((value.timeline as { clips?: Array<{ id: string }> } | undefined)?.clips) ?? []).map((c) => c.id);
        for (const [what, ids] of [["scene", scenes], ["clip", clips]] as const) {
            if (new Set(ids).size !== ids.length) valueError(loc, `each ${what} id must be unique in the bundle`);
        }
    },
};

// ── uploads ──

/** Content type → [extension, media bin kind, most bytes] (uploads_router.TYPES). */
const UPLOAD_TYPES: Readonly<Record<string, readonly [string, "image" | "video" | "audio" | "file", number]>> = {
    "image/png": ["png", "image", 20 * MB], "image/jpeg": ["jpg", "image", 20 * MB], "image/webp": ["webp", "image", 20 * MB], "image/gif": ["gif", "image", 20 * MB],
    "video/mp4": ["mp4", "video", 1024 * MB], "video/quicktime": ["mov", "video", 1024 * MB], "video/webm": ["webm", "video", 1024 * MB],
    "audio/mpeg": ["mp3", "audio", 200 * MB], "audio/wav": ["wav", "audio", 200 * MB], "audio/mp4": ["m4a", "audio", 200 * MB], "audio/ogg": ["ogg", "audio", 200 * MB],
    "audio/flac": ["flac", "audio", 200 * MB], "application/x-subrip": ["srt", "file", 2 * MB],
};
const TOKEN_SECONDS = 3_600;
const TEMP_UPLOAD_HOURS = 24;

const UPLOAD_BODY: Model = {
    fields: {
        filename: req(str(255, undefined, 1)), content_type: req(str(100)), size_bytes: req(int(1)), project_id: opt(str(undefined, ID_PATTERN)),
        sha256: opt(str(undefined, /^[0-9a-f]{64}$/)), scope: opt(lit("project", "account", "temp")), multipart: def(BOOL),
    },
    after(value, loc) {
        const type = UPLOAD_TYPES[value.content_type as string];
        if (!type) valueError(loc, `content_type must be one of ${Object.keys(UPLOAD_TYPES).join(", ")}`);
        if ((value.size_bytes as number) > type![2]) valueError(loc, `at most ${type![2] / MB} MB for ${value.content_type}`);
        if (value.scope === "account" && !value.sha256) valueError(loc, "scope account needs the file's sha256");
        if (value.scope === "temp" && value.project_id) valueError(loc, "scope temp takes no project_id (a temporary file can't be project media)");
    },
};

const COMPLETE_BODY: Model = {
    fields: { parts: opt(list(obj({ fields: { number: req(int(1, 10_000)), etag: req(str(128, undefined, 1)) } }), 10_000)) },
};

const base32 = (bytes: Buffer) => {
    const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
    let bits = 0;
    let value = 0;
    let out = "";
    for (const byte of bytes) {
        value = (value << 8) | byte;
        bits += 8;
        while (bits >= 5) {
            out += alphabet[(value >>> (bits - 5)) & 31];
            bits -= 5;
        }
    }
    return bits > 0 ? out + alphabet[(value << (5 - bits)) & 31] : out;
};
const isoSeconds = (ms: number) => new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(".000Z", "Z");
const secondsToUtcMidnight = (ms: number) => {
    const midnight = new Date(ms);
    midnight.setUTCHours(24, 0, 0, 0);
    return Math.max(1, Math.ceil((midnight.getTime() - ms) / 1000));
};
/** The account's folder name on the storage (uploads_router._owner of the fake account). */
const OWNER = createHash("sha256").update("fake-account").digest("hex").slice(0, 24);

// ── SRT, times ───────────────────────────────────────────────────────────────────────────────────────────────────

function parseSrt(text: string): Array<{ start: string; end: string; text: string }> | null {
    const cues: Array<{ start: string; end: string; text: string }> = [];
    for (const block of text.replace(/\r\n/g, "\n").trim().split(/\n\s*\n/)) {
        const lines = block.split("\n");
        if (lines.length < 2 || !/^\d+$/.test(lines[0]!.trim())) return null;
        const times = /^\s*([0-9:,.]+)\s*-->\s*([0-9:,.]+)/.exec(lines[1]!);
        if (!times) return null;
        cues.push({ start: times[1]!, end: times[2]!, text: lines.slice(2).join("\n") });
    }
    return cues;
}

function srtSeconds(value: string): number {
    const match = /^(\d+):(\d+):(\d+)(?:[,.](\d+))?$/.exec(value.trim());
    if (!match) return 0;
    return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(`0.${match[4] ?? "0"}`);
}

function srtStamp(seconds: number): string {
    const total = Math.round(Math.max(0, Number.isFinite(seconds) ? seconds : 0) * 1000);
    const pad = (n: number, w = 2) => String(n).padStart(w, "0");
    return `${pad(Math.floor(total / 3_600_000))}:${pad(Math.floor((total % 3_600_000) / 60_000))}:${pad(Math.floor((total % 60_000) / 1000))},${pad(total % 1000, 3)}`;
}

/** Canonical JSON (sorted keys), for request hashes and row comparison. */
function canonical(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    if (value && typeof value === "object") {
        return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(",")}}`;
    }
    return JSON.stringify(value ?? null);
}

const iso = (ms: number) => new Date(ms).toISOString();

// ── stored rows ──────────────────────────────────────────────────────────────────────────────────────────────────

export interface FakeEffect { effect_id: string; order: number; enabled: boolean; params_json: string | null }
export interface FakeTrack { type: string; index: number; label: string; muted: boolean; locked: boolean; visible: boolean; volume: number }

interface StoredClip { id: string; row: Record<string, unknown>; effects: FakeEffect[] }
interface StoredScene {
    id: string;
    row: Record<string, unknown>;
    effects: FakeEffect[];
    shots: Array<Record<string, unknown>>;
    /** The drawn storyboard (phase 9c): [{image_url, panels: [{index, shot_index, image_url}]}], as stored. */
    sheets?: Array<Record<string, unknown>>;
}

const PROJECT_FIELDS = ["name", "description", "aspect_ratio", "music_url", "music_filename", "music_volume", "default_audio_on", "extras_json", "final_video_url"] as const;

interface StoredProject {
    id: string;
    fields: {
        name: string; description: string | null; product_type: string; aspect_ratio: string; visual_style: string; camera_type: string;
        default_video_quality: string; default_audio_on: boolean; music_url: string | null; music_filename: string | null; music_volume: number;
        extras_json: string | null; srt_content: string | null; script_text: string | null; final_video_url: string | null;
    };
    revision: number;
    createdAt: number;
    updatedAt: number;
    deletedAt: number | null;
    origin: string | null;
    lastEditedDevice: string | null;
    /** The saved track list; null shows V1 + A1. */
    tracks: FakeTrack[] | null;
    clips: Map<string, StoredClip>;
    scenes: Map<string, StoredScene>;
    /** Asset ids linked into the media bin. */
    media: string[];
    historyBytes: number;
}

const DEFAULT_TRACKS: ReadonlyArray<Pick<FakeTrack, "type" | "index" | "label">> = [{ type: "video", index: 1, label: "V1" }, { type: "audio", index: 1, label: "A1" }];

function normalizeTracks(raw: ReadonlyArray<Record<string, unknown>>): FakeTrack[] {
    const order: string[] = [];
    const byKey = new Map<string, FakeTrack>();
    for (const t of raw) {
        const type = t.type as string;
        const index = t.index as number;
        if (!(TRACK_TYPES as readonly string[]).includes(type) || !Number.isInteger(index) || index < 1) continue;
        const keyOf = `${type}:${index}`;
        if (!byKey.has(keyOf)) order.push(keyOf);
        const label = typeof t.label === "string" && t.label.trim() ? t.label.trim() : `${type[0]!.toUpperCase()}${index}`;
        byKey.set(keyOf, {
            type, index, label, muted: t.muted === true, locked: t.locked === true, visible: t.visible !== false,
            volume: typeof t.volume === "number" && Number.isFinite(t.volume) ? t.volume : 1.0,
        });
    }
    return order.map((k) => byKey.get(k)!);
}

const tracksOf = (p: StoredProject): FakeTrack[] => (p.tracks && p.tracks.length > 0 ? p.tracks.map((t) => ({ ...t })) : normalizeTracks(DEFAULT_TRACKS));

function effectsOf(raw: unknown): FakeEffect[] {
    return ((raw as Array<Record<string, unknown>> | null | undefined) ?? []).map((e, index) => ({
        effect_id: e.effect_id as string, order: typeof e.order === "number" ? e.order : index, enabled: e.enabled !== false, params_json: (e.params_json as string | null | undefined) ?? null,
    }));
}

const effectViews = (effects: FakeEffect[]) => effects.map((e, i) => ({ e, i })).sort((a, b) => a.e.order - b.e.order || a.i - b.i).map(({ e }) => ({ ...e }));

/** A scene's playback length (_scene_effective_duration): a source clip's trim, its shots' sum, or its duration. */
function sceneDuration(row: Record<string, unknown>, shots: Array<Record<string, unknown>>): number {
    if (row.card_type === "source_clip") {
        try {
            const config = JSON.parse((row.card_config as string | null) ?? "{}") as Record<string, unknown>;
            const start = Number(config.timelineTrimStart ?? config.trimStart);
            const end = Number(config.timelineTrimEnd ?? config.trimEnd);
            if (Number.isFinite(start) && Number.isFinite(end) && end > start) return end - start;
        } catch {
            // not JSON: the duration
        }
        return Number(row.duration ?? 0) || 5.0;
    }
    const total = shots.reduce((sum, shot) => sum + (typeof shot.duration === "number" ? shot.duration : 0), 0);
    if (total > 0) return total;
    return Number(row.duration ?? 0) || 5.0;
}

function clipView(c: StoredClip): Record<string, unknown> {
    const r = c.row;
    const out: Record<string, unknown> = { id: c.id, track_type: r.track_type, track_index: r.track_index, start_time: r.start_time, end_time: r.end_time };
    for (const [name, , fallback] of CLIP_COLUMNS) out[name] = r[name] ?? (name === "media_type" ? null : fallback);
    const transition = typeof r.transition_type === "string" && r.transition_type ? r.transition_type : "none";
    out.transition_type = transition;
    const half = Math.max(0, ((r.end_time as number) - (r.start_time as number)) / 2);
    out.transition_duration = transition === "none" ? 0 : Math.max(0, Math.min(half, Number(r.transition_duration ?? 0) || 0));
    out.effects = effectViews(c.effects);
    return out;
}

function tags(raw: unknown): string[] {
    try {
        const parsed = JSON.parse((raw as string | null) ?? "[]");
        return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === "string") : [];
    } catch {
        return [];
    }
}

function shotView(shot: Record<string, unknown>, index: number) {
    const text = (v: unknown) => (typeof v === "string" ? v : null);
    return {
        index, description: text(shot.description), duration: typeof shot.duration === "number" ? shot.duration : null, image_url: text(shot.image_url),
        end_image_url: text(shot.end_image_url), video_url: text(shot.video_url), dialogue: text(shot.dialogue),
    };
}

/** ps.shots_version: an opaque name for a scene's shots and storyboard as they are now (the scene id is part of it). */
export function shotsVersionOf(s: Pick<StoredScene, "id" | "shots" | "sheets">): string {
    return `sv_${createHash("sha256").update(`opennan-shots-v1\n${s.id}\n${canonical({ shots: s.shots, sheets: s.sheets ?? [] })}`).digest("hex").slice(0, 24)}`;
}

/** storyboard_sheet_views: only URLs on our storage (a sheet elsewhere is null, a panel elsewhere left out). */
function sheetViews(s: StoredScene, ours: (url: unknown) => boolean): Array<Record<string, unknown>> {
    return (s.sheets ?? []).map((sheet) => ({
        image_url: ours(sheet.image_url) ? sheet.image_url : null,
        panels: (Array.isArray(sheet.panels) ? sheet.panels as Array<Record<string, unknown>> : [])
            .filter((panel) => ours(panel.image_url))
            .map((panel) => ({ index: panel.index, shot_index: panel.shot_index, image_url: panel.image_url })),
    }));
}

function sceneViewWith(s: StoredScene, ours: (url: unknown) => boolean): Record<string, unknown> {
    const r = s.row;
    const duration = sceneDuration(r, s.shots);
    const transition = typeof r.visual_transition === "string" && r.visual_transition ? r.visual_transition : "none";
    const rawTransition = r.visual_transition_duration ?? 0.5;
    return {
        object: "scene", id: s.id, order: Number(r.order ?? 0), caption: r.caption ?? null, card_type: (r.card_type as string | null) || "ai_video", status: "pending",
        duration, timeline_position_seconds: Number(r.timeline_position_seconds ?? 0), track_index: Number(r.track_index ?? 1) || 1, transition: null,
        visual_transition: transition, visual_transition_duration: transition === "none" ? 0 : Math.max(0, Math.min(duration / 2, Number(rawTransition) || 0)),
        scene_location: r.scene_location ?? null, objects_in_scene: tags(r.objects_in_scene), overlay_text: r.overlay_text ?? null, audio_text: r.audio_text ?? null,
        music_enabled: r.music_enabled === true, start_image_url: r.start_image_url ?? null, end_image_url: r.end_image_url ?? null, video_url: r.video_url ?? null,
        audio_url: r.audio_url ?? null, source_video_url: r.source_video_url ?? null, background_url: r.background_url ?? null,
        shots: s.shots.map(shotView),
        start_time: r.start_time ?? null, end_time: r.end_time ?? null, card_config: r.card_config ?? null, fit_mode: r.fit_mode ?? null,
        transform_scale: r.transform_scale ?? null, transform_offset_x: r.transform_offset_x ?? null, transform_offset_y: r.transform_offset_y ?? null,
        source_width: r.source_width ?? null, source_height: r.source_height ?? null, extras_json: r.extras_json ?? null, effects: effectViews(s.effects),
        shots_version: shotsVersionOf(s), storyboard_sheets: sheetViews(s, ours),
    };
}

const orderedScenes = (p: StoredProject) => [...p.scenes.values()].map((s, i) => ({ s, i })).sort((a, b) => Number(a.s.row.order) - Number(b.s.row.order) || a.i - b.i).map(({ s }) => s);
const orderedClips = (p: StoredProject) => [...p.clips.values()].map((c, i) => ({ c, i })).sort((a, b) => Number(a.c.row.start_time) - Number(b.c.row.start_time) || a.i - b.i).map(({ c }) => c);

/** ps._resequence: every scene's order by (track, position, order), ties keeping their list order. */
function resequence(p: StoredProject): void {
    const sorted = orderedScenes(p).map((s, i) => ({ s, i })).sort((a, b) =>
        (Number(a.s.row.track_index ?? 1) || 1) - (Number(b.s.row.track_index ?? 1) || 1)
        || Number(a.s.row.timeline_position_seconds ?? 0) - Number(b.s.row.timeline_position_seconds ?? 0)
        || Number(a.s.row.order) - Number(b.s.row.order) || a.i - b.i);
    sorted.forEach(({ s }, order) => {
        s.row.order = order;
    });
}

/** storage_quota.measure_project's document bytes: a fixed size per row plus the text columns. */
function documentBytes(p: StoredProject): number {
    const len = (v: unknown) => (typeof v === "string" ? v.length : 0);
    let rows = 1;
    let text = 0;
    for (const s of p.scenes.values()) {
        rows += 1 + s.effects.length;
        for (const name of ["caption", "card_config", "overlay_text", "audio_text", "extras_json"]) text += len(s.row[name]);
        for (const e of s.effects) text += len(e.params_json);
    }
    for (const c of p.clips.values()) {
        rows += 1 + c.effects.length;
        for (const name of CLIP_DATA_TEXT) text += len(c.row[name]);
        for (const e of c.effects) text += len(e.params_json);
    }
    const config = p.tracks ? JSON.stringify({ tracks: p.tracks }).length : 0;
    return rows * ROW_OVERHEAD + text + config + len(p.fields.extras_json) + len(p.fields.srt_content) + len(p.fields.script_text);
}

const dataBytes = (p: StoredProject) => documentBytes(p) + p.historyBytes;

function cloneProject(p: StoredProject): StoredProject {
    return {
        ...p,
        fields: { ...p.fields },
        tracks: p.tracks ? p.tracks.map((t) => ({ ...t })) : null,
        clips: new Map([...p.clips].map(([id, c]) => [id, { id, row: { ...c.row }, effects: c.effects.map((e) => ({ ...e })) }])),
        scenes: new Map([...p.scenes].map(([id, s]) => [id, { id, row: { ...s.row }, effects: s.effects.map((e) => ({ ...e })), shots: s.shots.map((x) => ({ ...x })), sheets: (s.sheets ?? []).map((x) => ({ ...x })) }])),
        media: [...p.media],
    };
}

// ── the cloud ────────────────────────────────────────────────────────────────────────────────────────────────────

export type FakeOfflineMode = "503" | "drop" | "off";

export interface FakeChangeFailure {
    status: number;
    code: string;
    message?: string;
    details?: Record<string, unknown>;
    /** How many changesets answer it (default 1). */
    count?: number;
    /** Retry-After seconds, when the error carries one. */
    retry_after?: number;
}

export interface FakeChangeRecord { project_id: string; key: string | null; if_match: string | null; status: number; at: number }

export interface FakeCloudProjectState {
    id: string;
    name: string;
    revision: number;
    deleted_at: string | null;
    origin: string | null;
    last_edited_device: string | null;
    description: string | null;
    product_type: string;
    aspect_ratio: string;
    visual_style: string;
    camera_type: string;
    default_video_quality: string;
    default_audio_on: boolean;
    music_url: string | null;
    music_filename: string | null;
    music_volume: number;
    extras_json: string | null;
    tracks: FakeTrack[];
    clips: Array<Record<string, unknown>>;
    scenes: Array<Record<string, unknown>>;
    media: string[];
    data_bytes: number;
    /** The stored script and subtitles (phase 9b; stored only). */
    script_text: string | null;
    srt_content: string | null;
    /** The project's latest export (phase 9c: what its share link plays). */
    final_video_url: string | null;
}

export interface FakeCloudAssetState { id: string; sha256: string | null; size_bytes: number; content_type: string; scope: "project" | "account" | "temp"; media_url: string; project_ids: string[] }
export interface FakeCloudUploadState {
    id: string;
    scope: "project" | "account" | "temp";
    project_id: string | null;
    sha256: string | null;
    size_bytes: number;
    /** Successful PUTs (gateway URLs, parts, or the old presigned path). */
    puts: number;
    completed: boolean;
    transport: "gateway" | "multipart";
    gateway_tokens_used: number;
}

/** The storage limits and usage the fake answers with (GET /v1/storage), and what the storage knob changes. */
export interface FakeStorageSettings {
    media_limit_bytes?: number;
    /** Media bytes counted on top of the fake's own uploads (a nearly full account). */
    media_used_extra_bytes?: number;
    project_data_limit_bytes?: number;
    /** The free storage pool is full: uploads answer 503 free_storage_pool_full. */
    pool_full?: boolean;
    uploads_per_day?: number;
    upload_bytes_per_day?: number;
    temp_limit_bytes?: number;
}

export interface FakeUploadLimits {
    /** Files up to this size go in one gateway PUT (default 95 MiB); bigger ones need multipart. */
    single_put_max_bytes?: number;
    /** The size of each part but the last (default 32 MiB). */
    part_size?: number;
    /** Big tool inputs (scope temp) may go in parts (default true; false answers multipart_required, as before 9a.1). */
    temp_multipart?: boolean;
}

/** The free plan's limits. */
export const FAKE_STORAGE_DEFAULTS: Readonly<Required<FakeStorageSettings>> = Object.freeze({
    media_limit_bytes: 2 * GB, media_used_extra_bytes: 0, project_data_limit_bytes: 250 * MB, pool_full: false,
    uploads_per_day: 100, upload_bytes_per_day: 2 * GB, temp_limit_bytes: 2 * GB,
});
export const FAKE_UPLOAD_LIMITS: Readonly<Required<FakeUploadLimits>> = Object.freeze({ single_put_max_bytes: 95 * MB, part_size: 32 * MB, temp_multipart: true });

export interface FakeCloudState {
    projects: FakeCloudProjectState[];
    assets: FakeCloudAssetState[];
    uploads: FakeCloudUploadState[];
    changes: FakeChangeRecord[];
    document_reads: number;
    document_304s: number;
    /** What GET /v1/storage answers now. */
    storage: Record<string, unknown>;
    /** Share links (phase 9c), tokens included (test state only). */
    shares: FakeShareState[];
}

/** An upload as the phase 11 state lists it (never its bytes). */
export interface FakeLegacyUpload { id: string; contentType: string; sizeBytes: number; filename: string; put: boolean; completed: boolean }

/** The fake's cloud, in process (FakeOpenNan.cloud): every /__test/cloud knob as a typed call. */
export interface FakeCloud {
    /** Applies a changeset (the /changes body) as another device, without If-Match; throws FakeCloudError on a refusal. */
    remoteChange(projectId: string, changes: unknown, device?: string): { revision: number };
    /** Revision + 1 with no change (as a pipeline would). */
    bump(projectId: string): { revision: number };
    lockClip(projectId: string, clipId: string, locked: boolean): { revision: number };
    deleteEntity(projectId: string, kind: "clip" | "scene", id: string): { revision: number };
    /** Read-only shots of a scene (as opennan.com's planner writes them) and, phase 9c, its storyboard sheets; the set it replaces is kept. */
    setShots(projectId: string, sceneId: string, shots: Array<Record<string, unknown>>, sheets?: Array<Record<string, unknown>>): void;
    /** Marks a scene as being written by a tool (shots writes answer 409 scene_busy meanwhile). */
    setSceneBusy(projectId: string, sceneId: string, busy: boolean): void;
    /** "503" answers /v1, /u and /files with 503; "drop" destroys the socket; "off" restores. */
    setOffline(mode: FakeOfflineMode): void;
    /** Delays requests whose path starts with pathPrefix (default every /v1, /u and /files path); 0 turns it off. */
    setLatency(ms: number, pathPrefix?: string): void;
    failNextChange(failure: FakeChangeFailure): void;
    /** The next `count` changesets with If-Match answer 412, bumping the revision each time. */
    storm412(count: number): void;
    /** The next authenticated /v1 call answers 401 invalid_api_key. */
    expireKey(): void;
    /** Merges storage limits and usage (FAKE_STORAGE_DEFAULTS until changed). */
    setStorage(settings: FakeStorageSettings): void;
    setUploadLimits(limits: FakeUploadLimits): void;
    state(): FakeCloudState;
}

/** What the fake's pipelines and director read of a live project (FakeCloudServer.facts). */
export interface FakeProjectFacts {
    id: string;
    revision: number;
    script_text: string | null;
    srt_content: string | null;
    /** The SRT's cues ([] without subtitles, null when they are not valid SRT). */
    cues: Array<{ start: string; end: string; text: string; start_seconds: number; end_seconds: number }> | null;
    default_video_quality: string;
    /** The scenes in order, as the document shows them. */
    scenes: Array<{ id: string; order: number; caption: string | null; duration: number; video_url: string | null; source_video_url: string | null; shots: Array<ReturnType<typeof shotView>> }>;
}

export interface FakeCloudServer {
    readonly cloud: FakeCloud;
    /** A live project's facts; throws the 404 FakeCloudError when there is none. */
    facts(projectId: string): FakeProjectFacts;
    /** Applies a changeset as `device` (no If-Match) and answers the whole project_change; throws FakeCloudError. */
    change(projectId: string, changes: unknown, device: string): Record<string, unknown>;
    /** The cloud /v1 routes (the caller checked the key and its api:project scope); null when the path is not one. */
    api(req: CloudRequest): CloudAnswer | null;
    /** Which scenes a running project task writes (the director's), for 409 scene_busy. */
    setSceneBusyProbe(probe: (projectId: string, sceneId: string) => boolean): void;
    /** The share links' public routes (no key: GET /v1/shares/{token}, POST …/reports); null when the path is not one. */
    publicShares(req: CloudRequest): CloudAnswer | null;
    /** GET /v1/account's share_base_url (null: the share-base-url knob plays an older server). */
    shareBaseUrl(): string | null;
    /** POST /__test/cloud/<name> and GET /__test/cloud/state; null when not a cloud knob. */
    knob(name: string, method: string, body: unknown): CloudAnswer | null;
    /** What the offline and latency knobs do to this path. */
    network(path: string): { offline: "503" | "drop" | null; delayMs: number };
    /** Whether the next authenticated /v1 call must answer 401 (consumed). */
    takeExpiredKey(): boolean;
    /** PUT /u/<token> (the gateway) and PUT /__uploads/<upload id> (the old presigned path); null for other paths. */
    gateway(req: CloudRequest): CloudAnswer | null;
    /** GET or HEAD /files/<key> of a stored object (with a single Range); null when nothing is stored there. */
    file(path: string, method: string, range: string | undefined): CloudAnswer | null;
    /** The uploads in the phase 11 state's shape. */
    legacyUploads(): FakeLegacyUpload[];
    /** The bytes stored behind a media URL of this fake. */
    bytesAt(url: string): Buffer | undefined;
    reset(): void;
}

const NETWORK_PATHS = ["/v1/", "/u/", "/files/"];

interface StoredAsset {
    id: string;
    sha256: string | null;
    sizeBytes: number;
    contentType: string;
    scope: "project" | "account" | "temp";
    key: string;
    mediaUrl: string;
    /** The project a project-scope file belongs to (deleted with it). */
    projectId: string | null;
    filename: string;
    createdAt: number;
    expiresAt: number | null;
}

interface StoredUpload {
    id: string;
    scope: "project" | "account" | "temp";
    projectId: string | null;
    sha256: string | null;
    sizeBytes: number;
    contentType: string;
    filename: string;
    key: string;
    transport: "gateway" | "multipart";
    tokens: string[];
    parts: Map<number, { etag: string; bytes: Buffer }>;
    puts: number;
    answer: Record<string, unknown> | null;
}

interface GatewayToken { uploadId: string; part: number | null; size: number; contentType: string; used: boolean }

export function createFakeCloud(base: () => string, options: { ownerName?: () => string | null } = {}): FakeCloudServer {
    const validator = makeValidator(base);
    /** A media URL on this fake's storage (our CDN), never a temporary upload. */
    const ours = (url: unknown): boolean => typeof url === "string" && url.startsWith(`${base()}/files/`) && !url.includes("/uploads/temp/");
    /** The sheet-views knob: answer storyboard sheets as stored (other hosts included), as a server that does not filter. */
    let sheetsUnfiltered = false;
    const sceneView = (s: StoredScene) => sceneViewWith(s, sheetsUnfiltered ? (url) => typeof url === "string" : ours);
    /** Kept shot sets per scene (scene_shot_snapshots): at most 20 each, newest last. */
    let snapshots = new Map<string, Array<{ version: string; shots: Array<Record<string, unknown>>; sheets: Array<Record<string, unknown>> }>>();
    /** Scenes a tool is writing now (the scene-busy knob); the director adds its running tasks' scenes. */
    let busyScenes = new Set<string>();
    let busyProbe: ((projectId: string, sceneId: string) => boolean) | null = null;
    const isBusy = (projectId: string, sceneId: string) => busyScenes.has(sceneId) || (busyProbe?.(projectId, sceneId) ?? false);
    const keepShots = (scene: StoredScene) => {
        // As the server's snapshots: an empty set is never kept (a client clears instead).
        if (scene.shots.length === 0 && (scene.sheets ?? []).length === 0) return;
        const version = shotsVersionOf(scene);
        const kept = (snapshots.get(scene.id) ?? []).filter((k) => k.version !== version);
        kept.push({ version, shots: scene.shots.map((x) => ({ ...x })), sheets: (scene.sheets ?? []).map((x) => ({ ...x })) });
        snapshots.set(scene.id, kept.slice(-20));
    };
    let projects = new Map<string, StoredProject>();
    let answers = new Map<string, Map<string, { hash: string; answer: Record<string, unknown> }>>();
    let changeLog: FakeChangeRecord[] = [];
    let documentReads = 0;
    let document304s = 0;
    let offline: FakeOfflineMode = "off";
    let latency: { ms: number; prefix: string | null } = { ms: 0, prefix: null };
    let failures: FakeChangeFailure[] = [];
    let storm = 0;
    let expireNext = false;
    let settings: Required<FakeStorageSettings> = { ...FAKE_STORAGE_DEFAULTS };
    let uploadLimits: Required<FakeUploadLimits> = { ...FAKE_UPLOAD_LIMITS };
    let assets = new Map<string, StoredAsset>();
    let uploads = new Map<string, StoredUpload>();
    let tokens = new Map<string, GatewayToken>();
    let objects = new Map<string, { bytes: Buffer; contentType: string }>();
    let daily = { day: "", uploads: 0, bytes: 0 };
    let lastTick = 0;

    const tick = () => {
        lastTick = Math.max(Date.now(), lastTick + 1);
        return lastTick;
    };

    const live = (id: string): StoredProject => {
        const p = projects.get(id);
        if (!p || p.deletedAt !== null) throw notFound();
        return p;
    };
    const accountDataBytes = () => [...projects.values()].reduce((sum, p) => sum + dataBytes(p), 0);
    const idsInUse = (kind: "clip" | "scene", ids: string[]): string[] => {
        const wanted = new Set(ids);
        const out: string[] = [];
        for (const p of projects.values()) for (const id of (kind === "clip" ? p.clips : p.scenes).keys()) if (wanted.has(id)) out.push(id);
        return out;
    };
    const roomForANewProject = () => {
        if (accountDataBytes() + NEW_PROJECT_MIN_DATA_BYTES > settings.project_data_limit_bytes) {
            throw new FakeCloudError(403, "permission_error", "Not enough project data left for a new project. Delete projects you no longer need (empty the trash too).", "project_data_quota_exceeded");
        }
    };

    function stats(p: StoredProject) {
        let duration = 0;
        for (const c of p.clips.values()) duration = Math.max(duration, Number(c.row.end_time) || 0);
        for (const s of p.scenes.values()) duration = Math.max(duration, Number(s.row.timeline_position_seconds ?? 0) + (Number(s.row.duration ?? 0) || 5.0));
        const first = orderedScenes(p)[0];
        return { duration_seconds: duration, thumbnail_url: (first?.row.start_image_url as string | null | undefined) ?? null, media_bytes: hooks.mediaBytes(p.id, p.media) };
    }

    function projectView(p: StoredProject, document = false): Record<string, unknown> {
        const f = p.fields;
        const s = stats(p);
        return {
            object: "project", id: p.id, name: f.name, description: f.description, product_type: f.product_type, status: "draft", aspect_ratio: f.aspect_ratio,
            visual_style: f.visual_style, camera_type: f.camera_type, default_video_quality: f.default_video_quality, default_audio_on: f.default_audio_on,
            music_url: f.music_url, music_filename: f.music_filename, music_volume: f.music_volume, final_video_url: f.final_video_url, scene_count: p.scenes.size,
            timeline_revision: p.revision, created_at: iso(p.createdAt), updated_at: iso(p.updatedAt), duration_seconds: s.duration_seconds, thumbnail_url: s.thumbnail_url,
            media_bytes: s.media_bytes, data_bytes: dataBytes(p), origin: p.origin === "studio" ? "studio" : "web", last_edited_device: p.lastEditedDevice,
            deleted_at: p.deletedAt === null ? null : iso(p.deletedAt), ...(document ? { extras_json: f.extras_json } : {}),
        };
    }

    const trackView = (t: FakeTrack) => ({ type: t.type, index: t.index, label: t.label, muted: t.muted, locked: t.locked, visible: t.visible, volume: t.volume });
    const etagOf = (revision: number) => `"r${revision}"`;

    function newProject(fields: Record<string, unknown>): StoredProject {
        const now = tick();
        return {
            id: randomUUID(),
            fields: {
                name: fields.name as string, description: (fields.description as string | null | undefined) ?? null, product_type: (fields.product_type as string | undefined) || "music_video",
                aspect_ratio: (fields.aspect_ratio as string | undefined) || "16:9", visual_style: (fields.visual_style as string | undefined) || "cinema",
                camera_type: (fields.camera_type as string | undefined) || "cinema-35mm", default_video_quality: (fields.default_video_quality as string | undefined) || "480p",
                default_audio_on: false, music_url: (fields.music_url as string | null | undefined) ?? null, music_filename: (fields.music_filename as string | null | undefined) ?? null,
                music_volume: 1.0, extras_json: (fields.extras_json as string | null | undefined) ?? null, srt_content: (fields.srt_content as string | null | undefined) ?? null,
                script_text: (fields.script_text as string | null | undefined) ?? null, final_video_url: null,
            },
            revision: 0, createdAt: now, updatedAt: now, deletedAt: null, origin: null, lastEditedDevice: null, tracks: null,
            clips: new Map(), scenes: new Map(), media: [], historyBytes: 0,
        };
    }

    function wantedRevision(ifMatch: string): number {
        let tag = ifMatch.trim();
        if (tag.startsWith("W/")) tag = tag.slice(2);
        tag = tag.replace(/^"+|"+$/g, "");
        if (tag.startsWith("r")) tag = tag.slice(1);
        tag = tag.split("-")[0]!;
        if (!/^\d{1,12}$/.test(tag)) throw invalid("If-Match must be the project's revision or an ETag this API gave.");
        return Number(tag);
    }

    const header = (req: CloudRequest, name: string): string | undefined => {
        const value = req.headers[name];
        return Array.isArray(value) ? value[0] : value;
    };

    // ── the changeset (changes_router.apply_changeset) ──

    function applyChangeset(projectId: string, body: Record<string, unknown>, ifMatch: string | null, key: string | null, hash: string | null): Record<string, unknown> {
        const stored = live(projectId);
        if (key !== null) {
            const kept = answers.get(projectId)?.get(key);
            if (kept) {
                if (kept.hash !== hash) throw new FakeCloudError(409, "idempotency_error", "This Idempotency-Key was used for a different changeset.", "idempotency_key_reused");
                return kept.answer;
            }
        }
        const current = stored.revision;
        if (ifMatch !== null) {
            const wanted = wantedRevision(ifMatch);
            if (storm > 0) {
                storm -= 1;
                stored.revision += 1;
                stored.updatedAt = tick();
                throw new FakeCloudError(412, "precondition_failed", "The project changed since you read it: pull it again and resend.", "timeline_changed", { revision: stored.revision });
            }
            if (wanted !== current) throw new FakeCloudError(412, "precondition_failed", "The project changed since you read it: pull it again and resend.", "timeline_changed", { revision: current });
        }
        const S = body.scenes as { create: Array<Record<string, unknown>>; patch: Array<Record<string, unknown>>; delete: string[] };
        const C = body.clips as { create: Array<Record<string, unknown>>; patch: Array<Record<string, unknown>>; delete: string[] };
        const tracksBody = body.tracks as { put: Array<Record<string, unknown>>; removed: Array<{ type: string; index: number }> } | null | undefined;
        const media = body.media as { add: string[]; remove: string[] };
        const projectBody = body.project as Record<string, unknown> | null | undefined;

        // Each scene and clip once per changeset.
        for (const [kind, ops] of [["scenes", S], ["clips", C]] as const) {
            const seen = new Map<string, string>();
            const rows: Array<[string, number, string]> = [
                ...ops.create.map((r, i) => ["create", i, r.id as string] as [string, number, string]),
                ...ops.patch.map((r, i) => ["patch", i, r.id as string] as [string, number, string]),
                ...ops.delete.map((id, i) => ["delete", i, id] as [string, number, string]),
            ];
            for (const [op, index, id] of rows) {
                if (seen.has(id)) throw invalid(`${id} appears twice in this changeset (${seen.get(id)}).`, "invalid_change", { path: `${kind}.${op}[${index}].id` });
                seen.set(id, `${kind}.${op}[${index}]`);
            }
        }

        const p = cloneProject(stored);
        const before = stored;
        const sortedIds = (ids: Iterable<string>) => [...new Set(ids)].sort();
        const missing = (kind: string, ids: Iterable<string>) => notFound(`Some ${kind}s of this changeset are not in the project (deleted elsewhere?).`, "entity_missing", { kind, ids: sortedIds(ids) });
        const locked = (ids: Iterable<string>) => new FakeCloudError(409, "conflict", "Some clips of this changeset are locked, or on a locked or hidden track.", "clip_locked", { kind: "clip", ids: sortedIds(ids) });
        const taken = (kind: string, ids: Iterable<string>) => new FakeCloudError(409, "conflict", `Some new ${kind} ids are already in use.`, "id_in_use", { kind, ids: sortedIds(ids) });

        // ── refusals before anything is written ──
        let gone = [...S.delete.filter((id) => !p.scenes.has(id)), ...S.patch.map((s) => s.id as string).filter((id) => !p.scenes.has(id))];
        if (gone.length) throw missing("scene", gone);
        gone = [...C.delete.filter((id) => !p.clips.has(id)), ...C.patch.map((c) => c.id as string).filter((id) => !p.clips.has(id))];
        if (gone.length) throw missing("clip", gone);
        for (const [kind, ids] of [["scene", S.create.map((s) => s.id as string)], ["clip", C.create.map((c) => c.id as string)]] as const) {
            const used = ids.length ? idsInUse(kind, ids) : [];
            if (used.length) throw taken(kind, used);
        }
        const known = new Set([...[...p.scenes.keys()].filter((id) => !S.delete.includes(id)), ...S.create.map((s) => s.id as string)]);
        const named = [...C.create, ...C.patch].map((c) => c.scene_id).filter((id): id is string => typeof id === "string" && id.length > 0);
        if (named.some((id) => !known.has(id))) throw missing("scene", named.filter((id) => !known.has(id)));
        const graphics = [...C.create, ...C.patch].map((c) => c.custom_graphic_id).filter((id): id is string => typeof id === "string" && id.length > 0);
        if (graphics.length) throw notFound("No such graphic in this account's library.", "entity_missing", { kind: "graphic", ids: sortedIds(graphics) });
        if (media.add.length) {
            const unknown = media.add.filter((id) => !hooks.ownsAsset(id));
            if (unknown.length) throw missing("asset", unknown);
        }
        // Shot writes (phase 9c): a scene a tool is writing now, or a version not kept for that scene.
        const shotWrites = S.patch.filter((patch) => patch.clear_shots === true || typeof patch.shots_version === "string");
        const busy = shotWrites.map((patch) => patch.id as string).filter((sceneId) => isBusy(projectId, sceneId));
        if (busy.length) {
            throw new FakeCloudError(409, "conflict", "A tool is writing some of these scenes' shots right now: try again when it has finished.", "scene_busy", { kind: "scene", ids: sortedIds(busy) });
        }
        const unknownVersions = shotWrites.filter((patch) => typeof patch.shots_version === "string" && patch.shots_version !== shotsVersionOf(p.scenes.get(patch.id as string)!)
            && !(snapshots.get(patch.id as string) ?? []).some((k) => k.version === patch.shots_version)).map((patch) => patch.id as string);
        if (unknownVersions.length) {
            throw new FakeCloudError(409, "conflict", "These scenes no longer keep the shots version asked for.", "shots_version_unknown", { kind: "scene", ids: sortedIds(unknownVersions) });
        }
        if (known.size > p.scenes.size && known.size > MAX_PROJECT_SCENES) {
            throw new FakeCloudError(403, "permission_error", `A project holds at most ${MAX_PROJECT_SCENES} scenes`, "project_too_large");
        }

        // tracks put (the locked / hidden rules below read the new list)
        if (tracksBody && tracksBody.put.length) {
            const put = normalizeTracks(tracksBody.put);
            const keys = new Set(put.map((t) => `${t.type}:${t.index}`));
            p.tracks = [...put, ...(p.tracks ?? []).filter((t) => !keys.has(`${t.type}:${t.index}`))];
        }
        const trackMap = new Map(tracksOf(p).map((t) => [`${t.type}:${t.index}`, t]));
        const protectedTrack = (type: unknown, index: unknown) => {
            if (type == null || index == null) return false;
            const t = trackMap.get(`${type}:${index}`);
            return !!t && (t.locked || !t.visible);
        };
        const changesOnlyLock = (patch: Record<string, unknown>) => {
            const changed = Object.keys(patch).filter((name) => name !== "id" && name !== "effects" && patch[name] !== null && patch[name] !== undefined);
            return changed.length === 1 && changed[0] === "locked";
        };
        const lockedIds: string[] = [];
        for (const patch of C.patch) if (p.clips.get(patch.id as string)!.row.locked === true && !changesOnlyLock(patch)) lockedIds.push(patch.id as string);
        for (const id of C.delete) if (p.clips.get(id)!.row.locked === true) lockedIds.push(id);
        for (const create of C.create) if (protectedTrack(create.track_type, create.track_index)) lockedIds.push(create.id as string);
        for (const patch of C.patch) {
            const row = p.clips.get(patch.id as string)!.row;
            if (protectedTrack(row.track_type, row.track_index) || protectedTrack(patch.track_type ?? row.track_type, patch.track_index ?? row.track_index)) lockedIds.push(patch.id as string);
        }
        for (const id of C.delete) {
            const row = p.clips.get(id)!.row;
            if (protectedTrack(row.track_type, row.track_index)) lockedIds.push(id);
        }
        if (lockedIds.length) throw locked(lockedIds);
        C.patch.forEach((patch, index) => {
            const row = p.clips.get(patch.id as string)!.row;
            const start = (patch.start_time ?? row.start_time) as number;
            const end = (patch.end_time ?? row.end_time) as number;
            if (end <= start) throw invalid("A clip must end after it starts", "invalid_change", { path: `clips.patch[${index}].end_time` });
        });

        const removedTracks = new Set((tracksBody?.removed ?? []).map((r) => `${r.type}:${r.index}`));
        const patched = new Set(C.patch.map((c) => c.id as string));
        const removedClips = [...p.clips.values()].filter((c) => removedTracks.has(`${c.row.track_type}:${c.row.track_index}`) && !C.delete.includes(c.id) && !patched.has(c.id)).map((c) => c.id);

        // scenes: deletes, creates, patches
        for (const id of S.delete) {
            for (const c of p.clips.values()) if (c.row.scene_id === id) c.row.scene_id = null;
            p.scenes.delete(id);
        }
        S.create.forEach((data, index) => {
            const values = Object.fromEntries(Object.entries(data).filter(([name, v]) => v !== null && !["id", "order", "effects", "objects_in_scene", "visual_transition", "visual_transition_duration"].includes(name)));
            const row: Record<string, unknown> = {
                visual_transition: "none", visual_transition_duration: 0.5, ...values,
                order: typeof data.order === "number" ? data.order : 100_000 + index,
                start_time: values.start_time ?? "00:00:00,000", end_time: (values.end_time as string | undefined) || "", caption: values.caption ?? "",
                card_type: values.card_type ?? "ai_video", duration: values.duration ?? 5.0, timeline_position_seconds: values.timeline_position_seconds ?? 0.0,
                track_index: values.track_index ?? 1,
            };
            if (!row.end_time) row.end_time = srtStamp(srtSeconds(row.start_time as string) + Number(row.duration));
            if (Array.isArray(data.objects_in_scene)) row.objects_in_scene = JSON.stringify(data.objects_in_scene);
            const scene: StoredScene = { id: data.id as string, row, effects: [], shots: [] };
            if (data.visual_transition != null || data.visual_transition_duration != null) {
                setSceneTransition(scene, data.visual_transition ?? undefined, data.visual_transition_duration ?? undefined);
            }
            if (data.effects != null) scene.effects = effectsOf(data.effects);
            p.scenes.set(scene.id, scene);
        });
        const keptShots: StoredScene[] = [];
        let shotsChanged = false;
        for (const patch of S.patch) {
            const scene = p.scenes.get(patch.id as string)!;
            writeSceneFields(scene, patch);
            const wanted = patch.clear_shots === true ? { shots: [], sheets: [] }
                : typeof patch.shots_version === "string" && patch.shots_version !== shotsVersionOf(scene) ? (snapshots.get(scene.id) ?? []).find((k) => k.version === patch.shots_version)! : null;
            if (!wanted) continue;
            const before = shotsVersionOf(scene);
            keptShots.push({ ...scene, shots: scene.shots.map((x) => ({ ...x })), sheets: (scene.sheets ?? []).map((x) => ({ ...x })) });
            scene.shots = wanted.shots.map((x) => ({ ...x }));
            scene.sheets = wanted.sheets.map((x) => ({ ...x }));
            if (shotsVersionOf(scene) !== before) shotsChanged = true;
        }

        // clips: deletes, creates, patches
        for (const id of C.delete) p.clips.delete(id);
        for (const data of C.create) {
            p.clips.set(data.id as string, { id: data.id as string, row: newClipRow(data), effects: data.effects != null ? effectsOf(data.effects) : [] });
        }
        for (const patch of C.patch) {
            const c = p.clips.get(patch.id as string)!;
            for (const name of CLIP_UPDATE_FIELDS) if (patch[name] !== undefined && patch[name] !== null) c.row[name] = patch[name];
            if (typeof patch.scene_id === "string") c.row.scene_id = patch.scene_id;
            for (const [name, value] of Object.entries(patch)) if (value === null && name !== "effects") c.row[name] = null;
            if ("effects" in patch) c.effects = effectsOf(patch.effects);
        }

        // tracks removed, with their clips
        if (removedTracks.size) {
            for (const id of removedClips) p.clips.delete(id);
            p.tracks = tracksOf(p).filter((t) => !removedTracks.has(`${t.type}:${t.index}`));
        }

        // media links
        for (const id of media.add) if (!p.media.includes(id)) p.media.push(id);
        p.media = p.media.filter((id) => !media.remove.includes(id));

        // project fields
        if (projectBody) for (const [name, value] of Object.entries(projectBody)) (p.fields as Record<string, unknown>)[name] = value;

        // normalise: scene order
        resequence(p);

        // caps
        if (p.clips.size > before.clips.size && p.clips.size > MAX_PROJECT_CLIPS) {
            throw new FakeCloudError(403, "permission_error", `A project holds at most ${MAX_PROJECT_CLIPS} clips`, "project_too_large");
        }
        const clipText = (q: StoredProject) => [...q.clips.values()].reduce((sum, c) => sum + CLIP_TEXT_FIELDS.reduce((n, f) => n + (typeof c.row[f] === "string" ? (c.row[f] as string).length : 0), 0), 0);
        const textNow = clipText(p);
        if (textNow > clipText(before) && textNow > MAX_PROJECT_CLIP_TEXT) {
            throw new FakeCloudError(403, "permission_error", "A project holds at most 32 MB of clip keyframes, props and text", "project_too_large");
        }

        // the history entry: the rows that changed, before and after
        const deltaBefore: Record<string, Record<string, unknown>> = { clips: {}, scenes: {}, effects: {}, project: {} };
        const deltaAfter: Record<string, Record<string, unknown>> = { clips: {}, scenes: {}, effects: {}, project: {} };
        for (const [kind, a, b] of [["scenes", before.scenes, p.scenes], ["clips", before.clips, p.clips]] as const) {
            for (const id of new Set([...a.keys(), ...b.keys()])) {
                const old = (a as Map<string, StoredScene | StoredClip>).get(id);
                const now = (b as Map<string, StoredScene | StoredClip>).get(id);
                if (canonical(old?.row ?? null) !== canonical(now?.row ?? null)) {
                    deltaBefore[kind]![id] = old?.row ?? null;
                    deltaAfter[kind]![id] = now?.row ?? null;
                }
                if (canonical(old?.effects ?? null) !== canonical(now?.effects ?? null) && (old?.effects.length || now?.effects.length)) {
                    deltaBefore.effects![`${kind === "scenes" ? "scene" : "clip"}:${id}`] = old?.effects ?? [];
                    deltaAfter.effects![`${kind === "scenes" ? "scene" : "clip"}:${id}`] = now?.effects ?? [];
                }
            }
        }
        for (const name of PROJECT_FIELDS) {
            if (canonical(before.fields[name]) !== canonical(p.fields[name])) {
                deltaBefore.project![name] = before.fields[name];
                deltaAfter.project![name] = p.fields[name];
            }
        }
        const tracksChanged = canonical(before.tracks) !== canonical(p.tracks);
        const changed = Object.values(deltaBefore).some((rows) => Object.keys(rows).length > 0) || tracksChanged || shotsChanged;
        if (changed) {
            const afterText = JSON.stringify(deltaAfter);
            const beforeText = JSON.stringify(deltaBefore);
            const growth = afterText.length + Math.floor(beforeText.length / 2);
            if (documentBytes(p) > PROJECT_DOCUMENT_MAX_BYTES && growth > 0) {
                throw new FakeCloudError(403, "permission_error", "A cloud project holds at most 8.0 MB of scenes, clips and settings. Split it into two projects.", "project_too_large");
            }
            const used = accountDataBytes();
            if (growth > 0 && used + growth > settings.project_data_limit_bytes) {
                throw new FakeCloudError(403, "permission_error", `Not enough project data left: ${human(Math.max(0, settings.project_data_limit_bytes - used))} of ${human(settings.project_data_limit_bytes)}. Delete projects you no longer need (empty the trash too); edits that don't add data still save.`, "project_data_quota_exceeded");
            }
            p.historyBytes += afterText.length + beforeText.length;
            p.revision += 1;
            p.updatedAt = tick();
        }
        if (typeof body.device === "string") {
            p.lastEditedDevice = body.device;
            if (p.origin === null && current === 0) p.origin = "studio";
        }
        projects.set(p.id, p);
        // The sets a shots write replaced are kept (a redo can put the newer one back).
        for (const scene of keptShots) keepShots(scene);

        // the answer: the rows it touched, as the fake now holds them
        const touchedScenes = new Set([...Object.keys(deltaAfter.scenes!), ...S.create.map((s) => s.id as string), ...S.patch.map((s) => s.id as string)]);
        const touchedClips = new Set([...Object.keys(deltaAfter.clips!), ...C.create.map((c) => c.id as string), ...patched]);
        for (const owner of Object.keys(deltaAfter.effects!)) {
            const [kind, id] = owner.split(":") as [string, string];
            (kind === "scene" ? touchedScenes : touchedClips).add(id);
        }
        const answer: Record<string, unknown> = {
            object: "project_change", revision: p.revision, etag: etagOf(p.revision),
            clips: [...touchedClips].filter((id) => p.clips.has(id)).map((id) => p.clips.get(id)!).sort((a, b) => Number(a.row.start_time) - Number(b.row.start_time) || (a.id < b.id ? -1 : 1)).map(clipView),
            scenes: [...touchedScenes].filter((id) => p.scenes.has(id)).map((id) => p.scenes.get(id)!).sort((a, b) => Number(a.row.order) - Number(b.row.order)).map(sceneView),
            tracks: tracksBody || tracksChanged ? tracksOf(p).map(trackView) : null,
            project: projectBody || Object.keys(deltaBefore.project!).length ? projectView(p, true) : null,
            deleted: { clips: sortedIds([...C.delete, ...removedClips]), scenes: sortedIds(S.delete) },
        };
        if (key !== null && hash !== null) {
            if (!answers.has(projectId)) answers.set(projectId, new Map());
            answers.get(projectId)!.set(key, { hash, answer });
        }
        return answer;
    }

    function newClipRow(data: Record<string, unknown>): Record<string, unknown> {
        const row: Record<string, unknown> = { track_type: data.track_type, track_index: data.track_index, start_time: data.start_time, end_time: data.end_time };
        for (const [name, , fallback] of CLIP_COLUMNS) row[name] = data[name] ?? fallback;
        return row;
    }

    function setSceneTransition(scene: StoredScene, transition: unknown, duration: unknown): void {
        const name = transition !== undefined ? String(transition ?? "none").trim().toLowerCase() || "none" : (scene.row.visual_transition as string | undefined) ?? "none";
        scene.row.visual_transition = name;
        if (name === "none") {
            scene.row.visual_transition_duration = 0;
            return;
        }
        const raw = duration !== undefined ? duration : (scene.row.visual_transition_duration ?? 0.5);
        scene.row.visual_transition_duration = Math.max(0, Math.min(sceneDuration(scene.row, scene.shots) / 2, Number(raw) || 0));
    }

    /** ps.write_scene_fields for the fields a /changes scene patch sends. */
    function writeSceneFields(scene: StoredScene, patch: Record<string, unknown>): void {
        const r = scene.row;
        const has = (name: string) => name in patch;
        for (const name of ["timeline_position_seconds", "track_index", "start_time", "end_time", "fit_mode", "transform_scale", "transform_offset_x", "transform_offset_y", "source_width", "source_height", "extras_json"]) {
            if (has(name)) r[name] = patch[name];
        }
        if (has("video_url")) r.video_url = patch.video_url || null;
        if (has("caption")) r.caption = patch.caption;
        if (has("visual_transition") || has("visual_transition_duration")) {
            setSceneTransition(scene, has("visual_transition") ? patch.visual_transition : undefined, has("visual_transition_duration") ? patch.visual_transition_duration : undefined);
        }
        if (has("card_type")) r.card_type = patch.card_type;
        if (has("audio_url")) r.audio_url = patch.audio_url;
        if (has("audio_text")) r.audio_text = patch.audio_text;
        if (has("music_enabled")) r.music_enabled = patch.music_enabled === true;
        if (has("duration")) {
            // Only an ai_video scene without shots is rounded to 5, 10 or 15 seconds (the editor's rule).
            const card = has("card_type") ? patch.card_type : r.card_type;
            let duration = patch.duration as number;
            if (card === "ai_video" && scene.shots.length === 0 && ![5, 10, 15].includes(duration)) {
                duration = [5, 10, 15].reduce((best, v) => (Math.abs(v - duration) < Math.abs(best - duration) ? v : best), 5);
            }
            r.duration = duration;
        }
        if (has("overlay_text")) r.overlay_text = patch.overlay_text;
        if (has("background_url")) r.background_url = patch.background_url;
        if (has("source_video_url")) r.source_video_url = patch.source_video_url;
        if (has("card_config")) r.card_config = patch.card_config;
        if (has("start_image_url")) r.start_image_url = patch.start_image_url || null;
        if (has("end_image_url")) r.end_image_url = patch.end_image_url || null;
        if (has("scene_location")) r.scene_location = patch.scene_location || null;
        if (has("objects_in_scene")) {
            const cleaned = ((patch.objects_in_scene as string[] | null) ?? []).map((t) => t.trim()).filter(Boolean);
            r.objects_in_scene = JSON.stringify(cleaned);
        }
        if (has("effects")) scene.effects = effectsOf(patch.effects);
    }

    // ── import (ps.import_project) ──

    function importProject(body: Record<string, unknown>): Record<string, unknown> {
        roomForANewProject();
        const fields = body.project as Record<string, unknown>;
        const scenes = (body.scenes as Array<Record<string, unknown>> | undefined) ?? [];
        const timeline = (body.timeline as { tracks?: Array<Record<string, unknown>>; clips?: Array<Record<string, unknown>> } | undefined) ?? {};
        const clips = timeline.clips ?? [];
        const graphics = clips.map((c) => c.custom_graphic_id).filter((id): id is string => typeof id === "string" && id.length > 0);
        if (graphics.length) throw notFound("No such graphic in this account's library.", "entity_missing", { kind: "graphic", ids: [...new Set(graphics)].sort() });
        const p = newProject(fields);
        p.origin = "studio";
        const used = (kind: "clip" | "scene", ids: string[]) => new Set(idsInUse(kind, ids.filter((id) => CLIENT_ID.test(id))));
        const usedScenes = used("scene", scenes.map((s) => s.id as string));
        const usedClips = used("clip", clips.map((c) => c.id as string));
        const sceneIds: Record<string, string> = {};
        const clipIds: Record<string, string> = {};
        scenes.forEach((data, order) => {
            const bundleId = data.id as string;
            const id = CLIENT_ID.test(bundleId) && !usedScenes.has(bundleId) ? bundleId : randomUUID();
            const row: Record<string, unknown> = { order, start_time: data.start_time || "00:00:00,000", end_time: data.end_time || "00:00:05,000" };
            for (const [name, value] of Object.entries(data)) if (value !== null && !["id", "effects", "start_time", "end_time"].includes(name)) row[name] = value;
            if (row.caption == null) row.caption = "";
            if (row.duration != null && !data.end_time) row.end_time = srtStamp(srtSeconds(row.start_time as string) + Number(row.duration));
            p.scenes.set(id, { id, row, effects: effectsOf(data.effects), shots: [] });
            sceneIds[bundleId] = id;
        });
        if (timeline.tracks && timeline.tracks.length) p.tracks = normalizeTracks(timeline.tracks);
        for (const data of clips) {
            const bundleId = data.id as string;
            const id = CLIENT_ID.test(bundleId) && !usedClips.has(bundleId) ? bundleId : randomUUID();
            const values = { ...data };
            if (typeof data.scene_id === "string") {
                if (!(data.scene_id in sceneIds)) throw invalid("A clip names a scene the bundle does not have", "invalid_change");
                values.scene_id = sceneIds[data.scene_id];
            }
            p.clips.set(id, { id, row: newClipRow(values), effects: effectsOf(data.effects) });
            clipIds[bundleId] = id;
        }
        projects.set(p.id, p);
        return { project: projectView(p), scene_ids: sceneIds, clip_ids: clipIds };
    }

    // ── the list (ps.list_project_page) ──

    function encodeCursor(ms: number, id: string): string {
        return Buffer.from(`${iso(ms)}|${id}`).toString("base64url");
    }

    function listProjects(query: URLSearchParams): Record<string, unknown> {
        const bad = (name: string, message: string) => invalid(`query.${name}: ${message}`);
        const limitText = query.get("limit");
        const limit = limitText === null ? 50 : Number(limitText);
        if (!Number.isInteger(limit)) throw bad("limit", "Input should be a valid integer, unable to parse string as an integer");
        if (limit < 1) throw bad("limit", "Input should be greater than or equal to 1");
        if (limit > 100) throw bad("limit", "Input should be less than or equal to 100");
        const order = query.get("order") ?? "created";
        if (order !== "created" && order !== "updated") throw bad("order", "Input should be 'created' or 'updated'");
        const state = query.get("state") ?? "active";
        if (state !== "active" && state !== "deleted") throw bad("state", "Input should be 'active' or 'deleted'");
        const cursor = query.get("cursor");
        if (cursor !== null && (cursor.length > 200 || !/^[A-Za-z0-9_=-]+$/.test(cursor))) throw bad("cursor", "String should match pattern '^[A-Za-z0-9_=-]+$'");
        const startingAfter = query.get("starting_after");
        if (startingAfter !== null && !PROJECT_ID.test(startingAfter)) throw bad("starting_after", "String should match pattern '^[A-Za-z0-9_-]{1,36}$'");
        const pageError = () => invalid("starting_after must be the id of one of this account's projects, and cursor the next_cursor of a page.");
        const column = (p: StoredProject) => (order === "updated" ? p.updatedAt : p.createdAt);
        let after: { stamp: number; id: string } | null = null;
        if (cursor) {
            const raw = Buffer.from(cursor.replace(/=+$/, ""), "base64url").toString("utf8");
            const [stamp, id] = raw.split("|");
            const ms = Date.parse(stamp ?? "");
            if (!id || !Number.isFinite(ms)) throw pageError();
            after = { stamp: ms, id };
        } else if (startingAfter) {
            const p = projects.get(startingAfter);
            if (!p) throw pageError();
            after = { stamp: column(p), id: p.id };
        }
        let rows = [...projects.values()].filter((p) => (state === "deleted" ? p.deletedAt !== null : p.deletedAt === null));
        if (after) rows = rows.filter((p) => column(p) < after!.stamp || (column(p) === after!.stamp && p.id < after!.id));
        rows.sort((a, b) => column(b) - column(a) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
        const more = rows.length > limit;
        const page = rows.slice(0, limit);
        const last = page[page.length - 1];
        return { object: "list", data: page.map((p) => projectView(p)), has_more: more, next_cursor: more && last ? encodeCursor(column(last), last.id) : null };
    }

    // ── the routes ──

    function route(req: CloudRequest): CloudAnswer | null {
        const { method, path } = req;
        const ok = (json: unknown, status = 200, headers?: Record<string, string>): CloudAnswer => ({ status, json, ...(headers ? { headers } : {}) });
        if (path === "/v1/storage" && method === "GET") return ok(storageView());
        if (path === "/v1/uploads" && method === "POST") return startUpload(validator.body(UPLOAD_BODY, req.body));
        const complete = /^\/v1\/uploads\/([^/]+)\/complete$/.exec(path);
        if (complete && method === "POST") {
            const id = decodeURIComponent(complete[1]!);
            if (id.length > 1_024) throw uploadNotFound();
            return completeUpload(id, req.body === undefined ? {} : validator.body(COMPLETE_BODY, req.body));
        }
        if (path === "/v1/projects") {
            if (method === "POST") {
                const body = validator.body(PROJECT_CREATE, req.body);
                roomForANewProject();
                const p = newProject(body);
                for (const [i, cue] of (body.srt_content ? parseSrt(body.srt_content as string) ?? [] : []).entries()) {
                    const id = randomUUID();
                    p.scenes.set(id, { id, row: { order: i, start_time: cue.start, end_time: cue.end, caption: cue.text, visual_transition: "none" }, effects: [], shots: [] });
                }
                projects.set(p.id, p);
                return ok(projectView(p), 201);
            }
            if (method === "GET") return ok(listProjects(req.query));
            return null;
        }
        if (path === "/v1/projects/import" && method === "POST") {
            if (req.raw.length > IMPORT_MAX_BODY_BYTES) throw new FakeCloudError(413, "invalid_request_error", "The request body is too large.", "request_too_large");
            return ok(importProject(validator.body(IMPORT_BODY, req.body)), 201);
        }
        const shared = shares.owner({ method, path, body: req.body });
        if (shared) return shared;
        const match = /^\/v1\/projects\/([^/]+)(\/restore|\/document|\/changes|\/script)?$/.exec(path);
        if (!match) return null;
        const id = decodeURIComponent(match[1]!);
        if (!PROJECT_ID.test(id)) throw invalid("project_id: String should match pattern '^[A-Za-z0-9_-]{1,36}$'");
        const tail = match[2];
        if (!tail) {
            if (method === "GET") return ok(projectView(live(id)));
            if (method === "PATCH") {
                const body = validator.body(PROJECT_PATCH, req.body);
                const ifMatch = header(req, "if-match");
                if (ifMatch !== undefined) {
                    const wanted = wantedRevision(ifMatch);
                    const p = live(id);
                    if (p.revision !== wanted) throw new FakeCloudError(412, "precondition_failed", "The project changed since you read it: read it again and retry with its revision.", "timeline_changed", { revision: p.revision });
                }
                const p = live(id);
                const growth = JSON.stringify(Object.fromEntries(Object.entries(body).filter(([, v]) => v !== null))).length;
                const used = accountDataBytes();
                if (growth > 0 && used + growth > settings.project_data_limit_bytes) {
                    throw new FakeCloudError(403, "permission_error", `Not enough project data left: ${human(Math.max(0, settings.project_data_limit_bytes - used))} of ${human(settings.project_data_limit_bytes)}.`, "project_data_quota_exceeded");
                }
                for (const [name, value] of Object.entries(body)) (p.fields as Record<string, unknown>)[name] = value;
                p.updatedAt = tick();
                return ok(projectView(p), 200, { etag: etagOf(p.revision) });
            }
            if (method === "DELETE") {
                const permanent = req.query.get("permanent");
                if (permanent !== null && !["true", "false", "1", "0"].includes(permanent.toLowerCase())) throw invalid("query.permanent: Input should be a valid boolean");
                const p = projects.get(id);
                if (permanent === "true" || permanent === "1") {
                    if (!p) throw notFound();
                    projects.delete(id);
                    answers.delete(id);
                    hooks.projectPurged(id);
                } else {
                    live(id).deletedAt = tick();
                }
                return ok({ id, object: "project", deleted: true });
            }
            return null;
        }
        if (tail === "/restore" && method === "POST") {
            const p = projects.get(id);
            if (!p || p.deletedAt === null) throw notFound();
            p.deletedAt = null;
            return ok(projectView(p));
        }
        if (tail === "/script" && method === "GET") {
            const p = live(id);
            const srt = p.fields.srt_content || null;
            let cues = 0;
            try {
                cues = srtCues(srt, []);
            } catch {
                cues = 0; // written before these rules: shown as it is
            }
            return ok({ object: "project_script", script_text: p.fields.script_text || null, srt_content: srt, cues, revision: p.revision });
        }
        if (tail === "/document" && method === "GET") {
            const p = live(id);
            const etag = etagOf(p.revision);
            const ifNoneMatch = header(req, "if-none-match");
            if (ifNoneMatch !== undefined) {
                const tag = ifNoneMatch.trim().startsWith("W/") ? ifNoneMatch.trim().slice(2) : ifNoneMatch.trim();
                if (tag === etag) {
                    document304s += 1;
                    return { status: 304, headers: { etag } };
                }
            }
            documentReads += 1;
            return ok({
                object: "project_document", revision: p.revision, project: projectView(p, true), tracks: tracksOf(p).map(trackView),
                clips: orderedClips(p).map(clipView), scenes: orderedScenes(p).map(sceneView), media: hooks.mediaItems(p.media),
            }, 200, { etag });
        }
        if (tail === "/changes" && method === "POST") {
            const ifMatch = header(req, "if-match") ?? null;
            const key = header(req, "idempotency-key") ?? null;
            const record = (status: number) => changeLog.push({ project_id: id, key, if_match: ifMatch, status, at: Date.now() });
            try {
                const failure = failures[0];
                if (failure) {
                    failure.count = (failure.count ?? 1) - 1;
                    if (failure.count <= 0) failures.shift();
                    throw new FakeCloudError(failure.status, typeOfStatus(failure.status), failure.message ?? failure.code, failure.code, failure.details,
                        failure.retry_after !== undefined ? { "retry-after": String(failure.retry_after) } : undefined);
                }
                if (req.raw.length > CHANGES_MAX_BODY_BYTES) throw new FakeCloudError(413, "invalid_request_error", "The request body is too large.", "request_too_large");
                const body = validator.body(CHANGESET, req.body);
                if (!key || key.length > MAX_KEY_CHARS) throw invalid(`Send an Idempotency-Key header (1-${MAX_KEY_CHARS} characters) with each changeset.`);
                const answer = applyChangeset(id, withDefaults(body), ifMatch, key, createHash("sha256").update(canonical(body)).digest("hex"));
                record(200);
                return ok(answer, 200, { etag: answer.etag as string });
            } catch (error) {
                record(error instanceof FakeCloudError ? error.status : 500);
                throw error;
            }
        }
        return null;
    }

    /** The changeset with its lists defaulted (the model's default_factory). */
    function withDefaults(body: Record<string, unknown>): Record<string, unknown> {
        const lists = (value: unknown, names: string[]) => {
            const o = (value as Record<string, unknown> | undefined) ?? {};
            return Object.fromEntries(names.map((n) => [n, (o[n] as unknown[] | undefined) ?? []]));
        };
        return {
            ...body,
            scenes: lists(body.scenes, ["create", "patch", "delete"]),
            clips: lists(body.clips, ["create", "patch", "delete"]),
            media: lists(body.media, ["add", "remove"]),
            tracks: body.tracks ? lists(body.tracks, ["put", "removed"]) : null,
        };
    }

    function stateOf(): FakeCloudState {
        return {
            projects: [...projects.values()].map((p) => ({
                id: p.id, name: p.fields.name, revision: p.revision, deleted_at: p.deletedAt === null ? null : iso(p.deletedAt), origin: p.origin,
                last_edited_device: p.lastEditedDevice, description: p.fields.description, product_type: p.fields.product_type, aspect_ratio: p.fields.aspect_ratio,
                visual_style: p.fields.visual_style, camera_type: p.fields.camera_type, default_video_quality: p.fields.default_video_quality,
                default_audio_on: p.fields.default_audio_on, music_url: p.fields.music_url, music_filename: p.fields.music_filename, music_volume: p.fields.music_volume,
                extras_json: p.fields.extras_json, script_text: p.fields.script_text, srt_content: p.fields.srt_content, final_video_url: p.fields.final_video_url, tracks: tracksOf(p), clips: orderedClips(p).map(clipView), scenes: orderedScenes(p).map(sceneView), media: [...p.media],
                data_bytes: dataBytes(p),
            })),
            assets: [...assets.values()].map((a) => ({
                id: a.id, sha256: a.sha256, size_bytes: a.sizeBytes, content_type: a.contentType, scope: a.scope, media_url: a.mediaUrl,
                project_ids: [...projects.values()].filter((p) => p.media.includes(a.id)).map((p) => p.id),
            })),
            uploads: [...uploads.values()].map((u) => ({
                id: u.id, scope: u.scope, project_id: u.projectId, sha256: u.sha256, size_bytes: u.sizeBytes, puts: u.puts, completed: u.answer !== null,
                transport: u.transport, gateway_tokens_used: u.tokens.filter((t) => tokens.get(t)?.used).length,
            })),
            changes: changeLog.map((c) => ({ ...c })),
            document_reads: documentReads,
            document_304s: document304s,
            storage: storageView(),
            shares: shares.state(),
        };
    }

    const bumped = (p: StoredProject) => {
        p.revision += 1;
        p.updatedAt = tick();
        return { revision: p.revision };
    };

    const cloud: FakeCloud = {
        remoteChange(projectId, changes, device) {
            const body = validator.body(CHANGESET, changes ?? {});
            if (device !== undefined) body.device = device;
            const answer = applyChangeset(projectId, withDefaults(body), null, null, null);
            return { revision: answer.revision as number };
        },
        bump: (projectId) => bumped(live(projectId)),
        lockClip(projectId, clipId, isLocked) {
            const p = live(projectId);
            const c = p.clips.get(clipId);
            if (!c) throw notFound("No such clip in this project.", "entity_missing", { kind: "clip", ids: [clipId] });
            c.row.locked = isLocked;
            return bumped(p);
        },
        deleteEntity(projectId, kind, id) {
            const p = live(projectId);
            if (kind === "clip") {
                if (!p.clips.delete(id)) throw notFound("No such clip in this project.", "entity_missing", { kind: "clip", ids: [id] });
            } else {
                if (!p.scenes.delete(id)) throw notFound("No such scene in this project.", "entity_missing", { kind: "scene", ids: [id] });
                for (const c of p.clips.values()) if (c.row.scene_id === id) c.row.scene_id = null;
                resequence(p);
            }
            return bumped(p);
        },
        setShots(projectId, sceneId, shots, sheets) {
            const scene = live(projectId).scenes.get(sceneId);
            if (!scene) throw notFound("No such scene in this project.", "entity_missing", { kind: "scene", ids: [sceneId] });
            // The server keeps the set a tool is about to overwrite (an undo can put it back).
            keepShots(scene);
            scene.shots = shots.map((s) => ({ ...s }));
            if (sheets !== undefined) scene.sheets = sheets.map((x) => ({ ...x }));
        },
        setSceneBusy(_projectId, sceneId, busy) {
            if (busy) busyScenes.add(sceneId);
            else busyScenes.delete(sceneId);
        },
        setOffline(mode) {
            offline = mode;
        },
        setLatency(ms, pathPrefix) {
            latency = { ms: Math.max(0, ms), prefix: pathPrefix ?? null };
        },
        failNextChange(failure) {
            failures.push({ ...failure });
        },
        storm412(count) {
            storm = Math.max(0, Math.floor(count));
        },
        expireKey() {
            expireNext = true;
        },
        setStorage(patch) {
            settings = { ...settings, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) };
        },
        setUploadLimits(patch) {
            uploadLimits = { ...uploadLimits, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) };
        },
        state: stateOf,
    };

    const hooks = {
        /** ps.project_stats' media bytes: the project's own counted files plus the account files it links. */
        mediaBytes(projectId: string, media: string[]): number {
            let total = 0;
            for (const a of assets.values()) if (a.scope === "project" && a.projectId === projectId) total += a.sizeBytes;
            for (const id of media) {
                const a = assets.get(id);
                if (a && a.scope === "account") total += a.sizeBytes;
            }
            return total;
        },
        mediaItems(media: string[]): unknown[] {
            return media.map((id) => assets.get(id)).filter((a): a is StoredAsset => a !== undefined).map((a) => ({
                id: a.id, kind: UPLOAD_TYPES[a.contentType]?.[1] ?? "file", source: "upload", url: a.mediaUrl, scene_id: null, filename: a.filename,
                size_bytes: a.sizeBytes, created_at: iso(a.createdAt), asset_id: a.id, sha256: a.sha256,
            }));
        },
        ownsAsset: (id: string) => assets.has(id),
        /** A purged project's own files go with it. */
        projectPurged(projectId: string): void {
            shares.purge(projectId);
            for (const a of [...assets.values()]) {
                if (a.scope !== "project" || a.projectId !== projectId) continue;
                assets.delete(a.id);
                objects.delete(a.key);
                for (const p of projects.values()) p.media = p.media.filter((id) => id !== a.id);
            }
        },
    };

    // ── share links (phase 9c, testing-shares.ts) ──

    const shares = createFakeShares({
        base,
        ownerName: () => options.ownerName?.() ?? null,
        project(id) {
            const p = projects.get(id);
            if (!p) return null;
            const scenes = [...p.scenes.values()].map((s, i) => ({ s, i })).sort((a, b) =>
                (Number(a.s.row.track_index ?? 1) || 1) - (Number(b.s.row.track_index ?? 1) || 1)
                || Number(a.s.row.timeline_position_seconds ?? 0) - Number(b.s.row.timeline_position_seconds ?? 0)
                || Number(a.s.row.order) - Number(b.s.row.order) || a.i - b.i);
            return {
                id: p.id, name: p.fields.name, aspectRatio: p.fields.aspect_ratio, durationSeconds: stats(p).duration_seconds, finalVideoUrl: p.fields.final_video_url,
                trashed: p.deletedAt !== null,
                scenes: scenes.map(({ s }) => ({ duration: sceneDuration(s.row, s.shots), videoUrl: (s.row.video_url as string | null | undefined) ?? null, imageUrl: (s.row.start_image_url as string | null | undefined) ?? null })),
            };
        },
    });

    // ── storage ──

    const pending = () => [...uploads.values()].filter((u) => u.answer === null);
    const mediaBytes = () => [...assets.values()].filter((a) => a.scope !== "temp").reduce((n, a) => n + a.sizeBytes, 0)
        + pending().filter((u) => u.scope !== "temp").reduce((n, u) => n + u.sizeBytes, 0) + settings.media_used_extra_bytes;
    const tempBytes = () => [...assets.values()].filter((a) => a.scope === "temp").reduce((n, a) => n + a.sizeBytes, 0)
        + pending().filter((u) => u.scope === "temp").reduce((n, u) => n + u.sizeBytes, 0);
    const today = () => {
        const day = new Date().toISOString().slice(0, 10);
        if (daily.day !== day) daily = { day, uploads: 0, bytes: 0 };
        return daily;
    };

    function storageView(): Record<string, unknown> {
        const limits = { media_bytes: settings.media_limit_bytes, project_data_bytes: settings.project_data_limit_bytes, uploads_per_day: settings.uploads_per_day, upload_bytes_per_day: settings.upload_bytes_per_day };
        const media = mediaBytes();
        const data = accountDataBytes();
        const day = today();
        const state = media >= settings.media_limit_bytes || data >= settings.project_data_limit_bytes ? "over_quota" : settings.pool_full ? "pool_full" : "ok";
        return {
            object: "storage", media_bytes: media, project_data_bytes: data, included: { ...limits }, purchased: { media_bytes: 0, project_data_bytes: 0, uploads_per_day: 0, upload_bytes_per_day: 0 },
            limits, today: { uploads: day.uploads, upload_bytes: day.bytes }, temp_bytes: tempBytes(), temp_limit_bytes: settings.temp_limit_bytes, state, grace_ends_at: null, blocks: [],
        };
    }

    /** sq.hold_upload: the account's media quota (or the temp limit), the daily caps, then the free pool. */
    function holdUpload(size: number, temp: boolean): void {
        const now = Date.now();
        const midnight = { "retry-after": String(secondsToUtcMidnight(now)) };
        const day = today();
        if (size > settings.upload_bytes_per_day) {
            throw new FakeCloudError(429, "rate_limit_error", `A file can't be larger than the daily upload limit (${human(settings.upload_bytes_per_day)}).`, "upload_daily_limit", undefined, midnight);
        }
        if (temp && tempBytes() + size > settings.temp_limit_bytes) {
            throw new FakeCloudError(429, "rate_limit_error", `Too many temporary uploads at once: at most ${human(settings.temp_limit_bytes)} of tool inputs until running tasks finish (they are deleted then, or after 24 hours).`,
                "temp_storage_exceeded", undefined, { "retry-after": "600" });
        }
        const used = mediaBytes();
        if (!temp && used + size > settings.media_limit_bytes) {
            throw new FakeCloudError(403, "permission_error", `Not enough cloud storage: ${human(Math.max(0, settings.media_limit_bytes - used))} left of ${human(settings.media_limit_bytes)}. Delete media you no longer use; nothing was charged.`,
                "storage_quota_exceeded");
        }
        if (day.uploads + 1 > settings.uploads_per_day || day.bytes + size > settings.upload_bytes_per_day) {
            throw new FakeCloudError(429, "rate_limit_error", `Daily upload limit reached: at most ${settings.uploads_per_day} files and ${human(settings.upload_bytes_per_day)} a day. Try again after midnight UTC.`,
                "upload_daily_limit", undefined, midnight);
        }
        if (settings.pool_full) {
            throw new FakeCloudError(503, "unavailable", "Free cloud storage is full right now. Try again later; nothing was charged.", "free_storage_pool_full", undefined, { "retry-after": "3600" });
        }
        day.uploads += 1;
        day.bytes += size;
    }

    // ── uploads ──

    const fileUrl = (key: string) => `${base()}/files/${key}`;
    const gatewayUrl = (token: string) => `${base()}/u/${token}`;
    const linkMedia = (projectId: string, assetId: string) => {
        const p = projects.get(projectId);
        if (p && !p.media.includes(assetId)) p.media.push(assetId);
    };

    function startUpload(body: Record<string, unknown>): CloudAnswer {
        const projectId = (body.project_id as string | null | undefined) ?? null;
        const sha256 = (body.sha256 as string | null | undefined) ?? null;
        const size = body.size_bytes as number;
        const contentType = body.content_type as string;
        if (projectId) live(projectId);
        if (sha256) {
            const found = [...assets.values()].find((a) => a.sha256 === sha256 && a.sizeBytes === size && a.contentType === contentType);
            if (found) {
                if (projectId) linkMedia(projectId, found.id);
                return { status: 200, json: { object: "upload", deduplicated: true, asset_id: found.id, media_url: found.mediaUrl, content_type: contentType, size_bytes: size, project_id: projectId } };
            }
        }
        const big = size > uploadLimits.single_put_max_bytes;
        const scope = ((body.scope as string | null | undefined) ?? (projectId ? "project" : "temp")) as StoredUpload["scope"];
        if (big && (body.multipart !== true || (scope === "temp" && !uploadLimits.temp_multipart))) {
            throw invalid("Files over 95 MB must be sent in parts: ask with multipart: true.", "multipart_required");
        }
        const transport = big ? "multipart" : "gateway";
        const ext = UPLOAD_TYPES[contentType]![0];
        const token = base32(randomBytes(15));
        const key = scope === "account" ? `uploads/media/${OWNER}/${sha256}.${ext}` : scope === "temp" ? `uploads/temp/${OWNER}/${token}.${ext}` : projectId ? `projects/${projectId}/uploads/${token}.${ext}` : `uploads/api/${OWNER}/${token}.${ext}`;
        holdUpload(size, scope === "temp");
        const upload: StoredUpload = {
            id: `up_${randomBytes(24).toString("base64url")}.${randomBytes(16).toString("base64url")}`, scope, projectId, sha256: scope === "account" ? sha256 : null,
            sizeBytes: size, contentType, filename: body.filename as string, key, transport, tokens: [], parts: new Map(), puts: 0, answer: null,
        };
        const mint = (part: number | null, partSize: number) => {
            const t = `${randomBytes(24).toString("base64url")}.${randomBytes(16).toString("base64url")}`;
            tokens.set(t, { uploadId: upload.id, part, size: partSize, contentType, used: false });
            upload.tokens.push(t);
            return t;
        };
        let uploadUrl: string | null = null;
        let multipart: Record<string, unknown> | null = null;
        if (transport === "multipart") {
            const partSize = uploadLimits.part_size;
            const parts: Array<{ number: number; size: number; url: string }> = [];
            for (let number = 1, left = size; left > 0; number += 1, left -= partSize) {
                const partBytes = Math.min(partSize, left);
                parts.push({ number, size: partBytes, url: gatewayUrl(mint(number, partBytes)) });
            }
            multipart = { part_size: partSize, parts };
        } else {
            uploadUrl = gatewayUrl(mint(null, size));
        }
        uploads.set(upload.id, upload);
        return {
            status: 201,
            json: {
                object: "upload", upload_id: upload.id, upload_url: uploadUrl, method: "PUT", headers: { "Content-Type": contentType, "Content-Length": String(size) },
                media_url: fileUrl(key), expires_at: isoSeconds(Date.now() + TOKEN_SECONDS * 1000), multipart, scope,
            },
        };
    }

    const uploadNotFound = () => notFound("No such upload on this account (or it expired: start a new one).", "upload_not_found");

    function completeUpload(id: string, body: Record<string, unknown>): CloudAnswer {
        const upload = uploads.get(id);
        if (!upload) throw uploadNotFound();
        if (upload.answer) return { status: 200, json: upload.answer };
        if (upload.transport === "multipart") {
            const wanted = upload.tokens.length;
            const parts = ((body.parts as Array<{ number: number; etag: string }> | null | undefined) ?? []).slice().sort((a, b) => a.number - b.number);
            if (parts.map((part) => part.number).join(",") !== Array.from({ length: wanted }, (_, i) => i + 1).join(",")) {
                throw invalid(`Send the ETag of each of the ${wanted} parts.`, "upload_parts_invalid");
            }
            if (parts.some((part) => upload.parts.get(part.number)?.etag !== part.etag.replace(/^"|"$/g, ""))) {
                throw invalid("The parts don't make up the file: send every part, then the ETags they answered.", "upload_parts_invalid");
            }
            objects.set(upload.key, { bytes: Buffer.concat(parts.map((part) => upload.parts.get(part.number)!.bytes)), contentType: upload.contentType });
        }
        if (!objects.has(upload.key)) throw new FakeCloudError(409, "conflict", "Nothing was uploaded to upload_url yet: PUT the file first.", "upload_not_received");
        if (upload.projectId) live(upload.projectId);
        const url = fileUrl(upload.key);
        let asset = [...assets.values()].find((a) => a.mediaUrl === url)
            ?? (upload.sha256 ? [...assets.values()].find((a) => a.sha256 === upload.sha256 && a.sizeBytes === upload.sizeBytes && a.contentType === upload.contentType) : undefined);
        const temp = upload.scope === "temp";
        if (!asset) {
            const now = Date.now();
            asset = {
                id: randomUUID(), sha256: upload.sha256, sizeBytes: upload.sizeBytes, contentType: upload.contentType, scope: upload.scope, key: upload.key, mediaUrl: url,
                projectId: upload.scope === "project" ? upload.projectId : null, filename: upload.filename || "upload", createdAt: now,
                expiresAt: temp ? now + TEMP_UPLOAD_HOURS * 3_600_000 : null,
            };
            assets.set(asset.id, asset);
        }
        if (upload.projectId && !temp) linkMedia(upload.projectId, asset.id);
        upload.answer = {
            object: "upload", asset_id: asset.id, media_url: asset.mediaUrl, content_type: upload.contentType, size_bytes: upload.sizeBytes, project_id: upload.projectId,
            scope: asset.expiresAt !== null ? "temp" : asset.sha256 ? "account" : "project", expires_at: asset.expiresAt !== null ? iso(asset.expiresAt) : null,
        };
        return { status: 200, json: upload.answer };
    }

    /** The Worker's PUT (infra/upload-gateway): token, exact size and type, then a single claim; and the old presigned PUT. */
    function gateway(req: CloudRequest): CloudAnswer | null {
        const gatewayPath = /^\/u\/([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(req.path);
        const legacyPath = /^\/__uploads\/([^/]+)$/.exec(req.path);
        if ((!gatewayPath && !legacyPath) || req.method !== "PUT") return null;
        const type = (header(req, "content-type") ?? "").split(";")[0]!.trim().toLowerCase();
        if (header(req, "authorization") !== undefined) return new FakeCloudError(403, "permission_error", "The storage host takes no Authorization header.", "permission_denied").answer();
        if (legacyPath) {
            const upload = uploads.get(decodeURIComponent(legacyPath[1]!));
            if (!upload || upload.transport !== "gateway") return notFound("No such upload.").answer();
            if (type !== upload.contentType) return invalid("Content-Type does not match the upload.").answer();
            if (req.raw.length !== upload.sizeBytes) return invalid("Content-Length does not match the upload.").answer();
            objects.set(upload.key, { bytes: req.raw, contentType: upload.contentType });
            upload.puts += 1;
            return { status: 200 };
        }
        const claim = tokens.get(gatewayPath![1]!);
        const upload = claim ? uploads.get(claim.uploadId) : undefined;
        if (!claim || !upload) return notFound("This upload URL is invalid or has expired.", "upload_not_found").answer();
        if (req.raw.length !== claim.size) return invalid(`This URL takes exactly ${claim.size} bytes; got Content-Length ${req.raw.length}.`, "upload_size_mismatch").answer();
        if (type !== claim.contentType) return invalid(`This URL takes Content-Type ${claim.contentType}.`, "upload_type_mismatch").answer();
        if (claim.used) return new FakeCloudError(410, "conflict", "This upload URL has already been used. Request a new one.", "upload_url_used").answer();
        claim.used = true;
        upload.puts += 1;
        const etag = createHash("md5").update(req.raw).digest("hex");
        if (claim.part !== null) {
            upload.parts.set(claim.part, { etag, bytes: req.raw });
            return { status: 200, json: { part_number: claim.part, etag }, headers: { etag: `"${etag}"` } };
        }
        objects.set(upload.key, { bytes: req.raw, contentType: upload.contentType });
        return { status: 200, json: { etag }, headers: { etag: `"${etag}"` } };
    }

    function file(path: string, method: string, range: string | undefined): CloudAnswer | null {
        if (!path.startsWith("/files/") || (method !== "GET" && method !== "HEAD")) return null;
        let key: string;
        try {
            key = decodeURIComponent(path.slice("/files/".length));
        } catch {
            return null;
        }
        const stored = objects.get(key);
        if (!stored) return null;
        const size = stored.bytes.length;
        const plain = { "accept-ranges": "bytes" };
        const match = range ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null;
        if (match && (match[1] || match[2])) {
            let start: number;
            let end: number;
            if (!match[1]) {
                const suffix = Number(match[2]);
                start = Math.max(0, size - suffix);
                end = size - 1;
            } else {
                start = Number(match[1]);
                end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
            }
            if (start >= size || start > end) return { status: 416, json: undefined, headers: { ...plain, "content-range": `bytes */${size}` } };
            const slice = stored.bytes.subarray(start, end + 1);
            return { status: 206, bytes: method === "HEAD" ? Buffer.alloc(0) : slice, contentType: stored.contentType, headers: { ...plain, "content-range": `bytes ${start}-${end}/${size}`, "content-length": String(slice.length) } };
        }
        return { status: 200, bytes: method === "HEAD" ? Buffer.alloc(0) : stored.bytes, contentType: stored.contentType, headers: { ...plain, "content-length": String(size) } };
    }

    function knob(name: string, method: string, body: unknown): CloudAnswer | null {
        const b = (body ?? {}) as Record<string, unknown>;
        const text = (v: unknown) => typeof v === "string" && v.length > 0;
        const ok = (json: unknown = { ok: true }): CloudAnswer => ({ status: 200, json });
        const bad = (message: string) => invalid(message).answer();
        try {
            if (name === "state" && method === "GET") return ok(stateOf());
            if (method !== "POST") return null;
            switch (name) {
                case "remote-change":
                    if (!text(b.project_id)) return bad("project_id is required");
                    return ok(cloud.remoteChange(b.project_id as string, b.changes ?? {}, typeof b.device === "string" ? b.device : undefined));
                case "bump":
                    if (!text(b.project_id)) return bad("project_id is required");
                    return ok(cloud.bump(b.project_id as string));
                case "lock-clip":
                    if (!text(b.project_id) || !text(b.clip_id) || typeof b.locked !== "boolean") return bad("project_id, clip_id and locked are required");
                    return ok(cloud.lockClip(b.project_id as string, b.clip_id as string, b.locked));
                case "delete-entity":
                    if (!text(b.project_id) || !text(b.id) || (b.kind !== "clip" && b.kind !== "scene")) return bad("project_id, kind (clip or scene) and id are required");
                    return ok(cloud.deleteEntity(b.project_id as string, b.kind, b.id as string));
                case "set-shots":
                    if (!text(b.project_id) || !text(b.scene_id) || !Array.isArray(b.shots)) return bad("project_id, scene_id and shots are required");
                    cloud.setShots(b.project_id as string, b.scene_id as string, b.shots as Array<Record<string, unknown>>, Array.isArray(b.sheets) ? b.sheets as Array<Record<string, unknown>> : undefined);
                    return ok();
                case "sheet-views":
                    if (typeof b.unfiltered !== "boolean") return bad("unfiltered is true or false");
                    sheetsUnfiltered = b.unfiltered;
                    return ok({ unfiltered: sheetsUnfiltered });
                case "scene-busy":
                    if (!text(b.project_id) || !text(b.scene_id) || typeof b.busy !== "boolean") return bad("project_id, scene_id and busy are required");
                    cloud.setSceneBusy(b.project_id as string, b.scene_id as string, b.busy);
                    return ok();
                case "offline":
                    if (b.mode !== "503" && b.mode !== "drop" && b.mode !== "off") return bad("mode is 503, drop or off");
                    cloud.setOffline(b.mode);
                    return ok();
                case "latency":
                    if (typeof b.ms !== "number" || b.ms < 0) return bad("ms is a number of milliseconds");
                    cloud.setLatency(b.ms, typeof b.path_prefix === "string" ? b.path_prefix : undefined);
                    return ok();
                case "fail-next-change":
                    if (typeof b.status !== "number" || !text(b.code)) return bad("status and code are required");
                    cloud.failNextChange(b as unknown as FakeChangeFailure);
                    return ok();
                case "storm-412":
                    if (typeof b.count !== "number") return bad("count is required");
                    cloud.storm412(b.count);
                    return ok();
                case "expire-key":
                    cloud.expireKey();
                    return ok();
                case "storage": {
                    const known = Object.keys(FAKE_STORAGE_DEFAULTS);
                    const extra = Object.keys(b).filter((k) => !known.includes(k));
                    if (extra.length) return bad(`unknown storage field ${extra[0]}`);
                    if (Object.entries(b).some(([k, v]) => (k === "pool_full" ? typeof v !== "boolean" : typeof v !== "number" || v < 0))) return bad("storage fields are byte counts (pool_full a boolean)");
                    cloud.setStorage(b as FakeStorageSettings);
                    return ok(storageView());
                }
                case "upload-limits": {
                    if (Object.keys(b).some((k) => k !== "single_put_max_bytes" && k !== "part_size" && k !== "temp_multipart")
                        || Object.entries(b).some(([k, v]) => (k === "temp_multipart" ? typeof v !== "boolean" : typeof v !== "number" || v < 1))) {
                        return bad("single_put_max_bytes and part_size are byte counts, temp_multipart a boolean");
                    }
                    cloud.setUploadLimits(b as FakeUploadLimits);
                    return ok({ ...uploadLimits });
                }
                default:
                    return shares.knob(name, body);
            }
        } catch (error) {
            if (error instanceof FakeCloudError) return error.answer();
            throw error;
        }
    }

    return {
        cloud,
        facts(projectId) {
            const p = live(projectId);
            const cues = p.fields.srt_content ? parseSrt(p.fields.srt_content) : [];
            return {
                id: p.id, revision: p.revision, script_text: p.fields.script_text, srt_content: p.fields.srt_content, default_video_quality: p.fields.default_video_quality,
                cues: cues === null ? null : cues.map((c) => ({ ...c, start_seconds: srtSeconds(c.start), end_seconds: srtSeconds(c.end) })),
                scenes: orderedScenes(p).map((sc) => {
                    const view = sceneView(sc);
                    return {
                        id: sc.id, order: view.order as number, caption: view.caption as string | null, duration: view.duration as number, video_url: view.video_url as string | null,
                        source_video_url: view.source_video_url as string | null, shots: sc.shots.map(shotView),
                    };
                }),
            };
        },
        change(projectId, changes, device) {
            const body = validator.body(CHANGESET, changes ?? {});
            body.device = device;
            return applyChangeset(projectId, withDefaults(body), null, null, null);
        },
        api(req) {
            try {
                return route(req);
            } catch (error) {
                if (error instanceof FakeCloudError) return error.answer();
                throw error;
            }
        },
        knob,
        setSceneBusyProbe(probe) {
            busyProbe = probe;
        },
        shareBaseUrl: () => shares.shareBaseUrl(),
        publicShares(req) {
            try {
                return shares.publicRoute({ method: req.method, path: req.path, body: req.body });
            } catch (error) {
                if (error instanceof FakeCloudError) return error.answer();
                throw error;
            }
        },
        network(path) {
            const applies = NETWORK_PATHS.some((prefix) => path.startsWith(prefix));
            const delayMs = latency.ms > 0 && (latency.prefix !== null ? path.startsWith(latency.prefix) : applies) ? latency.ms : 0;
            return { offline: applies && offline !== "off" ? offline : null, delayMs };
        },
        takeExpiredKey() {
            const expired = expireNext;
            expireNext = false;
            return expired;
        },
        gateway,
        file,
        legacyUploads: () => [...uploads.values()].map((u) => ({
            id: u.id, contentType: u.contentType, sizeBytes: u.sizeBytes, filename: u.filename,
            put: u.transport === "multipart" ? u.parts.size === u.tokens.length : objects.has(u.key), completed: u.answer !== null,
        })),
        bytesAt(url) {
            const prefix = `${base()}/files/`;
            return url.startsWith(prefix) ? objects.get(url.slice(prefix.length))?.bytes : undefined;
        },
        reset() {
            projects = new Map();
            answers = new Map();
            changeLog = [];
            documentReads = 0;
            document304s = 0;
            offline = "off";
            latency = { ms: 0, prefix: null };
            failures = [];
            storm = 0;
            expireNext = false;
            settings = { ...FAKE_STORAGE_DEFAULTS };
            uploadLimits = { ...FAKE_UPLOAD_LIMITS };
            assets = new Map();
            uploads = new Map();
            tokens = new Map();
            objects = new Map();
            daily = { day: "", uploads: 0, bytes: 0 };
            shares.reset();
            snapshots = new Map();
            busyScenes = new Set();
            sheetsUnfiltered = false;
        },
    };
}

function human(n: number): string {
    if (n >= GB) return `${(n / GB).toFixed(1)} GB`;
    if (n >= MB) return `${Math.round(n / MB)} MB`;
    return `${n} bytes`;
}
