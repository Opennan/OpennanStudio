// The cast check (frames step): one cheap vision call after each keyframe, through the same text.generate capability
// the story writer uses with an image input. It sends the keyframe and the sheets of the shot's cast and asks for
// strict JSON: does each listed character match their sheet (hair, outfit, colours), yes or no, and why. A miss redraws
// the keyframe with the look restated (see redrawPrompt); an answer that does not read never triggers a redraw.
import { jsonObjectOf } from "./draft";
import { castOf } from "./recipe";
import type { StoryFilm, StoryShot } from "./types";

/** The check's output cap: a verdict per character is a few dozen tokens; thinking models need some room. */
export const CAST_CHECK_MAX_TOKENS = 1_000;
/** Redraws a shot may get when its cast does not match (the option's default and its most). */
export const CAST_CHECK_REDRAWS = 1;
export const CAST_CHECK_MAX_REDRAWS = 3;

const INSTRUCTION = `Check one keyframe of an animated film against the character design sheets of its cast. The first image is the keyframe; each next image is one character's design sheet, in the order listed. For each listed character, say whether the keyframe draws them as on their sheet: the same hair (style and colour), the same outfit and the same colours. Pose, angle, expression, lighting and framing may differ. A listed character missing from the keyframe does not match.
Answer with one JSON object and nothing else:
{ "characters": [{ "id": "the listed id", "match": true or false, "reason": "under 20 words: what differs, or empty" }] }`;

export interface CastCheckRequest {
    capability: "text.generate";
    input: { instruction: string; prompt: string; images: unknown[]; maxTokens: number };
    /** The ids the answer must cover, in sheet order. */
    ids: string[];
}

/**
 * The check of a shot's keyframe (null: no character of the shot has a sheet, nothing to check). `keyframe` is what
 * is sent as the first image (a project image ref, or a placeholder link when it is only priced).
 */
export function castCheckRequest(story: Pick<StoryFilm, "characters">, shot: Pick<StoryShot, "cast">, keyframe: unknown): CastCheckRequest | null {
    const cast = castOf(story, shot).filter((c) => c.sheet);
    if (cast.length === 0) return null;
    const lines = cast.map((c, i) => `- ${c.id} (image ${i + 2}): ${c.name}. Look: ${c.look}`);
    return {
        capability: "text.generate",
        input: {
            instruction: INSTRUCTION,
            prompt: `Characters to check:\n${lines.join("\n")}`,
            images: [keyframe, ...cast.map((c) => ({ mediaUrl: c.sheet!.url }))],
            maxTokens: CAST_CHECK_MAX_TOKENS,
        },
        ids: cast.map((c) => c.id),
    };
}

export type CastVerdict = { read: true; misses: Array<{ id: string; reason: string }> } | { read: false };

const yes = (value: unknown): boolean | null => {
    if (typeof value === "boolean") return value;
    if (typeof value === "string" && /^(yes|true|match)$/i.test(value.trim())) return true;
    if (typeof value === "string" && /^(no|false|mismatch)$/i.test(value.trim())) return false;
    return null;
};

/** The check's answer: who did not match (empty: all did), or unread when it does not cover every listed id. */
export function parseCastCheck(reply: string, ids: readonly string[]): CastVerdict {
    const value = jsonObjectOf(reply) as { characters?: unknown } | null;
    if (!value || !Array.isArray(value.characters)) return { read: false };
    const answers = new Map<string, { match: boolean; reason: string }>();
    for (const row of value.characters as unknown[]) {
        if (!row || typeof row !== "object") continue;
        const { id, match, reason } = row as Record<string, unknown>;
        const verdict = yes(match);
        if (typeof id !== "string" || verdict === null) continue;
        answers.set(id.trim(), { match: verdict, reason: typeof reason === "string" ? reason.trim().replace(/\s+/g, " ").slice(0, 300) : "" });
    }
    if (!ids.every((id) => answers.has(id))) return { read: false };
    return { read: true, misses: ids.filter((id) => !answers.get(id)!.match).map((id) => ({ id, reason: answers.get(id)!.reason })) };
}
