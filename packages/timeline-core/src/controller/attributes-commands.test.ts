import { LocalBackend } from "../backend/local-backend";
import { createMemoryPersistence } from "../backend/persistence";
import type { TimelineBackend } from "../backend/types";
import { snapshotAttributes, type AttributePasteReport } from "../attributes/attributes";
import { parseTimelineKeyframes } from "../lib/timeline-editing-properties";
import { createEditorStore } from "../store/editor-store";
import { selectLiveScenes } from "../store/live-scenes";
import { TimelineController } from "./timeline-controller";

const STYLE = {
    visualFilter: "warm", filterIntensity: 0.6, brightness: 0.2, contrast: 1.3, saturation: 0.8,
    adjustmentsJson: JSON.stringify({ exposure: 0.25 }),
    animationJson: JSON.stringify({ in: { id: "fade_in", duration: 0.8 } }),
    keyframesJson: JSON.stringify({ keyframes: [{ time: 0, adj_exposure: 0 }, { time: 1, adj_exposure: 0.5 }] }),
};

async function setup(backendFor: (local: LocalBackend) => TimelineBackend = (local) => local) {
    let n = 0;
    const local = new LocalBackend({ persistence: createMemoryPersistence(), idFactory: () => `id-${++n}` });
    const store = createEditorStore();
    const onToast = vi.fn();
    const controller = new TimelineController({ backend: backendFor(local), store, projectId: "p1", onToast });
    await controller.load();
    const video = (startTime: number, endTime: number, extra: Record<string, unknown> = {}) => ({ trackType: "video", trackIndex: 2, startTime, endTime, mediaType: "video", mediaUrl: "a.mp4", ...extra });
    await controller.execute({ type: "clip.create", input: [video(0, 4, STYLE), video(5, 9), video(10, 14), video(14, 16)] });
    await controller.execute({ type: "scene.add", input: { afterOrder: -1, cardType: "source_clip", sourceVideoUrl: "s.mp4", trackIndex: 1, timelinePositionSeconds: 0.001, duration: 4 } });
    await controller.execute({ type: "scene.add", input: { afterOrder: 0, cardType: "source_clip", sourceVideoUrl: "s.mp4", trackIndex: 1, timelinePositionSeconds: 4.001, duration: 2 } });
    const [a, b, c, d] = store.getState().timelineData!.clips.map((clip) => clip.id);
    const [s1, s2] = selectLiveScenes(store.getState()).map((scene) => scene.id);
    if (controller.capabilities.clipEffects) {
        await controller.execute({ type: "clip.effect.add", clipId: a, effectId: "fx_blur", params: { amount: 0.3 } });
        await controller.execute({ type: "clip.effect.add", clipId: a, effectId: "fx_pixelate" });
        const pixelate = store.getState().timelineData!.clips[0].effects!.find((e) => e.effectId === "fx_pixelate")!;
        await controller.execute({ type: "clip.effect.update", effectRowId: pixelate.id, patch: { enabled: false } });
        await controller.execute({ type: "clip.effect.add", clipId: c, effectId: "fx_zoom_blur" });
    } else {
        // A seeded stack the backend cannot edit.
        await local.updateClips("p1", [{ clipId: a, effects: [{ id: "row", clipId: a, sceneId: null, effectId: "fx_blur", order: 0, paramsJson: null, enabled: true, ownerScope: "project" }] }]);
        await controller.refresh();
    }
    await controller.execute({ type: "speed.set", clipId: a, speed: 2 });
    const clipOf = (id: string) => store.getState().timelineData!.clips.find((clip) => clip.id === id)!;
    const sceneOf = (id: string) => selectLiveScenes(store.getState()).find((scene) => scene.id === id)!;
    const rows = (owner: { effects?: Array<{ effectId: string; enabled: boolean; paramsJson: string | null }> | null }) => (owner.effects ?? []).map((e) => `${e.effectId}${e.enabled ? "" : "(off)"}${e.paramsJson ? e.paramsJson : ""}`);
    return { local, store, controller, onToast, ids: { a, b, c, d, s1, s2 }, clipOf, sceneOf, rows };
}

