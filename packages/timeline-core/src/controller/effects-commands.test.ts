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
    await controller.execute({ type: "clip.create", input: { trackType: "video", trackIndex: 2, startTime: 0, endTime: 4, mediaType: "video", mediaUrl: "a.mp4" } });
    await controller.execute({ type: "scene.add", input: { afterOrder: -1, cardType: "source_clip", sourceVideoUrl: "s.mp4", trackIndex: 1, timelinePositionSeconds: 0.001, duration: 3 } });
    const clipId = store.getState().timelineData!.clips[0].id;
    const sceneId = selectLiveScenes(store.getState())[0].id;
    return { local, store, controller, clipId, sceneId };
}

const clipRows = (store: ReturnType<typeof createEditorStore>, clipId: string) =>
    (store.getState().timelineData!.clips.find((c) => c.id === clipId)!.effects ?? []).map((e) => `${e.effectId}@${e.order}`);
const sceneRows = (store: ReturnType<typeof createEditorStore>, sceneId: string) =>
    (selectLiveScenes(store.getState()).find((s) => s.id === sceneId)!.effects ?? []).map((e) => `${e.effectId}@${e.order}`);

describe("effect stack commands", () => {
    it("adds rows with params at an index on clips, one undo step each", async () => {
        const { controller, store, clipId, local } = await setup();
        await controller.execute({ type: "clip.effect.add", clipId, effectId: "fx_blur" });
        await controller.execute({ type: "clip.effect.add", clipId, effectId: "fx_glitch", params: { amount: 0.3 }, index: 0 });
        expect(clipRows(store, clipId)).toEqual(["fx_glitch@0", "fx_blur@1"]);
        const persisted = (await local.loadTimeline("p1")).clips[0].effects!;
        expect(persisted.map((e) => e.effectId)).toEqual(["fx_glitch", "fx_blur"]);
        expect(persisted[0].paramsJson).toBe('{"amount":0.3}');
        await controller.execute({ type: "history.undo" });
        expect(clipRows(store, clipId)).toEqual(["fx_blur@0"]);
        await controller.execute({ type: "history.redo" });
        expect(clipRows(store, clipId)).toEqual(["fx_glitch@0", "fx_blur@1"]);
    });

    it("adds, reorders, updates, and removes rows on scenes, undoable", async () => {
        const { controller, store, sceneId, local } = await setup();
        await controller.execute({ type: "clip.effect.add", sceneId, effectId: "fx_sepia" });
        await controller.execute({ type: "clip.effect.add", sceneId, effectId: "fx_vhs" });
        expect(sceneRows(store, sceneId)).toEqual(["fx_sepia@0", "fx_vhs@1"]);
        const rows = selectLiveScenes(store.getState())[0].effects!;
        await controller.execute({ type: "clip.effect.reorder", sceneId, effectRowIds: [rows[1].id, rows[0].id] });
        expect(sceneRows(store, sceneId)).toEqual(["fx_vhs@0", "fx_sepia@1"]);
        await controller.execute({ type: "clip.effect.update", effectRowId: rows[0].id, patch: { enabled: false } });
        expect(selectLiveScenes(store.getState())[0].effects!.find((e) => e.id === rows[0].id)!.enabled).toBe(false);
        await controller.execute({ type: "clip.effect.remove", effectRowId: rows[1].id });
        expect(sceneRows(store, sceneId)).toEqual(["fx_sepia@0"]);
        expect((await local.loadScenes("p1"))[0].effects!.map((e) => e.effectId)).toEqual(["fx_sepia"]);
        await controller.execute({ type: "history.undo" });
        expect(sceneRows(store, sceneId)).toEqual(["fx_vhs@0", "fx_sepia@1"]);
        await controller.execute({ type: "history.undo", steps: 2 });
        expect(sceneRows(store, sceneId)).toEqual(["fx_sepia@0", "fx_vhs@1"]);
        expect((await local.loadScenes("p1"))[0].effects!.map((e) => e.effectId)).toEqual(["fx_sepia", "fx_vhs"]);
    });

    it("rejects a reorder that is not a permutation and unknown targets", async () => {
        const { controller, clipId } = await setup();
        await controller.execute({ type: "clip.effect.add", clipId, effectId: "fx_blur" });
        expect((await controller.execute({ type: "clip.effect.reorder", clipId, effectRowIds: ["nope"] })).ok).toBe(false);
        expect((await controller.execute({ type: "clip.effect.add", sceneId: "missing", effectId: "fx_blur" })).ok).toBe(false);
        expect((await controller.execute({ type: "clip.effect.remove", effectRowId: "missing" })).ok).toBe(false);
    });

    it("lists the built-in effects from the local backend", async () => {
        const { local } = await setup();
        const effects = await local.listEffects("effect");
        expect(effects.length).toBeGreaterThanOrEqual(20);
        expect(effects.some((e) => e.id === "fx_kaleidoscope" && e.ownerScope === "builtin")).toBe(true);
        expect(await local.listEffects("transition")).toEqual([]);
    });
});
