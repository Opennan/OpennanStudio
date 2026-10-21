import { describe, expect, it } from "vitest";
import { sceneEffectPseudoClips } from "./effect-layer-prep";

const row = (id: string, effectId: string, enabled = true) => ({ id, effectId, order: 0, paramsJson: null, enabled });

describe("sceneEffectPseudoClips", () => {
    it("spans each scene with its enabled rows, keeping only the rows `keep` accepts", () => {
        const scenes = [
            { id: "a", effects: [row("r1", "legacy_glow"), row("r2", "fx_blur"), row("r3", "legacy_off", false)] },
            { id: "b", effects: [row("r4", "fx_blur")] },
        ];
        const clips = sceneEffectPseudoClips(scenes, (s) => (s.id === "a" ? { start: 0, end: 2 } : { start: 2, end: 4 }), (effectId) => !effectId.startsWith("fx_"));
        expect(clips).toHaveLength(1);
        expect(clips[0]).toMatchObject({ id: "scene-effects-a", trackType: "effect", trackIndex: 0, startTime: 0, endTime: 2 });
        expect(clips[0].effects!.map((e) => e.effectId)).toEqual(["legacy_glow"]);
    });
});