const strip = <T,>(value: T) => JSON.parse(JSON.stringify(value)) as T;

describe("attributes.paste", () => {
    it("pastes onto several clips in one undo step, with fresh effect rows owned by each target", async () => {
        const { controller, store, local, ids, clipOf, rows } = await setup();
        const before = controller.historyDepth().undo;
        const backendBefore = await local.loadTimeline("p1");
        const result = await controller.execute({
            type: "attributes.paste", source: { clipId: ids.a }, targets: [{ clipId: ids.b }, { clipId: ids.c }], attributes: ["filter", "adjust", "effects", "animation", "speed"],
        });
        expect(result.ok).toBe(true);
        expect((result.output as AttributePasteReport).applied).toEqual([
            { clipId: ids.b, kinds: ["filter", "adjust", "effects", "animation", "speed"] },
            { clipId: ids.c, kinds: ["filter", "adjust", "effects", "animation", "speed"] },
        ]);
        expect(controller.historyDepth().undo).toBe(before + 1);
        for (const id of [ids.b, ids.c]) {
            const clip = clipOf(id);
            expect(clip).toMatchObject({ visualFilter: "warm", filterIntensity: 0.6, brightness: 0.2, contrast: 1.3, saturation: 0.8, playbackSpeed: 2, animationJson: STYLE.animationJson });
            expect(clip.endTime - clip.startTime).toBeCloseTo(2, 6);
            expect(rows(clip)).toEqual(["fx_blur{\"amount\":0.3}", "fx_pixelate(off)"]);
            expect(clip.effects!.every((e) => e.clipId === id && !e.id.startsWith("temp-"))).toBe(true);
            expect(parseTimelineKeyframes(clip.keyframesJson)).toEqual([{ time: 0, adj_exposure: 0 }, { time: 0.5, adj_exposure: 0.5 }]);
        }
        // Row ids are new: the source keeps its own rows.
        const sourceIds = new Set(clipOf(ids.a).effects!.map((e) => e.id));
        expect(clipOf(ids.b).effects!.some((e) => sourceIds.has(e.id))).toBe(false);
        // c was 10-14, now 10-12: d (14-16) is not overlapped and stays.
        expect(clipOf(ids.d)).toMatchObject({ startTime: 14, endTime: 16 });
        const persisted = (await local.loadTimeline("p1")).clips.find((clip) => clip.id === ids.c)!;
        expect(rows(persisted)).toEqual(["fx_blur{\"amount\":0.3}", "fx_pixelate(off)"]);
        expect(persisted.visualFilter).toBe("warm");

        await controller.execute({ type: "history.undo" });
        expect(controller.historyDepth().undo).toBe(before);
        const restored = await local.loadTimeline("p1");
        expect(strip(restored.clips)).toEqual(strip(backendBefore.clips));
        expect(strip(store.getState().timelineData!.clips)).toEqual(strip(backendBefore.clips));
        expect(rows(clipOf(ids.c))).toEqual(["fx_zoom_blur"]);

        await controller.execute({ type: "history.redo" });
        expect(rows(clipOf(ids.c))).toEqual(["fx_blur{\"amount\":0.3}", "fx_pixelate(off)"]);
        expect(clipOf(ids.b).visualFilter).toBe("warm");
    });

    it("pastes from a clip onto a scene with the ripple of later scenes, and undo puts everything back", async () => {
        const { controller, local, ids, sceneOf, rows } = await setup();
        const scenesBefore = await local.loadScenes("p1");
        const result = await controller.execute({ type: "attributes.paste", source: { clipId: ids.a }, targets: [{ sceneId: ids.s1 }], attributes: ["filter", "adjust", "effects", "speed"] });
        expect(result.ok).toBe(true);
        expect(sceneOf(ids.s1)).toMatchObject({ visualFilter: "warm", playbackSpeed: 2 });
        expect(rows(sceneOf(ids.s1))).toEqual(["fx_blur{\"amount\":0.3}", "fx_pixelate(off)"]);
        expect(sceneOf(ids.s2).timelinePositionSeconds).toBeCloseTo(2.001, 6);
        expect((await local.loadScenes("p1")).find((s) => s.id === ids.s1)!.effects!.map((e) => e.sceneId)).toEqual([ids.s1, ids.s1]);
        await controller.execute({ type: "history.undo" });
        expect(strip(await local.loadScenes("p1"))).toEqual(strip(scenesBefore));
        expect(sceneOf(ids.s2).timelinePositionSeconds).toBeCloseTo(4.001, 6);
        expect(rows(sceneOf(ids.s1))).toEqual([]);
    });

    it("pastes a stored snapshot after its source was deleted", async () => {
        const { controller, store, ids, clipOf } = await setup();
        const snapshot = snapshotAttributes({ kind: "clip", clip: clipOf(ids.a) });
        store.getState().setAttributeClipboard(snapshot);
        await controller.execute({ type: "clip.delete", clipIds: [ids.a] });
        const result = await controller.execute({ type: "attributes.paste", source: store.getState().attributeClipboard!, targets: [{ clipId: ids.b }], attributes: ["filter", "animation"] });
        expect(result.ok).toBe(true);
        expect(clipOf(ids.b)).toMatchObject({ visualFilter: "warm", animationJson: STYLE.animationJson, playbackSpeed: 1 });
    });

    it("pastes every kind the source has when no attributes are named, and reports what it skipped", async () => {
        const { controller, ids, clipOf } = await setup();
        await controller.execute({ type: "track.update", tracks: [
            { type: "video", index: 1, label: "V1", muted: false, locked: false, visible: true, volume: 1 },
            { type: "video", index: 2, label: "V2", muted: false, locked: false, visible: true, volume: 1 },
            { type: "text", index: 1, label: "T1", muted: false, locked: false, visible: true, volume: 1 },
        ] });
        await controller.execute({ type: "clip.create", input: { trackType: "text", trackIndex: 1, startTime: 0, endTime: 3, mediaType: "text", textContent: "Hi" } });
        const textId = controller.snapshot().clips.find((clip) => clip.trackType === "text")!.id;
        const result = await controller.execute({ type: "attributes.paste", source: { clipId: ids.a }, targets: [{ clipId: textId }, { clipId: ids.b }] });
        expect(result.ok).toBe(true);
        const report = result.output as AttributePasteReport;
        expect(report.applied).toEqual([{ clipId: ids.b, kinds: ["filter", "adjust", "effects", "animation", "speed"] }]);
        expect(report.skipped.filter((s) => s.clipId === textId).map((s) => `${s.kind}:${s.reason}`)).toEqual([
            "filter:not-supported", "adjust:not-supported", "effects:not-supported", "animation:not-supported", "speed:not-supported",
        ]);
        expect(clipOf(textId).visualFilter).toBe("none");
    });

    it("refuses locked targets and fails when nothing can be pasted", async () => {
        const { controller, ids, clipOf } = await setup();
        await controller.execute({ type: "track.update", tracks: [
            { type: "video", index: 1, label: "V1", muted: false, locked: false, visible: true, volume: 1 },
            { type: "video", index: 2, label: "V2", muted: false, locked: true, visible: true, volume: 1 },
        ] });
        const before = controller.historyDepth().undo;
        const result = await controller.execute({ type: "attributes.paste", source: { clipId: ids.a }, targets: [{ clipId: ids.b }], attributes: ["filter"] });
        expect(result.ok).toBe(false);
        expect((result.output as AttributePasteReport).skipped).toEqual([{ clipId: ids.b, reason: "locked" }]);
        expect(clipOf(ids.b).visualFilter).toBe("none");
        expect(controller.historyDepth().undo).toBe(before);
        expect((await controller.execute({ type: "attributes.paste", source: { clipId: "missing" }, targets: [{ clipId: ids.b }] })).ok).toBe(false);
        expect((await controller.execute({ type: "attributes.paste", source: { clipId: ids.a }, targets: [] })).ok).toBe(false);
    });

    it("writes scenes one by one on a backend without updateScenes, and skips effects on one that cannot edit them", async () => {
        const without = (keys: string[]) => (inner: LocalBackend) => new Proxy(inner, {
            get(target, key, receiver) {
                if (keys.includes(String(key))) return undefined;
                const value = Reflect.get(target, key, receiver);
                return typeof value === "function" ? value.bind(target) : value;
            },
        });
        const plain = await setup(without(["updateScenes"]));
        const scenesBefore = await plain.local.loadScenes("p1");
        const ok = await plain.controller.execute({ type: "attributes.paste", source: { clipId: plain.ids.a }, targets: [{ sceneId: plain.ids.s1 }, { sceneId: plain.ids.s2 }], attributes: ["filter", "animation"] });
        expect(ok.ok).toBe(true);
        expect([plain.sceneOf(plain.ids.s1).visualFilter, plain.sceneOf(plain.ids.s2).visualFilter]).toEqual(["warm", "warm"]);
        await plain.controller.execute({ type: "history.undo" });
        expect(strip(await plain.local.loadScenes("p1"))).toEqual(strip(scenesBefore));

        const noEffects = await setup(without(["addClipEffect", "removeClipEffect", "updateClipEffect"]));
        const result = await noEffects.controller.execute({ type: "attributes.paste", source: { clipId: noEffects.ids.a }, targets: [{ clipId: noEffects.ids.b }], attributes: ["filter", "effects"] });
        expect(result.ok).toBe(true);
        expect((result.output as AttributePasteReport).skipped).toEqual([{ clipId: noEffects.ids.b, kind: "effects", reason: "not-supported" }]);
        expect(noEffects.clipOf(noEffects.ids.b).visualFilter).toBe("warm");
    });

    it("takes back its partial writes when a later write fails", async () => {
        let failNextAdd = false;
        const { controller, store, local, ids, clipOf, rows, onToast } = await setup((inner) => new Proxy(inner, {
            get(target, key, receiver) {
                if (key === "addClipEffect") {
                    return async (...args: Parameters<LocalBackend["addClipEffect"]>) => {
                        if (failNextAdd && args[1].clipId !== undefined && (await inner.loadTimeline("p1")).clips.find((c) => c.id === args[1].clipId)!.effects?.length === 1) {
                            throw new Error("backend down");
                        }
                        return inner.addClipEffect(...args);
                    };
                }
                const value = Reflect.get(target, key, receiver);
                return typeof value === "function" ? value.bind(target) : value;
            },
        }));
        const backendBefore = await local.loadTimeline("p1");
        const storeBefore = strip(store.getState().timelineData!.clips);
        const depth = controller.historyDepth();
        failNextAdd = true;
        const result = await controller.execute({ type: "attributes.paste", source: { clipId: ids.a }, targets: [{ clipId: ids.b }], attributes: ["filter", "effects"] });
        expect(result.ok).toBe(false);
        expect(onToast).toHaveBeenCalledWith(expect.objectContaining({ kind: "error" }));
        expect(strip((await local.loadTimeline("p1")).clips)).toEqual(strip(backendBefore.clips));
        expect(strip(store.getState().timelineData!.clips)).toEqual(storeBefore);
        expect(controller.historyDepth()).toEqual(depth);
        expect(rows(clipOf(ids.b))).toEqual([]);
        // The history still lines up: the last undo takes back the speed change, not something else.
        await controller.execute({ type: "history.undo" });
        expect(clipOf(ids.a).playbackSpeed).toBe(1);
    });
});
