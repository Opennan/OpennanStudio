// Stable voice references and explicit speaker timing, shared by the editor and every MCP client.
import type { SeriesCast, StoryDialogue, StoryFilm, StoryShot, StoryVoice } from "./types";
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const slug = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export function parseStoryVoice(value: unknown): StoryVoice | null {
    if (!record(value) || typeof value.providerId !== "string" || !/^[a-z0-9_-]{1,64}$/.test(value.providerId) || typeof value.id !== "string" || !/^[A-Za-z0-9_.:-]{1,100}$/.test(value.id)) return null;
    const voice: StoryVoice = { providerId: value.providerId, id: value.id };
    if (value.language !== undefined) {
        if (typeof value.language !== "string" || !/^[A-Za-z-]{2,16}$/.test(value.language)) return null;
        voice.language = value.language;
    }
    if (value.model !== undefined) {
        if (typeof value.model !== "string" || !/^[a-z0-9._-]{1,64}$/.test(value.model)) return null;
        voice.model = value.model;
    }
    return voice;
}

export function dialogueOf(value: unknown, shot: StoryShot, known: Set<string>, errors: string[], where: string): StoryDialogue[] | undefined {
    if (value === undefined) return undefined;
    if (!Array.isArray(value) || value.length > 24) { errors.push(`${where}dialogue must be a list of at most 24 lines (empty means silent)`); return undefined; }
    const lines: StoryDialogue[] = [];
    for (const raw of value) {
        if (!record(raw) || typeof raw.id !== "string" || !slug.test(raw.id) || lines.some(l => l.id === raw.id)
            || typeof raw.characterId !== "string" || !known.has(raw.characterId) || typeof raw.text !== "string" || !raw.text.trim() || raw.text.length > 3000
            || typeof raw.start !== "number" || !Number.isFinite(raw.start) || raw.start < 0 || typeof raw.end !== "number" || !Number.isFinite(raw.end)
            || raw.end <= raw.start || raw.end > (shot.seconds ?? 5) || (lines.length > 0 && raw.start < lines[lines.length - 1]!.end)) {
            errors.push(`${where}dialogue needs unique line ids, known character ids, text and ordered non-overlapping times within the shot`);
            continue;
        }
        lines.push({ id: raw.id, characterId: raw.characterId, text: raw.text.trim(), start: raw.start, end: raw.end });
    }
    return lines;
}

export function speechContext(story: Pick<StoryFilm, "characters">, shot: StoryShot) {
    if (shot.dialogue === undefined) return { status: "unassigned" as const, speaking: [], silent: [], lines: [] };
    const speaking = [...new Set(shot.dialogue.map(l => l.characterId))];
    return {
        status: shot.dialogue.length ? "dialogue" as const : "silent" as const,
        speaking, silent: shot.cast.filter(id => !speaking.includes(id)),
        lines: shot.dialogue.map(line => ({ ...line, name: story.characters.find(c => c.id === line.characterId)?.name, voice: story.characters.find(c => c.id === line.characterId)?.voice ?? null })),
    };
}

export function dialoguePrompt(story: Pick<StoryFilm, "characters">, shot: StoryShot): string {
    const context = speechContext(story, shot);
    if (context.status === "unassigned") return "";
    if (context.status === "silent") return " No dialogue in this shot. All characters remain silent; no speaking mouth movements.";
    const names = (ids: string[]) => ids.map(id => story.characters.find(c => c.id === id)?.name ?? id).join(", ");
    const timing = context.lines.map(l => `${l.start}-${l.end}s: ${l.name ?? l.characterId}${shot.cast.includes(l.characterId) ? " speaks" : " speaks off screen (no visible character lip movement)"}`).join("; ");
    return ` Speaking schedule: ${timing}. Only the scheduled visible speaker moves their mouth during their line. Other characters listen silently.${context.silent.length ? ` Silent throughout: ${names(context.silent)}.` : ""} Preserve every character's identity.`;
}

/** A shareable cast contains identity/voice references, never episode audio, media URLs, or credentials. */
export function castForSeries(story: StoryFilm, id: string, name: string): SeriesCast {
    if (!slug.test(id) || !name.trim() || name.length > 80) throw new Error("Use a short series id and a name (up to 80 characters)");
    return { id, name: name.trim(), characters: story.characters.map(({ id, name, look, voice }) => ({ id, name, look, ...(voice ? { voice: { ...voice } } : {}) })) };
}

export function parseSeriesCast(value: unknown): SeriesCast {
    if (!record(value) || typeof value.id !== "string" || !slug.test(value.id) || typeof value.name !== "string" || !value.name.trim() || value.name.length > 80
        || !Array.isArray(value.characters) || !value.characters.length || value.characters.length > 8) throw new Error("Invalid series cast");
    const ids = new Set<string>();
    const characters = value.characters.map(c => {
        if (!record(c) || typeof c.id !== "string" || !slug.test(c.id) || ids.has(c.id) || typeof c.name !== "string" || !c.name.trim() || c.name.length > 60
            || typeof c.look !== "string" || !c.look.trim() || c.look.length > 800) throw new Error("Invalid character identity");
        ids.add(c.id);
        const voice = c.voice == null ? null : parseStoryVoice(c.voice);
        if (c.voice != null && !voice) throw new Error("Invalid character voice");
        return { id: c.id, name: c.name.trim(), look: c.look.trim(), ...(voice ? { voice } : {}) };
    });
    return { id: value.id, name: value.name.trim(), characters };
}
