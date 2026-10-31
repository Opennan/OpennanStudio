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
