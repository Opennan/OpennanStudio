// Round-trip cases for track_motion (phase 10d): the fixture's stand-in tracker (testing/fixture.ts
// createFakeMotionTracker) moves the region's centre right by 0.05 and down by 0.02 of the picture per second; each
// case checks the follower keyframes through the controller and that undo_last_edit takes them back in one step.
import { parseTimelineKeyframes } from "@opennan/timeline-core/lib/timeline-editing-properties";
import { clipOf, data, type Case } from "../roundtrip";

const REGION = { x: 0.4, y: 0.4, width: 0.2, height: 0.2 };
const keyframes = (json: string | null | undefined) => parseTimelineKeyframes(json ?? null);

export const TRACKING_CASES: Record<string, Case> = {
    track_motion: async (call, studio) => {
        // Scene 1 (0-4 s, a source clip that fills the 16:9 frame) moves the "Title" text (0-3 s); audio cannot follow,
        // and scene 1 has no mask yet.
        const tracked = data(await call("track_motion", { scene_order: 1, region: REGION, time: 0, follower_clip_ids: ["title", "music"], follow_mask: true }));
        expect(tracked).toMatchObject({ ok: true, sceneId: "s1", frames: 121, lost: 0, fps: 30 });
        expect(tracked.applied).toEqual([{ clipId: "title", keyframes: 2, approximate: true }]);
        expect(tracked.skipped).toEqual([{ clipId: "music", reason: "not-visual" }, { mask: true, reason: "no-mask" }]);
        const points = keyframes(clipOf(studio, "title")?.keyframesJson);
        expect(points.map((p) => p.time)).toEqual([0, 3]);
        expect(points[0]).toMatchObject({ position_x: 0.5, position_y: 0.5 });
        expect(points[1].position_x).toBeCloseTo(0.65, 3);
        expect(points[1].position_y).toBeCloseTo(0.56, 3);
        expect((await call("undo_last_edit")).isError).toBe(false);
        expect(clipOf(studio, "title")?.keyframesJson ?? null).toBeNull();

        // A V2 video clip with a mask: its mask follows in its own picture.
        const created = await studio.controller.execute({ type: "clip.create", input: { trackType: "video", trackIndex: 2, startTime: 5, endTime: 7, mediaType: "video", mediaUrl: "https://media.test/v.mp4" } });
        const clipId = created.createdClipIds![0];
        await call("set_mask", { clip_id: clipId, shape: "circle", x: 0.3, y: 0.3 });
        const masked = data(await call("track_motion", { clip_id: clipId, region: REGION, follow_mask: true, start: 0.5, end: 1.5, time: 0.5 }));
        expect(masked).toMatchObject({ ok: true, clipId, applied: [{ mask: true, keyframes: 2 }] });
        const maskPoints = keyframes(clipOf(studio, clipId)?.keyframesJson);
        expect(maskPoints.map((p) => [p.time, p.mask_x])).toEqual([[0.5, 0.3], [1.5, 0.35]]);
        expect((await call("undo_last_edit")).isError).toBe(false);
        expect(keyframes(clipOf(studio, clipId)?.keyframesJson)).toEqual([]);

        // Refusals.
        expect(data(await call("track_motion", { scene_order: 1, region: REGION })).error).toMatch(/follower_clip_ids or follow_mask/);
        expect(data(await call("track_motion", { clip_id: "title", region: REGION, follow_mask: true })).error).toMatch(/text clip/);
        expect(data(await call("track_motion", { scene_order: 2, region: REGION, follower_clip_ids: ["title"] })).error).toMatch(/no single video/);
        expect(data(await call("track_motion", { scene_order: 1, region: REGION, follower_clip_ids: ["music"] })).error).toMatch(/no follower moved/);
    },
};
