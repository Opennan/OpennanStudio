// Drafts from a text model (text.generate): a written story turned into shots, or a copied video's beats (its frames on
// one contact sheet) retold. A copy makes an original cast and title by default (new character designs and names that
// keep the beats and the feel, safe to publish); "keep" keeps the people as they are, only for the user's own video.
// The draft is always a draft: the person edits it before anything paid runs.
import { parseStoryFilm, STORY_LIMITS, type StoryParse } from "./validate";
import type { StoryMedium, StorySource } from "./types";

/** The output cap of a draft call (12 shots of JSON take about 3,000 tokens; thinking models need room). */
export const DRAFT_MAX_TOKENS = 12_000;

const SHAPE = `Answer with one JSON object and nothing else:
{
  "title": "short film title (at most 40 characters)",
  "style": "one paragraph: medium, linework, shading, palette, light, era and composition of every image, ending with: cinematic 16:9 composition, no text, no watermark",
  "medium": "2d" | "3d" | "stop-motion" | "anime",
  "characters": [{ "id": "short-lowercase-id", "name": "Name", "look": "build, face, hair, clothes and colours that never change" }],
  "shots": [{ "id": "s01", "cast": ["character ids in the shot, most important first"], "frame": "the still image: shot size, place, light, where each character is and what they are doing", "motion": "what moves from that still, and the camera", "seconds": 5 }],
  "music": "an instrumental music description that fits the whole film, no vocals"
}`;

const RULES = `Rules:
- At most ${STORY_LIMITS.characters} characters and ${STORY_LIMITS.shots} shots; usually 2 characters and 8 to 14 shots.
- Each shot is ${STORY_LIMITS.minSeconds} to ${STORY_LIMITS.maxSeconds} seconds (5 unless a beat needs longer); never cut a shot shorter.
- Several characters may share a shot; list each one in its cast.
- "frame" describes one still image. "motion" describes only what happens from that still: it must match the frame (do not say a character enters when the frame already shows them).
- Restate nothing about a character's look in "frame" or "motion": the look lives in "look", which lists what never changes (hair, clothes, colours, build).
- Never put readable words, signs, logos or subtitles in a frame.`;

export interface WriteDraftInput {
    /** The story in the person's words (any language; the draft is in English). */
    text: string;
    style?: string;
    medium?: StoryMedium;
    /** About how many shots. */
    shots?: number;
}

export interface CopyDraftInput {
    /** The contact sheet of the reference video's frames (a project image or an https link). */
    sheet: unknown;
    /** Frames on the sheet, their spacing, and the video's length (seconds). */
    frames: number;
    everySeconds: number;
    durationSeconds: number;
    cast: "original" | "keep";
    /** Anything the person adds (what the video is about, what to change). */
    notes?: string;
    medium?: StoryMedium;
    /**
     * The video's real shots (Studio found the cuts), in order, with the sheet frames (1-based, inclusive) that show
     * each one: the draft then has exactly one story shot per real shot, so each can be remade from its real shot.
     */
    shots?: ReadonlyArray<{ start: number; end: number; firstFrame: number; lastFrame: number }>;
}

export interface DraftRequest {
    capability: "text.generate";
    input: { instruction: string; prompt: string; images?: unknown[]; maxTokens: number };
}

const INSTRUCTION = `You write story films: short animated films made shot by shot, each shot drawn as one keyframe from character design sheets and then animated. ${SHAPE}\n${RULES}`;

/** The text call that turns a written story into a draft. */
export function writeDraftRequest(input: WriteDraftInput): DraftRequest {
    const asks = [
        `Story:\n${input.text.trim()}`,
        input.style ? `Art style wanted: ${input.style.trim()}` : "Pick an art style that suits the story.",
        input.medium ? `Medium: ${input.medium}.` : "",
        input.shots ? `About ${Math.round(input.shots)} shots.` : "",
    ].filter(Boolean);
    return { capability: "text.generate", input: { instruction: INSTRUCTION, prompt: asks.join("\n\n"), maxTokens: DRAFT_MAX_TOKENS } };
}

const fmt = (seconds: number) => String(Math.round(seconds * 10) / 10);

