// The story film validator: any story.json (a file, an agent's argument, a text model's draft, the saved project) is
// checked and normalized here before anything uses it. Texts are trimmed and capped, ids are short slugs, a shot's
// cast names known characters, seconds are whole numbers from 4 to 15 (default 5). Assets are kept only when they are
// well formed, so a hand-edited file can never point a run at something it did not make.
import { STORY_FILM_VERSION, STORY_MEDIUMS, type StoryAsset, type StoryCastCheck, type StoryCharacter, type StoryFilm, type StoryShot, type StorySettings, type StorySource } from "./types";

export const STORY_LIMITS = Object.freeze({
    title: 80,
    style: 1500,
    name: 60,
    look: 800,
    frame: 1500,
    motion: 1000,
    music: 1000,
    characters: 8,
    shots: 40,
    /** A keyframe takes the cast's sheets plus the previous keyframe: at most 10 images, so 6 leaves room. */
    castPerShot: 6,
    minSeconds: 4,
    maxSeconds: 15,
});
export const DEFAULT_SHOT_SECONDS = 5;

const ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const MEDIA_URL = /^(opennan-local:\/\/|opennan-media:\/\/|blob:|https:\/\/|http:\/\/(127\.0\.0\.1|localhost)[:/])/;
const MODEL = /^[a-z0-9._-]{1,64}$/;

export type StoryParse = { ok: true; story: StoryFilm } | { ok: false; errors: string[] };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** "Theo Baker" → "theo-baker" (a usable id from a name). */
export function slugId(text: string, fallback: string): string {
    const slug = text.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32).replace(/-+$/, "");
    return ID.test(slug) ? slug : fallback;
}

function textOf(raw: Record<string, unknown>, field: string, max: number, errors: string[], where: string, required = true): string {
    const value = raw[field];
    if (value === undefined || value === null || (typeof value === "string" && value.trim() === "")) {
        if (required) errors.push(`${where}${field} is required`);
        return "";
    }
    if (typeof value !== "string") {
        errors.push(`${where}${field} must be text`);
        return "";
    }
    const trimmed = value.trim().replace(/\s+/g, " ");
    if ([...trimmed].length > max) errors.push(`${where}${field} is longer than ${max} characters`);
    return trimmed;
}

/** A stored asset, or null when it is not one (dropped, never trusted half-formed). */
export function assetOf(value: unknown): StoryAsset | null {
    if (!isRecord(value) || typeof value.url !== "string" || !MEDIA_URL.test(value.url) || value.url.length > 4096) return null;
    if (typeof value.key !== "string" || value.key.length === 0 || value.key.length > 64) return null;
    const asset: StoryAsset = { url: value.url, key: value.key };
    if (finite(value.costUsd) && value.costUsd >= 0) asset.costUsd = value.costUsd;
    if (typeof value.model === "string" && MODEL.test(value.model)) asset.model = value.model;
    for (const key of ["width", "height", "durationSeconds"] as const) if (finite(value[key]) && (value[key] as number) > 0) asset[key] = value[key] as number;
    if (typeof value.at === "string" && value.at.length <= 40) asset.at = value.at;
    return asset;
}

/** A stored cast check of `keyframe`, or null (one about another keyframe, or half-formed, is dropped). */
export function castCheckOf(value: unknown, keyframe: StoryAsset | null): StoryCastCheck | null {
    if (!keyframe || !isRecord(value) || value.keyframeUrl !== keyframe.url || typeof value.ok !== "boolean") return null;
    if (!Number.isInteger(value.tries) || (value.tries as number) < 1 || (value.tries as number) > 8) return null;
    const misses = (Array.isArray(value.misses) ? value.misses : []).filter(isRecord).slice(0, STORY_LIMITS.castPerShot)
        .filter((m) => typeof m.id === "string" && ID.test(m.id))
        .map((m) => ({ id: m.id as string, reason: typeof m.reason === "string" ? m.reason.trim().slice(0, 300) : "" }));
    const check: StoryCastCheck = { keyframeUrl: keyframe.url, ok: value.ok, tries: value.tries as number, misses };
    if (value.unread === true) check.unread = true;
    if (finite(value.costUsd) && value.costUsd >= 0) check.costUsd = value.costUsd;
    if (typeof value.at === "string" && value.at.length <= 40) check.at = value.at;
    return check;
}

