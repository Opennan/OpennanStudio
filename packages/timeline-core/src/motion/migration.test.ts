// Phase 10a projects open unchanged in 10b: legacy speed ramps, motion presets, linear keyframes, fades,
// and emoji stickers plan the same timing, and the new fields round-trip through persistence.
import { describe, expect, it } from "vitest";
import { LocalBackend } from "../backend/local-backend";
import { createMemoryPersistence, type LocalProjectState } from "../backend/persistence";
import { createEditorStore } from "../store/editor-store";
import { selectLiveScenes } from "../store/live-scenes";
import { TimelineController } from "../controller/timeline-controller";
import { clipTransitionChains } from "../looks/windows";
import { parseAnimationSpec } from "./animation-spec";
import { clipSpeedProfile, LEGACY_RAMP_CURVES, sourceSpan } from "./speed";
import { itemMotion, motionAt } from "./transform";
import phase10a from "./__fixtures__/phase10a-project.json";

async function open(persistence: ReturnType<typeof createMemoryPersistence>) {
    const backend = new LocalBackend({ persistence });
    const store = createEditorStore();
    const controller = new TimelineController({ backend, store, projectId: "legacy10a", onToast: vi.fn() });
    await controller.load();
    return { backend, store, controller };
}

async function seeded() {
    const persistence = createMemoryPersistence();
    await persistence.saveProject("legacy10a", structuredClone(phase10a) as unknown as LocalProjectState);
    return persistence;
}

describe("phase 10a projects", () => {
    it("open with legacy speed, motion, keyframes, and fades read the old way", async () => {
        const { store } = await open(await seeded());
        const [clip, sticker] = store.getState().timelineData!.clips;
        expect(clip.animationJson).toBeUndefined();
        expect(clip.speedCurveJson).toBeUndefined();
        const profile = clipSpeedProfile(clip);
        expect(profile.curve?.points).toEqual(LEGACY_RAMP_CURVES.hero.points);
        // hero: 0.35·0.45 + 0.30·1.35 + 0.35·0.65 = 0.79 source seconds per timeline second (10a ramp table).
        expect(sourceSpan(profile, 2)).toBeCloseTo(1.58, 9);
        const motion = itemMotion({ kind: "clip", clip });
        expect(motion.animated).toBe(true);
        // Linear keyframes interpolate as before: halfway, opacity 0.75 (times the fade-in, done by 0.5 s).
        expect(motionAt(motion, 1).opacity).toBeCloseTo(0.75, 6);
        expect(motionAt(motion, 0).opacity).toBeCloseTo(0, 6);
        expect(sticker.stickerId).toBeUndefined();
        expect(sticker.textContent).toBe("🔥");
        expect(itemMotion({ kind: "clip", clip: sticker }).animated).toBe(false);
    });

    it("keep a 10a transition preset on touching V2 clips as per-clip fades, not a clip-cut window", async () => {
        // getTimelineTransitionPresetUpdate wrote cross_dissolve with fadeIn = fadeOut = transitionDuration on c3;
        // 10a rendered that as c3 fading in and out over V1, which both the export and the preview keep.
        const { store } = await open(await seeded());
        const clips = store.getState().timelineData!.clips;
        const c3 = clips.find((c) => c.id === "c3")!;
        expect(c3).toMatchObject({ trackIndex: 2, transitionType: "cross_dissolve", transitionDuration: 0.5, fadeInDuration: 0.5, fadeOutDuration: 0.5 });
        expect(clipTransitionChains(clips)).toEqual([]);
        const motion = itemMotion({ kind: "clip", clip: c3 });
        expect(motionAt(motion, 0).opacity).toBeCloseTo(0, 6);
        expect(motionAt(motion, 0.25).opacity).toBeCloseTo(0.5, 6);
        expect(motionAt(motion, 0.5).opacity).toBeCloseTo(1, 6);
        expect(motionAt(motion, 0.75).opacity).toBeCloseTo(0.5, 6);
    });

    it("round-trip animations, keyframe easing, speed, stickers, and scene motion", async () => {
        const persistence = await seeded();
        const first = await open(persistence);
        const scene = selectLiveScenes(first.store.getState())[0];
        expect((await first.controller.execute({ type: "animation.set", clipId: "c1", slot: "in", animationId: "zoom_in", duration: 0.6 })).ok).toBe(true);
        await first.controller.execute({ type: "keyframe.easing", clipId: "c1", time: 0, easing: "ease_out" });
        await first.controller.execute({ type: "speed.set", clipId: "c1", speed: 2, curve: null, preservePitch: false });
        await first.controller.execute({ type: "clip.update", clipIds: ["c2"], patch: { stickerId: "twemoji:1f525", textContent: null } });
        await first.controller.execute({ type: "keyframe.set", sceneId: scene.id, time: 0, values: { scale: 1.2 }, easing: "hold" });
        await first.controller.execute({ type: "animation.set", sceneId: scene.id, slot: "out", animationId: "fade_out" });
        await first.controller.execute({ type: "speed.set", sceneId: scene.id, speed: 1.5 });

        const second = await open(persistence);
        const [clip, sticker] = second.store.getState().timelineData!.clips;
        expect(parseAnimationSpec(clip.animationJson).in).toEqual({ id: "zoom_in", duration: 0.6 });
        expect(clip).toMatchObject({ playbackSpeed: 2, speedRamp: "none", preservePitch: false });
        expect(clip.speedCurveJson ?? null).toBeNull();
        expect(JSON.parse(clip.keyframesJson!).keyframes[0].easing).toBe(2);
        expect(sticker.stickerId).toBe("twemoji:1f525");
        const reopened = selectLiveScenes(second.store.getState())[0];
        expect(reopened).toMatchObject({ playbackSpeed: 1.5 });
        expect(JSON.parse(reopened.keyframesJson!).keyframes[0]).toMatchObject({ scale: 1.2, easing: 4 });
        expect(parseAnimationSpec(reopened.animationJson).out?.id).toBe("fade_out");
    });
});
