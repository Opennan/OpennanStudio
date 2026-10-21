import type { EffectDef } from "@opennan/timeline-core";
import { optimisticTimelineClipFromInput } from "@opennan/timeline-core/lib/timeline-optimistic";
import { collectGlLayers, hexToRgb, planGlPasses, toGlEffectSpec } from "./gl";
import type { ExportWarning } from "./types";

const def: EffectDef = {
    id: "tint", name: "Tint", kind: "effect", category: "Basic", glsl: "vec4 effect(sampler2D tex, vec2 uv){return texture2D(tex,uv);}",
    thumbnail: null, ownerScope: "builtin",
    params: [
        { key: "amount", label: "Amount", type: "slider", min: 0, max: 1, default: 0.5 },
        { key: "on", label: "On", type: "toggle", min: 0, max: 1, default: 0 },
        { key: "key", label: "Key", type: "color", min: 0, max: 0, default: 0 },
    ],
};

const effectClip = (id: string, start: number, end: number) =>
    optimisticTimelineClipFromInput({ trackType: "effect", trackIndex: 1, startTime: start, endTime: end }, "p", id);

describe("gl", () => {
    it("maps params like the preview", () => {
        expect(hexToRgb("#ff0000")).toEqual([1, 0, 0]);
        expect(toGlEffectSpec("tint", JSON.stringify({ amount: 0.2, on: true, key: "#00ff00" }), def)).toEqual({
            id: "tint", glsl: def.glsl, floatParams: { amount: 0.2, on: 1 }, keyColor: [0, 1, 0],
        });
        expect(toGlEffectSpec("tint", null, def).floatParams).toEqual({ amount: 0.5, on: 0 });
    });

    it("collects effect-track layers, warns on unknown effects (clip-attached ones are reported where clips compile)", () => {
        const a = { ...effectClip("e1", 1, 3), effects: [{ id: "r1", clipId: "e1", sceneId: null, effectId: "tint", order: 0, paramsJson: null, enabled: true, ownerScope: "project" }] };
        const b = { ...effectClip("e2", 2, 4), effects: [{ id: "r2", clipId: "e2", sceneId: null, effectId: "missing", order: 0, paramsJson: null, enabled: true, ownerScope: "project" }] };
        const v = { ...optimisticTimelineClipFromInput({ trackType: "video", trackIndex: 2 }, "p", "v1"), effects: a.effects };
        const warnings: ExportWarning[] = [];
        const layers = collectGlLayers([a, b, v], [], [def], warnings);
        expect(layers).toHaveLength(1);
        expect(warnings.map((w) => w.code)).toEqual(["gl-effect-unknown"]);
    });

    it("keeps legacy catalog effects on scenes as GL layers over the scene (built-in ones compile as looks)", () => {
        const row = (id: string, effectId: string) => ({ id, clipId: null, sceneId: "s", effectId, order: 0, paramsJson: null, enabled: true, ownerScope: "project" });
        const placed = [
            { scene: { id: "s", effects: [row("r1", "tint"), row("r2", "fx_blur")] }, start: 2, end: 5, trackIndex: 1, transition: "none", transitionDuration: 0 },
            { scene: { id: "t", effects: [row("r3", "fx_blur")] }, start: 5, end: 7, trackIndex: 1, transition: "none", transitionDuration: 0 },
        ] as unknown as Parameters<typeof collectGlLayers>[1];
        const warnings: ExportWarning[] = [];
        const layers = collectGlLayers([], placed, [def], warnings);
        expect(layers).toEqual([{ start: 2, end: 5, trackIndex: 0, effects: [toGlEffectSpec("tint", null, def)], sceneId: "s" }]);
        expect(warnings).toEqual([]);
    });

    it("splits passes at layer edges", () => {
        const spec = toGlEffectSpec("tint", null, def);
        const other = { ...spec, id: "other" };
        const passes = planGlPasses([
            { start: 1, end: 3, trackIndex: 1, effects: [spec] },
            { start: 2, end: 4, trackIndex: 2, effects: [other] },
        ], 5);
        expect(passes.map((p) => [p.start, p.end, p.effects.map((e) => e.id)])).toEqual([
            [1, 2, ["tint"]], [2, 3, ["tint", "other"]], [3, 4, ["other"]],
        ]);
    });
});
