// Studio's project model ⇄ the server's ("server space"). A project is a ServerDoc of entities — "project",
// "track:<type>:<index>", "clip:<id>", "scene:<id>" — each a flat map of fields: server columns under their server
// names, and every Studio-only field as "x.<key>" (these travel together in the row's extras_json). The codec is
// lossless:
//   - a Studio value a column can't hold exactly (null on a non-null column, out of range, too long, absent, an
//     effect stack the server would renumber) is still sent as the nearest legal value (or not sent) and kept exactly
//     in "x.$x.<column>" ("x.$u.<column>" when the Studio field is absent); on read the exact value wins while the
//     column still holds what Studio sent;
//   - fields the server shows but never writes (scene status, transition, shots) are kept in extras only when
//     Studio's value differs from the server's;
//   - list order (clips and scenes) is kept in "x.$pos".
// Local media URLs (opennan-local://media/<id>) are mapped to their uploaded URL on the way out and cached files back
// on the way in (UrlMap); a local URL with no upload yet stays as it is in server space and holds its entity back.
import type { ClipEffect, LocalProjectState, ProjectMeta, SceneData, TimelineClip, TimelineTrack, UploadedMedia } from "@opennan/timeline-core";
import { canonical, clone, mapStrings, same, type Json } from "./json";

export type Fields = Record<string, Json>;

export interface ServerDoc {
    revision: number;
    entities: Record<string, Fields>;
    /** Clip and scene ids in the server's list order (entities without x.$pos sort by it). */
    order?: { clip: string[]; scene: string[] };
}

export type LocalDoc = Pick<LocalProjectState, "meta" | "tracks" | "clips" | "scenes" | "library">;

