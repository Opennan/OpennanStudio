import type { SceneData } from "@opennan/timeline-core";
import { FilterGraph } from "../graph";
import { resolveOutputFormat } from "../presets";
import { sceneSpeedProfile } from "@opennan/timeline-core/motion/speed";
import { pieceRead, remapFilters } from "../speed-remap";
import { buildSceneLanes, placeScenes, sceneDuration } from "../timeline-model";
import type { MediaInfo } from "../types";
import type { CompileContext } from "./context";
import { compileSceneLanes } from "./lanes";

function scene(id: string, start: number, duration: number, patch: Partial<SceneData> = {}): SceneData {
    return {
        id, order: 0, caption: "", startTime: "0", endTime: "0", startImageUrl: null, endImageUrl: null, videoUrl: null,
        sourceVideoUrl: `/m/${id}.webm`, status: "ready", transition: "cut", cardType: "source_clip", duration,
        frameConsistencyScore: null, audioUrl: null, audioText: null, cardConfig: null, timelinePositionSeconds: start || 0.001, ...patch,
    };
}

function context(media: Record<string, MediaInfo>, duration: number): CompileContext {
    return { graph: new FilterGraph(), format: resolveOutputFormat("16:9", "720p"), duration, media: new Map(Object.entries(media)), rasters: new Map(), warnings: [], files: [], fileKeys: new Map() };
}
const video = (width = 640, height = 360): MediaInfo => ({ durationSeconds: 10, hasVideo: true, hasAudio: false, width, height });

