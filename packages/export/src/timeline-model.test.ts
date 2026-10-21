import type { SceneData, TimelineTrack } from "@opennan/timeline-core";
import { optimisticTimelineClipFromInput } from "@opennan/timeline-core/lib/timeline-optimistic";
import { outputTimeAt, sceneSpeedProfile } from "@opennan/timeline-core/motion/speed";
import {
    activeSceneWindows, buildSceneLanes, placeScenes, sceneDuration, sceneShotSequence, sceneTrimStart, sceneVideoUrl, timelineDuration,
} from "./timeline-model";

function scene(id: string, partial: Partial<SceneData> = {}): SceneData {
    return {
        id, order: 0, caption: "", startTime: "00:00:00", endTime: "00:00:05", startImageUrl: null, endImageUrl: null,
        videoUrl: null, status: "ready", transition: "cut", frameConsistencyScore: null, audioUrl: null, audioText: null,
        cardConfig: null, cardType: "source_clip", sourceVideoUrl: `/m/${id}.webm`, ...partial,
    };
}
const tracks: TimelineTrack[] = [
    { type: "video", index: 1, label: "V1", muted: false, locked: false, visible: true, volume: 1 },
    { type: "video", index: 2, label: "V2", muted: false, locked: false, visible: false, volume: 1 },
];

describe("scene timing", () => {
    it("duration prefers the trim range, then duration, then timecodes", () => {
        expect(sceneDuration(scene("a", { cardConfig: JSON.stringify({ timelineTrimStart: 1, timelineTrimEnd: 3.5 }) }))).toBe(2.5);
        expect(sceneDuration(scene("a", { duration: 7 }))).toBe(7);
        expect(sceneDuration(scene("a", { startTime: "00:00:01", endTime: "00:00:04" }))).toBe(3);
        expect(sceneTrimStart(scene("a", { cardConfig: JSON.stringify({ trimStart: 2 }) }))).toBe(2);
    });

    it("video url: generated video, else source clip footage", () => {
        expect(sceneVideoUrl(scene("a", { videoUrl: "/v.mp4" }))).toBe("/v.mp4");
        expect(sceneVideoUrl(scene("a"))).toBe("/m/a.webm");
        expect(sceneVideoUrl(scene("a", { cardType: "ai_video" }))).toBeNull();
    });

    it("shot-sequenced scenes play each shot's own video with the preview's timing", () => {
        const shots = JSON.stringify([{ duration: 2, video_url: "/m/s1.webm" }, { duration: 1, video_url: "/m/s2.webm" }]);
        const generated = (patch: Partial<SceneData> = {}) => scene("g", { cardType: "ai_video", sourceVideoUrl: null, shotBreakdown: shots, ...patch });
        expect(sceneShotSequence(generated())).toEqual([
            { url: "/m/s1.webm", start: 0, end: 2, speed: 1, sourceStart: 0, sourceEnd: 2, rate: 1 },
            { url: "/m/s2.webm", start: 2, end: 3, speed: 1, sourceStart: 2, sourceEnd: 3, rate: 1 },
        ]);
        // A 6 s scene over 3 s of shots: each shot stretches and plays at half speed (ShotSequencerV2 timeScale).
        expect(sceneShotSequence(generated({ cardConfig: JSON.stringify({ timelineTrimStart: 0, timelineTrimEnd: 6 }) }))?.map((p) => [p.start, p.end, p.speed]))
            .toEqual([[0, 4, 0.5], [4, 6, 0.5]]);
        expect(sceneShotSequence(generated({ videoUrl: "/v.mp4" }))).toBeNull();
        expect(sceneShotSequence(generated({ shotBreakdown: JSON.stringify([{ duration: 2, video_url: "/m/s1.webm" }, { duration: 1 }]) }))).toBeNull();
    });
});

