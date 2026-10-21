// Round-trip cases for transitions, filters, adjustments, and effect order.
import { clipOf, data, scenesOf, type Case } from "../roundtrip";
import type { FixtureStudio } from "../fixture";

const json = (value: string | null | undefined) => (value ? JSON.parse(value) : null);
const lockTrack = async (studio: FixtureStudio, type: string, index: number) => {
    const tracks = studio.controller.snapshot().tracks.map((t) => (t.type === type && t.index === index ? { ...t, locked: true } : t));
    await studio.controller.execute({ type: "track.update", tracks });
};
/** A video layer clip on V2 (made with the track in the same command), for clip targets. */
const addVideoClip = async (studio: FixtureStudio, startTime = 0, endTime = 4): Promise<string> => {
    const rows = studio.controller.snapshot().tracks;
    const hasV2 = rows.some((t) => t.type === "video" && t.index === 2);
    const created = await studio.controller.execute({
        type: "clip.create",
        ...(hasV2 ? {} : { tracks: [...rows, { type: "video" as const, index: 2, label: "V2", muted: false, locked: false, visible: true, volume: 1 }] }),
        input: { trackType: "video", trackIndex: 2, startTime, endTime, mediaUrl: "https://media.test/layer.mp4", mediaType: "video" },
    });
    return created.createdClipIds![0];
};

