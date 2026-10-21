import { waitFor } from "@testing-library/react";
import { optimistic } from "@opennan/timeline-core";
import { parseTimelineKeyframes } from "@opennan/timeline-core/lib/timeline-editing-properties";
import { createTimelineTestRuntime, renderWithTimeline, seedTimeline } from "../../test-utils/render-with-timeline";
import { dragCommitCommands, sceneDragCommands, useDragCommit } from "./drag-commit";
import { testClip } from "./test-fixtures";

const json = (value: unknown) => JSON.stringify(value);

describe("dragCommitCommands", () => {
    it("writes static channels to the clip fields", () => {
        const clip = testClip({ id: "a" });
        expect(dragCommitCommands(clip, { posX: 0.2, posY: 0.8 }, 1)).toEqual([{ type: "clip.update", clipIds: ["a"], patch: { positionX: 0.2, positionY: 0.8 } }]);
        expect(dragCommitCommands(clip, { scale: 1.5 }, 1)).toEqual([{ type: "clip.update", clipIds: ["a"], patch: { scale: 1.5 } }]);
        expect(dragCommitCommands(clip, null, 1)).toEqual([]);
    });

    it("keys keyframed channels at the playhead (item-local time, clamped to the clip)", () => {
        const clip = testClip({ id: "a", startTime: 10, endTime: 14, keyframesJson: json([{ time: 0, position_x: 0.1 }, { time: 4, position_x: 0.9, scale: 2 }]) });
        expect(dragCommitCommands(clip, { posX: 0.3, posY: 0.6 }, 1.23456)).toEqual([
            { type: "keyframe.set", clipId: "a", time: 1.235, values: { position_x: 0.3, position_y: 0.6 } },
        ]);
        expect(dragCommitCommands(clip, { scale: 0.7 }, 9)).toEqual([{ type: "keyframe.set", clipId: "a", time: 4, values: { scale: 0.7 } }]);
        // Only position is keyframed here: a corner drag still writes the static scale.
        const posOnly = testClip({ id: "b", keyframesJson: json([{ time: 0, position_y: 0.2 }]) });
        expect(dragCommitCommands(posOnly, { scale: 1.2 }, 0)).toEqual([{ type: "clip.update", clipIds: ["b"], patch: { scale: 1.2 } }]);
        expect(dragCommitCommands(posOnly, { posX: 0.4 }, -1)).toEqual([{ type: "keyframe.set", clipId: "b", time: 0, values: { position_x: 0.4, position_y: 0.2 } }]);
    });
});

describe("dragCommitCommands: rotation and anchored scale", () => {
    it("writes a static rotation to the field and keys a keyframed one", () => {
        const clip = testClip({ id: "a" });
        expect(dragCommitCommands(clip, { rotation: 30 }, 1)).toEqual([{ type: "clip.update", clipIds: ["a"], patch: { rotationDegrees: 30 } }]);
        const keyed = testClip({ id: "k", keyframesJson: json([{ time: 0, rotation_degrees: 0 }, { time: 4, rotation_degrees: 90 }]) });
        expect(dragCommitCommands(keyed, { rotation: -15 }, 2)).toEqual([{ type: "keyframe.set", clipId: "k", time: 2, values: { rotation_degrees: -15 } }]);
    });

    it("commits an anchored corner drag (scale + position) as ONE command, keyed channels in keyframesJson", () => {
        const allStatic = testClip({ id: "a" });
        expect(dragCommitCommands(allStatic, { scale: 2, posX: 0.1, posY: 0.9 }, 1)).toEqual([
            { type: "clip.update", clipIds: ["a"], patch: { positionX: 0.1, positionY: 0.9, scale: 2 } },
        ]);
        const allKeyed = testClip({ id: "b", keyframesJson: json([{ time: 0, scale: 1, position_x: 0.5 }]) });
        expect(dragCommitCommands(allKeyed, { scale: 2, posX: 0.1, posY: 0.9 }, 1)).toEqual([
            { type: "keyframe.set", clipId: "b", time: 1, values: { position_x: 0.1, position_y: 0.9, scale: 2 } },
        ]);
        // Scale keyed, position static: one clip.update carrying the new keyframes and the static fields.
        const mixed = testClip({ id: "c", keyframesJson: json([{ time: 0, scale: 1 }, { time: 4, scale: 3 }]) });
        const commands = dragCommitCommands(mixed, { scale: 2.5, posX: 0.2, posY: 0.3 }, 2);
        expect(commands).toHaveLength(1);
        const command = commands[0] as Extract<(typeof commands)[number], { type: "clip.update" }>;
        expect(command.type).toBe("clip.update");
        expect(command.patch).toMatchObject({ positionX: 0.2, positionY: 0.3 });
        expect(command.patch.scale).toBeUndefined();
        const points = parseTimelineKeyframes(command.patch.keyframesJson);
        expect(points.find((p) => Math.abs(p.time - 2) < 1e-9)).toMatchObject({ scale: 2.5 });
        expect(points).toHaveLength(3);
    });
});

