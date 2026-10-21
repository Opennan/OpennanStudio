// Round-trip cases for local media, graphics, and effect tools.
import { data, clipOf, scenesOf, type Case } from "../roundtrip";

export const MEDIA_CASES: Record<string, Case> = {
    publish_audio_to_timeline: async (call, studio) => {
        const result = await call("publish_audio_to_timeline", { local_path: "beep.wav", duration: 2, start_time: 1 });
        expect(result.isError).toBe(false);
        // A1 holds the Music clip at 0-15 s, so the first free audio track is A2.
        expect(clipOf(studio, data(result).clipId)).toMatchObject({ trackType: "audio", trackIndex: 2, startTime: 1, endTime: 3, label: "beep.wav" });
        expect(clipOf(studio, data(result).clipId)?.mediaUrl).toMatch(/^opennan-local:\/\/media\//);
        expect(data(await call("publish_audio_to_timeline", { local_path: "beep.wav", duration: 2, track_index: 1 })).error)
            .toMatch(/^audio1 already has music \(0-15s\) in 0-2s\./);
    },
    publish_video_to_timeline: async (call, studio) => {
        const result = await call("publish_video_to_timeline", { local_path: "clip.mp4", start_time: 2, duration: 3, label: "B-roll" });
        expect(clipOf(studio, data(result).clipId)).toMatchObject({ trackType: "video", trackIndex: 2, startTime: 2, endTime: 5, label: "B-roll" });
    },
    add_graphics_clip: async (call, studio) => {
        const result = await call("add_graphics_clip", { template_id: "lower-third", props: { name: "Ana" }, start_time: 1, end_time: 5 });
        const clip = clipOf(studio, data(result).clipId)!;
        expect(clip).toMatchObject({ trackType: "remotion", remotionTemplateId: "lower-third", label: "Lower Third" });
        // The template's defaults fill the props the call leaves out.
        expect(JSON.parse(clip.remotionPropsJson!)).toMatchObject({ name: "Ana", role: "Title, Company", barColor: "#7c3aed" });
        expect(data(await call("add_graphics_clip", { template_id: "nope", start_time: 1, end_time: 2 })).error)
            .toBe("Unknown graphics template nope. Available templates: lower-third.");
    },
    list_graphics_templates: async (call) => {
        const all = data(await call("list_graphics_templates", {}));
        expect(all.templates.length).toBe(19);
        expect(all.templates.find((t: { id: string }) => t.id === "lower-third")).toMatchObject({
            name: "Lower Third", category: "text", props: expect.arrayContaining([expect.objectContaining({ key: "name", type: "text", default: "Name Surname" })]),
        });
        expect(data(await call("list_graphics_templates", { category: "data" })).templates.map((t: { id: string }) => t.id)).toEqual(["bar-chart", "line-chart", "donut-chart", "stat-counter"]);
        expect((await call("list_graphics_templates", { category: "nope" })).isError).toBe(true);
    },
    update_graphics_clip: async (call, studio) => {
        const id = data(await call("add_graphics_clip", { template_id: "lower-third", props: { name: "Ana", barColor: "red" }, start_time: 1, end_time: 5 })).clipId;
        await call("update_graphics_clip", { clip_id: id, props: { name: "Bo" }, end_time: 6 });
        expect(clipOf(studio, id)!.endTime).toBe(6);
        expect(JSON.parse(clipOf(studio, id)!.remotionPropsJson!)).toMatchObject({ name: "Bo", barColor: "red", role: "Title, Company" });
        expect((await call("update_graphics_clip", { clip_id: "title", end_time: 2 })).isError).toBe(true);
    },
    apply_visual_effect: async (call, studio) => {
        const result = await call("apply_visual_effect", { scene_order: 1, effect_id: "blur", params: { amount: 0.8 } });
        expect(result.isError).toBe(false);
        expect(scenesOf(studio)[0].effects).toEqual([expect.objectContaining({ effectId: "blur", enabled: true, paramsJson: "{\"amount\":0.8}" })]);
        expect(data(await call("apply_visual_effect", { scene_order: 1, effect_id: "nope" })).error).toMatch(/Unknown effect nope/);
        expect(data(await call("apply_visual_effect", { clip_id: "title", effect_id: "blur" })).error).toMatch(/looks apply to video and sticker clips/);
        // A range without a target: an effect layer on a new effect track.
        const layer = data(await call("apply_visual_effect", { effect_id: "fx_vhs", start_time: 1, end_time: 3 }));
        expect(clipOf(studio, layer.clipId)).toMatchObject({ trackType: "effect", startTime: 1, endTime: 3 });
        expect(clipOf(studio, layer.clipId)?.effects?.map((e) => e.effectId)).toEqual(["fx_vhs"]);
        // Undo removes the layer call's last edit.
        expect((await call("undo_last_edit")).isError).toBe(false);
    },
    remove_visual_effect: async (call, studio) => {
        await call("apply_visual_effect", { scene_order: 1, effect_id: "blur" });
        expect((await call("remove_visual_effect", { scene_order: 1, effect_id: "blur" })).isError).toBe(false);
        expect(scenesOf(studio)[0].effects?.[0].enabled).toBe(false);
        expect((await call("remove_visual_effect", { scene_order: 1, effect_id: "blur" })).isError).toBe(true);
        expect((await call("remove_visual_effect", { scene_order: 1, effect_id: "blur", delete: true })).isError).toBe(false);
        expect(scenesOf(studio)[0].effects).toEqual([]);
        expect(data(await call("remove_visual_effect", { effect_id: "blur" })).error).toMatch(/needs clip_id or scene_order/);
    },
};
