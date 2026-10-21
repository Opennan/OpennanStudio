// A V2+ video/image clip's look in the compositor (phase 10b), drawn through the shared LookRenderer.
// Adjust keyframes (`adj_*`, `filter_intensity`) cross-fade the CLUTs of the two keyframes around the
// time (LookRenderer.lutMix, the export's lut-keyframes blend) before the rest of the look (sharpen,
// vignette, grain, effects), exactly as the main-track overlay does for scenes (lane-look-overlay.tsx).
import { clipLegacyOps, legacyMediaInput, type LegacyOps } from "@opennan/timeline-core/looks/legacy";
import { itemLook, type LookPlan, type LookSource } from "@opennan/timeline-core/looks/look-plan";
import type { KeyframePoints } from "@opennan/timeline-core/motion/keyframes";
import { lookAfterKeyframes } from "@opennan/timeline-core/motion/look-keyframes";
import type { TimelineClip } from "@opennan/timeline-core/model/timeline";
import type { LookRenderer } from "@opennan/timeline-media/looks/look-renderer";
import { keyframeLut, lookKeyframeMix, lookKeyframeTimes, type LutStep } from "../lane-look-plan";
import { clipKeyframePoints } from "./clip-motion";

/** What to run at one time: the CLUT cross-fade (Adjust keyframes), then the plan. */
export interface ClipLookFrame {
    plan: LookPlan | null;
    mix: { a: LutStep; b: LutStep; w: number } | null;
    /** Legacy blur slider, chroma key, blend mode (phase 10d), after the look; the blur radius in export pixels. */
    legacy: LegacyOps | null;
}

interface ClipLookEntry {
    key: string;
    /** The full static look (no Adjust keyframes). */
    plan: LookPlan | null;
    /** Adjust keyframes: the steps after the keyframed CLUT, the points, and one CLUT per keyframe time. */
    keyed: { rest: LookPlan | null; points: KeyframePoints; source: LookSource; luts: Map<number, LutStep> } | null;
    legacy: LegacyOps | null;
}

const NO_LOOK: ClipLookFrame = Object.freeze({ plan: null, mix: null, legacy: null }) as ClipLookFrame;

/** The fields a clip's look reads (the cache key). */
function lookKey(clip: TimelineClip): string {
    return [
        clip.visualFilter, clip.filterIntensity, clip.adjustmentsJson, clip.brightness, clip.contrast, clip.saturation,
        JSON.stringify(clip.effects ?? []), clip.keyframesJson ?? "", clip.maskJson ?? "", clip.trackType,
        clip.blurStrength, clip.chromaKeyEnabled, clip.chromaKeyColor, clip.chromaKeySimilarity, clip.chromaKeyBlend, clip.blendMode, clip.mediaUrl, clip.mediaType,
    ].join("|");
}

/**
 * Per-clip looks, rebuilt when a look field or the keyframes change; keyframe CLUTs are built once each.
 * Clip objects are immutable, so the entry is memoized per object (no key built per frame); an edited clip
 * (new object) compares its key with the entry of its id, so unrelated edits (a drag) keep its CLUTs.
 */
export class ClipLookCache {
    private readonly entries = new Map<string, ClipLookEntry>();
    private byObject = new WeakMap<TimelineClip, ClipLookEntry>();

    get size(): number {
        return this.entries.size;
    }

    /** Drops the entries of clips not in `ids` (deleted clips); call when the clip list changes. */
    retain(ids: ReadonlySet<string>): void {
        for (const id of [...this.entries.keys()]) if (!ids.has(id)) this.entries.delete(id);
    }

