// GL effect catalog and stack types. Copied from opennan frontend lib/effects-api.ts:8-46
// (the GraphQL client stays in provider-opennan).
import type { ClipEffect } from "./timeline";

/** Local-only effect row for instant preview before the addClipEffect mutation returns. */
export function buildOptimisticClipEffect(clipId: string, effectId: string, order = 0): ClipEffect {
    return {
        id: `temp-effect-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        clipId,
        sceneId: null,
        effectId,
        order,
        paramsJson: null,
        enabled: true,
        ownerScope: "project",
    };
}

export interface EffectParam {
    key: string;
    label: string;
    type: "slider" | "color" | "toggle";
    min: number;
    max: number;
    default: number;
}

export interface EffectDef {
    id: string;
    name: string;
    kind: "effect" | "transition";
    category: string;
    params: EffectParam[];
    glsl: string;
    thumbnail: string | null;
    ownerScope: string;
}

/** Which object an effect stack is attached to. Exactly one id is set. */
export interface EffectTarget {
    clipId?: string | null;
    sceneId?: string | null;
}
