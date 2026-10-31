// The prompts of the proven recipe (prototype run 2026-10-31, "Rain Check"), as pure functions. The 2D medium gives
// the prototype's exact words; the other mediums swap only the medium words. Two rules carry the consistency: every
// keyframe restates each character's look next to "exactly as drawn in reference image i" (once, without it, a
// character came out with another hairstyle), and every keyframe after the first matches the previous shot's look.
import type { StoryCharacter, StoryFilm, StoryMedium, StoryShot } from "./types";

interface MediumWords {
    /** "A single frame from a {film}." */
    film: string;
    /** The motion prompt's tail. */
    keep: string;
}

const MEDIUM_WORDS: Record<StoryMedium, MediumWords> = {
    "2d": {
        film: "hand-drawn animated short film",
        keep: "Keep the exact hand-drawn 2D animation style, character designs and colours of the first frame. Smooth classic cel animation, no morphing, no text.",
    },
    "3d": {
        film: "3D animated short film",
        keep: "Keep the exact 3D animation style, character designs, materials and colours of the first frame. Smooth character animation, no morphing, no text.",
    },
    "stop-motion": {
        film: "stop-motion animated short film",
        keep: "Keep the exact stop-motion look, puppet designs, materials and colours of the first frame. Stop-motion movement, no morphing, no text.",
    },
    anime: {
        film: "anime short film",
        keep: "Keep the exact anime style, character designs and colours of the first frame. Smooth anime animation, no morphing, no text.",
    },
};

const mediumOf = (story: Pick<StoryFilm, "medium">): MediumWords => MEDIUM_WORDS[story.medium ?? "2d"];

/** A character design sheet: drawn once per character, no references, 16:9. */
export function sheetPrompt(story: Pick<StoryFilm, "style">, character: Pick<StoryCharacter, "name" | "look">): string {
    return `Character design model sheet for an animated film. ${character.name}: ${character.look}. Full body turnaround (front, three-quarter, side, back) plus four facial expressions (happy, surprised, shy, laughing), plain off-white background, consistent proportions. Style: ${story.style}`;
}

/** The cast of a shot in reference order (unknown ids are left out). */
export function castOf(story: Pick<StoryFilm, "characters">, shot: Pick<StoryShot, "cast">): StoryCharacter[] {
    return shot.cast.map((id) => story.characters.find((c) => c.id === id)).filter((c): c is StoryCharacter => c !== undefined);
}

/**
 * A shot's keyframe. References: the cast's sheets in cast order, then the previous shot's keyframe (the style
 * anchor) when there is one; `withPrevious` says whether that last reference is sent.
 */
export function keyframePrompt(story: Pick<StoryFilm, "style" | "characters" | "medium">, shot: Pick<StoryShot, "cast" | "frame">, withPrevious: boolean): string {
    const cast = castOf(story, shot);
    const who = cast.map((c, i) => `${c.name} (exactly as drawn in reference image ${i + 1}: ${c.look})`).join("; ");
    const characters = cast.length > 0 ? ` Characters: ${who}.` : "";
    const styleRef = withPrevious ? " Match the art style, line weight and colour palette of the last reference image (previous shot of the same film)." : "";
    return `A single frame from a ${mediumOf(story).film}.${characters} Scene: ${shot.frame}${styleRef} Style: ${story.style}`;
}

/** A shot's clip: the keyframe is its first frame; the motion must match what that frame shows. */
export function motionPrompt(story: Pick<StoryFilm, "medium">, shot: Pick<StoryShot, "motion">): string {
    return `${shot.motion} ${mediumOf(story).keep}`;
}

/** The music bed: the story's description as an instrumental. */
export function musicPrompt(story: Pick<StoryFilm, "music" | "title">): string {
    return story.music || `Gentle instrumental score for an animated short film called ${story.title}, no vocals`;
}

/**
 * A keyframe drawn again after its cast check: the same prompt with each character that did not match restated as
 * the first thing to get right (restating the look is what fixed the prototype's one lost look), and what was wrong.
 */
export function redrawPrompt(
    story: Pick<StoryFilm, "style" | "characters" | "medium">, shot: Pick<StoryShot, "cast" | "frame">, withPrevious: boolean,
    misses: ReadonlyArray<{ id: string; reason: string }>,
): string {
    const cast = castOf(story, shot);
    const stress = misses.map((miss) => {
        const index = cast.findIndex((c) => c.id === miss.id);
        if (index < 0) return null;
        const c = cast[index]!;
        const wrong = miss.reason ? ` The last drawing got this wrong: ${miss.reason}` : "";
        return `${c.name} must look exactly like reference image ${index + 1}: ${c.look}. Same hair, same outfit, same colours.${wrong}`;
    }).filter((line): line is string => line !== null);
    const first = stress.length > 0 ? ` Most important: ${stress.join(" ")}` : "";
    return `${keyframePrompt(story, shot, withPrevious)}${first}`;
}

/** The most a video prompt holds (the provider's limit for a description). */
export const VIDEO_PROMPT_MAX = 4000;

/**
 * A remade shot: the real shot is @Video1 (its motion, timing, blocking and camera are kept), the cast sheets are
 * @Image1..n in cast order, and the shot's keyframe is the last image (the style anchor). The new cast's looks are
 * restated next to their sheets, as in every keyframe prompt.
 */
export function remakePrompt(story: Pick<StoryFilm, "style" | "characters" | "medium">, shot: Pick<StoryShot, "cast" | "frame" | "motion">, withKeyframe: boolean): string {
    const cast = castOf(story, shot);
    const anchor = cast.length + 1;
    const people = cast.length > 0
        ? ` Replace the people with ${cast.map((c, i) => `@Image${i + 1} (${c.name}: ${c.look})`).join(" and ")}. Keep their looks exactly as drawn in their reference sheets.`
        : " Keep the place and the action; there are no characters to replace.";
    const style = withKeyframe ? ` Match the art style, line weight and colours of @Image${anchor} (this shot's first frame).` : "";
    const text = `Recreate @Video1 exactly: same motion, timing, blocking and camera move, frame by frame.${people} The shot: ${shot.frame} What happens: ${shot.motion}${style} Render as a ${mediumOf(story).film}: ${story.style} No text, no watermark.`;
    return text.length > VIDEO_PROMPT_MAX ? `${text.slice(0, VIDEO_PROMPT_MAX - 1)}…` : text;
}
