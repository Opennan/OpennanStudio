import type { SceneData, TimelineTrack } from "@opennan/timeline-core";
import { optimisticTimelineClipFromInput } from "@opennan/timeline-core/lib/timeline-optimistic";
import { buildAudioSources, sceneAudioUrl } from "./audio-model";
import { placeScenes } from "./timeline-model";

function scene(id: string, start: number, duration: number, patch: Partial<SceneData> = {}): SceneData {
    return {
        id, order: 0, caption: "", startTime: "0", endTime: "0", startImageUrl: null, endImageUrl: null, videoUrl: null,
        sourceVideoUrl: `/m/${id}.webm`, status: "ready", transition: "cut", cardType: "source_clip", duration,
        frameConsistencyScore: null, audioUrl: null, audioText: null, cardConfig: null, timelinePositionSeconds: start || 0.001, ...patch,
    };
}
const track = (type: TimelineTrack["type"], index: number, patch: Partial<TimelineTrack> = {}): TimelineTrack =>
    ({ type, index, label: "", muted: false, locked: false, visible: true, volume: 1, ...patch });

describe("buildAudioSources", () => {
    const tracks = [track("video", 1, { volume: 0.5 }), track("audio", 1, { volume: 0.8 }), track("audio", 2, { volume: 0.5 }), track("video", 2)];

    it("plays source-clip audio from the trim, at A1 × V1 faders", () => {
        const sources = buildAudioSources({
            placed: placeScenes([scene("a", 0, 2, { cardConfig: JSON.stringify({ trimStart: 1 }) })], tracks), tracks, clips: [], musicUrl: null, musicVolume: 1, duration: 2, fps: 30,
        });
        expect(sources).toEqual([expect.objectContaining({ kind: "scene-video", url: "/m/a.webm", start: 0, duration: 2, sourceOffset: 1, volume: 0.4 })]);
    });

    it("plays the scene voiceover instead of embedded audio, unless the timeline owns it", () => {
        const s = scene("a", 0, 2, { audioUrl: "/m/vo.mp3" });
        expect(sceneAudioUrl(s)).toBe("/m/vo.mp3");
        const placed = placeScenes([s], tracks);
        expect(buildAudioSources({ placed, tracks, clips: [], musicUrl: null, musicVolume: 1, duration: 2, fps: 30 })).toEqual([
            expect.objectContaining({ kind: "scene-voiceover", url: "/m/vo.mp3", sceneId: "a" }),
        ]);
        const owned = optimisticTimelineClipFromInput({ trackType: "audio", trackIndex: 2, startTime: 0, endTime: 2, mediaUrl: "/m/vo.mp3", mediaType: "voiceover" }, "p", "vo");
        expect(buildAudioSources({ placed, tracks, clips: [owned], musicUrl: null, musicVolume: 1, duration: 2, fps: 30 }).map((x) => x.kind)).toEqual(["clip"]);
    });

    it("mutes embedded audio where the scene's detached audio sits on the timeline", () => {
        const detached = optimisticTimelineClipFromInput({ trackType: "audio", trackIndex: 2, startTime: 0.5, endTime: 1.5, sceneId: "a", mediaUrl: "/m/x.wav" }, "p", "d");
        const [video] = buildAudioSources({ placed: placeScenes([scene("a", 0, 2)], tracks), tracks, clips: [detached], musicUrl: null, musicVolume: 1, duration: 2, fps: 30 });
        expect(video.muted).toEqual([[0.5, 1.5]]);
    });

    it("music, audio clips and overlay clip audio carry their gains", () => {
        const sources = buildAudioSources({
            placed: [], tracks, musicUrl: "/m/music.mp3", musicVolume: 0.5, duration: 4, fps: 30,
            clips: [
                optimisticTimelineClipFromInput({ trackType: "audio", trackIndex: 2, startTime: 1, endTime: 3, mediaUrl: "/m/sfx.wav", trimStart: 0.5, volume: 0.6 }, "p", "s"),
                optimisticTimelineClipFromInput({ trackType: "video", trackIndex: 2, startTime: 0, endTime: 2, mediaUrl: "/m/v.mp4", volume: 0.5 }, "p", "v"),
                optimisticTimelineClipFromInput({ trackType: "video", trackIndex: 2, startTime: 0, endTime: 2, mediaUrl: "/m/i.png" }, "p", "i"),
            ],
        });
        expect(sources.map((s) => [s.kind, s.url, s.start, s.duration, s.sourceOffset, s.volume, s.trackVolume])).toEqual([
            ["music", "/m/music.mp3", 0, 4, 0, 0.4, 1],
            ["clip", "/m/sfx.wav", 1, 2, 0.5, 0.6, 0.5],
            ["overlay-clip", "/m/v.mp4", 0, 2, 0, 0.5, 1],
        ]);
    });

    it("overlay clip audio starts at the clip's trimStart, like its picture", () => {
        const [source] = buildAudioSources({
            placed: [], tracks, musicUrl: null, musicVolume: 1, duration: 4, fps: 30,
            clips: [optimisticTimelineClipFromInput({ trackType: "video", trackIndex: 2, startTime: 1, endTime: 3, mediaUrl: "/m/v.mp4", trimStart: 2.5, trimEnd: 4.5 }, "p", "v")],
        });
        expect([source.kind, source.start, source.duration, source.sourceOffset]).toEqual(["overlay-clip", 1, 2, 2.5]);
    });

    it("a muted A1 silences scene audio and music", () => {
        const muted = [track("audio", 1, { muted: true })];
        expect(buildAudioSources({ placed: placeScenes([scene("a", 0, 2)], muted), tracks: muted, clips: [], musicUrl: "/m/m.mp3", musicVolume: 1, duration: 2, fps: 30 })).toEqual([]);
    });

    it("shot-sequenced scenes play each shot's own audio at the A1 fader", () => {
        const shots = JSON.stringify([{ duration: 1, video_url: "/m/s1.webm" }, { duration: 1, video_url: "/m/s2.webm" }]);
        const s = scene("g", 0, 2, { cardType: "ai_video", sourceVideoUrl: null, shotBreakdown: shots, autoGenerateAudio: true } as Partial<SceneData>);
        const sources = buildAudioSources({ placed: placeScenes([s], tracks), tracks, clips: [], musicUrl: null, musicVolume: 1, duration: 2, fps: 30 });
        expect(sources.map((x) => [x.kind, x.url, x.start, x.duration, x.sourceOffset, x.volume])).toEqual([
            ["scene-video", "/m/s1.webm", 0, 1, 0, 0.8],
            ["scene-video", "/m/s2.webm", 1, 1, 0, 0.8],
        ]);
    });

    describe("speed (phase 10b)", () => {
        const one = (outputEnd: number, sourceEnd: number, speed: number) => [{ outputStart: 0, outputEnd, sourceStart: 0, sourceEnd, speed }];

        it("scene video follows the scene speed from S(t) after the trim", () => {
            const [source] = buildAudioSources({
                placed: placeScenes([scene("a", 0, 4, { playbackSpeed: 2, cardConfig: JSON.stringify({ trimStart: 1 }) })], tracks), tracks, clips: [], musicUrl: null, musicVolume: 1, duration: 2, fps: 30,
            });
            expect(source).toMatchObject({ kind: "scene-video", start: 0, duration: 2, sourceOffset: 1, stretch: { segments: one(2, 4, 2), preservePitch: true, drift: 0 } });
        });

        it("the active window of a partly covered scene starts at S(into the scene)", () => {
            const placed = placeScenes([scene("a", 0, 4, { playbackSpeed: 2, preservePitch: false }), scene("o", 0, 1, { trackIndex: 3 })], [...tracks, track("video", 3)]);
            const video = buildAudioSources({ placed, tracks, clips: [], musicUrl: null, musicVolume: 1, duration: 2, fps: 30 }).filter((x) => x.url === "/m/a.webm");
            expect(video).toEqual([expect.objectContaining({ start: 0, duration: 2, sourceOffset: 0 })]);
            const late = placeScenes([scene("o", 0, 1, { trackIndex: 1 }), scene("a", 1, 4, { playbackSpeed: 2, preservePitch: false, timelinePositionSeconds: 0.5 })], tracks);
            const tail = buildAudioSources({ placed: late, tracks, clips: [], musicUrl: null, musicVolume: 1, duration: 3, fps: 30 }).find((x) => x.url === "/m/a.webm")!;
            // "o" covers [0, 1) on V1 and "a" starts at 0.5: a's window starts 0.5 s into it = 1 source second.
            expect(tail).toMatchObject({ start: 1, sourceOffset: 1, stretch: { segments: one(1.5, 3, 2), preservePitch: false } });
        });

        it("a scene's own source sound follows its speed; voiceovers stay at 1x (preview sceneAudioFollowsSpeed)", () => {
            const run = (patch: Partial<SceneData>) => buildAudioSources({
                placed: placeScenes([scene("a", 0, 4, { playbackSpeed: 2, ...patch })], tracks), tracks, clips: [], musicUrl: null, musicVolume: 1, duration: 2, fps: 30,
            }).find((x) => x.kind === "scene-voiceover")!;
            const layers = (type: string) => JSON.stringify({ trimStart: 0.5, audio_layers: [{ type, url: "/m/layer.wav" }] });
            expect(run({ cardConfig: layers("extracted") })).toMatchObject({ url: "/m/layer.wav", sourceOffset: 0.5, stretch: { segments: one(2, 4, 2) } });
            expect(run({ cardConfig: layers("voiceover") })).toMatchObject({ url: "/m/layer.wav", sourceOffset: 0.5, stretch: null });
            expect(run({ audioUrl: "/m/own.wav", cardConfig: JSON.stringify({ trimStart: 0.5 }) })).toMatchObject({ sourceOffset: 0.5, stretch: { segments: one(2, 4, 2) } });
            expect(run({ audioUrl: "/m/tts.mp3", cardType: "ai_video", sourceVideoUrl: null, startImageUrl: "/m/i.png" })).toMatchObject({ sourceOffset: 0, stretch: null });
        });

        it("shot audio follows the scene speed per shot", () => {
            const shots = JSON.stringify([{ duration: 1, video_url: "/m/s1.webm" }, { duration: 1, video_url: "/m/s2.webm" }]);
            const s = scene("g", 0, 2, { cardType: "ai_video", sourceVideoUrl: null, shotBreakdown: shots, autoGenerateAudio: true, playbackSpeed: 2 } as Partial<SceneData>);
            const sources = buildAudioSources({ placed: placeScenes([s], tracks), tracks, clips: [], musicUrl: null, musicVolume: 1, duration: 1, fps: 30 });
            expect(sources.map((x) => [x.url, x.start, x.duration, x.sourceOffset, x.stretch?.segments])).toEqual([
                ["/m/s1.webm", 0, 0.5, 0, one(0.5, 1, 2)],
                ["/m/s2.webm", 0.5, 0.5, 0, one(0.5, 1, 2)],
            ]);
        });

        it("overlay clips and audio clips follow their speed profile, legacy ramps exactly", () => {
            const sources = buildAudioSources({
                placed: [], tracks, musicUrl: null, musicVolume: 1, duration: 4, fps: 30,
                clips: [
                    optimisticTimelineClipFromInput({ trackType: "audio", trackIndex: 2, startTime: 0, endTime: 2, mediaUrl: "/m/sfx.wav", trimStart: 0.5, playbackSpeed: 1.25 }, "p", "s"),
                    optimisticTimelineClipFromInput({ trackType: "video", trackIndex: 2, startTime: 0, endTime: 4, mediaUrl: "/m/v.mp4", speedRamp: "montage" }, "p", "v"),
                    optimisticTimelineClipFromInput({ trackType: "video", trackIndex: 2, startTime: 0, endTime: 4, mediaUrl: "/m/w.mp4" }, "p", "w"),
                ],
            });
            expect(sources[0]).toMatchObject({ kind: "clip", sourceOffset: 0.5, stretch: { segments: one(2, 2.5, 1.25) } });
            expect(sources[1].stretch!.segments.map((g) => [g.outputStart, g.outputEnd])).toEqual([[0, 1], [1, 3], [3, 4]]);
            expect(sources[1].stretch!.segments.map((g) => g.speed)).toEqual([0.55, 1.85, 0.75].map((x) => expect.closeTo(x, 12)));
            expect(sources[1].stretch!.drift).toBe(0);
            expect(sources[2].stretch).toBeNull();
        });
    });
});