export const LOCAL_URL_PREFIX = "opennan-local://media/";
const LOCAL_URL_TOKEN = /opennan-local:\/\/media\/[A-Za-z0-9._-]+/g;
const HTTP_URL_TOKEN = /https?:\/\/[^\s"'<>\\)]+/g;

export interface UrlMap {
    /** On OpenNan's storage (an upload or a result), never a temporary upload. */
    isCloudUrl(url: string): boolean;
    /** A local media URL's uploaded URL, once uploaded. */
    toRemote(localUrl: string): string | undefined;
    /** A local URL for a cloud URL when this device has the file (it imported it, or cached it). */
    toLocal(remoteUrl: string): string | undefined;
    /** A storyboard file the decoder left out because it is not on OpenNan's storage (9c.1): a quiet log line. */
    ignored?(url: string): void;
}

export const IDENTITY_URLS: UrlMap = { isCloudUrl: () => false, toRemote: () => undefined, toLocal: () => undefined };

export function isLocalUrl(url: unknown): url is string {
    return typeof url === "string" && url.startsWith(LOCAL_URL_PREFIX);
}

/** Every local media URL inside a value (any depth, JSON strings included). */
export function localUrlsIn(value: unknown, into: Set<string> = new Set()): Set<string> {
    if (typeof value === "string") {
        for (const match of value.matchAll(LOCAL_URL_TOKEN)) into.add(match[0]);
    } else if (Array.isArray(value)) {
        for (const item of value) localUrlsIn(item, into);
    } else if (value !== null && typeof value === "object") {
        for (const item of Object.values(value)) localUrlsIn(item, into);
    }
    return into;
}

function toServerUrls<T>(value: T, urls: UrlMap): T {
    return mapStrings(value, (text) => (text.includes(LOCAL_URL_PREFIX) ? text.replace(LOCAL_URL_TOKEN, (url) => urls.toRemote(url) ?? url) : text));
}

function toLocalUrls<T>(value: T, urls: UrlMap): T {
    return mapStrings(value, (text) => (text.includes("://") ? text.replace(HTTP_URL_TOKEN, (url) => urls.toLocal(url) ?? url) : text));
}

// ── columns ──────────────────────────────────────────────

type Kind = "number" | "int" | "string" | "bool" | "url" | "object" | "enum" | "effects";

export interface Column {
    col: string;
    key: string;
    kind: Kind;
    nullable: boolean;
    min?: number;
    max?: number;
    /** min is exclusive (gt). */
    gt?: boolean;
    maxLength?: number;
    pattern?: RegExp;
    values?: readonly string[];
    maxBytes?: number;
    /**
     * What the server stores for a sent value (its own rules: an ai_video scene's length rounded to 5, 10 or 15 s,
     * transition lengths capped at half the item). Studio keeps its exact value whenever the two differ.
     */
    normalize?(value: Json, fields: Fields): Json;
}

function num(value: Json | undefined, fallback: number): number {
    return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** The server's scene rule: a patched ai_video scene without shots is 5, 10 or 15 seconds long. */
function sceneDurationRule(value: Json, fields: Fields): Json {
    if (typeof value !== "number") return value;
    const card = typeof fields.card_type === "string" ? fields.card_type : "ai_video";
    const shots = Array.isArray(fields.shots) ? fields.shots.length : 0;
    if (card !== "ai_video" || shots > 0 || [5, 10, 15].includes(value)) return value;
    return [5, 10, 15].reduce((best, v) => (Math.abs(v - value) < Math.abs(best - value) ? v : best), 5);
}

/** The server's clip transition rule: no transition is 0 long; a transition is at most half the clip. */
function clipTransitionRule(value: Json, fields: Fields): Json {
    if (typeof value !== "number") return value;
    if ((typeof fields.transition_type === "string" ? fields.transition_type : "none") === "none") return 0;
    const half = Math.max(0, (num(fields.end_time, 0) - num(fields.start_time, 0)) / 2);
    return Math.max(0, Math.min(half, value));
}

/** The server's scene transition rule: no transition is 0 long; a transition is at most half the scene. */
function sceneTransitionRule(value: Json, fields: Fields): Json {
    if (typeof value !== "number") return value;
    const name = typeof fields.visual_transition === "string" ? fields.visual_transition.trim().toLowerCase() || "none" : "none";
    if (name === "none") return 0;
    const duration = sceneDurationRule(num(fields.duration, 5), fields) as number;
    return Math.max(0, Math.min(duration / 2, value));
}

export const TRACK_TYPES = ["video", "audio", "text", "sticker", "effect", "remotion"] as const;
export const ASPECT_RATIOS = ["16:9", "9:16", "1:1", "4:3", "3:4", "4:5", "21:9", "9:21"] as const;
export const EFFECT_ID = /^[A-Za-z0-9_.:-]{1,64}$/;
export const MAX_EFFECTS = 50;
export const EXTRAS_MAX_BYTES = 64 * 1024;

const n = (col: string, key: string, min: number, max: number, extra: Partial<Column> = {}): Column => ({ col, key, kind: "number", nullable: false, min, max, ...extra });
const s = (col: string, key: string, maxLength: number, extra: Partial<Column> = {}): Column => ({ col, key, kind: "string", nullable: false, maxLength, ...extra });
const b = (col: string, key: string): Column => ({ col, key, kind: "bool", nullable: false });
const u = (col: string, key: string, nullable = true): Column => ({ col, key, kind: "url", nullable });

/** The clip fields of the public API (create, patch, and the fields a patch may clear). custom_graphic_id stays in extras (a Studio graphic is not an opennan.com library graphic). */
export const CLIP_COLUMNS: readonly Column[] = [
    { col: "track_type", key: "trackType", kind: "enum", nullable: false, values: TRACK_TYPES },
    { col: "track_index", key: "trackIndex", kind: "int", nullable: false, min: 1, max: 99 },
    n("start_time", "startTime", 0, 86_400),
    n("end_time", "endTime", 0, 86_400, { gt: true }),
    u("media_url", "mediaUrl"),
    s("media_type", "mediaType", 20, { pattern: /^[a-z_]{1,20}$/ }),
    { col: "scene_id", key: "sceneId", kind: "string", nullable: true, maxLength: 64, pattern: /^[A-Za-z0-9_-]{1,64}$/ },
    s("label", "label", 255, { nullable: true }),
    u("thumbnail_url", "thumbnailUrl"),
    b("locked", "locked"),
    n("volume", "volume", 0, 4),
    n("audio_pan", "audioPan", -1, 1),
    n("audio_pitch", "audioPitch", -24, 24),
    s("audio_eq", "audioEq", 20),
    b("audio_denoise", "audioDenoise"),
    b("audio_normalize", "audioNormalize"),
    n("playback_speed", "playbackSpeed", 0, 100, { gt: true }),
    s("speed_ramp", "speedRamp", 20),
    b("reverse_playback", "reversePlayback"),
    b("freeze_frame", "freezeFrame"),
    n("fade_in_duration", "fadeInDuration", 0, 3_600),
    n("fade_out_duration", "fadeOutDuration", 0, 3_600),
    s("transition_type", "transitionType", 20),
    n("transition_duration", "transitionDuration", 0, 60, { normalize: clipTransitionRule }),
    n("opacity", "opacity", 0, 1),
    n("scale", "scale", 0, 100, { gt: true }),
    n("position_x", "positionX", -10, 10),
    n("position_y", "positionY", -10, 10),
    b("horizontal_flip", "horizontalFlip"),
    b("vertical_flip", "verticalFlip"),
    n("crop_left", "cropLeft", 0, 1),
    n("crop_right", "cropRight", 0, 1),
    n("crop_top", "cropTop", 0, 1),
    n("crop_bottom", "cropBottom", 0, 1),
    n("brightness", "brightness", -1, 1),
    n("contrast", "contrast", 0, 4),
    n("saturation", "saturation", 0, 4),
    s("visual_filter", "visualFilter", 20),
    s("motion_preset", "motionPreset", 20),
    n("blur_strength", "blurStrength", 0, 100),
    b("chroma_key_enabled", "chromaKeyEnabled"),
    s("chroma_key_color", "chromaKeyColor", 16),
    n("chroma_key_similarity", "chromaKeySimilarity", 0, 1),
    n("chroma_key_blend", "chromaKeyBlend", 0, 1),
    s("blend_mode", "blendMode", 20),
    n("mosaic_strength", "mosaicStrength", 0, 100),
    n("rotation_degrees", "rotationDegrees", -3_600, 3_600),
    s("keyframes_json", "keyframesJson", 65_536, { nullable: true }),
    s("text_content", "textContent", 5_000, { nullable: true }),
    s("text_style", "textStyle", 8_192, { nullable: true }),
    n("trim_start", "trimStart", 0, Number.MAX_SAFE_INTEGER, { nullable: true }),
    n("trim_end", "trimEnd", 0, Number.MAX_SAFE_INTEGER, { nullable: true }),
    s("remotion_template_id", "remotionTemplateId", 64, { nullable: true }),
    s("remotion_props_json", "remotionPropsJson", 65_536, { nullable: true }),
    { col: "transition_params_json", key: "transitionParamsJson", kind: "object", nullable: true, maxBytes: 8_192 },
    { col: "effects", key: "effects", kind: "effects", nullable: true },
];

/** The scene fields of POST /v1/projects/{id}/changes (and those a patch may clear). Scene `order` is create-only on the server: Studio's is an extras field. */
export const SCENE_COLUMNS: readonly Column[] = [
    s("start_time", "startTime", 20, { nullable: true, pattern: /^[0-9:,.]{1,20}$/ }),
    s("end_time", "endTime", 20, { nullable: true, pattern: /^[0-9:,.]{1,20}$/ }),
    { col: "card_config", key: "cardConfig", kind: "object", nullable: true, maxBytes: 16_384 },
    { col: "fit_mode", key: "fitMode", kind: "enum", nullable: true, values: ["contain", "cover", "fill"] },
    n("transform_scale", "transformScale", 0, 100, { gt: true, nullable: true }),
    n("transform_offset_x", "transformOffsetX", -10, 10, { nullable: true }),
    n("transform_offset_y", "transformOffsetY", -10, 10, { nullable: true }),
    { col: "source_width", key: "sourceWidth", kind: "int", nullable: true, min: 1, max: 32_768 },
    { col: "source_height", key: "sourceHeight", kind: "int", nullable: true, min: 1, max: 32_768 },
    n("timeline_position_seconds", "timelinePositionSeconds", 0, 86_400),
    { col: "track_index", key: "trackIndex", kind: "int", nullable: false, min: 1, max: 99 },
    s("caption", "caption", 5_000),
    s("card_type", "cardType", 30, { pattern: /^[a-z_]{1,30}$/ }),
    n("duration", "duration", 0, 3_600, { gt: true, normalize: sceneDurationRule }),
    s("visual_transition", "visualTransition", 30),
    n("visual_transition_duration", "visualTransitionDuration", 0, 10, { normalize: sceneTransitionRule }),
    s("overlay_text", "overlayText", 2_000, { nullable: true }),
    s("audio_text", "audioText", 5_000, { nullable: true }),
    u("start_image_url", "startImageUrl"),
    u("end_image_url", "endImageUrl"),
    u("video_url", "videoUrl"),
    u("audio_url", "audioUrl"),
    u("source_video_url", "sourceVideoUrl"),
    { col: "effects", key: "effects", kind: "effects", nullable: true },
];

/** The project fields of POST /v1/projects/{id}/changes that Studio's ProjectMeta has. */
export const PROJECT_COLUMNS: readonly Column[] = [
    s("name", "name", 255, { min: 1 }),
    { col: "aspect_ratio", key: "aspectRatio", kind: "enum", nullable: false, values: ASPECT_RATIOS },
    u("music_url", "musicUrl"),
    n("music_volume", "musicVolume", 0, 2),
];

/** TrackBody. */
export const TRACK_COLUMNS: readonly Column[] = [
    s("label", "label", 40, { nullable: true }),
    b("muted", "muted"),
    b("locked", "locked"),
    b("visible", "visible"),
    n("volume", "volume", 0, 4),
];

const NO_VALUE = Symbol("no value");
type Encoded = Json | typeof NO_VALUE;

function isPlainObjectJson(text: string, maxBytes: number): boolean {
    if (new TextEncoder().encode(text).length > maxBytes) return false;
    try {
        const parsed = JSON.parse(text);
        return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed);
    } catch {
        return false;
    }
}

/** The server stack of a Studio effect stack: rows the server can hold, in order. */
function effectStack(rows: ClipEffect[]): Json[] {
    return rows
        .map((row, index) => ({ row, index }))
        .filter(({ row }) => typeof row?.effectId === "string" && EFFECT_ID.test(row.effectId))
        .sort((x, y) => (Number(x.row.order) || 0) - (Number(y.row.order) || 0) || x.index - y.index)
        .slice(0, MAX_EFFECTS)
        .map(({ row }, order) => ({
            effect_id: row.effectId, order, enabled: row.enabled !== false,
            params_json: typeof row.paramsJson === "string" && isPlainObjectJson(row.paramsJson, 8_192) ? row.paramsJson : null,
        }));
}

/** The value a column would hold for a Studio value, or NO_VALUE when it can't hold one. */
export function encodeValue(column: Column, value: unknown, urls: UrlMap): Encoded {
    if (value === undefined) return NO_VALUE;
    if (value === null) return column.nullable ? null : NO_VALUE;
    switch (column.kind) {
        case "number":
        case "int": {
            if (typeof value !== "number" || !Number.isFinite(value)) return NO_VALUE;
            if (column.kind === "int" && !Number.isInteger(value)) return NO_VALUE;
            const min = column.min ?? -Infinity;
            const max = column.max ?? Infinity;
            if (column.gt ? value <= min : value < min) return column.gt ? NO_VALUE : min;
            return value > max ? max : value;
        }
        case "string":
            if (typeof value !== "string") return NO_VALUE;
            if (column.maxLength !== undefined && value.length > column.maxLength) return NO_VALUE;
            if (column.min !== undefined && value.length < column.min) return NO_VALUE;
            if (column.pattern && !column.pattern.test(value)) return NO_VALUE;
            return value;
        case "enum":
            return typeof value === "string" && column.values!.includes(value) ? value : NO_VALUE;
        case "bool":
            return typeof value === "boolean" ? value : NO_VALUE;
        case "url": {
            if (typeof value !== "string" || value.length > 512) return NO_VALUE;
            if (urls.isCloudUrl(value) || isLocalUrl(value)) return value;
            return NO_VALUE;
        }
        case "object":
            return typeof value === "string" && isPlainObjectJson(value, column.maxBytes ?? 8_192) ? value : NO_VALUE;
        case "effects":
            return Array.isArray(value) ? effectStack(value as ClipEffect[]) : NO_VALUE;
    }
}

/** Effect rows rebuilt from a server stack: ids and owner scopes from Studio's x.$fx when they line up. */
function effectRows(stack: Json, owner: { clipId?: string; sceneId?: string }, meta: Json | undefined): ClipEffect[] {
    const rows = Array.isArray(stack) ? stack as Array<Record<string, Json>> : [];
    const info = Array.isArray(meta) && meta.length === rows.length ? meta as Array<Record<string, Json>> : null;
    const ownerId = owner.clipId ?? owner.sceneId ?? "";
    return rows.map((row, index) => ({
        id: typeof info?.[index]?.id === "string" ? info[index]!.id as string : `${ownerId}-fx-${index}`,
        clipId: owner.clipId ?? null,
        sceneId: owner.clipId ? null : owner.sceneId ?? null,
        effectId: String(row.effect_id ?? ""),
        order: typeof row.order === "number" ? row.order : index,
        paramsJson: typeof row.params_json === "string" ? row.params_json : null,
        enabled: row.enabled !== false,
        ownerScope: typeof info?.[index]?.ownerScope === "string" ? info[index]!.ownerScope as string : "project",
    }));
}

function effectMeta(rows: ClipEffect[]): Json {
    const ordered = rows
        .map((row, index) => ({ row, index }))
        .filter(({ row }) => typeof row?.effectId === "string" && EFFECT_ID.test(row.effectId))
        .sort((x, y) => (Number(x.row.order) || 0) - (Number(y.row.order) || 0) || x.index - y.index)
        .slice(0, MAX_EFFECTS);
    return ordered.map(({ row }) => ({ id: row.id, ownerScope: row.ownerScope }));
}

// ── entities ─────────────────────────────────────────────

interface Derived {
    key: string;
    /** The Studio value the server's own columns give (when Studio keeps no value of its own). */
    from(fields: Fields, urls: UrlMap): unknown;
}

/**
 * A storyboard file Studio shows (9c.1): a sheet, a panel, a shot's keyframe or video. Only OpenNan's storage (the
 * cloud media allowlist, so the guarded downloader caches it) or this device; anything else is left out and reported.
 */
function storyboardMedia(value: Json | undefined, urls: UrlMap): string | null {
    if (typeof value !== "string" || value === "") return null;
    if (value.length <= 2048 && (isLocalUrl(value) || urls.isCloudUrl(value)) && !/[\s"'<>]/.test(value)) return value;
    urls.ignored?.(value);
    return null;
}

function shotsBreakdown(fields: Fields, urls: UrlMap): string {
    const shots = Array.isArray(fields.shots) ? fields.shots as Array<Record<string, Json>> : [];
    return JSON.stringify(shots.map((shot) => {
        const keyframe = storyboardMedia(shot.image_url, urls);
        const endKeyframe = storyboardMedia(shot.end_image_url, urls);
        const video = storyboardMedia(shot.video_url, urls);
        return {
            duration: typeof shot.duration === "number" ? shot.duration : 0,
            prompt: typeof shot.description === "string" ? shot.description : "",
            ...(keyframe ? { keyframe_url: keyframe } : {}),
            ...(endKeyframe ? { end_keyframe_url: endKeyframe } : {}),
            ...(video ? { video_url: video } : {}),
            ...(typeof shot.dialogue === "string" ? { dialogue: shot.dialogue } : {}),
            readOnly: true,
        };
    }));
}

/** A scene's storyboard_sheets (phase 9c) as Studio's StoryboardSheet list; undefined when none is drawn. */
function storyboardSheets(fields: Fields, urls: UrlMap): unknown {
    const raw = Array.isArray(fields.storyboard_sheets) ? fields.storyboard_sheets as Json[] : [];
    const sheets = raw.filter((sheet): sheet is Record<string, Json> => sheet !== null && typeof sheet === "object" && !Array.isArray(sheet)).map((sheet) => ({
        imageUrl: storyboardMedia(sheet.image_url, urls),
        panels: (Array.isArray(sheet.panels) ? sheet.panels : [])
            .filter((panel): panel is Record<string, Json> => panel !== null && typeof panel === "object" && !Array.isArray(panel))
            .map((panel, i) => ({ panel, i, imageUrl: storyboardMedia(panel.image_url, urls) }))
            .filter((p): p is { panel: Record<string, Json>; i: number; imageUrl: string } => p.imageUrl !== null)
            .map(({ panel, i, imageUrl }) => ({
                index: typeof panel.index === "number" && Number.isInteger(panel.index) ? panel.index : i,
                shotIndex: typeof panel.shot_index === "number" && Number.isInteger(panel.shot_index) ? panel.shot_index : i,
                imageUrl,
            })),
    }));
    return sheets.length > 0 ? sheets : undefined;
}

/** Scene fields only the server draws: never kept in Studio's extras (a working copy can't pin them). */
const SERVER_DRAWN = new Set(["storyboardSheets"]);

/** The scene has shots OpenNan wrote (a plan, a storyboard): they win over a breakdown Studio keeps in extras. */
function hasServerShots(fields: Fields | undefined): boolean {
    return Boolean(fields) && Array.isArray(fields!.shots) && fields!.shots.length > 0;
}

function serverDrawn(key: string, fields: Fields | undefined): boolean {
    return SERVER_DRAWN.has(key) || (key === "shotBreakdown" && hasServerShots(fields));
}

/** The same URL rules without reporting again (a second read of the same fields). */
const QUIET = (urls: UrlMap): UrlMap => (urls.ignored ? { isCloudUrl: (u) => urls.isCloudUrl(u), toRemote: (u) => urls.toRemote(u), toLocal: (u) => urls.toLocal(u) } : urls);

/** Scene fields the server shows but Studio never writes to a column. */
const SCENE_DERIVED: readonly Derived[] = [
    { key: "status", from: (f) => (typeof f.status === "string" ? f.status : "pending") },
    { key: "transition", from: (f) => (typeof f.transition === "string" ? f.transition : "cut") },
    { key: "shotBreakdown", from: shotsBreakdown },
    { key: "frameConsistencyScore", from: () => null },
    { key: "order", from: (f) => (typeof f.order === "number" ? f.order : 0) },
    { key: "storyboardSheets", from: storyboardSheets },
];

const CLIP_STRUCTURAL = new Set(["id", "projectId"]);
const SCENE_STRUCTURAL = new Set(["id"]);
const EXACT = "x.$x.";
const ABSENT = "x.$u.";
export const POSITION = "x.$pos";
const EFFECT_META = "x.$fx";

function encodeColumns(local: Record<string, unknown>, columns: readonly Column[], urls: UrlMap, out: Fields): void {
    const encodedValues = new Map<Column, Encoded>();
    for (const column of columns) {
        const encoded = encodeValue(column, local[column.key], urls);
        encodedValues.set(column, encoded);
        if (encoded !== NO_VALUE) out[column.col] = encoded;
    }
    for (const column of columns) {
        const value = local[column.key];
        const encoded = encodedValues.get(column)!;
        let exact: boolean;
        if (column.kind === "effects") {
            if (encoded === NO_VALUE) exact = true;
            else if (encoded === null) exact = value !== null;
            else {
                const owner = local.trackType !== undefined ? { clipId: String(local.id) } : { sceneId: String(local.id) };
                const meta = effectMeta(value as ClipEffect[]);
                // Ids and scopes the decoder would make up anyway (rows made on opennan.com) are not stored.
                const derivable = (meta as Array<Record<string, Json>>).every((row, i) => row.id === `${String(local.id)}-fx-${i}` && row.ownerScope === "project");
                if (!derivable) out[EFFECT_META] = meta;
                exact = !same(effectRows(encoded, owner, derivable ? undefined : meta), value);
            }
        } else {
            exact = encoded === NO_VALUE || !same(encoded, value) || (column.normalize !== undefined && !same(column.normalize(encoded, out), value));
        }
        if (!exact) continue;
        if (value === undefined) out[`${ABSENT}${column.col}`] = true;
        else out[`${EXACT}${column.col}`] = clone(value) as Json;
    }
}

function encodeExtras(local: Record<string, unknown>, columns: readonly Column[], structural: Set<string>, out: Fields, skip: Set<string> = new Set()): void {
    const mapped = new Set(columns.map((c) => c.key));
    for (const [key, value] of Object.entries(local)) {
        if (value === undefined || structural.has(key) || mapped.has(key) || skip.has(key)) continue;
        out[`x.${key}`] = clone(value) as Json;
    }
}

function decodeColumns(fields: Fields, columns: readonly Column[], urls: UrlMap, out: Record<string, unknown>, owner: { clipId?: string; sceneId?: string }): void {
    for (const column of columns) {
        const absent = fields[`${ABSENT}${column.col}`] === true;
        const exactKey = `${EXACT}${column.col}`;
        const hasExact = exactKey in fields;
        const present = column.col in fields;
        const server = fields[column.col];
        if (absent || hasExact) {
            const exact = absent ? undefined : fields[exactKey];
            const wouldSend = encodeValue(column, exact, urls);
            if (wouldSend === NO_VALUE || !present || same(wouldSend, server) || (column.normalize !== undefined && same(column.normalize(wouldSend, fields), server))) {
                if (!absent) out[column.key] = clone(exact);
                continue;
            }
        }
        if (!present) continue;
        out[column.key] = column.kind === "effects" ? effectRows(server ?? [], owner, fields[EFFECT_META]) : clone(server);
    }
}

function decodeExtras(fields: Fields, out: Record<string, unknown>): void {
    for (const [name, value] of Object.entries(fields)) {
        if (!name.startsWith("x.") || name.startsWith("x.$")) continue;
        out[name.slice(2)] = clone(value);
    }
}

export function encodeClip(clip: TimelineClip, urls: UrlMap): Fields {
    const local = toServerUrls(clip as unknown as Record<string, unknown>, urls);
    const out: Fields = {};
    encodeColumns(local, CLIP_COLUMNS, urls, out);
    encodeExtras(local, CLIP_COLUMNS, CLIP_STRUCTURAL, out);
    return out;
}

export function decodeClip(id: string, fields: Fields, projectId: string, urls: UrlMap): TimelineClip {
    const out: Record<string, unknown> = { id, projectId };
    decodeColumns(fields, CLIP_COLUMNS, urls, out, { clipId: id });
    decodeExtras(fields, out);
    if (out.customGraphicId === undefined && typeof fields.custom_graphic_id === "string") out.customGraphicId = fields.custom_graphic_id;
    return toLocalUrls(out, urls) as unknown as TimelineClip;
}

/** `confirmed`: the scene as the server holds it, so fields Studio left as the server shows them stay out of extras. */
export function encodeScene(scene: SceneData, urls: UrlMap, confirmed?: Fields): Fields {
    const local = toServerUrls(scene as unknown as Record<string, unknown>, urls);
    const out: Fields = {};
    encodeColumns(local, SCENE_COLUMNS, urls, out);
    const skip = new Set<string>();
    for (const derived of SCENE_DERIVED) {
        const value = local[derived.key];
        if (value === undefined || serverDrawn(derived.key, confirmed)) {
            skip.add(derived.key);
            continue;
        }
        if (confirmed && !(`x.${derived.key}` in confirmed) && same(derived.from(confirmed, QUIET(urls)), value)) skip.add(derived.key);
    }
    encodeExtras(local, SCENE_COLUMNS, SCENE_STRUCTURAL, out, skip);
    return out;
}

export function decodeScene(id: string, fields: Fields, urls: UrlMap): SceneData {
    const out: Record<string, unknown> = { id };
    decodeColumns(fields, SCENE_COLUMNS, urls, out, { sceneId: id });
    for (const derived of SCENE_DERIVED) {
        if (`x.${derived.key}` in fields && !serverDrawn(derived.key, fields)) continue;
        const value = derived.from(fields, urls);
        if (value !== undefined) out[derived.key] = value;
    }
    for (const key of ["startImageUrl", "endImageUrl", "videoUrl", "audioUrl", "audioText", "cardConfig"] as const) if (out[key] === undefined && fields[`${ABSENT}${SCENE_COLUMNS.find((c) => c.key === key)!.col}`] !== true) out[key] = null;
    if (out.caption === undefined && fields["x.$u.caption"] !== true) out.caption = "";
    if (out.startTime === undefined && fields["x.$u.start_time"] !== true) out.startTime = "00:00:00.000";
    if (out.endTime === undefined && fields["x.$u.end_time"] !== true) out.endTime = "00:00:00.000";
    decodeExtras(fields, out);
    // What only OpenNan draws wins over anything Studio kept in extras.
    for (const derived of SCENE_DERIVED) {
        if (!serverDrawn(derived.key, fields)) continue;
        const value = derived.from(fields, QUIET(urls));
        if (value === undefined) delete out[derived.key];
        else out[derived.key] = value;
    }
    return toLocalUrls(out, urls) as unknown as SceneData;
}

/** `confirmed`: the server's document, so a project made on opennan.com that Studio left as it is gets no extras. */
export function encodeProject(meta: ProjectMeta, tracks: TimelineTrack[], library: UploadedMedia[] | undefined, urls: UrlMap, confirmed?: ServerDoc): Fields {
    const local = toServerUrls({ ...meta, tracks, library: library ?? [] } as unknown as Record<string, unknown>, urls);
    const out: Fields = {};
    encodeColumns(local, PROJECT_COLUMNS, urls, out);
    const skip = new Set<string>();
    const project = confirmed?.entities.project;
    if (project && !("x.tracks" in project) && same(decodeTracks(confirmed!.entities, undefined, urls), tracks)) skip.add("tracks");
    if (project && !("x.library" in project) && (library ?? []).length === 0) skip.add("library");
    encodeExtras(local, PROJECT_COLUMNS, new Set(["id"]), out, skip);
    return out;
}

export function decodeProject(fields: Fields, projectId: string, urls: UrlMap): { meta: ProjectMeta; tracks?: TimelineTrack[]; library: UploadedMedia[] } {
    const out: Record<string, unknown> = { id: projectId };
    decodeColumns(fields, PROJECT_COLUMNS, urls, out, {});
    decodeExtras(fields, out);
    const { tracks, library, ...meta } = toLocalUrls(out, urls) as Record<string, unknown>;
    return {
        meta: { name: "Untitled", musicUrl: null, musicVolume: 1, aspectRatio: "16:9", ...meta, id: projectId } as ProjectMeta,
        ...(Array.isArray(tracks) ? { tracks: tracks as TimelineTrack[] } : {}),
        library: Array.isArray(library) ? library as UploadedMedia[] : [],
    };
}

export function trackKey(type: string, index: number): string {
    return `track:${type}:${index}`;
}

export function encodeTrack(track: TimelineTrack, urls: UrlMap): Fields {
    const out: Fields = {};
    for (const column of TRACK_COLUMNS) {
        const encoded = encodeValue(column, (track as unknown as Record<string, unknown>)[column.key], urls);
        if (encoded !== NO_VALUE) out[column.col] = encoded;
    }
    return out;
}

/** Studio's exact tracks (project x.tracks) when the server's still match them, else the server's in Studio's order. */
function decodeTracks(entities: Record<string, Fields>, exact: TimelineTrack[] | undefined, urls: UrlMap): TimelineTrack[] {
    const server: TimelineTrack[] = [];
    for (const [key, fields] of Object.entries(entities)) {
        if (!key.startsWith("track:")) continue;
        const [, type, index] = key.split(":");
        server.push({
            type: type as TimelineTrack["type"], index: Number(index),
            label: typeof fields.label === "string" ? fields.label : `${type!.charAt(0).toUpperCase()}${index}`,
            muted: fields.muted === true, locked: fields.locked === true, visible: fields.visible !== false,
            volume: typeof fields.volume === "number" ? fields.volume : 1,
        });
    }
    if (exact) {
        const encodedExact = new Map(exact.map((t) => [trackKey(t.type, t.index), encodeTrack(t, urls)]));
        const serverKeys = new Set(server.map((t) => trackKey(t.type, t.index)));
        // A field Studio could not send (a label over 40 characters) is not compared: the server shows its own. A track
        // only the server has is one Studio dropped without removing it (its clips stayed): Studio's list wins.
        const matches = [...encodedExact].every(([key, fields]) => serverKeys.has(key) && Object.entries(fields).every(([col, value]) => same(value, entities[key]![col])));
        if (matches) return clone(exact);
        const rank = new Map(exact.map((t, i) => [trackKey(t.type, t.index), i]));
        return server.sort((x, y) => (rank.get(trackKey(x.type, x.index)) ?? 1e9) - (rank.get(trackKey(y.type, y.index)) ?? 1e9) || x.type.localeCompare(y.type) || x.index - y.index);
    }
    return server.sort((x, y) => x.type.localeCompare(y.type) || x.index - y.index);
}

// ── list order ───────────────────────────────────────────

/** Positions far above any Studio position: where entities with none (made on opennan.com) sort, in server order. */
export const IMPLICIT_BASE = 1e12;

function positionOf(fields: Fields | undefined, serverIndex: number): number | undefined {
    if (fields && typeof fields[POSITION] === "number") return fields[POSITION] as number;
    return serverIndex >= 0 ? IMPLICIT_BASE + serverIndex : undefined;
}

/** Indexes of a longest strictly increasing subsequence of the defined keys. */
function longestIncreasing(keys: Array<number | undefined>): Set<number> {
    const tails: number[] = [];
    const tailIndex: number[] = [];
    const parent = new Array<number>(keys.length).fill(-1);
    keys.forEach((key, i) => {
        if (key === undefined) return;
        let lo = 0;
        let hi = tails.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (tails[mid]! < key) lo = mid + 1;
            else hi = mid;
        }
        tails[lo] = key;
        tailIndex[lo] = i;
        parent[i] = lo > 0 ? tailIndex[lo - 1]! : -1;
    });
    const kept = new Set<number>();
    let i = tailIndex[tails.length - 1] ?? -1;
    while (i >= 0) {
        kept.add(i);
        i = parent[i]!;
    }
    return kept;
}

/**
 * x.$pos for each id in its new list order: ids whose previous position still fits keep it (written only when
 * it was explicit), the others get a position between their neighbours. Implicit positions (≥ IMPLICIT_BASE) can't
 * be written; when a new position would have to be one, every id is renumbered explicitly.
 */
export function assignPositions(ids: string[], previous: (id: string) => number | undefined): Map<string, number | null> {
    const keys = ids.map((id) => previous(id));
    const kept = longestIncreasing(keys);
    const out = new Map<string, number | null>();
    let left: number | undefined;
    let renumber = false;
    for (let i = 0; i < ids.length; i++) {
        if (kept.has(i)) {
            left = keys[i];
            out.set(ids[i]!, keys[i]! >= IMPLICIT_BASE ? null : keys[i]!);
            continue;
        }
        let right: number | undefined;
        for (let j = i + 1; j < ids.length; j++) {
            if (kept.has(j)) {
                right = keys[j];
                break;
            }
        }
        const position = left === undefined ? (right === undefined ? i : right - 1) : right === undefined ? left + 1 : (left + right) / 2;
        if (position >= IMPLICIT_BASE || (left !== undefined && right !== undefined && !(position > left && position < right))) {
            renumber = true;
            break;
        }
        out.set(ids[i]!, position);
        left = position;
    }
    if (renumber) {
        out.clear();
        ids.forEach((id, i) => out.set(id, i));
    }
    return out;
}

// ── whole documents ──────────────────────────────────────

export interface EncodeContext {
    urls: UrlMap;
    /** The server's document (for list order and fields Studio leaves as the server shows them). */
    confirmed?: ServerDoc;
    /** The previous encoding of this working copy (its positions are kept where they still fit). */
    previous?: ServerDoc;
}

function previousPosition(kind: "clip" | "scene", ctx: EncodeContext): (id: string) => number | undefined {
    const order = ctx.confirmed?.order?.[kind] ?? [];
    const index = new Map(order.map((id, i) => [id, i]));
    return (id) => {
        const key = `${kind}:${id}`;
        const fromPrevious = ctx.previous?.entities[key];
        if (fromPrevious) return positionOf(fromPrevious, ctx.previous?.order?.[kind]?.indexOf(id) ?? index.get(id) ?? -1);
        const fromConfirmed = ctx.confirmed?.entities[key];
        return fromConfirmed ? positionOf(fromConfirmed, index.get(id) ?? -1) : undefined;
    };
}

export function encodeDoc(local: LocalDoc, ctx: EncodeContext): ServerDoc {
    const entities: Record<string, Fields> = {};
    entities.project = encodeProject(local.meta, local.tracks, local.library, ctx.urls, ctx.confirmed);
    for (const track of local.tracks) entities[trackKey(track.type, track.index)] = encodeTrack(track, ctx.urls);
    const clipPositions = assignPositions(local.clips.map((c) => c.id), previousPosition("clip", ctx));
    for (const clip of local.clips) {
        const fields = encodeClip(clip, ctx.urls);
        const position = clipPositions.get(clip.id);
        if (typeof position === "number") fields[POSITION] = position;
        entities[`clip:${clip.id}`] = fields;
    }
    const scenePositions = assignPositions(local.scenes.map((s) => s.id), previousPosition("scene", ctx));
    for (const scene of local.scenes) {
        const fields = encodeScene(scene, ctx.urls, ctx.confirmed?.entities[`scene:${scene.id}`]);
        const position = scenePositions.get(scene.id);
        if (typeof position === "number") fields[POSITION] = position;
        entities[`scene:${scene.id}`] = fields;
    }
    return { revision: ctx.confirmed?.revision ?? 0, entities, ...(ctx.confirmed?.order ? { order: clone(ctx.confirmed.order) } : {}) };
}

function sortedIds(doc: ServerDoc, kind: "clip" | "scene"): string[] {
    const prefix = `${kind}:`;
    const order = doc.order?.[kind] ?? [];
    const index = new Map(order.map((id, i) => [id, i]));
    return Object.keys(doc.entities)
        .filter((key) => key.startsWith(prefix))
        .map((key) => key.slice(prefix.length))
        .map((id) => ({ id, position: positionOf(doc.entities[`${prefix}${id}`], index.get(id) ?? -1) ?? Infinity, serverIndex: index.get(id) ?? Infinity }))
        .sort((x, y) => x.position - y.position || x.serverIndex - y.serverIndex || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0))
        .map((entry) => entry.id);
}

export function decodeDoc(doc: ServerDoc, projectId: string, urls: UrlMap): LocalDoc {
    const project = decodeProject(doc.entities.project ?? {}, projectId, urls);
    const exactTracks = Array.isArray(doc.entities.project?.["x.tracks"]) ? doc.entities.project!["x.tracks"] as unknown as TimelineTrack[] : undefined;
    const tracks = decodeTracks(doc.entities, exactTracks ? toLocalUrls(exactTracks, urls) : undefined, urls);
    const clips = sortedIds(doc, "clip").map((id) => decodeClip(id, doc.entities[`clip:${id}`]!, projectId, urls));
    const scenes = sortedIds(doc, "scene").map((id) => decodeScene(id, doc.entities[`scene:${id}`]!, urls));
    return { meta: project.meta, tracks, clips, scenes, library: project.library };
}

/** Canonical JSON of a project for "is it the same project": ids, values and list order; not timestamps or the local project id. */
export function normalizedProject(doc: LocalDoc): string {
    return canonical({
        meta: { ...doc.meta, id: undefined },
        tracks: doc.tracks,
        clips: doc.clips.map((clip) => ({ ...clip, projectId: undefined })),
        scenes: doc.scenes,
        library: doc.library ?? [],
    });
}

// ── rows (what a request carries, what the server answers) ──

export type EntityKind = "project" | "track" | "clip" | "scene";

export function entityKind(key: string): EntityKind {
    return key === "project" ? "project" : (key.slice(0, key.indexOf(":")) as EntityKind);
}

export function entityId(key: string): string {
    return key.slice(key.indexOf(":") + 1);
}

/** The extras object of an entity's fields (Studio-only fields, exact values, absent markers, positions). */
export function extrasOf(fields: Fields): Record<string, Json> | null {
    const out: Record<string, Json> = {};
    const exact: Record<string, Json> = {};
    const absent: string[] = [];
    for (const [name, value] of Object.entries(fields)) {
        if (!name.startsWith("x.")) continue;
        if (name.startsWith(EXACT)) exact[name.slice(EXACT.length)] = value;
        else if (name.startsWith(ABSENT)) absent.push(name.slice(ABSENT.length));
        else out[name.slice(2)] = value;
    }
    if (Object.keys(exact).length > 0) out.$x = exact;
    if (absent.length > 0) out.$u = absent.sort();
    return Object.keys(out).length > 0 ? out : null;
}

/** Fields of an extras object (the inverse of extrasOf). */
export function fieldsOfExtras(extras: Record<string, Json> | null | undefined): Fields {
    const out: Fields = {};
    if (!extras) return out;
    for (const [key, value] of Object.entries(extras)) {
        if (key === "$x" && value && typeof value === "object" && !Array.isArray(value)) {
            for (const [col, exact] of Object.entries(value)) out[`${EXACT}${col}`] = exact;
        } else if (key === "$u" && Array.isArray(value)) {
            for (const col of value) if (typeof col === "string") out[`${ABSENT}${col}`] = true;
        } else {
            out[`x.${key}`] = value;
        }
    }
    return out;
}

/** Server columns of an entity's fields. */
export function columnsOf(fields: Fields): Fields {
    const out: Fields = {};
    for (const [name, value] of Object.entries(fields)) if (!name.startsWith("x.")) out[name] = value;
    return out;
}

/** True for a field that travels inside extras_json. */
export function isExtrasField(name: string): boolean {
    return name.startsWith("x.");
}

const ZIP_THRESHOLD = 60 * 1024;

function base64(bytes: Uint8Array): string {
    let text = "";
    for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(text);
}

function unbase64(text: string): Uint8Array {
    const raw = atob(text);
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
}

async function transform(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
    const output = new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(stream);
    return new Uint8Array(await new Response(output).arrayBuffer());
}

/** extras_json for a request: canonical JSON, deflated past 60 KB; null when there is nothing to keep. */
export async function extrasJson(fields: Fields): Promise<string | null> {
    const extras = extrasOf(fields);
    if (!extras) return null;
    const text = canonical(extras);
    if (new TextEncoder().encode(text).length <= ZIP_THRESHOLD) return text;
    const zipped = await transform(new TextEncoder().encode(text), new CompressionStream("deflate-raw"));
    return JSON.stringify({ $z: base64(zipped) });
}

export async function parseExtrasJson(text: unknown): Promise<Record<string, Json> | null> {
    if (typeof text !== "string" || !text) return null;
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        return null;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const zipped = (parsed as Record<string, unknown>).$z;
    if (typeof zipped === "string") {
        try {
            const inflated = await transform(unbase64(zipped), new DecompressionStream("deflate-raw"));
            const value = JSON.parse(new TextDecoder().decode(inflated));
            return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, Json> : null;
        } catch {
            return null;
        }
    }
    return parsed as Record<string, Json>;
}

export function extrasBytes(text: string | null): number {
    return text === null ? 0 : new TextEncoder().encode(text).length;
}

/** Server fields of a project document's rows, as ServerDoc entities (extras parsed). */
const VIEW_ONLY = new Set(["object", "id", "extras_json"]);
const PROJECT_KEPT = ["name", "description", "aspect_ratio", "music_url", "music_filename", "music_volume", "default_audio_on"];

async function rowFields(row: Record<string, unknown>, keep?: readonly string[]): Promise<Fields> {
    const out: Fields = {};
    for (const [name, value] of Object.entries(row)) {
        if (VIEW_ONLY.has(name)) continue;
        if (keep && !keep.includes(name)) continue;
        out[name] = clone(value) as Json;
    }
    Object.assign(out, fieldsOfExtras(await parseExtrasJson(row.extras_json)));
    return out;
}

export interface DocumentJson {
    revision: number;
    project: Record<string, unknown>;
    tracks: Array<Record<string, unknown>>;
    clips: Array<Record<string, unknown>>;
    scenes: Array<Record<string, unknown>>;
    media?: Array<Record<string, unknown>>;
}

export async function ingestProject(row: Record<string, unknown>): Promise<Fields> {
    return rowFields(row, PROJECT_KEPT);
}

export async function ingestClip(row: Record<string, unknown>): Promise<Fields> {
    return rowFields(row);
}

export async function ingestScene(row: Record<string, unknown>): Promise<Fields> {
    return rowFields(row);
}

export function ingestTrack(row: Record<string, unknown>): Fields {
    const out: Fields = {};
    for (const column of TRACK_COLUMNS) if (column.col in row) out[column.col] = clone(row[column.col]) as Json;
    return out;
}

export async function ingestDocument(document: DocumentJson): Promise<ServerDoc> {
    const entities: Record<string, Fields> = {};
    entities.project = await ingestProject(document.project);
    for (const track of document.tracks ?? []) entities[trackKey(String(track.type), Number(track.index))] = ingestTrack(track);
    const clipOrder: string[] = [];
    for (const clip of document.clips ?? []) {
        const id = String(clip.id);
        clipOrder.push(id);
        entities[`clip:${id}`] = await ingestClip(clip);
    }
    const sceneOrder: string[] = [];
    for (const scene of document.scenes ?? []) {
        const id = String(scene.id);
        sceneOrder.push(id);
        entities[`scene:${id}`] = await ingestScene(scene);
    }
    return { revision: Number(document.revision) || 0, entities, order: { clip: clipOrder, scene: sceneOrder } };
}
