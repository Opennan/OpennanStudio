// A serializable listing of the motion, text, and sticker features (phase 10b) for the editor and for
// agents (MCP list tools). Names are English fallbacks; the UI translates by id.
import { displayName } from "../looks/catalog";
import { STICKER_CATEGORIES, STICKER_CATEGORY_NAMES } from "../stickers/catalog";
import { CAPTION_STYLES } from "../text/captions";
import { TEXT_FONTS } from "../text/fonts";
import { TEXT_TEMPLATES } from "../text/templates";
import { CLIP_ANIMATIONS } from "./animations";
import { EASING_IDS } from "./easing";
import { KEYFRAME_CHANNELS } from "./keyframes";
import { SPEED_CURVE_PRESETS } from "./speed";
import { TEXT_ANIMATIONS } from "./text-animations";
import type { AnimationKind, AnimationSlot } from "./types";

export interface CatalogAnimation { id: string; kind: AnimationKind; slot: AnimationSlot; name: string; defaultDuration: number; raster: boolean }

export interface MotionCatalog {
    animations: CatalogAnimation[];
    easings: string[];
    keyframeChannels: string[];
    speedCurves: Array<{ id: string; name: string; points: Array<[number, number]> }>;
    textTemplates: Array<{ id: string; category: string; name: string; defaultText: string }>;
    fonts: Array<{ id: string; family: string; weights: number[]; category: string }>;
    captionStyles: Array<{ id: string; name: string; karaoke: boolean }>;
    stickerCategories: Array<{ id: string; name: string }>;
}

const name = (id: string) => displayName(id.replace(/^combo_/, "").replace(/_out$/, ""));

export function motionCatalog(): MotionCatalog {
    const animation = (def: (typeof CLIP_ANIMATIONS)[number]): CatalogAnimation => ({
        id: def.id, kind: def.kind, slot: def.slot, name: name(def.id), defaultDuration: def.defaultDuration, raster: Boolean(def.raster),
    });
    return {
        animations: [...CLIP_ANIMATIONS, ...TEXT_ANIMATIONS].map(animation),
        easings: [...EASING_IDS],
        keyframeChannels: [...KEYFRAME_CHANNELS],
        speedCurves: SPEED_CURVE_PRESETS.map((c) => ({ id: c.id, name: displayName(c.id), points: c.points.map(([x, y]) => [x, y] as [number, number]) })),
        textTemplates: TEXT_TEMPLATES.map((t) => ({ id: t.id, category: t.category, name: displayName(t.id), defaultText: t.defaultText })),
        fonts: TEXT_FONTS.map((f) => ({ id: f.id, family: f.family, weights: [...f.weights], category: f.category })),
        captionStyles: CAPTION_STYLES.map((s) => ({ id: s.id, name: displayName(s.id), karaoke: s.karaoke })),
        stickerCategories: STICKER_CATEGORIES.map((id) => ({ id, name: STICKER_CATEGORY_NAMES[id] ?? displayName(id) })),
    };
}
