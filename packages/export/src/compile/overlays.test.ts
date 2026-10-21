import { optimisticTimelineClipFromInput } from "@opennan/timeline-core/lib/timeline-optimistic";
import { FilterGraph } from "../graph";
import { resolveOutputFormat } from "../presets";
import { planRasterJobs } from "../raster/jobs";
import type { CompileContext } from "./context";
import { overlayScale } from "./overlay-scale";
import { compileOverlay, overlayReadSpan, overlaySourceSpan } from "./overlays";

const clip = (input: Record<string, unknown>) => optimisticTimelineClipFromInput({ trackType: "video", trackIndex: 2, startTime: 1, endTime: 3, ...input }, "p", "c");
const ctx = (): CompileContext => ({ graph: new FilterGraph(), format: resolveOutputFormat("16:9", "1080p"), duration: 4, media: new Map(), rasters: new Map(), warnings: [], files: [], fileKeys: new Map() });
const media = (c: ReturnType<typeof clip>, video = true) => ({
    clip: c, input: { kind: "media" as const, source: "/m/v.webm", options: [] }, video, text: false,
    outer: { width: 640, height: 360 }, box: { width: 640, height: 360 }, baseScale: 1,
});

describe("overlayScale", () => {
    it("is static without keyframes, animation, or motion", () => {
        expect(overlayScale(clip({ scale: 0.7 }))).toEqual({ animated: false, reference: 0.7, layout: 0.7, scaleXPeak: 1 });
    });
    it("references the largest scale reached", () => {
        expect(overlayScale(clip({ scale: 1, keyframesJson: JSON.stringify([{ time: 0, scale: 0.5 }, { time: 1, scale: 1.4 }]) }))).toEqual({ animated: true, reference: 1.4, layout: 1.4, scaleXPeak: 1 });
        expect(overlayScale(clip({ scale: 2, motionPreset: "zoom_in" })).reference).toBeCloseTo(2.16);
    });
    it("samples animation scale and |scaleX| peaks at the clip's frame times (layout keeps the 10a rule)", () => {
        // bounce_in overshoots to about 1.18 of the clip scale.
        const bounce = overlayScale(clip({ scale: 0.5, animationJson: JSON.stringify({ in: { id: "bounce_in", duration: 1 } }) }));
        expect(bounce.layout).toBe(0.5);
        expect(bounce.reference).toBeGreaterThan(0.5 * 1.1);
        expect(bounce.reference).toBeLessThan(0.5 * 1.25);
        // combo_wobble widens the layer up to 1.08 × scale (the peak between frames is not reached).
        const wobble = overlayScale(clip({ animationJson: JSON.stringify({ combo: { id: "combo_wobble" } }) })).scaleXPeak;
        expect(wobble).toBeGreaterThan(1.07);
        expect(wobble).toBeLessThanOrEqual(1.08);
        // Fades animate opacity only: the bitmap stays at the clip scale.
        expect(overlayScale(clip({ scale: 0.8, fadeInDuration: 0.5 }))).toEqual({ animated: true, reference: 0.8, layout: 0.8, scaleXPeak: 1 });
    });
});

