// A delta as POST /v1/projects/{id}/changes bodies: creates carry every column Studio
// can send plus extras_json and the effect stack; patches carry only the changed columns (an explicit null clears a
// nullable one) and the whole extras_json / effect stack when any part of it changed; deletes carry ids. Entities
// that name media not uploaded yet are held back; entities the server would refuse for sure are refused here, with
// a reason. Bodies hold at most 500 items per list and stay under 1.9 MB, ordered so a scene is created before the
// clips that name it.
import { CLIP_COLUMNS, PROJECT_COLUMNS, SCENE_COLUMNS, TRACK_COLUMNS, entityId, entityKind, extrasBytes, extrasJson, isExtrasField, localUrlsIn, EXTRAS_MAX_BYTES, type Column, type Fields, type ServerDoc } from "./codec";
import type { Delta } from "./delta";
import type { Json } from "./json";

export const MAX_ITEMS = 500;
export const MAX_BODY_BYTES = 1_900_000;
export const MAX_PROJECT_CLIPS = 5_000;
export const MAX_PROJECT_SCENES = 1_000;

export interface ChangesetBody {
    label: string;
    device?: string;
    project?: Record<string, Json>;
    tracks?: { put: Array<Record<string, Json>>; removed: Array<{ type: string; index: number }> };
    scenes: { create: Array<Record<string, Json>>; patch: Array<Record<string, Json>>; delete: string[] };
    clips: { create: Array<Record<string, Json>>; patch: Array<Record<string, Json>>; delete: string[] };
    media: { add: string[]; remove: string[] };
}

export interface RefusedEntity {
    key: string;
    message: string;
}

export interface BuiltChangesets {
    bodies: ChangesetBody[];
    /** Entity keys each body carries. */
    keys: string[][];
    /** Entities waiting for a media upload (they stay queued). */
    held: string[];
    /** Entities the server would refuse (dropped, shown as conflicts). */
    refused: RefusedEntity[];
}

export function emptyBody(label: string, device?: string): ChangesetBody {
    return { label: label.slice(0, 200), ...(device ? { device: device.slice(0, 80) } : {}), scenes: { create: [], patch: [], delete: [] }, clips: { create: [], patch: [], delete: [] }, media: { add: [], remove: [] } };
}

const utf8 = new TextEncoder();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function columnValues(fields: Fields, columns: readonly Column[], only?: Set<string>): Record<string, Json> {
    const out: Record<string, Json> = {};
    for (const column of columns) {
        if (column.col === "effects") continue;
        if (only && !only.has(column.col)) continue;
        if (column.col in fields) out[column.col] = fields[column.col]!;
    }
    return out;
}

function effectsOf(fields: Fields): Json {
    return Array.isArray(fields.effects) ? fields.effects : [];
}

interface Item {
    list: "project" | "tracks.put" | "scenes.create" | "scenes.patch" | "clips.create" | "clips.patch" | "clips.delete" | "scenes.delete" | "tracks.removed" | "media.add";
    key: string;
    value: Json;
}

const ORDER: Item["list"][] = ["project", "tracks.put", "scenes.create", "scenes.patch", "clips.create", "clips.patch", "clips.delete", "scenes.delete", "tracks.removed", "media.add"];

async function extrasFor(fields: Fields, key: string, refused: RefusedEntity[]): Promise<string | null | false> {
    const text = await extrasJson(fields);
    if (extrasBytes(text) > EXTRAS_MAX_BYTES) {
        refused.push({ key, message: "Too much Studio data on one item for a cloud project (more than 64 KB after compression)." });
        return false;
    }
    return text;
}

export interface BuildOptions {
    label: string;
    device?: string;
    /** Asset ids to link into the project's media bin. */
    mediaAdd?: string[];
    /** UTF-8 bytes a body may take (default MAX_BODY_BYTES). */
    maxBytes?: number;
}

