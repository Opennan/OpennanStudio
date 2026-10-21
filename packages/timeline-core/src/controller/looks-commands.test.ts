import { LocalBackend } from "../backend/local-backend";
import { createMemoryPersistence } from "../backend/persistence";
import { createEditorStore } from "../store/editor-store";
import { selectLiveScenes } from "../store/live-scenes";
import { TimelineController } from "./timeline-controller";

async function setup() {
    let n = 0;
    const local = new LocalBackend({ persistence: createMemoryPersistence(), idFactory: () => `id-${++n}` });
    const store = createEditorStore();
    const controller = new TimelineController({ backend: local, store, projectId: "p1", onToast: vi.fn() });
    await controller.load();
    const add = (at: number, duration: number, order: number) => controller.execute({
        type: "scene.add", input: { afterOrder: order, cardType: "source_clip", sourceVideoUrl: "s.mp4", trackIndex: 1, timelinePositionSeconds: at, duration },
    });
    await add(0.001, 4, -1);
    await add(4.001, 3, 0);
    await add(7.001, 1, 1);
    await controller.execute({ type: "clip.create", input: { trackType: "video", trackIndex: 2, startTime: 0, endTime: 4, mediaType: "video", mediaUrl: "a.mp4" } });
    const scenes = () => selectLiveScenes(store.getState());
    return { local, store, controller, scenes };
}

