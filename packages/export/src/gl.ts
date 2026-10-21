// GL effects (GLSL stacks from the effect catalog) cannot be expressed as ffmpeg filters. The export
// renders the composite first, then runs the frames of each pass through a GlFrameProcessor (WebGL in a
// browser or Electron renderer) and overlays the processed frames back (node runner, two passes).
import type { ClipEffect, EffectDef, TimelineClip } from "@opennan/timeline-core";
import { isBuiltinEffect } from "@opennan/timeline-core/looks/effects";
import type { ExportWarning, GlEffectSpec, GlPass } from "./types";
import type { PlacedScene } from "./timeline-model";

export interface GlFrame {
    /** RGBA, width * height * 4 bytes, top row first. */
    data: Uint8Array;
    width: number;
    height: number;
    /** Timeline seconds (the shader's `time` uniform). */
    time: number;
}

export interface GlFrameProcessor {
    process(frame: GlFrame, effects: GlEffectSpec[]): Promise<Uint8Array>;
    dispose?(): void;
}

/** timeline-media effects/effect-renderer.ts hexToRgb */
export function hexToRgb(hex: unknown): [number, number, number] {
    if (typeof hex !== "string") return [0, 1, 0];
    const m = hex.replace(/^#/, "").replace(/^0x/i, "");
    const n = parseInt(m.length === 3 ? m.split("").map((c) => c + c).join("") : m, 16);
    if (Number.isNaN(n)) return [0, 1, 0];
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

function parseParams(json: string | null): Record<string, unknown> {
    if (!json) return {};
    try {
        const parsed = JSON.parse(json);
        return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
        return {};
    }
}

/** Same mapping as timeline-media effects/effect-layer-prep.ts toRenderEffect (:25-42). */
export function toGlEffectSpec(effectId: string, paramsJson: string | null, def: EffectDef): GlEffectSpec {
    const params = parseParams(paramsJson);
    const floatParams: Record<string, number> = {};
    let keyColor: [number, number, number] | undefined;
    for (const param of def.params) {
        const value = params[param.key];
        if (param.type === "color") keyColor = hexToRgb(value);
        else if (typeof value === "boolean") floatParams[param.key] = value ? 1 : 0;
        else floatParams[param.key] = typeof value === "number" ? value : param.default;
    }
    return keyColor ? { id: effectId, glsl: def.glsl, floatParams, keyColor } : { id: effectId, glsl: def.glsl, floatParams };
}

export interface GlLayer {
    start: number;
    end: number;
    trackIndex: number;
    effects: GlEffectSpec[];
    clipId?: string;
    sceneId?: string;
}

type EffectRow = Pick<ClipEffect, "effectId" | "order" | "paramsJson" | "enabled">;

function stack(rows: EffectRow[] | null | undefined, defs: Map<string, EffectDef>, warnings: ExportWarning[], owner: { clipId?: string; sceneId?: string }): GlEffectSpec[] {
    const specs: GlEffectSpec[] = [];
    // Built-in looks effects compile to ffmpeg filters (compile/effect-spans.ts, looks/look-filters.ts), never to GL passes.
    for (const row of [...(rows ?? [])].filter((r) => r.enabled && !isBuiltinEffect(r.effectId)).sort((a, b) => a.order - b.order)) {
        const def = defs.get(row.effectId);
        if (!def) {
            warnings.push({ code: "gl-effect-unknown", message: `Effect "${row.effectId}" is not in the effect catalog; it is skipped.`, effectId: row.effectId, ...owner });
            continue;
        }
        specs.push(toGlEffectSpec(row.effectId, row.paramsJson, def));
    }
    return specs;
}

/**
 * GL layers for legacy catalog effects (GLSL from a cloud catalog) on effect-track clips and on scenes
 * (over each scene's range, as the preview's pseudo-clips: effect-layer-prep.ts sceneEffectPseudoClips).
 * Built-in effects on any clip, scene, or effect-track span compile to ffmpeg filters instead; legacy
 * effects on media clips are reported where those clips compile (compile/overlays.ts).
 */
export function collectGlLayers(clips: TimelineClip[], placed: PlacedScene[], catalog: EffectDef[], warnings: ExportWarning[]): GlLayer[] {
    const defs = new Map(catalog.filter((def) => def.kind === "effect").map((def) => [def.id, def]));
    const layers: GlLayer[] = [];
    for (const clip of clips) {
        if (clip.trackType !== "effect") continue;
        const effects = stack(clip.effects, defs, warnings, { clipId: clip.id });
        if (effects.length) layers.push({ start: clip.startTime, end: clip.endTime, trackIndex: clip.trackIndex, effects, clipId: clip.id });
    }
    for (const p of placed) {
        const rows = (p.scene as typeof p.scene & { effects?: EffectRow[] | null }).effects;
        const effects = stack(rows, defs, warnings, { sceneId: p.scene.id });
        if (effects.length && p.end > p.start) layers.push({ start: p.start, end: p.end, trackIndex: 0, effects, sceneId: p.scene.id });
    }
    return layers.sort((a, b) => a.trackIndex - b.trackIndex || a.start - b.start);
}

/** Splits time at every layer edge; each span runs the active stacks in layer order (preview-panel.tsx:1433-1442). */
export function planGlPasses(layers: GlLayer[], duration: number): GlPass[] {
    const edges = [...new Set([0, duration, ...layers.flatMap((l) => [l.start, l.end])])]
        .filter((t) => t >= 0 && t <= duration)
        .sort((a, b) => a - b);
    const passes: GlPass[] = [];
    for (let i = 0; i < edges.length - 1; i += 1) {
        const start = edges[i];
        const end = edges[i + 1];
        const mid = (start + end) / 2;
        const effects = layers.filter((l) => mid >= l.start && mid < l.end).flatMap((l) => l.effects);
        if (effects.length === 0) continue;
        const last = passes[passes.length - 1];
        if (last && last.end === start && JSON.stringify(last.effects) === JSON.stringify(effects)) last.end = end;
        else passes.push({ start, end, effects });
    }
    return passes;
}