    private entry(clip: TimelineClip): ClipLookEntry {
        const memo = this.byObject.get(clip);
        if (memo && this.entries.get(clip.id) === memo) return memo;
        const key = lookKey(clip);
        const cached = this.entries.get(clip.id);
        if (cached?.key === key) {
            this.byObject.set(clip, cached);
            return cached;
        }
        const source: LookSource = { kind: "clip", ...clip };
        const points = clipKeyframePoints(clip);
        const keyedLook = lookKeyframeTimes(points).length > 0;
        const plan = itemLook(source);
        // The export's plane modes (gpu/plan.ts): RGB after any look, else what the media decodes to.
        const looked = keyedLook || Boolean(plan && plan.steps.length > 0);
        const input = looked ? "rgb" : legacyMediaInput(clip.mediaUrl ?? "", clip.mediaType !== "image");
        const legacy = clipLegacyOps(clip, { input });
        const entry: ClipLookEntry = !keyedLook
            ? { key, plan, keyed: null, legacy }
            : { key, plan: null, keyed: { rest: lookAfterKeyframes(plan), points, source, luts: new Map() }, legacy };
        this.entries.set(clip.id, entry);
        this.byObject.set(clip, entry);
        return entry;
    }

    /** The clip's look at item-local `t` seconds. */
    at(clip: TimelineClip, t: number): ClipLookFrame {
        const entry = this.entry(clip);
        const legacy = entry.legacy;
        if (!entry.keyed) return entry.plan || legacy ? { plan: entry.plan, mix: null, legacy } : NO_LOOK;
        const { rest, points, source, luts } = entry.keyed;
        const at = lookKeyframeMix(points, Math.max(0, t));
        if (!at) return rest || legacy ? { plan: rest, mix: null, legacy } : NO_LOOK;
        const lutAt = (time: number) => {
            let lut = luts.get(time);
            if (!lut) {
                lut = keyframeLut(source, points, time);
                luts.set(time, lut);
            }
            return lut;
        };
        return { plan: rest, mix: { a: lutAt(at.from), b: lutAt(at.to), w: at.w }, legacy };
    }

    clear(): void {
        this.entries.clear();
        this.byObject = new WeakMap();
    }
}

/** Legacy ops with the blur radius scaled from export pixels to drawn pixels (at least 1 px). */
function scaledLegacy(legacy: LegacyOps, scale: number): LegacyOps {
    if (!legacy.blur || scale === 1) return legacy;
    return { ...legacy, blur: { ...legacy.blur, radius: Math.max(1, Math.round(legacy.blur.radius * scale)) } };
}

/**
 * Draws `source` through a clip's look (the looks renderer) into the 2D compositor at (x, y, w, h);
 * false when it cannot (no look, no renderer, or a GL failure), so the caller draws the raw frame.
 * `frameScale` is the preview's CSS pixels per export pixel at the 1080p reference (the legacy blur's radius is in
 * export pixels).
 */
export function drawClipThroughLook(
    ctx: Pick<CanvasRenderingContext2D, "drawImage">, renderer: LookRenderer | null, look: ClipLookFrame, source: TexImageSource,
    sourceW: number, sourceH: number, x: number, y: number, w: number, h: number, t: number, dpr: number, frameScale = 1,
): boolean {
    if (!renderer || (!look.plan && !look.mix && !look.legacy) || renderer.isLost || sourceW <= 0 || sourceH <= 0 || w < 1 || h < 1) return false;
    try {
        const width = Math.max(2, Math.round(Math.min(w * dpr, 1920)));
        const height = Math.max(2, Math.round(Math.min(h * dpr, 1920 * (h / w))));
        const uploaded = renderer.upload(source, sourceW, sourceH);
        const fitted = renderer.resize(uploaded, width, height);
        const graded = look.mix ? renderer.lutMix(fitted, look.mix.a, look.mix.b, look.mix.w) : fitted;
        const looked = look.plan ? renderer.look(graded, look.plan, Math.max(0, t)) : graded;
        const out = look.legacy ? renderer.legacy(looked, scaledLegacy(look.legacy, (width / w) * frameScale)) : looked;
        // The shared canvas only grows: draw the region this frame went into.
        const region = renderer.presentRegion(out, width, height);
        renderer.releaseAll();
        ctx.drawImage(renderer.canvas as CanvasImageSource, region.x, region.y, region.width, region.height, x, y, w, h);
        return true;
    } catch {
        renderer.releaseAll();
        return false;
    }
}