describe("compileOverlay", () => {
    it("static clips: time filters, clip filters, opacity, rotation, placement", () => {
        const c = ctx();
        const out = compileOverlay(c, "base", media(clip({
            scale: 0.5, opacity: 0.5, rotationDegrees: 90, playbackSpeed: 2, reversePlayback: true, horizontalFlip: true, brightness: 0.2, positionX: 0, positionY: 0,
        })));
        const graph = c.graph.toString();
        // Reverse applies to the source first (the read span, trimmed of its slack), then the speed remaps it.
        expect(graph).toContain("[0:v]setpts=PTS-STARTPTS,trim=end=4,reverse,settb=AVTB,setpts='((clip(T,0,4)/2)+gte(T,4)*0.066666667+0.000003333)/TB',fps=30,trim=duration=2.000,scale=320:180[op");
        // Brightness is part of the clip's look: a Hald CLUT on packed RGB, as the preview samples it.
        expect(graph).toContain("haldclut=interp=trilinear");
        expect(graph).toMatch(/\]hflip,format=rgba,colorchannelmixer=aa=0.5,rotate=a=1.5708:c=none:ow=368:oh=368,setpts=PTS-STARTPTS\+1\/TB\[ol/);
        expect(c.files.map((f) => f.name)).toEqual(["look-0.png"]);
        expect(graph).toContain(`overlay=x=-24:y=-94:eof_action=pass:format=auto:enable='between(t,1,3)'[${out}]`);
    });

    it("animated clips scale per frame (frame time t) and move through the overlay's per-frame position (t - start)", () => {
        const c = ctx();
        compileOverlay(c, "base", media(clip({ keyframesJson: JSON.stringify([{ time: 0, position_x: 0, scale: 0.5 }, { time: 2, position_x: 1, scale: 1 }]) }), false));
        const graph = c.graph.toString();
        expect(graph).not.toContain("perspective");
        expect(graph).toMatch(/scale=w='max\(1,round\(\d+\*\(\(.*floor\(t\*30.*\)\/[\d.]+\)\)\)':h='.*':eval=frame,pad=w=\d+:h=\d+:x='\(ow-iw\)\/2':y='\(oh-ih\)\/2':color=black@0:eval=frame/);
        expect(graph).not.toContain("n/30");
        expect(graph).toMatch(/overlay=x='.*\(\(floor\(t\*30\+0\.5\)\/30\)-1\).*':y='.*':eval=frame:eof_action=pass:format=auto:enable='between\(t,1,3\)'/);
    });

    it("a tiny clip scale is referenced at a clamped minimum (no division by a zero-formatted reference)", () => {
        expect(overlayScale(clip({ scale: 1e-10, keyframesJson: JSON.stringify([{ time: 0, position_x: 0 }, { time: 2, position_x: 1 }]) })).reference).toBe(0.001);
        const c = ctx();
        compileOverlay(c, "base", media(clip({ scale: 1e-10, keyframesJson: JSON.stringify([{ time: 0, position_x: 0 }, { time: 2, position_x: 1 }]) })));
        const graph = c.graph.toString();
        expect(graph).not.toMatch(/\/0\)/);
        expect(graph).toContain(")/0.001)");
    });

    it("an animated clip is invisible while its scale is not positive (the preview draws nothing there)", () => {
        const c = ctx();
        compileOverlay(c, "base", media(clip({ keyframesJson: JSON.stringify([{ time: 0, scale: -1 }, { time: 2, scale: 1 }]) })));
        expect(c.graph.toString()).toMatch(/:eval=frame:eof_action=pass:format=auto:enable='between\(t,1,3\)\*gt\(.*\(floor\(t\*30\+0\.5\)\/30\)-1.*,0\)'\[ov/);
        // In a clip lane (range mode, no timeline enable) the gate stands alone.
        const lane = ctx();
        compileOverlay(lane, "base", media(clip({ keyframesJson: JSON.stringify([{ time: 0, scale: 0 }, { time: 2, scale: 1 }]) })), { from: 0, to: 2, after: 0 });
        expect(lane.graph.toString()).toMatch(/:eval=frame:eof_action=pass:format=auto:enable='gt\(.*,0\)'\[ov/);
        // Clips that stay positive keep the timeline enable alone.
        const plain = ctx();
        compileOverlay(plain, "base", media(clip({ keyframesJson: JSON.stringify([{ time: 0, scale: 0.5 }, { time: 2, scale: 1 }]) })));
        expect(plain.graph.toString()).toContain("format=auto:enable='between(t,1,3)'[ov");
        // A constant scale of 0 (a lone scale keyframe) draws nothing at all.
        const none = ctx();
        expect(compileOverlay(none, "base", media(clip({ keyframesJson: JSON.stringify([{ time: 0.5, scale: 0 }]) })))).toBe("base");
        expect(none.graph.toString()).not.toContain("overlay");
    });

    it("legacy fades keep the 10a alpha fade filters (opacity = base × fades); no geq, static placement", () => {
        const c = ctx();
        compileOverlay(c, "base", media(clip({ fadeInDuration: 0.5, fadeOutDuration: 0.25, opacity: 0.8, transitionType: "cross_dissolve" })));
        const graph = c.graph.toString();
        expect(graph).toContain("format=yuva444p,fade=t=in:st=0:d=0.5:alpha=1,fade=t=out:st=1.75:d=0.25:alpha=1,format=rgba,colorchannelmixer=aa=0.8,setpts=PTS-STARTPTS+1/TB");
        expect(graph).not.toContain("geq");
        expect(graph).toContain("overlay=x=640:y=360:eof_action=pass");
    });

    it("an opacity animation replaces the legacy fades with the model's opacity channel (fades included); dips stay colour fades", () => {
        const c = ctx();
        compileOverlay(c, "base", media(clip({ fadeOutDuration: 0.5, animationJson: JSON.stringify({ in: { id: "fade_in", duration: 0.5 } }) })));
        const graph = c.graph.toString();
        expect(graph).not.toContain("fade=t=");
        expect(graph).toMatch(/format=yuva444p,geq=lum='lum\(X,Y\)':cb='cb\(X,Y\)':cr='cr\(X,Y\)':a='alpha\(X,Y\)\*clip\(.*T.*\)\+0\.5'/);
        // Placement stays static: only opacity moves.
        expect(graph).toContain("overlay=x=640:y=360:eof_action=pass");
        const dip = ctx();
        compileOverlay(dip, "base", media(clip({ fadeInDuration: 0.5, transitionType: "dip_white", animationJson: JSON.stringify({ out: { id: "fade_out", duration: 0.5 } }) })));
        expect(dip.graph.toString()).toContain("fade=t=in:st=0:d=0.5:color=white");
        expect(dip.graph.toString()).toContain("geq=lum=");
    });

    it("clip animations place per frame: |scaleX| on the width, dx/dy in the overlay position, rotation per frame", () => {
        const c = ctx();
        compileOverlay(c, "base", media(clip({ scale: 0.5, animationJson: JSON.stringify({ in: { id: "flip_in", duration: 0.5 }, out: { id: "slide_left_out", duration: 0.5 } }) })));
        const graph = c.graph.toString();
        expect(graph).toMatch(/scale=w='max\(1,round\(320\*\(\(0\.5\)\/0\.5\)\*abs\(.*clip\(\(\(floor\(t\*30\+0\.5\)\/30\)\/0\.5\).*\)\)\)':h='max\(1,round\(180\*\(\(0\.5\)\/0\.5\)\)\)':eval=frame/);
        // Centre + dx·W, minus half the layer, minus pad's half-pixel shift for the frame's width, to an even pixel.
        expect(graph).toMatch(/overlay=x='2\*floor\(.*\(\(floor\(t\*30\+0\.5\)\/30\)-1\).*\*1920\)-162-\(-mod\(324-\(max\(1,round\(320\*.*\),2\)\/2\)\)\/2\+0\.5\)':y='2\*floor\(/);
        expect(graph).not.toContain("rotate=");
        const spin = ctx();
        compileOverlay(spin, "base", media(clip({ animationJson: JSON.stringify({ in: { id: "spin_in", duration: 0.5 } }) })));
        expect(spin.graph.toString()).toMatch(/rotate=a='\(.*floor\(t\*30.*\)\*PI\/180':c=black@0/);
    });

    it("a lone scale keyframe is a constant scale: static placement at that scale", () => {
        const c = ctx();
        compileOverlay(c, "base", media(clip({ scale: 1, keyframesJson: JSON.stringify([{ time: 0.5, scale: 0.5 }]) })));
        const graph = c.graph.toString();
        expect(graph).toContain("scale=320:180");
        expect(graph).toContain("overlay=x=800:y=450:eof_action=pass");
    });

    it("the motion preset is the model's scale channel, ignored when scale is keyframed (as in 10a)", () => {
        const c = ctx();
        compileOverlay(c, "base", media(clip({ motionPreset: "zoom_in", keyframesJson: JSON.stringify([{ time: 0, scale: 0.5 }, { time: 2, scale: 1 }]) })));
        expect(c.graph.toString()).not.toContain("0.08");
        const preset = ctx();
        compileOverlay(preset, "base", media(clip({ motionPreset: "zoom_in" })));
        expect(preset.graph.toString()).toContain("0.08");
    });

    it("Adjust keyframes grade the clip with one CLUT per keyframe, blended at the clip's own time (after its time filters)", () => {
        const c = ctx();
        compileOverlay(c, "base", media(clip({ brightness: 0.2, keyframesJson: JSON.stringify([{ time: 0, adj_exposure: -0.3, easing: 4 }, { time: 1, adj_exposure: 0.3 }]) })));
        const graph = c.graph.toString();
        // Two keyframe CLUTs (the static brightness is part of each keyframe's look), no third static one.
        expect(c.files).toHaveLength(2);
        expect(graph).toMatch(/\[op\d+\]format=rgba,split=2/);
        expect(graph).toMatch(/format=rgb24,split=2\[ks\d+\]\[ks\d+\]/);
        expect(graph).toContain("blend=all_expr='A+(B-A)*(floor(clip(if(gte(clip((((floor(T*30+0.5)/30)-0)/(1-0)),0,1),1),1,0),0,1)*1024+0.5)/1024)'");
        // A single keyframe is one CLUT and no blend.
        const one = ctx();
        compileOverlay(one, "base", media(clip({ keyframesJson: JSON.stringify([{ time: 0.5, adj_exposure: 0.3 }]) })));
        expect(one.graph.toString()).not.toContain("blend=");
        expect(one.graph.toString()).toContain("haldclut=interp=trilinear");
    });

    it("video overlays read the source span of their speed or ramp", () => {
        expect(overlaySourceSpan(clip({ playbackSpeed: 1.5 }))).toBe(3);
        // hero over a 2 s clip: 0.35·0.45 + 0.3·1.35 + 0.35·0.65 = 0.79 source seconds per second.
        expect(overlaySourceSpan(clip({ speedRamp: "hero" }))).toBeCloseTo(1.58);
        // A legacy ramp is its step curve: same span, one remap through the curve's exact inverse.
        const c = ctx();
        compileOverlay(c, "base", media(clip({ speedRamp: "bullet", playbackSpeed: 2 })));
        expect(c.graph.toString()).toContain("[0:v]setpts=PTS-STARTPTS,settb=AVTB,setpts='(clip(if(lt(T,");
        expect(c.graph.toString()).not.toContain("setpts=PTS/2");
    });

    it("speed curves set the span, and the read adds slack only when the clip is remapped", () => {
        const hero = JSON.stringify({ id: "hero", points: [[0, 1], [0.28, 1], [0.42, 0.25], [0.58, 0.25], [0.72, 1], [1, 1]] });
        // mean(hero) = 0.28 + 0.14·0.625 + 0.16·0.25 + 0.14·0.625 + 0.28 = 0.775
        expect(overlaySourceSpan(clip({ speedCurveJson: hero }))).toBeCloseTo(1.55, 9);
        expect(overlaySourceSpan(clip({ playbackSpeed: 50 }))).toBe(100);
        expect(overlayReadSpan(clip({ playbackSpeed: 50 }))).toBe(100.25);
        expect(overlayReadSpan(clip({}))).toBe(2);
    });

    it("1x reverse and frozen clips keep their 10a filters", () => {
        const reversed = ctx();
        compileOverlay(reversed, "base", media(clip({ reversePlayback: true })));
        expect(reversed.graph.toString()).toContain("[0:v]setpts=PTS-STARTPTS,reverse,fps=30,trim=duration=2.000");
        const frozen = ctx();
        compileOverlay(frozen, "base", media(clip({ freezeFrame: true, playbackSpeed: 3 })));
        expect(frozen.graph.toString()).toContain("[0:v]setpts=PTS-STARTPTS,fps=30,trim=end_frame=1,setpts=PTS-STARTPTS,loop=loop=59:size=1:start=0,setpts=N/30/TB,trim=duration=2.000");
        expect(frozen.graph.toString()).not.toContain("settb");
    });
});

describe("planRasterJobs", () => {
    it("plans text and emoji bitmaps at the reference scale", () => {
        const format = resolveOutputFormat("16:9", "720p");
        const jobs = planRasterJobs([
            optimisticTimelineClipFromInput({ trackType: "text", textContent: "Hi", scale: 2 }, "p", "t"),
            optimisticTimelineClipFromInput({ trackType: "text", textContent: "   " }, "p", "blank"),
            optimisticTimelineClipFromInput({ trackType: "sticker", textContent: "★" }, "p", "e"),
            optimisticTimelineClipFromInput({ trackType: "sticker", mediaUrl: "/s.png" }, "p", "img"),
        ], format);
        expect(jobs).toEqual([
            { kind: "text", id: "text-t", clipId: "t", text: "Hi", textStyle: null, scale: 2, frameScale: format.frameScale, frameWidth: 1280 },
            { kind: "emoji", id: "emoji-e", clipId: "e", text: "★", scale: 1, frameScale: format.frameScale },
        ]);
    });
});

describe("text and sticker masks (phase 10d)", () => {
    it("text runs its mask alone on the alpha, in the layout box centred in the padded raster (static: the reference image)", async () => {
        const { encodePng } = await import("@opennan/timeline-core/looks/png");
        const { maskImage, parseMask } = await import("@opennan/timeline-core/looks/masks");
        const c = ctx();
        const maskJson = '{"shape":"star","x":0.4,"width":0.6,"height":0.9,"rotation":12,"feather":0.1}';
        const text = clip({ trackType: "text", trackIndex: 1, textContent: "Hi", visualFilter: "warm", maskJson });
        compileOverlay(c, "base", {
            clip: text, input: { kind: "file", source: "raster-0.png", options: [] }, video: false, text: true,
            outer: { width: 120, height: 60 }, box: { width: 100, height: 40 }, baseScale: 1,
        });
        const graph = c.graph.toString();
        // No look (the filter is not applied to text), the mask multiplies the raster's alpha.
        expect(graph).not.toContain("haldclut");
        expect(graph).toContain("alphaextract");
        expect(graph).toContain("blend=all_mode=multiply");
        const file = c.files.find((f) => f.name.startsWith("mask-"))!;
        expect([...file.data]).toEqual([...encodePng({ width: 120, height: 60, channels: 1, data: maskImage(parseMask(maskJson)!, 120, 60, [], 0, { x: 10, y: 10, width: 100, height: 40 }) })]);
    });

    it("a keyframed text mask is geq on the alpha with the box shift; text without a mask has no look", () => {
        const c = ctx();
        const keyframesJson = JSON.stringify({ keyframes: [{ time: 0, mask_x: 0.2 }, { time: 2, mask_x: 0.8 }] });
        const source = (input: Record<string, unknown>) => ({
            clip: clip({ trackType: "text", trackIndex: 1, textContent: "Hi", ...input }), input: { kind: "file" as const, source: "raster-0.png", options: [] }, video: false, text: true,
            outer: { width: 120, height: 60 }, box: { width: 100, height: 40 }, baseScale: 1,
        });
        compileOverlay(c, "base", source({ maskJson: '{"shape":"circle"}', keyframesJson }));
        const graph = c.graph.toString();
        expect(graph).toMatch(/geq=i=n:lum='floor\(lum\(X,Y\)\*.*\(X-10\).*\/255\)'/);
        const plain = ctx();
        compileOverlay(plain, "base", source({ visualFilter: "warm" }));
        expect(plain.graph.toString()).not.toContain("alphaextract");
        expect(plain.files).toEqual([]);
    });
});