export const LOOK_CASES: Record<string, Case> = {
    list_transitions: async (call) => {
        const result = data(await call("list_transitions"));
        expect(result.transitions).toHaveLength(25);
        expect(result.transitions[0]).toEqual({ id: "cross_dissolve", name: "Dissolve", category: "basic", default_duration: 0.5 });
    },
    apply_transition: async (call, studio) => {
        const set = data(await call("apply_transition", { scene_order: 1, transition_id: "spin", duration: 0.8 }));
        expect(set).toMatchObject({ ok: true, transition: "spin", duration: 0.8 });
        expect(scenesOf(studio)[0]).toMatchObject({ visualTransition: "spin", visualTransitionDuration: 0.8 });
        expect(data(await call("apply_transition", { scene_order: 3, transition_id: "spin" })).error).toMatch(/no next scene/);
        expect((await call("apply_transition", { transition_id: "cross_dissolve", apply_to_all: true })).isError).toBe(false);
        expect(scenesOf(studio).slice(0, 2).map((s) => s.visualTransition)).toEqual(["cross_dissolve", "cross_dissolve"]);
        // One undo reverts the whole apply-to-all call.
        expect((await call("undo_last_edit")).isError).toBe(false);
        expect(scenesOf(studio)[0].visualTransition).toBe("spin");
        expect(data(await call("apply_transition", { transition_id: "spin" })).error).toMatch(/needs scene_order/);
    },
    list_filters: async (call) => {
        const result = data(await call("list_filters"));
        expect(result.filters).toHaveLength(30);
        expect(result.filters.map((f: { category: string }) => f.category)).toContain("landscape");
    },
    apply_filter: async (call, studio) => {
        expect(data(await call("apply_filter", { scene_order: 2, filter_id: "teal_orange", intensity: 65 }))).toMatchObject({ ok: true, intensity: 65 });
        expect(scenesOf(studio)[1]).toMatchObject({ visualFilter: "teal_orange", filterIntensity: 0.65 });
        expect((await call("apply_filter", { scene_order: 2, filter_id: "none" })).isError).toBe(false);
        expect(scenesOf(studio)[1].visualFilter).toBe("none");
        expect(data(await call("apply_filter", { filter_id: "vivid" })).error).toMatch(/needs clip_id or scene_order/);
    },
    set_adjustments: async (call, studio) => {
        expect(data(await call("set_adjustments", { scene_order: 1, exposure: 30, vignette: 150, contrast: -20 }))).toMatchObject({ values: { exposure: 30, vignette: 100, contrast: -20 } });
        expect(JSON.parse(scenesOf(studio)[0].adjustmentsJson!)).toEqual({ contrast: -0.2, exposure: 0.3, vignette: 1 });
        expect((await call("set_adjustments", { scene_order: 1, reset: true, grain: 25 })).isError).toBe(false);
        expect(JSON.parse(scenesOf(studio)[0].adjustmentsJson!)).toEqual({ grain: 0.25 });
        expect(data(await call("set_adjustments", { scene_order: 1 })).error).toMatch(/at least one control/);
        // A main-track clip on a locked V1 is not editable, as in the editor.
        const tracks = studio.controller.snapshot().tracks.map((t) => (t.type === "video" && t.index === 1 ? { ...t, locked: true } : t));
        await studio.controller.execute({ type: "track.update", tracks });
        expect(data(await call("set_adjustments", { scene_order: 1, exposure: 10 })).error).toMatch(/locked track video1/);
        expect(data(await call("apply_filter", { scene_order: 1, filter_id: "noir" })).error).toMatch(/locked track video1/);
    },
    reorder_visual_effects: async (call, studio) => {
        await call("apply_visual_effect", { scene_order: 1, effect_id: "fx_sepia" });
        await call("apply_visual_effect", { scene_order: 1, effect_id: "fx_vhs" });
        const ids = scenesOf(studio)[0].effects!.slice().sort((a, b) => a.order - b.order).map((e) => e.id);
        expect((await call("reorder_visual_effects", { scene_order: 1, effect_row_ids: [ids[1], ids[0]] })).isError).toBe(false);
        expect(scenesOf(studio)[0].effects!.slice().sort((a, b) => a.order - b.order).map((e) => e.effectId)).toEqual(["fx_vhs", "fx_sepia"]);
        expect((await call("reorder_visual_effects", { scene_order: 1, effect_row_ids: [ids[0]] })).isError).toBe(true);
    },
    set_mask: async (call, studio) => {
        // A new mask: the shape's defaults with the given fields.
        const set = data(await call("set_mask", { scene_order: 1, shape: "circle", x: 0.3, feather: 0.2 }));
        expect(set).toMatchObject({ ok: true, sceneId: "s1", mask: { shape: "circle", x: 0.3, y: 0.5, width: 0.6, height: 0.6, feather: 0.2, invert: false } });
        expect(json(scenesOf(studio)[0].maskJson)).toMatchObject({ shape: "circle", x: 0.3, feather: 0.2 });
        // A patch keeps the other fields and the shape; undo_last_edit reverts only that call.
        await call("set_mask", { scene_order: 1, width: 0.9, invert: true });
        expect(json(scenesOf(studio)[0].maskJson)).toMatchObject({ shape: "circle", x: 0.3, width: 0.9, invert: true });
        expect((await call("undo_last_edit")).isError).toBe(false);
        expect(json(scenesOf(studio)[0].maskJson)).toMatchObject({ shape: "circle", x: 0.3, width: 0.6, invert: false });

        // A keyframed field gets a keyframe at time (and the static value follows), as in the inspector.
        await call("set_keyframe", { scene_order: 1, time: 0, values: { mask_x: 0.3 } });
        const keyed = data(await call("set_mask", { scene_order: 1, x: 0.7, rotation: 30, time: 2 }));
        expect(keyed.keyframed).toEqual(["mask_x"]);
        const points = () => json(scenesOf(studio)[0].keyframesJson)?.keyframes ?? [];
        expect(points()).toEqual([{ time: 0, mask_x: 0.3 }, { time: 2, mask_x: 0.7 }]);
        expect(json(scenesOf(studio)[0].maskJson)).toMatchObject({ x: 0.7, rotation: 30 });

        // reset: the shape's defaults (the current shape unless one is given), mask keyframes dropped.
        const reset = data(await call("set_mask", { scene_order: 1, reset: true, shape: "star", feather: 0.1 }));
        expect(reset.mask).toEqual({ shape: "star", x: 0.5, y: 0.5, width: 0.6, height: 0.6, rotation: 0, feather: 0.1, roundness: 0, invert: false });
        expect(points()).toEqual([]);
        await call("set_mask", { scene_order: 1, reset: true });
        expect(json(scenesOf(studio)[0].maskJson)).toMatchObject({ shape: "star", feather: 0 });

        // remove and shape none delete it; undo brings it back.
        expect(data(await call("set_mask", { scene_order: 1, remove: true }))).toMatchObject({ ok: true, mask: null });
        expect(scenesOf(studio)[0].maskJson ?? null).toBeNull();
        expect((await call("undo_last_edit")).isError).toBe(false);
        expect(json(scenesOf(studio)[0].maskJson)).toMatchObject({ shape: "star" });
        await call("set_mask", { scene_order: 1, shape: "none" });
        expect(scenesOf(studio)[0].maskJson ?? null).toBeNull();
        expect(data(await call("set_mask", { scene_order: 1, shape: "none", remove: true }))).toMatchObject({ ok: true, mask: null });
        expect(data(await call("set_mask", { scene_order: 1, shape: "none", feather: 0.2 })).error).toMatch(/remove \(or shape none\) deletes the mask/);

        // A video layer clip.
        const clipId = await addVideoClip(studio);
        expect(data(await call("set_mask", { clip_id: clipId, shape: "rectangle", roundness: 0.4, height: 0.3 }))).toMatchObject({ ok: true, clipId, mask: { shape: "rectangle", roundness: 0.4, height: 0.3 } });
        expect(json(clipOf(studio, clipId)?.maskJson)).toMatchObject({ shape: "rectangle", roundness: 0.4 });

        // A text clip (phase 10d): its mask lives in the text's layout box.
        expect(data(await call("set_mask", { clip_id: "title", shape: "heart", width: 1.2, invert: true }))).toMatchObject({ ok: true, clipId: "title", mask: { shape: "heart", width: 1.2, invert: true } });
        expect(json(clipOf(studio, "title")?.maskJson)).toMatchObject({ shape: "heart", width: 1.2 });
        expect((await call("undo_last_edit")).isError).toBe(false);
        expect(clipOf(studio, "title")?.maskJson ?? null).toBeNull();

        // Refusals with what to do instead.
        expect(data(await call("set_mask", { shape: "circle" })).error).toMatch(/needs clip_id or scene_order/);
        expect(data(await call("set_mask", { clip_id: "music", shape: "circle" })).error).toMatch(/masks apply to video, image, text, and sticker clips/);
        expect(data(await call("set_mask", { scene_order: 2, x: 0.4 })).error).toMatch(/has no mask yet; give shape/);
        expect(data(await call("set_mask", { scene_order: 2 })).error).toMatch(/needs shape, a mask field, reset, or remove/);
        expect(data(await call("set_mask", { scene_order: 2, shape: "circle", remove: true })).error).toMatch(/remove \(or shape none\) deletes the mask/);
        expect(data(await call("set_mask", { scene_order: 1, shape: "circle", time: 99 })).ok).toBe(true);
        await call("set_keyframe", { scene_order: 1, time: 0, values: { mask_y: 0.5 } });
        expect(data(await call("set_mask", { scene_order: 1, y: 0.4, time: 99 })).error).toMatch(/outside the item/);
        await lockTrack(studio, "video", 1);
        expect(data(await call("set_mask", { scene_order: 1, shape: "heart" })).error).toMatch(/locked track video1/);
    },
    paste_attributes: async (call, studio) => {
        await call("apply_filter", { scene_order: 1, filter_id: "teal_orange", intensity: 50 });
        await call("set_mask", { scene_order: 1, shape: "heart", feather: 0.3 });
        await call("set_animation", { scene_order: 1, slot: "in", animation_id: "fade_in", duration: 0.5 });
        // Every kind the source has, onto two scenes and a text clip (which takes only the mask: text has its own animations).
        const pasted = data(await call("paste_attributes", { source_scene_order: 1, scene_orders: [2, 3], clip_ids: ["title"] }));
        expect(pasted.ok).toBe(true);
        expect(pasted.applied).toEqual(expect.arrayContaining([
            { scene_order: 2, kinds: ["filter", "animation", "mask"] },
            { scene_order: 3, kinds: ["filter", "animation", "mask"] },
            { clip_id: "title", kinds: ["mask"] },
        ]));
        expect(pasted.skipped).toEqual(expect.arrayContaining([{ clip_id: "title", kind: "filter", reason: "not-supported" }]));
        expect(json(clipOf(studio, "title")?.maskJson)).toMatchObject({ shape: "heart", feather: 0.3 });
        for (const scene of scenesOf(studio).slice(1)) {
            expect(scene).toMatchObject({ visualFilter: "teal_orange", filterIntensity: 0.5 });
            expect(json(scene.maskJson)).toMatchObject({ shape: "heart", feather: 0.3 });
        }
        expect(json(scenesOf(studio)[2].animationJson)).toMatchObject({ in: { id: "fade_in" } });
        expect(clipOf(studio, "title")?.animationJson ?? null).toBeNull();
        // One undo takes the whole paste back.
        expect((await call("undo_last_edit")).isError).toBe(false);
        expect(scenesOf(studio).slice(1).map((s) => s.maskJson ?? null)).toEqual([null, null]);
        expect(scenesOf(studio).slice(1).map((s) => s.animationJson ?? null)).toEqual([null, null]);
        expect(scenesOf(studio)[1].visualFilter ?? "none").toBe("none");

        // A kind filter, from a clip source; the source itself is skipped.
        const clipId = await addVideoClip(studio);
        await call("set_mask", { clip_id: clipId, shape: "mirror" });
        await call("apply_filter", { clip_id: clipId, filter_id: "noir" });
        const onlyMask = data(await call("paste_attributes", { source_clip_id: clipId, scene_orders: [3], clip_ids: [clipId], attributes: ["mask"] }));
        expect(onlyMask.applied).toEqual([{ scene_order: 3, kinds: ["mask"] }]);
        expect(onlyMask.skipped).toEqual([{ clip_id: clipId, reason: "source" }]);
        expect(json(scenesOf(studio)[2].maskJson)).toMatchObject({ shape: "mirror" });
        expect(scenesOf(studio)[2].visualFilter ?? "none").toBe("none");

        // Nothing to paste: the report says why.
        const none = data(await call("paste_attributes", { source_clip_id: clipId, clip_ids: ["music"], attributes: ["mask"] }));
        expect(none.error).toMatch(/clip music: mask \(not-supported\)/);
        expect(none.skipped).toEqual([{ clip_id: "music", kind: "mask", reason: "not-supported" }]);
        expect(data(await call("paste_attributes", { scene_orders: [2] })).error).toMatch(/needs source_clip_id or source_scene_order/);
        expect(data(await call("paste_attributes", { source_scene_order: 1 })).error).toMatch(/needs clip_ids or scene_orders/);
        expect(data(await call("paste_attributes", { source_scene_order: 1, scene_orders: [9] })).error).toMatch(/Scene 9 not found/);
        expect(data(await call("paste_attributes", { source_scene_order: 1, clip_ids: ["nope"] })).error).toMatch(/Timeline clip not found: nope/);
    },
};