/** The text call that retells a reference video (its frames on one contact sheet) as a draft. */
export function copyDraftRequest(input: CopyDraftInput): DraftRequest {
    const cast = input.cast === "keep"
        ? "Keep the characters as they appear in the video (this is the person's own video): describe each one's look exactly."
        : "Make an ORIGINAL cast: new character designs and new names that play the same roles, and a new title. Keep the beats, the order, the pacing and the feel. Never copy a real person's likeness, names, logos, brands or dialogue from the video.";
    const shots = input.shots && input.shots.length > 0 ? input.shots : null;
    const sheet = shots
        ? `The image is a contact sheet of ${input.frames} frames from a reference video, in order (left to right, then top to bottom), each labelled with its shot number, from a ${Math.round(input.durationSeconds)}-second video.`
        : `The image is a contact sheet of ${input.frames} frames from a reference video, in order (left to right, then top to bottom), one every ${Math.round(input.everySeconds * 10) / 10} seconds of a ${Math.round(input.durationSeconds)}-second video.`;
    const retell = shots
        ? [
            `The video has exactly ${shots.length} shots (cut to cut):`,
            shots.map((shot, i) => `- shot ${i + 1}: ${fmt(shot.start)}-${fmt(shot.end)} s (${fmt(shot.end - shot.start)} s), frame${shot.firstFrame === shot.lastFrame ? ` ${shot.firstFrame}` : `s ${shot.firstFrame}-${shot.lastFrame}`}`).join("\n"),
            `Write exactly ${shots.length} story shots, in this order, one for each real shot: the same action, blocking and camera, played by the story's characters. "frame" is the first moment of that real shot with the new cast; "motion" is what happens in it and how the camera moves. Set "seconds" to the whole number nearest the shot's length (at least ${STORY_LIMITS.minSeconds}). Describe the reference's art style in "style" (medium, linework, palette, light).`,
        ].join("\n")
        : "Retell it as a story film with one shot per beat of the video. Describe the reference's art style in \"style\" (medium, linework, palette, light).";
    const prompt = [
        sheet,
        retell,
        cast,
        input.medium ? `Medium: ${input.medium}.` : "",
        input.notes?.trim() ? `Notes from the person: ${input.notes.trim()}` : "",
    ].filter(Boolean).join("\n\n");
    return { capability: "text.generate", input: { instruction: INSTRUCTION, prompt, images: [input.sheet], maxTokens: DRAFT_MAX_TOKENS } };
}

/** The first JSON object in a reply (code fences and words around it are dropped), or null. */
export function jsonObjectOf(reply: string): unknown {
    const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(reply);
    const text = fenced ? fenced[1]! : reply;
    const start = text.indexOf("{");
    if (start < 0) return null;
    // The object ends at its matching brace (strings may hold braces).
    let depth = 0;
    let inString = false;
    for (let i = start; i < text.length; i += 1) {
        const ch = text[i];
        if (inString) {
            if (ch === "\\") i += 1;
            else if (ch === "\"") inString = false;
            continue;
        }
        if (ch === "\"") inString = true;
        else if (ch === "{") depth += 1;
        else if (ch === "}") {
            depth -= 1;
            if (depth === 0) {
                try {
                    return JSON.parse(text.slice(start, i + 1));
                } catch {
                    return null;
                }
            }
        }
    }
    return null;
}

/** A text model's reply as a story draft (validated; its source recorded), or what is wrong with it. */
export function parseDraftReply(reply: string, source: StorySource): StoryParse {
    const value = jsonObjectOf(reply);
    if (value === null || typeof value !== "object") return { ok: false, errors: ["the story writer's answer had no story in it"] };
    const draft = { ...(value as Record<string, unknown>) };
    // A draft never carries assets, a placement or costs.
    for (const shot of Array.isArray(draft.shots) ? (draft.shots as unknown[]) : []) {
        if (!shot || typeof shot !== "object") continue;
        delete (shot as Record<string, unknown>).keyframe;
        delete (shot as Record<string, unknown>).check;
        delete (shot as Record<string, unknown>).clip;
        delete (shot as Record<string, unknown>).source;
    }
    for (const character of Array.isArray(draft.characters) ? (draft.characters as unknown[]) : []) {
        if (character && typeof character === "object") delete (character as Record<string, unknown>).sheet;
    }
    delete draft.musicAsset;
    delete draft.assembled;
    delete draft.spentUsd;
    if (typeof draft.title === "string") draft.title = draft.title.trim().slice(0, STORY_LIMITS.title);
    return parseStoryFilm({ ...draft, source });
}

/** A blank story to fill in by hand (the wizard's Write without a story writer). */
export function blankStory(): Record<string, unknown> {
    return {
        version: 1, title: "", style: "", medium: "2d", music: "",
        characters: [{ id: "a", name: "", look: "" }],
        shots: [{ id: "s01", cast: ["a"], frame: "", motion: "", seconds: 5 }],
        source: { kind: "write" },
    };
}