describe("scene speed", () => {
    const shots = JSON.stringify([{ duration: 2, video_url: "/m/s1.webm" }, { duration: 1, video_url: "/m/s2.webm" }]);
    const generated = (patch: Partial<SceneData> = {}) => scene("g", { cardType: "ai_video", sourceVideoUrl: null, shotBreakdown: shots, ...patch });

    it("shot sequences at constant speed stretch by timeScale, which absorbs the speed", () => {
        expect(sceneDuration(generated({ playbackSpeed: 2 }))).toBe(1.5);
        expect(sceneShotSequence(generated({ playbackSpeed: 2 }))).toEqual([
            { url: "/m/s1.webm", start: 0, end: 1, speed: 2, sourceStart: 0, sourceEnd: 2, rate: 1 },
            { url: "/m/s2.webm", start: 1, end: 1.5, speed: 2, sourceStart: 2, sourceEnd: 3, rate: 1 },
        ]);
    });

    it("shot boundaries follow a speed curve's time map", () => {
        const curve = JSON.stringify({ id: "flash_in", points: [[0, 6], [0.12, 3.5], [0.3, 1.4], [0.5, 1], [1, 1]] });
        const s = generated({ speedCurveJson: curve });
        const D = sceneDuration(s);
        const profile = sceneSpeedProfile(s);
        const pieces = sceneShotSequence(s)!;
        expect(pieces.map((p) => [p.sourceStart, p.sourceEnd, p.rate])).toEqual([[0, 2, 1], [2, 3, 1]]);
        expect(pieces[0].start).toBe(0);
        expect(pieces[0].end).toBeCloseTo(outputTimeAt(profile, 2, D), 12);
        expect(pieces[1].end).toBe(D);
    });

    it("an overlapped sped-up scene keeps its tail: offset in timeline seconds, trim in source seconds", () => {
        const overlap = [scene("a", { duration: 2 }), scene("b", { duration: 4, playbackSpeed: 2, timelinePositionSeconds: 1, cardConfig: JSON.stringify({ trimStart: 1 }) })];
        const [lane] = buildSceneLanes(placeScenes(overlap, []), 30);
        const second = lane.items[1];
        expect(second).toMatchObject({ kind: "scene", start: 2, duration: 1, offset: 1, trimStart: 3 });
    });
});

describe("placeScenes and lanes", () => {
    const scenes = [
        scene("a", { duration: 3 }),
        scene("b", { duration: 2, timelinePositionSeconds: 4, visualTransition: "cross_dissolve", visualTransitionDuration: 1 }),
        scene("c", { duration: 2 }),
        scene("d", { duration: 5, trackIndex: 2 }),
    ];

    it("places by the shared layout rule and drops hidden tracks", () => {
        const placed = placeScenes(scenes, tracks);
        expect(placed.map((p) => [p.scene.id, p.start, p.end])).toEqual([["a", 0, 3], ["b", 4, 6], ["c", 6, 8]]);
        expect(placed[1].transition).toBe("cross_dissolve");
    });

    it("fills gaps and joins touching scenes", () => {
        const [lane] = buildSceneLanes(placeScenes(scenes, tracks), 30);
        expect(lane.items.map((item) => [item.kind, item.start, item.duration])).toEqual([
            ["scene", 0, 3], ["gap", 3, 1], ["scene", 4, 2], ["scene", 6, 2],
        ]);
        expect([...lane.joins.entries()]).toEqual([[2, { type: "cross_dissolve", duration: 1 }]]);
        expect(lane.end).toBe(8);
    });

    it("treats scenes within the editor's cut tolerance (0.06 s) as touching: no gap frame, the transition joins", () => {
        const near = [
            scene("a", { duration: 5, visualTransition: "dip_black", visualTransitionDuration: 1 }),
            scene("b", { duration: 2, timelinePositionSeconds: 5.04 }),
        ];
        const [lane] = buildSceneLanes(placeScenes(near, []), 30);
        expect(lane.items.map((item) => item.kind)).toEqual(["scene", "scene"]);
        expect(lane.items[1].start).toBe(5);
        expect([...lane.joins.keys()]).toEqual([0]);
    });

    it("an overlapping scene keeps its uncovered tail", () => {
        const overlap = [scene("a", { duration: 3 }), scene("b", { duration: 3, timelinePositionSeconds: 2, cardConfig: JSON.stringify({ trimStart: 1 }) })];
        const [lane] = buildSceneLanes(placeScenes(overlap, []), 30);
        const second = lane.items[1];
        expect(second.kind).toBe("scene");
        if (second.kind === "scene") {
            expect(second.start).toBe(3);
            expect(second.duration).toBe(2);
            expect(second.trimStart).toBe(2);
            expect(second.offset).toBe(1);
        }
    });

    it("total duration counts visual clips, audio only as a fallback", () => {
        const clip = (trackType: string, endTime: number) => optimisticTimelineClipFromInput({ trackType, startTime: 0, endTime }, "p", `${trackType}${endTime}`);
        expect(timelineDuration(scenes.slice(0, 1), [clip("audio", 10), clip("text", 4)])).toBe(4);
        expect(timelineDuration([], [clip("audio", 10)])).toBe(10);
    });

    it("active windows prefer V1, then the highest track", () => {
        const placed = placeScenes([
            scene("a", { duration: 2 }),
            scene("o", { duration: 6, trackIndex: 2 }),
            scene("p", { duration: 6, trackIndex: 3 }),
        ], []);
        expect(activeSceneWindows(placed).map((w) => [w.placed.scene.id, w.start, w.end])).toEqual([["a", 0, 2], ["p", 2, 6]]);
    });
});