function settingsOf(value: unknown): StorySettings | undefined {
    if (!isRecord(value)) return undefined;
    const settings: StorySettings = {};
    for (const key of ["imageModel", "videoModel"] as const) if (typeof value[key] === "string" && MODEL.test(value[key] as string)) settings[key] = value[key] as string;
    for (const key of ["imageSize", "quality"] as const) if (typeof value[key] === "string" && /^[A-Za-z0-9]{1,8}$/.test(value[key] as string)) settings[key] = value[key] as string;
    return Object.keys(settings).length > 0 ? settings : undefined;
}

function sourceOf(value: unknown): StorySource | undefined {
    if (!isRecord(value)) return undefined;
    if (value.kind === "write") return { kind: "write" };
    if (value.kind !== "copy") return undefined;
    const source: StorySource = { kind: "copy", cast: value.cast === "keep" ? "keep" : "original" };
    if (typeof value.mediaUrl === "string" && MEDIA_URL.test(value.mediaUrl)) source.mediaUrl = value.mediaUrl;
    if (typeof value.link === "string" && /^https:\/\//.test(value.link) && value.link.length <= 4096) source.link = value.link;
    return source;
}

/** Checks and normalizes a story film. Every problem is listed (path and reason), none is fixed silently. */
export function parseStoryFilm(value: unknown): StoryParse {
    const errors: string[] = [];
    if (!isRecord(value)) return { ok: false, errors: ["the story must be an object"] };
    const title = textOf(value, "title", STORY_LIMITS.title, errors, "");
    const style = textOf(value, "style", STORY_LIMITS.style, errors, "");
    const musicRaw = isRecord(value.music) ? value.music.prompt : value.music;
    const music = textOf({ music: musicRaw }, "music", STORY_LIMITS.music, errors, "", false);

    const characters: StoryCharacter[] = [];
    const rawCharacters = Array.isArray(value.characters) ? value.characters : null;
    if (!rawCharacters) errors.push("characters must be a list");
    else if (rawCharacters.length > STORY_LIMITS.characters) errors.push(`at most ${STORY_LIMITS.characters} characters`);
    for (const [i, raw] of (rawCharacters ?? []).entries()) {
        const where = `characters[${i}].`;
        if (!isRecord(raw)) {
            errors.push(`${where.slice(0, -1)} must be an object`);
            continue;
        }
        const name = textOf(raw, "name", STORY_LIMITS.name, errors, where);
        const look = textOf(raw, "look", STORY_LIMITS.look, errors, where);
        const id = typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : slugId(name, `c${i + 1}`);
        if (!ID.test(id)) errors.push(`${where}id must be lowercase letters, digits, - or _ (at most 32)`);
        else if (characters.some((c) => c.id === id)) errors.push(`${where}id ${id} is used twice`);
        const character: StoryCharacter = { id, name, look };
        const sheet = assetOf(raw.sheet);
        if (sheet) character.sheet = sheet;
        characters.push(character);
    }
    const known = new Set(characters.map((c) => c.id));
    const byName = new Map(characters.map((c) => [c.name.toLowerCase(), c.id]));

    const shots: StoryShot[] = [];
    const rawShots = Array.isArray(value.shots) ? value.shots : null;
    if (!rawShots || rawShots.length === 0) errors.push("shots must list at least one shot");
    else if (rawShots.length > STORY_LIMITS.shots) errors.push(`at most ${STORY_LIMITS.shots} shots`);
    for (const [i, raw] of (rawShots ?? []).entries()) {
        const where = `shots[${i}].`;
        if (!isRecord(raw)) {
            errors.push(`${where.slice(0, -1)} must be an object`);
            continue;
        }
        const id = typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : `s${String(i + 1).padStart(2, "0")}`;
        if (!ID.test(id)) errors.push(`${where}id must be lowercase letters, digits, - or _ (at most 32)`);
        else if (shots.some((s) => s.id === id)) errors.push(`${where}id ${id} is used twice`);
        const frame = textOf(raw, "frame", STORY_LIMITS.frame, errors, where);
        const motion = textOf(raw, "motion", STORY_LIMITS.motion, errors, where);
        const cast: string[] = [];
        if (raw.cast !== undefined && !Array.isArray(raw.cast)) errors.push(`${where}cast must be a list of character ids`);
        for (const member of Array.isArray(raw.cast) ? raw.cast : []) {
            // A name works too (drafts often use names); it becomes the character's id.
            const id = typeof member === "string" ? (known.has(member.trim()) ? member.trim() : byName.get(member.trim().toLowerCase())) : undefined;
            if (!id) errors.push(`${where}cast names an unknown character ${JSON.stringify(member)}`);
            else if (!cast.includes(id)) cast.push(id);
        }
        if (cast.length > STORY_LIMITS.castPerShot) errors.push(`${where}cast has more than ${STORY_LIMITS.castPerShot} characters`);
        const shot: StoryShot = { id, cast, frame, motion };
        if (raw.seconds !== undefined && raw.seconds !== null) {
            if (!Number.isInteger(raw.seconds) || (raw.seconds as number) < STORY_LIMITS.minSeconds || (raw.seconds as number) > STORY_LIMITS.maxSeconds) {
                errors.push(`${where}seconds must be a whole number from ${STORY_LIMITS.minSeconds} to ${STORY_LIMITS.maxSeconds}`);
            } else shot.seconds = raw.seconds as number;
        }
        const keyframe = assetOf(raw.keyframe);
        if (keyframe) shot.keyframe = keyframe;
        const check = castCheckOf(raw.check, keyframe);
        if (check) shot.check = check;
        const clip = assetOf(raw.clip);
        if (clip) shot.clip = clip;
        shots.push(shot);
    }
    if (errors.length > 0) return { ok: false, errors };

    const story: StoryFilm = { version: STORY_FILM_VERSION, title, style, characters, shots, music };
    if (typeof value.medium === "string" && (STORY_MEDIUMS as readonly string[]).includes(value.medium)) story.medium = value.medium as StoryFilm["medium"];
    const musicAsset = assetOf(value.musicAsset);
    if (musicAsset) story.musicAsset = musicAsset;
    const settings = settingsOf(value.settings);
    if (settings) story.settings = settings;
    const source = sourceOf(value.source);
    if (source) story.source = source;
    if (isRecord(value.assembled) && Array.isArray(value.assembled.sceneIds) && Array.isArray(value.assembled.clipIds)) {
        const ids = (list: unknown[]) => list.filter((id): id is string => typeof id === "string" && id.length > 0 && id.length <= 128).slice(0, 200);
        story.assembled = { sceneIds: ids(value.assembled.sceneIds), clipIds: ids(value.assembled.clipIds) };
    }
    if (finite(value.spentUsd) && value.spentUsd >= 0) story.spentUsd = value.spentUsd;
    return { ok: true, story };
}

/** A shot's length in seconds (its own, else the default). */
export function shotSeconds(shot: StoryShot): number {
    return shot.seconds ?? DEFAULT_SHOT_SECONDS;
}

/** The film's length: every shot end to end. */
export function filmSeconds(story: StoryFilm): number {
    return story.shots.reduce((sum, shot) => sum + shotSeconds(shot), 0);
}

/** The story as stored on the project (ProjectMeta.storyFilmJson). */
export function storyJson(story: StoryFilm): string {
    return JSON.stringify(story);
}

/** The project's stored story, or null when there is none (or it no longer reads). */
export function readStoryJson(json: string | null | undefined): StoryFilm | null {
    if (!json) return null;
    try {
        const parsed = parseStoryFilm(JSON.parse(json));
        return parsed.ok ? parsed.story : null;
    } catch {
        return null;
    }
}
