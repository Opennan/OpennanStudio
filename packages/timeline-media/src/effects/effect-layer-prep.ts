// Shared mapping from effect-track timeline clips to renderable GLSL effect
// stacks. Used by the ScenePreview effect overlay (footage-only pass) and the
// preview-panel compositor (full-composite pass when overlays are visible).

import { hexToRgb, type RenderEffect } from "./effect-renderer";
import type { EffectDef } from "@opennan/timeline-core/model/effects";
import type { TimelineClip, TimelineTrack } from "@opennan/timeline-core/model/timeline";

export type PreparedEffectLayer = {
    startTime: number;
    endTime: number;
    trackIndex: number;
    renderEffects: RenderEffect[];
};

function parseParams(json: string | null): Record<string, number | string> {
    if (!json) return {};
    try {
        return JSON.parse(json) ?? {};
    } catch {
        return {};
    }
}

export function toRenderEffect(
    effectId: string,
    paramsJson: string | null,
    defsById: Map<string, EffectDef>,
): RenderEffect | null {
    const def = defsById.get(effectId);
    if (!def) return null;
    const params = parseParams(paramsJson);
    const floatParams: Record<string, number> = {};
    let keyColor: [number, number, number] | undefined;
    for (const p of def.params) {
        if (p.type === "color") keyColor = hexToRgb(params[p.key] as string);
        // Toggles persist as JSON booleans; the shader only ever sees floats.
        else if (typeof params[p.key] === "boolean") floatParams[p.key] = params[p.key] ? 1 : 0;
        else floatParams[p.key] = typeof params[p.key] === "number" ? (params[p.key] as number) : p.default;
    }
    return { id: def.id, glsl: def.glsl, floatParams, keyColor };
}

export function isEffectTrackVisible(index: number, tracks?: TimelineTrack[]): boolean {
    const track = (tracks || []).find((t) => t.type === "effect" && t.index === index);
    return !track || track.visible !== false;
}

export type SceneEffectEntry = {
    id: string;
    effectId: string;
    order: number;
    paramsJson: string | null;
    enabled: boolean;
};

export type SceneEffectSource = {
    id: string;
    effects?: SceneEffectEntry[] | null;
};

/** Scene-attached effect stacks (clip_effects.scene_id rows, written by
 *  apply_visual_effect / the Effects tab) → pseudo effect-track clips spanning
 *  the scene's timeline range, so both preview passes reuse the clip pipeline.
 *  trackIndex 0 never collides with a real effect track (they start at 1). */
export function sceneEffectPseudoClips<S extends SceneEffectSource>(
    scenes: S[],
    resolveRange: (scene: S) => { start: number; end: number },
    /** Which effects to keep (e.g. legacy catalog effects only; built-in ones run as the scene's look). */
    keep: (effectId: string) => boolean = () => true,
): TimelineClip[] {
    const out: TimelineClip[] = [];
    for (const scene of scenes) {
        const effects = (scene.effects ?? []).filter((e) => e.enabled && keep(e.effectId));
        if (!effects.length) continue;
        const { start, end } = resolveRange(scene);
        if (!(end > start)) continue;
        out.push({
            id: `scene-effects-${scene.id}`,
            trackType: "effect",
            trackIndex: 0,
            startTime: start,
            endTime: end,
            effects,
        } as unknown as TimelineClip);
    }
    return out;
}

/** Effect-track clips → ordered renderable layers (hidden tracks excluded). */
export function prepareEffectLayers(
    clips: TimelineClip[],
    defsById: Map<string, EffectDef>,
    tracks?: TimelineTrack[],
): PreparedEffectLayer[] {
    const layers: PreparedEffectLayer[] = [];
    for (const clip of clips) {
        if (clip.trackType !== "effect" || !isEffectTrackVisible(clip.trackIndex, tracks)) continue;
        const renderEffects = [...(clip.effects ?? [])]
            .filter((effect) => effect.enabled)
            .sort((a, b) => a.order - b.order)
            .map((effect) => toRenderEffect(effect.effectId, effect.paramsJson, defsById))
            .filter(Boolean) as RenderEffect[];
        if (renderEffects.length === 0) continue;
        layers.push({
            startTime: clip.startTime,
            endTime: clip.endTime,
            trackIndex: clip.trackIndex,
            renderEffects,
        });
    }
    return layers.sort((a, b) => a.trackIndex - b.trackIndex || a.startTime - b.startTime);
}
