// Which animations an item can use (phase 10b): video, image clips and scenes take the clip animations,
// text clips the text animations, sticker clips the clip in / out / combo animations plus the text loops
// that are pure motion (no raster part, since a sticker has no glyphs).
import { CLIP_ANIMATIONS } from "./animations";
import { TEXT_ANIMATIONS } from "./text-animations";
import type { AnimationDef, AnimationKind, AnimationSlot } from "./types";

/** Animation families: the def kinds plus stickers, which mix both. */
export type AnimationTarget = AnimationKind | "sticker";

/** Text loop animations without a raster part (pulse, shake, float, swing …): the sticker loops. */
export function stickerLoopAnimations(): readonly AnimationDef[] {
    return TEXT_ANIMATIONS.filter((def) => def.slot === "loop" && def.raster === undefined);
}

export function animationsFor(kind: AnimationTarget, slot: AnimationSlot): readonly AnimationDef[] {
    if (kind === "text") return TEXT_ANIMATIONS.filter((def) => def.slot === slot);
    if (kind === "sticker" && slot === "loop") return stickerLoopAnimations();
    return CLIP_ANIMATIONS.filter((def) => def.slot === slot);
}

export function animationById(kind: AnimationTarget, slot: AnimationSlot, id: string): AnimationDef | undefined {
    return animationsFor(kind, slot).find((def) => def.id === id);
}