export async function buildChangesets(delta: Delta, target: ServerDoc, options: BuildOptions): Promise<BuiltChangesets> {
    const items: Item[] = [];
    const held: string[] = [];
    const refused: RefusedEntity[] = [];
    const clipsAfter = Object.keys(target.entities).filter((k) => k.startsWith("clip:")).length;
    const scenesAfter = Object.keys(target.entities).filter((k) => k.startsWith("scene:")).length;

    for (const [key, change] of Object.entries(delta.entities)) {
        const kind = entityKind(key);
        const fields = target.entities[key];
        if (change.op !== "delete" && fields && localUrlsIn(fields).size > 0) {
            held.push(key);
            continue;
        }
        const changed = new Set(Object.keys(change.fields));
        const extrasChanged = [...changed].some(isExtrasField);
        if (kind === "project") {
            if (!fields) continue;
            const value: Record<string, Json> = columnValues(fields, PROJECT_COLUMNS, changed);
            if (extrasChanged) {
                const extras = await extrasFor(fields, key, refused);
                if (extras === false) continue;
                value.extras_json = extras;
            }
            if (Object.keys(value).length > 0) items.push({ list: "project", key, value });
            continue;
        }
        if (kind === "track") {
            const [type, index] = entityId(key).split(":");
            if (change.op === "delete") {
                // A track whose clips Studio kept is not removed on the server (removal deletes its clips there).
                const used = Object.entries(target.entities).some(([k, f]) => k.startsWith("clip:") && f.track_type === type && f.track_index === Number(index));
                if (!used) items.push({ list: "tracks.removed", key, value: { type: type!, index: Number(index) } });
            } else if (fields) {
                items.push({ list: "tracks.put", key, value: { type: type!, index: Number(index), ...columnValues(fields, TRACK_COLUMNS) } });
            }
            continue;
        }
        const id = entityId(key);
        const columns = kind === "clip" ? CLIP_COLUMNS : SCENE_COLUMNS;
        if (change.op === "delete") {
            items.push({ list: kind === "clip" ? "clips.delete" : "scenes.delete", key, value: id });
            continue;
        }
        if (!fields) continue;
        if (change.op === "create") {
            if (!UUID.test(id)) {
                refused.push({ key, message: "This item's id can't be used in a cloud project." });
                continue;
            }
            if (kind === "clip" && clipsAfter > MAX_PROJECT_CLIPS) {
                refused.push({ key, message: `A cloud project holds at most ${MAX_PROJECT_CLIPS} clips.` });
                continue;
            }
            if (kind === "scene" && scenesAfter > MAX_PROJECT_SCENES) {
                refused.push({ key, message: `A cloud project holds at most ${MAX_PROJECT_SCENES} scenes.` });
                continue;
            }
            const value: Record<string, Json> = { id, ...columnValues(fields, columns) };
            if (kind === "clip") {
                const missing = ["track_type", "track_index", "start_time", "end_time"].filter((name) => !(name in value));
                if (missing.length > 0 || !((value.end_time as number) > (value.start_time as number))) {
                    refused.push({ key, message: "This clip's place on the timeline can't be saved to a cloud project." });
                    continue;
                }
            } else if (typeof fields["x.order"] === "number" && Number.isInteger(fields["x.order"]) && (fields["x.order"] as number) >= 0 && (fields["x.order"] as number) <= 100_000) {
                value.order = fields["x.order"]!;
            }
            const extras = await extrasFor(fields, key, refused);
            if (extras === false) continue;
            if (extras !== null) value.extras_json = extras;
            if ("effects" in fields && fields.effects !== null) value.effects = effectsOf(fields);
            items.push({ list: kind === "clip" ? "clips.create" : "scenes.create", key, value });
            continue;
        }
        const value: Record<string, Json> = { id, ...columnValues(fields, columns, changed) };
        if (kind === "clip" && (changed.has("start_time") || changed.has("end_time"))) {
            const start = fields.start_time;
            const end = fields.end_time;
            if (typeof start === "number" && typeof end === "number" && !(end > start)) {
                refused.push({ key, message: "A clip must end after it starts." });
                continue;
            }
        }
        if (extrasChanged) {
            const extras = await extrasFor(fields, key, refused);
            if (extras === false) continue;
            value.extras_json = extras;
        }
        if (changed.has("effects")) value.effects = "effects" in fields ? fields.effects! : null;
        if (Object.keys(value).length > 1) items.push({ list: kind === "clip" ? "clips.patch" : "scenes.patch", key, value });
    }
    for (const assetId of options.mediaAdd ?? []) items.push({ list: "media.add", key: `media:${assetId}`, value: assetId });

    items.sort((x, y) => ORDER.indexOf(x.list) - ORDER.indexOf(y.list));
    const bodies: ChangesetBody[] = [];
    const keys: string[][] = [];
    let body = emptyBody(options.label, options.device);
    let bodyKeys: string[] = [];
    const maxBytes = options.maxBytes ?? MAX_BODY_BYTES;
    const sizeOf = (value: unknown) => utf8.encode(JSON.stringify(value)).length;
    let bytes = sizeOf(body);
    const lists = (b: ChangesetBody, list: Item["list"]): Json[] | null => {
        switch (list) {
            case "tracks.put": return (b.tracks ??= { put: [], removed: [] }).put as Json[];
            case "tracks.removed": return (b.tracks ??= { put: [], removed: [] }).removed as unknown as Json[];
            case "scenes.create": return b.scenes.create as Json[];
            case "scenes.patch": return b.scenes.patch as Json[];
            case "scenes.delete": return b.scenes.delete as Json[];
            case "clips.create": return b.clips.create as Json[];
            case "clips.patch": return b.clips.patch as Json[];
            case "clips.delete": return b.clips.delete as Json[];
            case "media.add": return b.media.add as Json[];
            default: return null;
        }
    };
    const flush = () => {
        if (bodyKeys.length === 0) return;
        bodies.push(body);
        keys.push(bodyKeys);
        body = emptyBody(options.label, options.device);
        bodyKeys = [];
        bytes = sizeOf(body);
    };
    for (const item of items) {
        const size = sizeOf(item.value) + 1;
        const list = item.list === "project" ? null : lists(body, item.list);
        if (bytes + size > maxBytes || (list && list.length >= MAX_ITEMS)) flush();
        if (item.list === "project") body.project = item.value as Record<string, Json>;
        else lists(body, item.list)!.push(item.value);
        bodyKeys.push(item.key);
        bytes += size;
    }
    flush();
    return { bodies, keys, held, refused };
}