describe("sceneDragCommands", () => {
    const scene = (over: Record<string, unknown> = {}) => ({ id: "s1", transformScale: 1, transformOffsetX: 0, transformOffsetY: 0, rotationDegrees: 0, keyframesJson: null, ...over });

    it("writes static scene channels with scene.update (offsets in percent, transformScale, rotationDegrees)", () => {
        expect(sceneDragCommands(scene(), 5, { offsetX: 12.5, offsetY: -3 }, 1)).toEqual([
            { type: "scene.update", sceneId: "s1", patch: { transformOffsetX: 12.5, transformOffsetY: -3 } },
        ]);
        expect(sceneDragCommands(scene(), 5, { scale: 1.5, offsetX: 4, offsetY: 2 }, 1)).toEqual([
            { type: "scene.update", sceneId: "s1", patch: { transformOffsetX: 4, transformOffsetY: 2, transformScale: 1.5 } },
        ]);
        expect(sceneDragCommands(scene(), 5, { rotation: 45 }, 1)).toEqual([{ type: "scene.update", sceneId: "s1", patch: { rotationDegrees: 45 } }]);
        expect(sceneDragCommands(scene(), 5, null, 1)).toEqual([]);
    });

    it("keys keyframed scene channels with keyframe.set (scene units) at the scene-local playhead", () => {
        const keyed = scene({ keyframesJson: json([{ time: 0, rotation_degrees: 0, position_x: 0 }, { time: 5, rotation_degrees: 90, position_x: 10 }]) });
        expect(sceneDragCommands(keyed, 5, { rotation: 30 }, 2.5)).toEqual([{ type: "keyframe.set", sceneId: "s1", time: 2.5, values: { rotation_degrees: 30 } }]);
        expect(sceneDragCommands(keyed, 5, { offsetX: 7 }, 9)).toEqual([{ type: "keyframe.set", sceneId: "s1", time: 5, values: { position_x: 7, position_y: 0 } }]);
    });
});

describe("useDragCommit", () => {
    async function setup(keyframesJson: string | null) {
        const runtime = createTimelineTestRuntime();
        const clip = { ...optimistic.optimisticTimelineClipFromInput({ trackType: "text", trackIndex: 1, startTime: 2, endTime: 6, textContent: "Hi" }, runtime.projectId, "c1"), keyframesJson };
        await seedTimeline(runtime, { tracks: [{ type: "text", index: 1, label: "T1", muted: false, locked: false, visible: true, volume: 1 }], clips: [clip] });
        let commit: ReturnType<typeof useDragCommit> | null = null;
        function Probe() {
            commit = useDragCommit();
            return null;
        }
        renderWithTimeline(<Probe />, { runtime });
        return { runtime, commit: () => commit! };
    }

    it("commits a static move with history (one undo step)", async () => {
        const { runtime, commit } = await setup(null);
        expect(runtime.store.getState().canUndo).toBe(false);
        expect(await commit()("c1", { posX: 0.25, posY: 0.75 })).toBe(true);
        const clip = runtime.store.getState().timelineData!.clips.find((c) => c.id === "c1")!;
        expect(clip).toMatchObject({ positionX: 0.25, positionY: 0.75 });
        await waitFor(() => expect(runtime.store.getState().canUndo).toBe(true));
    });

    it("commits a keyframed move as a keyframe at the playhead, so the clip stays where it was dropped", async () => {
        const { runtime, commit } = await setup(json([{ time: 0, position_x: 0.1, position_y: 0.5 }, { time: 4, position_x: 0.9, position_y: 0.5 }]));
        runtime.store.getState().setCurrentTime(3);
        expect(await commit()("c1", { posX: 0.2, posY: 0.4 })).toBe(true);
        const clip = runtime.store.getState().timelineData!.clips.find((c) => c.id === "c1")!;
        expect(clip.positionX).toBe(0.5);
        const points = parseTimelineKeyframes(clip.keyframesJson);
        expect(points.find((point) => Math.abs(point.time - 1) < 1e-6)).toMatchObject({ position_x: 0.2, position_y: 0.4 });
        await waitFor(() => expect(runtime.store.getState().canUndo).toBe(true));
    });
});
