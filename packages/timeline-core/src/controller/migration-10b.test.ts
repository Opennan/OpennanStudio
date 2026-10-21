// Phase 10b projects open unchanged in 10c: no masks appear, single selection behaves as before, looks and motion plan
// the same, and the 10c fields (masks, multi-selection, retimed keyframes, pasted attributes) round-trip.
import { describe, expect, it } from "vitest";
import { LocalBackend } from "../backend/local-backend";
import { createMemoryPersistence, type LocalProjectState } from "../backend/persistence";
import { parseTimelineKeyframes } from "../lib/timeline-editing-properties";
import { itemLook } from "../looks/look-plan";
import { parseMask } from "../looks/masks";
import { itemMotion, motionAt } from "../motion/transform";
import { createEditorStore } from "../store/editor-store";
import { selectLiveScenes } from "../store/live-scenes";
import { TimelineController } from "./timeline-controller";
import phase10b from "./__fixtures__/phase10b-project.json";

async function seeded() {
    const persistence = createMemoryPersistence();
    await persistence.saveProject("legacy10b", structuredClone(phase10b) as unknown as LocalProjectState);
    return persistence;
}

async function open(persistence: ReturnType<typeof createMemoryPersistence>) {
    const backend = new LocalBackend({ persistence });
    const store = createEditorStore();
    const controller = new TimelineController({ backend, store, projectId: "legacy10b", onToast: vi.fn() });
    await controller.load();
    return { store, controller };
}

describe("phase 10b projects in 10c", () => {
    it("open without masks, with the same looks and motion, and an empty multi-selection", async () => {
        const { store } = await open(await seeded());
        const state = store.getState();
        const clips = state.timelineData!.clips;
        const scene = selectLiveScenes(state)[0];
        for (const item of [...clips, scene]) expect((item as { maskJson?: unknown }).maskJson ?? null).toBeNull();
        const sceneLook = itemLook({ kind: "scene", ...scene })!;
        expect(sceneLook.steps.map((s) => s.kind)).not.toContain("mask");
        expect(sceneLook.steps.at(-1)?.kind).toBe("pass");
        const warm = clips.find((c) => c.visualFilter === "warm")!;
        expect(itemLook({ kind: "clip", ...warm })!.steps.map((s) => s.kind)).toEqual(["lut"]);
        // Eased opacity keyframe (ease out from 0 to 1 over 1 s) under the zoom-in: unchanged motion.
        const motion = itemMotion({ kind: "clip", clip: clips[0] });
        expect(motionAt(motion, 0).opacity).toBeCloseTo(0, 6);
        expect(motionAt(motion, 1).opacity).toBeGreaterThan(0.99);
        expect(state.selectedSceneIds.size).toBe(0);
        expect(state.selectedKeyframe ?? null).toBeNull();
    });

    it("round-trip a mask, a retimed keyframe, and pasted attributes through persistence, each one undo step", async () => {
        const persistence = await seeded();
        const first = await open(persistence);
        const scene = selectLiveScenes(first.store.getState())[0];
        expect((await first.controller.execute({ type: "mask.set", sceneId: scene.id, mask: { shape: "heart", width: 0.6, height: 0.6, feather: 0.1 } })).ok).toBe(true);
        expect((await first.controller.execute({ type: "keyframe.retime", clipId: "c1", from: 1, to: 0.8 })).ok).toBe(true);
        const before = selectLiveScenes(first.store.getState())[0].visualFilter ?? null;
        expect((await first.controller.execute({ type: "attributes.paste", source: { clipId: "c3" }, targets: [{ sceneId: scene.id }], attributes: ["filter", "adjust"] })).ok).toBe(true);
        // One undo step takes the paste back; redo puts it again.
        await first.controller.execute({ type: "history.undo" });
        expect(selectLiveScenes(first.store.getState())[0].visualFilter ?? null).toBe(before);
        await first.controller.execute({ type: "history.redo" });
        expect(selectLiveScenes(first.store.getState())[0].visualFilter).toBe("warm");

        const second = await open(persistence);
        const reopened = selectLiveScenes(second.store.getState())[0];
        expect(parseMask(reopened.maskJson)).toMatchObject({ shape: "heart", width: 0.6, feather: 0.1 });
        expect(reopened).toMatchObject({ visualFilter: "warm" });
        const c1 = second.store.getState().timelineData!.clips.find((c) => c.id === "c1")!;
        expect(parseTimelineKeyframes(c1.keyframesJson).map((p) => p.time)).toEqual([0, 0.8]);
        expect(itemLook({ kind: "scene", ...reopened })!.steps.at(-1)?.kind).toBe("mask");

    });
});