/** The entity keys a refusal names: details {kind, ids} or {path: "clips.patch[3].end_time"} read against the body sent. */
export function refusedKeys(body: ChangesetBody, details: Record<string, unknown> | undefined): string[] {
    if (!details) return [];
    const kind = details.kind;
    if ((kind === "clip" || kind === "scene") && Array.isArray(details.ids)) return details.ids.filter((id): id is string => typeof id === "string").map((id) => `${kind}:${id}`);
    if (kind === "asset" && Array.isArray(details.ids)) return details.ids.filter((id): id is string => typeof id === "string").map((id) => `media:${id}`);
    const path = typeof details.path === "string" ? details.path : null;
    if (!path) return [];
    if (path.startsWith("project")) return ["project"];
    const match = /^(clips|scenes|tracks)\.(create|patch|delete|put|removed)\[(\d+)\]/.exec(path);
    if (!match) return [];
    const [, list, op, index] = match;
    if (list === "tracks") {
        const row = (op === "put" ? body.tracks?.put : body.tracks?.removed)?.[Number(index)] as { type?: string; index?: number } | undefined;
        return row ? [`track:${row.type}:${row.index}`] : [];
    }
    const rows = (body[list as "clips" | "scenes"] as Record<string, Array<Json>>)[op!] ?? [];
    const row = rows[Number(index)];
    const id = typeof row === "string" ? row : (row as Record<string, Json> | undefined)?.id;
    return typeof id === "string" ? [`${list === "clips" ? "clip" : "scene"}:${id}`] : [];
}