describe("compileSceneLanes", () => {
    it("joins scenes and black gaps into one V1 stream", () => {
        const ctx = context({ "/m/a.webm": video(), "/m/b.webm": video(480, 360) }, 7);
        const lanes = buildSceneLanes(placeScenes([scene("a", 0, 2), scene("b", 3, 2, { fitMode: "cover" })], []), 30);
        const pad = compileSceneLanes(ctx, lanes);
        const graph = ctx.graph.toString();
        expect(ctx.graph.inputs.map((i) => i.options)).toEqual([["-ss", "0.000", "-t", "2.000"], ["-ss", "0.000", "-t", "2.000"]]);
        expect(graph).toContain("color=c=black:s=1280x720:r=30:d=1.000");
        expect(graph).toContain("scale=1280:960");
        expect(graph).toContain("overlay=x=0:y=-120:eof_action=pass:format=auto");
        expect(graph).toContain("color=c=black:s=1280x720:r=30:d=2.000,format=yuv420p,settb=1/30[gap");
        expect(graph).toContain("[sc2][gap3][sc6][gap7]concat=n=4:v=1:a=0");
        expect(graph.endsWith(`[${pad}]`)).toBe(true);
    });

    it("centers a transition window on the cut without changing the lane length", () => {
        const ctx = context({ "/m/a.webm": video(), "/m/b.webm": video() }, 4);
        compileSceneLanes(ctx, buildSceneLanes(placeScenes([
            scene("a", 0, 2, { visualTransition: "dip_white", visualTransitionDuration: 1 }), scene("b", 2, 2),
        ], []), 30));
        const graph = ctx.graph.toString();
        // a: body [0, 1.5) and tail [1.5, 2); b: head [0, 0.5) and body [0.5, 2): separate reads.
        expect(ctx.graph.inputs.map((i) => `${i.source}${i.options.join(" ")}`)).toEqual([
            "/m/a.webm-ss 0.000 -t 1.500", "/m/a.webm-ss 1.500 -t 0.500", "/m/b.webm-ss 0.000 -t 0.500", "/m/b.webm-ss 0.500 -t 1.500",
        ]);
        expect(graph).toContain("tpad=stop_mode=clone:stop=17,setpts=N/30/TB,fps=30,format=gbrp");
        expect(graph).toContain("tpad=start_mode=clone:start=15:stop_mode=clone:stop=2,setpts=N/30/TB,fps=30,format=gbrp");
        expect(graph).toContain(",trim=end_frame=30,format=yuv420p");
        expect(graph).toMatch(/xfade=transition=custom:duration=1:offset=0:threads=1:expr='if\(eq\(PLANE,0\),/);
        expect(graph).toContain("concat=n=3:v=1:a=0");
        expect(graph).not.toContain("fade=t=");
    });

    it("applies a scene look before the background and keeps transparent lanes in gbrap windows", () => {
        const ctx = context({ "/m/a.webm": video(), "/m/b.webm": video() }, 4);
        compileSceneLanes(ctx, buildSceneLanes(placeScenes([
            scene("a", 0, 2, { visualFilter: "noir", adjustmentsJson: '{"vignette":0.4}', effects: [{ id: "r", clipId: null, sceneId: "a", effectId: "fx_rgb_split", order: 0, paramsJson: null, enabled: true, ownerScope: "project" }] }),
            scene("b", 0, 1, { trackIndex: 2, visualTransition: "wipe_left", visualTransitionDuration: 0.4 }), scene("c", 1, 1, { trackIndex: 2 }),
        ], []), 30));
        const graph = ctx.graph.toString();
        expect(ctx.files.map((f) => f.name)).toEqual(["look-0.png", "mask-1.png"]);
        // webm may carry alpha: the look runs on the color and the alpha plane is merged back.
        expect(graph).toMatch(/\[sf\d+\]format=rgba,split=2/);
        expect(graph).toContain("alphamerge");
        expect(graph).toContain("haldclut=interp=trilinear");
        expect(graph).toContain("blend=all_mode=multiply");
        expect(graph).toMatch(/geq=i=n:r='/);
        expect(graph).toContain("format=gbrap");
        expect(graph).toMatch(/expr='if\(eq\(PLANE,0\),.*eq\(PLANE,2\)/);
    });

    it("keeps the alpha of media that may carry it (webm, stills) through a scene look; opaque video stays rgb24", () => {
        const ctx = context({ "/m/a.webm": video(), "/m/b.mp4": video() }, 4);
        compileSceneLanes(ctx, buildSceneLanes(placeScenes([
            scene("a", 0, 2, { visualFilter: "noir" }),
            scene("b", 2, 2, { visualFilter: "noir", sourceVideoUrl: "/m/b.mp4" }),
        ], []), 30));
        const graph = ctx.graph.toString();
        expect(graph.match(/alphaextract/g)).toHaveLength(1);
        expect(graph).toMatch(/\[sf\d+\]format=rgb24\[lk\d+\]/);
    });

    it("stacks V2 scenes as a transparent lane and warns about unreadable media", () => {
        const ctx = context({ "/m/a.webm": video() }, 3);
        compileSceneLanes(ctx, buildSceneLanes(placeScenes([scene("a", 0, 3), scene("o", 1, 1, { trackIndex: 2 })], []), 30));
        const graph = ctx.graph.toString();
        expect(graph).toContain("color=c=black@0:s=1280x720:r=30:d=1.000,format=yuva420p");
        expect(graph).toContain("overlay=0:0:eof_action=pass:format=auto[ln");
        expect(ctx.warnings).toEqual([{ code: "media-unreadable", message: "Scene media could not be read; it exports as black.", sceneId: "o" }]);
    });

    it("loops still-image scenes", () => {
        const ctx = context({ "/m/i.png": { durationSeconds: 0, hasVideo: true, hasAudio: false, width: 320, height: 180 } }, 2);
        compileSceneLanes(ctx, buildSceneLanes(placeScenes([scene("i", 0, 2, { sourceVideoUrl: null, cardType: "image", startImageUrl: "/m/i.png" })], []), 30));
        expect(ctx.graph.inputs[0]).toEqual({ kind: "media", source: "/m/i.png", options: ["-loop", "1", "-framerate", "30", "-t", "2.000"] });
    });

    it("plays shot-sequenced scenes shot by shot (preview ShotSequencerV2)", () => {
        const ctx = context({ "/m/s1.webm": video(), "/m/s2.webm": video(480, 360) }, 3);
        const shots = JSON.stringify([{ duration: 2, video_url: "/m/s1.webm" }, { duration: 1, video_url: "/m/s2.webm" }]);
        compileSceneLanes(ctx, buildSceneLanes(placeScenes([scene("g", 0, 3, { cardType: "ai_video", sourceVideoUrl: null, shotBreakdown: shots })], []), 30));
        expect(ctx.graph.inputs.map((i) => [i.source, i.options])).toEqual([
            ["/m/s1.webm", ["-ss", "0.000", "-t", "2.000"]],
            ["/m/s2.webm", ["-ss", "0.000", "-t", "1.000"]],
        ]);
        expect(ctx.graph.toString()).toContain("concat=n=2:v=1:a=0");
        expect(ctx.warnings).toEqual([]);
    });

    it("sped-up scenes read their source span from absolute timestamps and remap it", () => {
        const ctx = context({ "/m/a.webm": video() }, 2);
        compileSceneLanes(ctx, buildSceneLanes(placeScenes([scene("a", 0, 4, { playbackSpeed: 2 })], []), 30));
        expect(ctx.graph.inputs.map((i) => i.options)).toEqual([["-ss", "0.000", "-t", "4.250"]]);
        expect(ctx.graph.toString()).toContain("[0:v]settb=AVTB,setpts='((clip(T,0,4)/2)+gte(T,4)*0.066666667+0.000003333)/TB',fps=30,scale=1280:720,setsar=1[sf");
        expect(ctx.graph.toString()).toContain("color=c=black:s=1280x720:r=30:d=2.000");
    });

    it("curve scenes with a transition: every piece reads from S(piece start) and the windows keep their frames", () => {
        const hero = JSON.stringify({ id: "hero", points: [[0, 1], [0.28, 1], [0.42, 0.25], [0.58, 0.25], [0.72, 1], [1, 1]] });
        const a = scene("a", 0, 3.1, { speedCurveJson: hero, cardConfig: JSON.stringify({ trimStart: 0.5 }), visualTransition: "dip_white", visualTransitionDuration: 1 });
        const D = sceneDuration(a);
        expect(D).toBeCloseTo(4, 9);
        const ctx = context({ "/m/a.webm": video(), "/m/b.webm": video() }, 6);
        compileSceneLanes(ctx, buildSceneLanes(placeScenes([a, scene("b", 4, 2)], []), 30));
        const profile = sceneSpeedProfile(a);
        const body = pieceRead({ profile, length: D, from: 0, duration: 3.5, origin: 0.5, rate: 1 });
        const tail = pieceRead({ profile, length: D, from: 3.5, duration: 0.5, origin: 0.5, rate: 1 });
        expect(ctx.graph.inputs.slice(0, 2).map((i) => i.options)).toEqual([
            ["-ss", body.readStart.toFixed(3), "-t", body.readLength.toFixed(3)],
            ["-ss", tail.readStart.toFixed(3), "-t", tail.readLength.toFixed(3)],
        ]);
        expect(tail.readStart).toBeGreaterThan(2.5);
        const graph = ctx.graph.toString();
        expect(graph).toContain(`[1:v]${remapFilters(tail.remap, 30).join(",")},fps=30,`);
        expect(graph).toContain("tpad=stop_mode=clone:stop=17,setpts=N/30/TB,fps=30,format=gbrp");
        expect(graph).toContain(",trim=end_frame=30,format=yuv420p");
        expect(graph).toContain("color=c=black:s=1280x720:r=30:d=0.500");
    });

    it("shot-sequenced scenes remap each shot through the scene speed", () => {
        const ctx = context({ "/m/s1.webm": video(), "/m/s2.webm": video() }, 1.5);
        const shots = JSON.stringify([{ duration: 2, video_url: "/m/s1.webm" }, { duration: 1, video_url: "/m/s2.webm" }]);
        compileSceneLanes(ctx, buildSceneLanes(placeScenes([scene("g", 0, 3, { cardType: "ai_video", sourceVideoUrl: null, shotBreakdown: shots, playbackSpeed: 2 })], []), 30));
        expect(ctx.graph.inputs.map((i) => [i.source, i.options])).toEqual([
            ["/m/s1.webm", ["-ss", "0.000", "-t", "2.250"]],
            ["/m/s2.webm", ["-ss", "0.000", "-t", "1.250"]],
        ]);
        expect(ctx.graph.toString()).toContain("[1:v]settb=AVTB,setpts='(max(0,(clip((T+2),0,3)/2)-1)+gte((T+2),3)*0.066666667+0.000003333)/TB',fps=30,");
        expect(ctx.graph.toString()).toContain("concat=n=2:v=1:a=0");
    });

    it("gap and background lengths never round up past their last frame (color emits frames while t < d)", () => {
        const ctx = context({ "/m/a.webm": video() }, 2);
        // 59 frames = 1.96667 s: "1.967" would make color emit a 60th frame.
        compileSceneLanes(ctx, buildSceneLanes(placeScenes([scene("a", 0, 59 / 30)], []), 30));
        expect(ctx.graph.toString()).toContain("color=c=black:s=1280x720:r=30:d=1.966,");
        expect(ctx.graph.toString()).not.toContain("d=1.967");
    });

    it("scenes without motion keep the 10a static fit (rotation 0, opacity 1, look-only keyframes)", () => {
        const ctx = context({ "/m/a.webm": video() }, 2);
        compileSceneLanes(ctx, buildSceneLanes(placeScenes([scene("a", 0, 2, { rotationDegrees: 360, opacity: 1, transformScale: 0.5, keyframesJson: JSON.stringify([{ time: 0, adj_exposure: 0.2 }]) })], []), 30));
        const graph = ctx.graph.toString();
        expect(graph).toContain("scale=640:360");
        expect(graph).toContain("overlay=x=320:y=180:eof_action=pass:format=auto");
        expect(graph).not.toContain("eval=frame");
    });

    it("places a moving scene per frame at scene-local time: scale, opacity, position on the frame centre", () => {
        const ctx = context({ "/m/a.webm": video() }, 2);
        compileSceneLanes(ctx, buildSceneLanes(placeScenes([scene("a", 0, 2, { animationJson: JSON.stringify({ in: { id: "zoom_in", duration: 0.5 } }) })], []), 30));
        const graph = ctx.graph.toString();
        // zoom_in peaks at 1: the scale-1 fit (1280×720) is the reference.
        expect(graph).toContain("fps=30,scale=1280:720,setsar=1[sf");
        expect(graph).toContain("format=yuva444p,geq=lum='lum(X,Y)':cb='cb(X,Y)':cr='cr(X,Y)':a='alpha(X,Y)*clip(clip((clip(((floor(T*30+0.5)/30)/0.5),0,1)/0.4),0,1),0,1)+0.5'");
        expect(graph).toMatch(/scale=w='max\(1,round\(1280\*max\(0,.*clip\(\(\(floor\(t\*30\+0\.5\)\/30\)\/0\.5\).*\)\/1\)\)':h='max\(1,round\(720\*max\(0,.*\)\/1\)\)':eval=frame,pad=w=1284:h=724:/);
        expect(graph).toMatch(/overlay=x='2\*floor\(\(\(640\+\(\(0\)\/100\+0\)\*1280\)-642-\(-mod\(1284-.*\),2\)\/2\)\)\/2\+0\.5\)':y='2\*floor\(\(\(360\+.*':eval=frame:eof_action=pass:format=auto,format=yuv420p/);
        expect(graph).not.toContain("rotate=");
    });

    it("a moving scene that only reaches a tiny scale fits at a clamped reference (no division by a zero-formatted peak)", () => {
        const ctx = context({ "/m/a.webm": video() }, 2);
        // fmt() writes 1e-8 as "0": the old reference made every scale expression divide by zero.
        const tiny = { transformScale: 1e-8, animationJson: JSON.stringify({ in: { id: "slide_left", duration: 0.5 } }) };
        compileSceneLanes(ctx, buildSceneLanes(placeScenes([scene("a", 0, 2, tiny)], []), 30));
        const graph = ctx.graph.toString();
        expect(graph).not.toMatch(/\/0\)/);
        expect(graph).toContain("fps=30,scale=2:2,setsar=1[sf");
        expect(graph).toMatch(/scale=w='max\(1,round\(2\*max\(0,.*\)\/0\.001\)\)'/);
    });

    it("a moving scene is invisible while its scale is not positive (the preview draws nothing there)", () => {
        const ctx = context({ "/m/a.webm": video() }, 2);
        compileSceneLanes(ctx, buildSceneLanes(placeScenes([scene("a", 0, 2, { keyframesJson: JSON.stringify([{ time: 0, scale: -0.5 }, { time: 2, scale: 1 }]) })], []), 30));
        const graph = ctx.graph.toString();
        expect(graph).toMatch(/:eval=frame:eof_action=pass:format=auto:enable='gt\(.*floor\(t\*30\+0\.5\)\/30.*,0\)',format=yuv420p/);
        // Scenes that stay positive keep the plain overlay (no enable).
        const plain = context({ "/m/a.webm": video() }, 2);
        compileSceneLanes(plain, buildSceneLanes(placeScenes([scene("a", 0, 2, { keyframesJson: JSON.stringify([{ time: 0, scale: 0.5 }, { time: 2, scale: 1 }]) })], []), 30));
        expect(plain.graph.toString()).not.toContain("enable=");
    });

    it("pieces of a moving scene keep scene-local time across a transition (head, body, tail)", () => {
        const ctx = context({ "/m/a.webm": video(), "/m/b.webm": video() }, 4);
        const keys = JSON.stringify([{ time: 0, rotation_degrees: 0 }, { time: 2, rotation_degrees: 90 }]);
        compileSceneLanes(ctx, buildSceneLanes(placeScenes([
            scene("a", 0, 2, { visualTransition: "cross_dissolve", visualTransitionDuration: 1 }), scene("b", 2, 2, { keyframesJson: keys }),
        ], []), 30));
        const graph = ctx.graph.toString();
        // b's head starts at scene second 0, its body at 0.5: the rotation reads t and t + 0.5 (window-local t on the frame grid).
        expect(graph).toContain("rotate=a='(if(lte((floor(t*30+0.5)/30),0),0,if(gte((floor(t*30+0.5)/30),2),90,(90*clip(((floor(t*30+0.5)/30)/2),0,1)))))*PI/180':c=black@0:ow=1476:oh=1476");
        expect(graph).toContain("rotate=a='(if(lte(((floor(t*30+0.5)/30)-(-0.5)),0),0,if(gte(((floor(t*30+0.5)/30)-(-0.5)),2),90,(90*clip((((floor(t*30+0.5)/30)-(-0.5))/2),0,1)))))*PI/180'");
    });

    it("a scene with Adjust keyframes cross-fades one CLUT per keyframe with the eased weight at scene-local time", () => {
        const ctx = context({ "/m/a.mp4": video() }, 2);
        const keys = JSON.stringify([{ time: 0, adj_exposure: 0 }, { time: 1, adj_exposure: 0.5, easing: 1 }, { time: 2, adj_exposure: -0.2 }]);
        compileSceneLanes(ctx, buildSceneLanes(placeScenes([scene("a", 0, 2, { sourceVideoUrl: "/m/a.mp4", keyframesJson: keys })], []), 30));
        const graph = ctx.graph.toString();
        expect(ctx.files).toHaveLength(3);
        expect(graph).toMatch(/format=rgb24,split=3\[ks\d+\]\[ks\d+\]\[ks\d+\]/);
        expect(graph.match(/haldclut=interp=trilinear,format=gbrp/g)).toHaveLength(3);
        // Keyframe 1 over keyframe 0: linear over [0, 1]; keyframe 2 over that: ease in over [1, 2].
        expect(graph).toContain("blend=all_expr='A+(B-A)*(floor(clip(clip((((floor(T*30+0.5)/30)-0)/(1-0)),0,1),0,1)*1024+0.5)/1024)'");
        expect(graph).toContain("blend=all_expr='A+(B-A)*(floor(clip(((clip((((floor(T*30+0.5)/30)-1)/(2-1)),0,1)*clip((((floor(T*30+0.5)/30)-1)/(2-1)),0,1))*clip((((floor(T*30+0.5)/30)-1)/(2-1)),0,1)),0,1)*1024+0.5)/1024)'");
    });

    describe("live transition handles", () => {
        const trims = (start: number, end: number, content?: number) =>
            JSON.stringify({ timelineTrimStart: start, timelineTrimEnd: end, ...(content !== undefined ? { timelineSourceDuration: content } : {}) });

        it("the outgoing tail reads real media after its trim end and clones only the rest; the incoming head starts earlier", () => {
            const ctx = context({ "/m/a.webm": video(), "/m/b.webm": video() }, 4);
            compileSceneLanes(ctx, buildSceneLanes(placeScenes([
                // a: media 0..2 of 10 s (8 s after); b: media 0.2..2.2 (0.2 s before).
                scene("a", 0, 2, { cardConfig: trims(0, 2, 10), visualTransition: "wipe_left", visualTransitionDuration: 1 }),
                scene("b", 2, 2, { cardConfig: trims(0.2, 2.2, 10) }),
            ], []), 30));
            const graph = ctx.graph.toString();
            expect(ctx.graph.inputs.map((i) => `${i.source}${i.options.join(" ")}`)).toEqual([
                "/m/a.webm-ss 0.000 -t 1.500", "/m/a.webm-ss 1.500 -t 1.000", "/m/b.webm-ss 0.000 -t 0.700", "/m/b.webm-ss 0.700 -t 1.500",
            ]);
            // a: 15 live frames after the cut, nothing cloned but the 2 spare frames; b: 6 live frames, 9 cloned.
            expect(graph).toContain("tpad=stop_mode=clone:stop=2,setpts=N/30/TB,fps=30,format=gbrp");
            expect(graph).toContain("tpad=start_mode=clone:start=9:stop_mode=clone:stop=2,setpts=N/30/TB,fps=30,format=gbrp");
            // Window and lane length unchanged: 30 window frames, bodies of 1.5 s.
            expect(graph).toContain(",trim=end_frame=30,format=yuv420p");
            expect(graph).toContain("color=c=black:s=1280x720:r=30:d=1.000,");
            expect(graph).toContain("color=c=black:s=1280x720:r=30:d=0.700,");
        });

        it("never reads past the probed media end and keeps frozen frames for unknown lengths", () => {
            const ctx = context({ "/m/a.webm": video(), "/m/b.webm": video() }, 4);
            compileSceneLanes(ctx, buildSceneLanes(placeScenes([
                scene("a", 0, 2, { cardConfig: trims(8, 10, 30), visualTransition: "wipe_left", visualTransitionDuration: 1 }),
                scene("b", 2, 2, { cardConfig: trims(1, 3) }),
                scene("c", 4, 2, { cardConfig: trims(0.1, 2.1, 10) }),
            ], []), 30));
            // a's file is 10 s long (probe), though the stored length says 30: no media after its trim end.
            expect(ctx.graph.inputs.map((i) => `${i.source}${i.options.join(" ")}`).slice(0, 3)).toEqual([
                "/m/a.webm-ss 8.000 -t 1.500", "/m/a.webm-ss 9.500 -t 0.500", "/m/b.webm-ss 0.500 -t 1.000",
            ]);
            expect(ctx.graph.toString()).toContain("tpad=stop_mode=clone:stop=17,");
            expect(ctx.graph.toString()).toContain("tpad=start_mode=clone:start=0:stop_mode=clone:stop=2,");
        });

        it("still scenes have full handles: the image simply plays on", () => {
            const still = { durationSeconds: 0, hasVideo: true, hasAudio: false, width: 1280, height: 720 };
            const ctx = context({ "/m/i.png": still, "/m/j.png": still }, 4);
            compileSceneLanes(ctx, buildSceneLanes(placeScenes([
                scene("i", 0, 2, { sourceVideoUrl: null, cardType: "image", startImageUrl: "/m/i.png", visualTransition: "cross_dissolve", visualTransitionDuration: 1 }),
                scene("j", 2, 2, { sourceVideoUrl: null, cardType: "image", startImageUrl: "/m/j.png" }),
            ], []), 30));
            expect(ctx.graph.inputs.map((i) => i.options.join(" "))).toEqual([
                "-loop 1 -framerate 30 -t 1.500", "-loop 1 -framerate 30 -t 1.000", "-loop 1 -framerate 30 -t 1.000", "-loop 1 -framerate 30 -t 1.500",
            ]);
            expect(ctx.graph.toString()).toContain("tpad=stop_mode=clone:stop=2,");
            expect(ctx.graph.toString()).toContain("tpad=start_mode=clone:start=0:stop_mode=clone:stop=2,");
        });

        it("sped-up scenes read their handles at the scene speed factor as separate pieces", () => {
            const ctx = context({ "/m/a.webm": video(), "/m/b.webm": video() }, 4);
            compileSceneLanes(ctx, buildSceneLanes(placeScenes([
                // 2x: media 0..4 fills 2 s; 0.4 media seconds after the end = 0.2 timeline seconds.
                scene("a", 0, 2, { playbackSpeed: 2, cardConfig: trims(0, 4, 4.4), visualTransition: "wipe_left", visualTransitionDuration: 1 }),
                scene("b", 2, 2),
            ], []), 30));
            const graph = ctx.graph.toString();
            const ext = pieceRead({ profile: { speed: 2, curve: null, preservePitch: true }, length: 0.2, from: 0, duration: 0.2, origin: 4, rate: 1 });
            expect(ctx.graph.inputs[2].options).toEqual(["-ss", ext.readStart.toFixed(3), "-t", ext.readLength.toFixed(3)]);
            const joined = graph.match(/\[sc\d+\]\[sc\d+\]concat=n=2:v=1:a=0,settb=1\/30\[(cc\d+)\]/)!;
            expect(graph).toContain(`[${joined[1]}]tpad=stop_mode=clone:stop=11,`);
        });

        it("shot-sequenced scenes stay frozen", () => {
            const ctx = context({ "/m/s1.webm": video(), "/m/b.webm": video() }, 4);
            const shots = JSON.stringify([{ duration: 2, video_url: "/m/s1.webm" }]);
            compileSceneLanes(ctx, buildSceneLanes(placeScenes([
                scene("g", 0, 2, { cardType: "ai_video", sourceVideoUrl: null, shotBreakdown: shots, visualTransition: "wipe_left", visualTransitionDuration: 1 }),
                scene("b", 2, 2, { cardConfig: trims(0.5, 2.5, 10) }),
            ], []), 30));
            expect(ctx.graph.toString()).toContain("tpad=stop_mode=clone:stop=17,");
            expect(ctx.graph.toString()).toContain("tpad=start_mode=clone:start=0:stop_mode=clone:stop=2,");
        });
    });

    it("warns and keeps the first 8 Adjust keyframes", () => {
        const ctx = context({ "/m/a.mp4": video() }, 2);
        const keys = JSON.stringify(Array.from({ length: 10 }, (_, i) => ({ time: i / 5, adj_exposure: (i % 2) / 2 })));
        compileSceneLanes(ctx, buildSceneLanes(placeScenes([scene("a", 0, 2, { sourceVideoUrl: "/m/a.mp4", keyframesJson: keys })], []), 30));
        expect(ctx.graph.toString().match(/haldclut/g)).toHaveLength(8);
        expect(ctx.warnings).toEqual([expect.objectContaining({ code: "look-keyframes-limited", sceneId: "a" })]);
    });
});
