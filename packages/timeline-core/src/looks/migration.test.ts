import { describe, expect, it } from "vitest";
import { LocalBackend } from "../backend/local-backend";
import { createMemoryPersistence, type LocalProjectState } from "../backend/persistence";
import { normalizeTimelineTransitionType } from "../lib/timeline-editing-navigation";
import { sceneJunctions } from "../lib/scene-transitions";
import { createEditorStore } from "../store/editor-store";
import { selectLiveScenes } from "../store/live-scenes";
import { TimelineController } from "../controller/timeline-controller";
import { itemLook } from "./look-plan";
import phase8 from "./__fixtures__/phase8-project.json";

async function open(persistence = createMemoryPersistence()) {
    const backend = new LocalBackend({ persistence });
    const store = createEditorStore();
    const controller = new TimelineController({ backend, store, projectId: "legacy", onToast: vi.fn() });
    await controller.load();
    return { backend, store, controller };
}

describe("phase 8 projects", () => {
    it("open unchanged and read their legacy looks and transitions", async () => {
        const persistence = createMemoryPersistence();
        await persistence.saveProject("legacy", structuredClone(phase8) as unknown as LocalProjectState);
        const { store } = await open(persistence);
        const clip = store.getState().timelineData!.clips[0];
        expect(clip.filterIntensity).toBeUndefined();
        const plan = itemLook({ kind: "clip", ...clip })!;
        expect(plan.steps.map((s) => s.kind)).toEqual(["lut"]);
        const scenes = selectLiveScenes(store.getState());
        expect(normalizeTimelineTransitionType(scenes[0].visualTransition!)).toBe("cross_dissolve");
        expect(sceneJunctions(scenes).map((j) => j.sceneId)).toEqual(["s1"]);
        expect(itemLook({ kind: "scene", ...scenes[1] })).toBeNull();
    });

    it("round-trip new look fields and effect stacks through persistence", async () => {
        const persistence = createMemoryPersistence();
        await persistence.saveProject("legacy", structuredClone(phase8) as unknown as LocalProjectState);
        const first = await open(persistence);
        await first.controller.execute({ type: "look.set", sceneId: "s1", filter: "vivid", intensity: 0.7, adjustments: { grain: 0.2 } });
        await first.controller.execute({ type: "clip.effect.add", sceneId: "s2", effectId: "fx_rgb_split", params: { amount: 0.4 } });
        await first.controller.execute({ type: "transition.set", sceneId: "s1", transition: "spin", duration: 0.9 });
        await first.controller.execute({ type: "look.set", clipId: "c1", intensity: 0.5, adjustments: { vignette: 0.3 } });
        const second = await open(persistence);
        const scenes = selectLiveScenes(second.store.getState());
        expect(scenes[0]).toMatchObject({ visualFilter: "vivid", filterIntensity: 0.7, adjustmentsJson: '{"grain":0.2}', visualTransition: "spin", visualTransitionDuration: 0.9 });
        expect(scenes[1].effects!.map((e) => [e.effectId, e.paramsJson])).toEqual([["fx_rgb_split", '{"amount":0.4}']]);
        expect(second.store.getState().timelineData!.clips[0]).toMatchObject({ visualFilter: "cinematic", filterIntensity: 0.5, adjustmentsJson: '{"vignette":0.3}', brightness: 0.1, contrast: 1.2 });
    });
});