describe("transition and look commands", () => {
    it("sets a transition on a scene cut with the default or a clamped duration, and removes it", async () => {
        const { controller, scenes, local } = await setup();
        const [a, b] = scenes();
        expect((await controller.execute({ type: "transition.set", sceneId: a.id, transition: "spin" })).ok).toBe(true);
        expect(scenes()[0]).toMatchObject({ visualTransition: "spin", visualTransitionDuration: 0.6 });
        await controller.execute({ type: "transition.set", sceneId: b.id, transition: "wipeleft", duration: 5 });
        expect(scenes()[1]).toMatchObject({ visualTransition: "wipe_left", visualTransitionDuration: 1 });
        await controller.execute({ type: "transition.set", sceneId: a.id, transition: "none" });
        expect(scenes()[0]).toMatchObject({ visualTransition: "none", visualTransitionDuration: 0 });
        expect((await local.loadScenes("p1"))[1].visualTransition).toBe("wipe_left");
        const last = scenes()[2];
        expect((await controller.execute({ type: "transition.set", sceneId: last.id, transition: "spin" })).ok).toBe(false);
    });

    it("removes a stale transition from a scene that no longer has a next scene", async () => {
        const { controller, scenes } = await setup();
        const last = scenes()[2];
        await controller.execute({ type: "scene.update", sceneId: last.id, patch: { visualTransition: "spin", visualTransitionDuration: 0.5 } });
        expect((await controller.execute({ type: "transition.set", sceneId: last.id, transition: "none" })).ok).toBe(true);
        expect(scenes()[2]).toMatchObject({ visualTransition: "none", visualTransitionDuration: 0 });
    });

    it("a reset right after a slider drag wins over the drag's debounced save", async () => {
        const { controller, scenes, local } = await setup();
        const sceneId = scenes()[0].id;
        const drag = controller.execute({ type: "look.set", sceneId, adjustments: { exposure: 0.4 } }, { coalesceKey: "adjust-exposure", debounceMs: 120 });
        const reset = controller.execute({ type: "look.set", sceneId, adjustments: null });
        await Promise.all([drag, reset]);
        expect((await local.loadScenes("p1"))[0].adjustmentsJson ?? null).toBeNull();
        expect(scenes()[0].adjustmentsJson ?? null).toBeNull();
    });

    it("applies one transition to every cut in one undo step", async () => {
        const { controller, scenes } = await setup();
        await controller.execute({ type: "transition.applyAll", transition: "cross_dissolve", duration: 0.8 });
        expect(scenes().map((s) => `${s.visualTransition ?? "none"}:${s.visualTransitionDuration ?? 0}`)).toEqual(["cross_dissolve:0.8", "cross_dissolve:0.8", "none:0"]);
        await controller.execute({ type: "history.undo" });
        expect(scenes().map((s) => s.visualTransition || "none")).toEqual(["none", "none", "none"]);
    });

    it("applies to every cut as one backend undo step, even past the backend's history limit", async () => {
        let n = 0;
        const local = new LocalBackend({ persistence: createMemoryPersistence(), idFactory: () => `id-${++n}`, historyLimit: 3 });
        const store = createEditorStore();
        const controller = new TimelineController({ backend: local, store, projectId: "p1", onToast: vi.fn() });
        await controller.load();
        for (let i = 0; i < 6; i += 1) {
            await controller.execute({ type: "scene.add", input: { afterOrder: i - 1, cardType: "source_clip", sourceVideoUrl: "s.mp4", trackIndex: 1, timelinePositionSeconds: i * 2 + 0.001, duration: 2 } });
        }
        await controller.execute({ type: "look.set", sceneId: selectLiveScenes(store.getState())[0].id, filter: "noir" });
        expect((await controller.execute({ type: "transition.applyAll", transition: "cross_dissolve", duration: 0.5 })).ok).toBe(true);
        expect((await local.loadScenes("p1")).filter((s) => s.visualTransition === "cross_dissolve")).toHaveLength(5);
        expect((await controller.execute({ type: "history.undo" })).ok).toBe(true);
        expect((await local.loadScenes("p1")).map((s) => s.visualTransition || "none")).toEqual(Array(6).fill("none"));
        expect(selectLiveScenes(store.getState()).map((s) => s.visualTransition || "none")).toEqual(Array(6).fill("none"));
        // The entry before it still has its backend step.
        expect((await controller.execute({ type: "history.undo" })).ok).toBe(true);
        expect((await local.loadScenes("p1"))[0].visualFilter ?? "none").toBe("none");
    });

    it("sets filter, intensity, and adjustments on scenes and clips, undoable", async () => {
        const { controller, scenes, store, local } = await setup();
        const sceneId = scenes()[0].id;
        await controller.execute({ type: "look.set", sceneId, filter: "Teal_Orange", intensity: 0.65 });
        await controller.execute({ type: "look.set", sceneId, adjustments: { exposure: 0.3, vignette: 0.5, contrast: -0.2 } });
        expect(scenes()[0]).toMatchObject({ visualFilter: "teal_orange", filterIntensity: 0.65 });
        expect(JSON.parse(scenes()[0].adjustmentsJson!)).toEqual({ contrast: -0.2, exposure: 0.3, vignette: 0.5 });
        await controller.execute({ type: "look.set", sceneId, adjustments: { exposure: null } });
        expect(JSON.parse(scenes()[0].adjustmentsJson!)).toEqual({ contrast: -0.2, vignette: 0.5 });
        await controller.execute({ type: "look.set", sceneId, adjustments: null });
        expect(scenes()[0].adjustmentsJson).toBeNull();
        await controller.execute({ type: "history.undo" });
        expect(JSON.parse(scenes()[0].adjustmentsJson!)).toEqual({ contrast: -0.2, vignette: 0.5 });

        const clipId = store.getState().timelineData!.clips[0].id;
        await controller.execute({ type: "look.set", clipId, filter: "noir", adjustments: { contrast: 0.5, saturation: -1, grain: 0.4 } });
        const clip = store.getState().timelineData!.clips[0];
        expect(clip).toMatchObject({ visualFilter: "noir", contrast: 1.5, saturation: 0, brightness: 0 });
        expect(JSON.parse(clip.adjustmentsJson!)).toEqual({ grain: 0.4 });
        expect((await local.loadTimeline("p1")).clips[0].visualFilter).toBe("noir");
        expect((await controller.execute({ type: "look.set", clipId })).ok).toBe(false);
    });

    describe("transitions on upper-track clip cuts", () => {
        async function clips() {
            const ctx = await setup();
            const create = (startTime: number, endTime: number, patch: Record<string, unknown> = {}) => ctx.controller.execute({
                type: "clip.create", input: { trackType: "video", trackIndex: 2, startTime, endTime, mediaType: "video", mediaUrl: "b.mp4", ...patch },
            });
            await create(4.04, 5.5, { fadeInDuration: 0.3 });
            await create(6, 8);
            const all = () => ctx.store.getState().timelineData!.clips.slice().sort((x, y) => x.startTime - y.startTime);
            return { ...ctx, all };
        }

        it("accepts any library transition when the next clip touches within the editor's cut tolerance; the window owns the cut, fades stay", async () => {
            const { controller, all } = await clips();
            const [a, b] = all();
            await controller.execute({ type: "clip.update", clipIds: [a.id], patch: { fadeInDuration: 0.7, fadeOutDuration: 0.2 } });
            expect((await controller.execute({ type: "transition.set", clipId: a.id, transition: "wipe_left", duration: 5 })).ok).toBe(true);
            // Clamped to 2 s and each neighbour's length (b is 1.46 s); the user's fades are untouched.
            expect(all()[0]).toMatchObject({ transitionType: "wipe_left", transitionDuration: 1.46, fadeInDuration: 0.7, fadeOutDuration: 0.2 });
            expect(all()[1].fadeInDuration).toBe(0.3);
            await controller.execute({ type: "history.undo" });
            expect(all()[0]).toMatchObject({ transitionType: "none", fadeInDuration: 0.7, fadeOutDuration: 0.2 });
            // b's next clip is 0.5 s away: no cut there.
            expect((await controller.execute({ type: "transition.set", clipId: b.id, transition: "spin" })).ok).toBe(false);
        });

        it("replacing a legacy fade preset clears the fades that preset wrote, and removing the transition keeps user fades", async () => {
            const { controller, all } = await clips();
            const a = all()[0];
            await controller.execute({ type: "clip.update", clipIds: [a.id], patch: { transitionType: "cross_dissolve", transitionDuration: 0.5, fadeInDuration: 0.5, fadeOutDuration: 0.5 } });
            await controller.execute({ type: "transition.set", clipId: a.id, transition: "push_left" });
            expect(all()[0]).toMatchObject({ transitionType: "push_left", transitionDuration: 0.5, fadeInDuration: 0, fadeOutDuration: 0 });
            await controller.execute({ type: "clip.update", clipIds: [a.id], patch: { fadeInDuration: 0.25 } });
            await controller.execute({ type: "transition.set", clipId: a.id, transition: "none" });
            expect(all()[0]).toMatchObject({ transitionType: "none", transitionDuration: 0, fadeInDuration: 0.25, fadeOutDuration: 0 });
        });
    });
});
