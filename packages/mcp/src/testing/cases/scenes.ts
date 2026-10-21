// Round-trip cases for the scenes tools.
import { getSceneStart } from "@opennan/timeline-core";
import { FIXTURE_PROJECT_ID } from "../fixture";
import { data, text, scenesOf, shotsOf, type Case } from "../roundtrip";

export const SCENE_CASES: Record<string, Case> = {
    create_scenes: async (call, studio) => {
        const result = await call("create_scenes", { scenes: [{ caption: "Outro", duration: 3, card_type: "image", transition: "continue" }] });
        expect(result.isError).toBe(false);
        expect(scenesOf(studio).map((s) => s.caption)).toEqual(["Intro", "Middle", "End", "Outro"]);
        expect(scenesOf(studio)[3]).toMatchObject({ transition: "continue", cardType: "image", duration: 3 });
        const planned = await call("create_scenes", { scenes: [{ caption: "x", start_frame_prompt: "a castle" }] });
        expect(data(planned)).toMatchObject({ unavailable: true, capability: "opennan.story.plan" });
        expect(text(planned)).toContain("Connect OpenNan to use create_scenes.");
        expect(scenesOf(studio)).toHaveLength(4);
        await call("create_scenes", { scenes: [{ source_url: "https://media.test/b.mp4", source_start_time: 2, source_end_time: 5 }] });
        expect(scenesOf(studio)[4]).toMatchObject({ cardType: "source_clip", sourceVideoUrl: "https://media.test/b.mp4", videoUrl: "https://media.test/b.mp4", duration: 3 });
        expect(JSON.parse(scenesOf(studio)[4].cardConfig ?? "{}")).toEqual({ timelineTrimStart: 2, timelineTrimEnd: 5 });
        expect(data(await call("create_scenes", { scenes: [{ source_url: "https://media.test/b.mp4", source_start_time: 2 }] })).error)
            .toBe("Scene 1: source_start_time needs source_end_time or duration.");
        await call("create_scenes", { replace_existing: true, scenes: [{ caption: "Only" }] });
        expect(scenesOf(studio).map((s) => s.caption)).toEqual(["Only"]);
    },
    update_scene: async (call, studio) => {
        expect((await call("update_scene", { scene_order: 2, caption: "Center", duration: 12 })).isError).toBe(false);
        expect(scenesOf(studio)[1].caption).toBe("Center");
        expect(shotsOf(studio, 1).map((s: { duration: string }) => Number(s.duration))).toEqual([6, 6]);
        expect(data(await call("update_scene", { scene_order: 9, caption: "x" })).error).toMatch(/Scene 9 not found/);
        expect(data(await call("update_scene", { scene_order: 1, character_ids: ["c1"] })).capability).toBe("opennan.story.plan");
        // A duplicate made in the editor UI bumps later orders; scene_order still hits the intended scene.
        await studio.controller.execute({ type: "scene.duplicate", sceneId: "s2" });
        const live = studio.controller.snapshot().scenes;
        expect(live.map((s) => `${s.id}#${s.order}`)).toEqual((await studio.backend.loadScenes(FIXTURE_PROJECT_ID)).map((s) => `${s.id}#${s.order}`));
        expect(new Set(live.map((s) => s.order)).size).toBe(4);
        expect((await call("update_scene", { scene_order: 4, caption: "Still the end" })).isError).toBe(false);
        expect(studio.controller.snapshot().scenes.find((s) => s.id === "s3")?.caption).toBe("Still the end");
        expect(scenesOf(studio)[2]).toMatchObject({ caption: "Center" });
    },
    delete_scenes: async (call, studio) => {
        await call("delete_scenes", { scene_orders: [1, 3] });
        expect(scenesOf(studio).map((s) => s.id)).toEqual(["s2"]);
    },
    reorder_scenes: async (call, studio) => {
        expect((await call("reorder_scenes", { new_order: [3, 1, 2] })).isError).toBe(false);
        expect(scenesOf(studio).map((s) => s.id)).toEqual(["s3", "s1", "s2"]);
        // Playback follows: s3 (5 s) first, then s1 (4 s), then s2 (6 s), in the store and in the backend.
        const scenes = studio.controller.snapshot().scenes;
        expect(scenes.map((s) => s.id)).toEqual(["s3", "s1", "s2"]);
        expect(scenes.map((s, i) => getSceneStart(s, scenes, i))).toEqual([0, 5, 9]);
        expect((await studio.backend.loadScenes(FIXTURE_PROJECT_ID)).map((s) => s.id)).toEqual(["s3", "s1", "s2"]);
        expect((await call("reorder_scenes", { new_order: [1, 1, 2] })).isError).toBe(true);
    },
    split_scene: async (call, studio) => {
        const result = await call("split_scene", { scene_order: 1, at_time: 2 });
        expect(result.isError).toBe(false);
        const { newSceneId } = data(result);
        const scenes = studio.controller.snapshot().scenes;
        // s1 (0-4 s) becomes 0-2 s + the new scene at 2-4 s; s2 and s3 stay at 4 s and 10 s.
        expect(scenes.map((s) => s.id)).toEqual(["s1", newSceneId, "s2", "s3"]);
        expect(scenes.map((s, i) => getSceneStart(s, scenes, i))).toEqual([0, 2, 4, 10]);
        expect(new Set(scenes.map((s) => s.order)).size).toBe(4);
        await call("update_scene", { scene_order: 3, caption: "Still the middle" });
        expect(scenesOf(studio).find((s) => s.id === "s2")?.caption).toBe("Still the middle");
        expect(data(await call("split_scene", { scene_order: 4, at_time: 12 })).error).toMatch(/^Scene 4 cannot be split at 12s/);
    },
    add_shot: async (call, studio) => {
        await call("add_shot", { scene_order: 2, prompt: "insert", duration: 2, position: 1 });
        expect(shotsOf(studio, 1).map((s: { prompt: string }) => s.prompt)).toEqual(["wide", "insert", "close"]);
    },
    update_shot: async (call, studio) => {
        await call("update_shot", { scene_order: 2, shot_index: 1, prompt: "tight", speech: "" });
        expect(shotsOf(studio, 1)[1]).toEqual({ prompt: "tight", duration: "3" });
        expect((await call("update_shot", { scene_order: 2, shot_index: 5, prompt: "x" })).isError).toBe(true);
    },
    delete_shot: async (call, studio) => {
        await call("delete_shot", { scene_order: 2, shot_index: 0 });
        expect(shotsOf(studio, 1).map((s: { prompt: string }) => s.prompt)).toEqual(["close"]);
    },
    merge_shots: async (call, studio) => {
        await call("merge_shots", { scene_order: 2, target_shot_index: 0, source_shot_index: 1 });
        expect(shotsOf(studio, 1)).toEqual([{ prompt: "wide close", duration: "6", speech: "hi" }]);
        expect((await call("merge_shots", { scene_order: 2, target_shot_index: 0, source_shot_index: 0 })).isError).toBe(true);
    },
    update_project: async (call, studio) => {
        await call("update_project", { name: "Trip", aspect_ratio: "9:16" });
        expect(studio.controller.snapshot().project).toMatchObject({ name: "Trip", aspectRatio: "9:16" });
        expect(data(await call("update_project", { movie_concept: "heist" })).capability).toBe("opennan.story.plan");
    },
};
