import { clip, input, scene, info, raster } from "../compile/test-helpers";
import type { MediaInfo, RasterResult } from "../types";
import { chromaKeyUv, eqPlanes } from "@opennan/timeline-core/looks/legacy";
import { planGpuExport, type DrawOp, type LaneOp, type LayerOp } from "./plan";

const FORMAT = { width: 1280, height: 720, fps: 30, aspectRatio: 16 / 9, refWidth: 1920, refHeight: 1080, frameScale: 2 / 3 };
const MEDIA = new Map<string, MediaInfo>([
    ["/m/a.webm", info({ width: 1280, height: 720, durationSeconds: 10 })],
    ["/m/b.webm", info({ width: 640, height: 360, durationSeconds: 10 })],
    ["/m/s.png", info({ durationSeconds: 0, hasAudio: false, width: 100, height: 100 })],
]);
const plan = (timeline: ReturnType<typeof input>, rasters: Map<string, RasterResult> = new Map(), gl = false) => planGpuExport(timeline, FORMAT, { media: MEDIA, rasters, gl });
const lanes = (ops: DrawOp[]) => ops.filter((op): op is LaneOp => op.kind === "lane");
const layers = (ops: DrawOp[]) => ops.filter((op): op is LayerOp => op.kind === "layer");

describe("planGpuExport", () => {
    const twoScenes = input({
        scenes: [
            scene("a", 0, 2, { sourceVideoUrl: "/m/a.webm", visualTransition: "cross_dissolve", visualTransitionDuration: 1, visualFilter: "warm" }),
            scene("b", 2, 2, { sourceVideoUrl: "/m/b.webm" }),
        ],
    });

    it("draws the main track as an opaque lane with a centered transition window", () => {
        const p = plan(twoScenes);
        expect(p.frameCount).toBe(120);
        const body = lanes(p.drawList(10));
        expect(body).toHaveLength(1);
        expect(body[0].opaque).toBe(true);
        expect(body[0].transition).toBeUndefined();
        expect(body[0].a?.look?.plan?.steps.length).toBeGreaterThan(0);
        // 0.5 s each side of the cut at 2 s: frames 45..74.
        const first = lanes(p.drawList(45))[0];
        expect(first).toMatchObject({ transition: "cross_dissolve", p: 0 });
        const middle = lanes(p.drawList(60))[0];
        expect(middle.p).toBeCloseTo(0.5, 9);
        expect(middle.a?.source.kind).toBe("video");
        expect(middle.b?.source.kind).toBe("video");
        expect(lanes(p.drawList(75))[0].transition).toBeUndefined();
    });

    it("fits each scene's media into the frame (static fit, centred)", () => {
        const p = plan(twoScenes);
        const a = lanes(p.drawList(10))[0].a!;
        expect(a.place).toMatchObject({ cx: 640, cy: 360, width: 1280, height: 720, rotation: 0 });
        const b = lanes(p.drawList(100))[0].a!;
        expect(b.bitmap).toEqual({ width: 1280, height: 720 });
    });

    it("lists every read with the frames that use it, for decoder lifetimes", () => {
        const p = plan(twoScenes);
        const urls = p.reads.map((r) => r.read.url);
        expect(new Set(urls)).toEqual(new Set(["/m/a.webm", "/m/b.webm"]));
        const a = p.reads.filter((r) => r.read.url === "/m/a.webm");
        expect(Math.min(...a.map((r) => r.first))).toBe(0);
        // The outgoing scene's tail read lasts to the end of the window.
        expect(Math.max(...a.map((r) => r.last))).toBe(74);
        // One forward stream per lane item and file.
        expect(new Set(a.map((r) => r.read.stream)).size).toBe(1);
    });

    it("draws overlays only while they are on screen, with their motion and fades", () => {
        const timeline = input({
            scenes: [scene("a", 0, 4, { sourceVideoUrl: "/m/a.webm" })],
            clips: [
                clip("o", { trackType: "video", trackIndex: 2, startTime: 1, endTime: 3, mediaUrl: "/m/b.webm", mediaType: "video", scale: 0.5, fadeInDuration: 0.5,
                    keyframesJson: JSON.stringify([{ time: 0, rotation_degrees: 0 }, { time: 2, rotation_degrees: 90 }]) }),
                clip("s", { trackType: "sticker", trackIndex: 1, startTime: 0, endTime: 4, mediaUrl: "/m/s.png", mediaType: "image", scale: 1 }),
            ],
        });
        const p = plan(timeline);
        expect(layers(p.drawList(15)).map((l) => l.source.kind)).toEqual(["image"]);
        const at = (k: number) => layers(p.drawList(k)).find((l) => l.source.kind === "video")!;
        // A plain fade-in is the legacy alpha fade (fadeAlpha), as the ffmpeg path's fade filter.
        expect(at(30).fadeAlpha).toBeCloseTo(0, 6);
        expect(at(45).fadeAlpha).toBeCloseTo(1, 6);
        expect(at(60).place.rotation).toBeCloseTo(Math.PI / 4, 6);
        expect(layers(p.drawList(90)).map((l) => l.source.kind)).toEqual(["image"]);
        // Overlays draw above the lane, lower tracks first, stickers after video clips.
        expect(p.drawList(45).map((op) => op.kind)).toEqual(["lane", "layer", "layer"]);
    });

    it("draws text from its raster and leaves out text without one", () => {
        const text = clip("t", { trackType: "text", trackIndex: 1, startTime: 0, endTime: 2, textContent: "Hi" });
        const withRaster = plan(input({ scenes: [scene("a", 0, 2, { sourceVideoUrl: "/m/a.webm" })], clips: [text] }), new Map([["text-t", raster]]));
        expect(layers(withRaster.drawList(5))[0].source).toEqual({ kind: "raster", id: "text-t", cell: null });
        const without = plan(input({ scenes: [scene("a", 0, 2, { sourceVideoUrl: "/m/a.webm" })], clips: [text] }));
        expect(layers(without.drawList(5))).toHaveLength(0);
        expect(without.warnings.map((w) => w.code)).toContain("text-unsupported");
    });

    it("runs effect-track spans on the composite and legacy GL passes only when asked", () => {
        const span = clip("fx", { trackType: "effect", trackIndex: 1, startTime: 1, endTime: 2 });
        span.effects = [{ id: "r", clipId: "fx", sceneId: null, effectId: "fx_rgb_split", order: 0, paramsJson: null, enabled: true, ownerScope: "p" }];
        const timeline = input({ scenes: [scene("a", 0, 3, { sourceVideoUrl: "/m/a.webm" })], clips: [span] });
        const p = plan(timeline);
        expect(p.drawList(20).some((op) => op.kind === "span")).toBe(false);
        const op = p.drawList(45).find((o) => o.kind === "span");
        expect(op).toMatchObject({ kind: "span", time: 0.5 });
        const legacy = clip("gl", { trackType: "effect", trackIndex: 1, startTime: 0, endTime: 1 });
        legacy.effects = [{ id: "g", clipId: "gl", sceneId: null, effectId: "glow", order: 0, paramsJson: null, enabled: true, ownerScope: "p" }];
        const withGl = { ...input({ scenes: [scene("a", 0, 2, { sourceVideoUrl: "/m/a.webm" })], clips: [legacy] }), effects: [{ id: "glow", name: "Glow", kind: "effect" as const, category: "", params: [], glsl: "x", thumbnail: null, ownerScope: "builtin" }] };
        expect(plan(withGl, new Map(), true).drawList(10).some((o) => o.kind === "gl")).toBe(true);
        expect(plan(withGl, new Map(), false).drawList(10).some((o) => o.kind === "gl")).toBe(false);
    });

    it("draws black where there is no scene (gaps, the end of the main track)", () => {
        const timeline = input({ scenes: [scene("a", 1, 1, { sourceVideoUrl: "/m/a.webm" })], clips: [clip("s", { trackType: "sticker", trackIndex: 1, startTime: 0, endTime: 3, mediaUrl: "/m/s.png", mediaType: "image" })] });
        const p = plan(timeline);
        expect(p.frameCount).toBe(90);
        expect(lanes(p.drawList(10))[0]).toMatchObject({ opaque: true, a: null });
        expect(lanes(p.drawList(40))[0].a).not.toBeNull();
        expect(lanes(p.drawList(80))[0]).toMatchObject({ a: null });
    });

    it("masks text, emoji, and stickers (phase 10d): text runs its mask alone, in the layout box centred in the padded bitmap", () => {
        const base = scene("a", 0, 2, { sourceVideoUrl: "/m/a.webm" });
        const maskJson = '{"shape":"circle","width":0.5,"height":0.5}';
        const keyframesJson = JSON.stringify({ keyframes: [{ time: 0, mask_x: 0.2 }, { time: 1, mask_x: 0.8 }] });
        const text = clip("t", { trackType: "text", trackIndex: 1, startTime: 0, endTime: 2, textContent: "Hi", visualFilter: "warm", maskJson, keyframesJson });
        const layer = layers(plan(input({ scenes: [base], clips: [text] }), new Map([["text-t", raster]])).drawList(15))[0];
        // The raster: a 120×60 bitmap around a 100×40 box (pad 10), drawn at its own scale.
        expect(layer.look?.plan?.steps.map((step) => step.kind)).toEqual(["mask"]);
        expect(layer.look?.mix).toBeNull();
        expect(layer.look).toMatchObject({ time: 0.5, keyframeTime: 0.5, maskBox: { x: 10, y: 10, width: 100, height: 40 } });
        // Without a mask, text still draws no look.
        const plain = layers(plan(input({ scenes: [base], clips: [{ ...text, maskJson: null }] }), new Map([["text-t", raster]])).drawList(15))[0];
        expect(plain.look).toBeNull();
        // An image sticker is its own box: the mask spans the bitmap (no box), after the sticker's look.
        const sticker = clip("s", { trackType: "sticker", trackIndex: 1, startTime: 0, endTime: 2, mediaUrl: "/m/s.png", mediaType: "image", visualFilter: "warm", maskJson });
        const stickerLayer = layers(plan(input({ scenes: [base], clips: [sticker] })).drawList(15))[0];
        expect(stickerLayer.look?.plan?.steps.map((step) => step.kind)).toEqual(["lut", "mask"]);
        expect(stickerLayer.look?.maskBox).toBeUndefined();
        // An emoji raster pads its box like text.
        const emoji = clip("e", { trackType: "sticker", trackIndex: 1, startTime: 0, endTime: 2, textContent: "★", maskJson });
        const emojiLayer = layers(plan(input({ scenes: [base], clips: [emoji] }), new Map([["emoji-e", { ...raster, id: "emoji-e", width: 90, height: 90, boxWidth: 70, boxHeight: 70 }]])).drawList(15))[0];
        expect(emojiLayer.look?.maskBox).toEqual({ x: 10, y: 10, width: 70, height: 70 });
    });

    describe("legacy blur, chroma key, and blend modes (compile/overlays.ts filters)", () => {
        const overlay = (patch: Record<string, unknown>) =>
            clip("o", { trackType: "video", trackIndex: 2, startTime: 0, endTime: 2, mediaUrl: "/m/b.webm", mediaType: "video", scale: 0.5, ...patch });
        const layerOf = (patch: Record<string, unknown>, id = "o") => {
            const p = plan(input({ scenes: [scene("a", 0, 2, { sourceVideoUrl: "/m/a.webm" })], clips: [overlay(patch)] }));
            return layers(p.drawList(15)).find(() => id === "o")!;
        };

        it("leaves layers without them alone", () => {
            expect(layerOf({}).legacy ?? null).toBeNull();
        });

        it("blurs decoded video on its 4:2:0 planes with the truncated radius", () => {
            expect(layerOf({ blurStrength: 3.7 }).legacy).toEqual({ blur: { radius: 3, mode: "yuv420" }, chromaKey: null, eq: null });
        });

        it("keys and grades in YUV, per 2×2 chroma block for video without a look", () => {
            const legacy = layerOf({ blurStrength: 2, chromaKeyEnabled: true, chromaKeyColor: "#00ff00", chromaKeySimilarity: 0.2, chromaKeyBlend: 0.05, blendMode: "overlay" }).legacy;
            expect(legacy).toEqual({
                blur: { radius: 2, mode: "yuv420" },
                chromaKey: { key: { ...chromaKeyUv("0x00FF00"), similarity: 0.2, blend: 0.05 }, subsampled: true },
                eq: eqPlanes({ brightness: 0, contrast: 1.25, saturation: 1.1 }),
            });
        });

        it("runs on 4:4:4 YUV after a look and on planar RGB for a lone blur on RGB input", () => {
            const looked = layerOf({ visualFilter: "warm", blurStrength: 2, blendMode: "multiply" }).legacy!;
            expect(looked.blur).toEqual({ radius: 2, mode: "yuv444" });
            expect(layerOf({ visualFilter: "warm", blurStrength: 2 }).legacy!.blur).toEqual({ radius: 2, mode: "rgb" });
            const sticker = plan(input({
                scenes: [scene("a", 0, 2, { sourceVideoUrl: "/m/a.webm" })],
                clips: [clip("s", { trackType: "sticker", trackIndex: 1, startTime: 0, endTime: 2, mediaUrl: "/m/s.png", mediaType: "image", blurStrength: 4 })],
            }));
            expect(layers(sticker.drawList(5))[0].legacy).toEqual({ blur: { radius: 4, mode: "rgb" }, chromaKey: null, eq: null });
        });

        it("follows a legacy alpha fade's yuva444p unless a mosaic sits in between", () => {
            expect(layerOf({ blurStrength: 2, fadeInDuration: 0.5 }).legacy!.blur).toEqual({ radius: 2, mode: "yuv444" });
            expect(layerOf({ blurStrength: 2, fadeInDuration: 0.5, mosaicStrength: 4 }).legacy!.blur).toEqual({ radius: 2, mode: "yuv420" });
            expect(layerOf({ chromaKeyEnabled: true, fadeInDuration: 0.5 }).legacy!.chromaKey!.subsampled).toBe(false);
        });

        it("applies them to text rasters too, as the ffmpeg path does", () => {
            const text = clip("t", { trackType: "text", trackIndex: 1, startTime: 0, endTime: 2, textContent: "Hi", blendMode: "screen" });
            const p = plan(input({ scenes: [scene("a", 0, 2, { sourceVideoUrl: "/m/a.webm" })], clips: [text] }), new Map([["text-t", raster]]));
            expect(layers(p.drawList(5))[0].legacy).toEqual({ blur: null, chromaKey: null, eq: eqPlanes({ brightness: 0.08, contrast: 0.9, saturation: 1 }) });
        });
    });
});

describe("planGpuExport graphics", () => {
    const graphic = (patch: Record<string, unknown> = {}) => clip("g", { trackType: "remotion", trackIndex: 1, startTime: 0.5, endTime: 1, remotionTemplateId: "lower-third", ...patch });
    const doc = (clips: ReturnType<typeof clip>[]) => input({ scenes: [scene("a", 0, 2, { sourceVideoUrl: "/m/a.webm" })], clips });

    it("draws a graphics op on exactly the frames the ffmpeg path overlays, between video and text", () => {
        const text = clip("t", { trackType: "text", trackIndex: 1, startTime: 0, endTime: 2, textContent: "Hi" });
        const p = plan(doc([graphic(), text]), new Map([["text-t", raster]]));
        expect(p.graphics).toEqual([{ clipId: "g", clip: { templateId: "lower-third", propsJson: null, startTime: 0.5, endTime: 1 }, first: 15, last: 29 }]);
        expect(p.drawList(14).some((op) => op.kind === "graphics")).toBe(false);
        expect(p.drawList(30).some((op) => op.kind === "graphics")).toBe(false);
        const ops = p.drawList(20);
        const kinds = ops.map((op) => op.kind);
        expect(kinds.indexOf("graphics")).toBeGreaterThan(kinds.indexOf("lane"));
        expect(kinds.lastIndexOf("layer")).toBeGreaterThan(kinds.indexOf("graphics"));
        const op = ops.find((o) => o.kind === "graphics");
        expect(op).toMatchObject({ clipId: "g", entry: { frame: 5, opacity: 1 } });
    });

    it("skips custom-code graphics and frames where the layer is hidden", () => {
        expect(plan(doc([graphic({ remotionCode: "x" })])).graphics).toEqual([]);
        const hidden = plan(doc([graphic({ opacity: 0 })]));
        expect(hidden.drawList(20).some((op) => op.kind === "graphics")).toBe(false);
    });
});


describe("planGpuExport: V2+ video overlays honour trimStart", () => {
    const overlay = (patch: Record<string, unknown>) => plan(input({
        clips: [clip("o", { trackType: "video", trackIndex: 2, startTime: 1, endTime: 3, mediaUrl: "/m/b.webm", mediaType: "video", ...patch })],
    }));
    const video = (ops: DrawOp[]) => layers(ops).find((l) => l.source.kind === "video");
    /** Media second a video layer shows (the read anchors on the first frame at or after its seek; 30 fps media here). */
    const mediaTime = (layer: LayerOp | LaneOp["a"] | undefined) => {
        const source = layer!.source;
        if (source.kind !== "video") throw new Error("not video");
        return source.read.seek + source.read.offsetAt(source.index);
    };

    it("a plain clip reads from its trimStart (untrimmed clips from media zero)", () => {
        expect(mediaTime(video(overlay({ trimStart: 2, trimEnd: 4 }).drawList(45)))).toBeCloseTo(2.5 + 0.5 / 30, 4);
        expect(mediaTime(video(overlay({}).drawList(45)))).toBeCloseTo(0.5 + 0.5 / 30, 4);
    });

    it("speed remaps from trimStart; reverse plays [trimStart, trimStart + span] backwards; freeze holds trimStart", () => {
        // 2×: local 0.5 s (+ half a frame) is 1.0333 source seconds after trimStart.
        expect(mediaTime(video(overlay({ trimStart: 2, playbackSpeed: 2 }).drawList(45)))).toBeCloseTo(2 + 2 * (0.5 + 0.5 / 30), 3);
        const reversed = video(overlay({ trimStart: 1.5, reversePlayback: true }).drawList(45))!;
        expect(reversed.source.kind === "video" && [reversed.source.read.seek, reversed.source.read.reverse]).toEqual([1.5, { span: 2 }]);
        const frozen = overlay({ trimStart: 3, freezeFrame: true });
        expect(mediaTime(video(frozen.drawList(35)))).toBeCloseTo(3 + 0.5 / 30, 4);
        expect(mediaTime(video(frozen.drawList(80)))).toBeCloseTo(3 + 0.5 / 30, 4);
    });

    it("a split pair joined by a transition shows the same media on both sides of the window (live handles both ways)", () => {
        const p = plan(input({
            clips: [
                clip("a", { trackType: "video", trackIndex: 2, startTime: 0, endTime: 2, mediaUrl: "/m/b.webm", mediaType: "video", trimStart: 0, trimEnd: 2, transitionType: "cross_dissolve", transitionDuration: 1 }),
                clip("b", { trackType: "video", trackIndex: 2, startTime: 2, endTime: 4, mediaUrl: "/m/b.webm", mediaType: "video", trimStart: 2, trimEnd: 4 }),
            ],
        }));
        for (const k of [50, 70]) {
            const lane = lanes(p.drawList(k)).find((op) => op.transition === "cross_dissolve")!;
            const t = k / 30 + 0.5 / 30;
            expect(mediaTime(lane.a)).toBeCloseTo(t, 3);
            expect(mediaTime(lane.b)).toBeCloseTo(t, 3);
        }
        // An untrimmed outgoing clip's after-handle is live too (it froze on the clip's last frame before).
        const unsplit = plan(input({
            clips: [
                clip("a", { trackType: "video", trackIndex: 2, startTime: 0, endTime: 2, mediaUrl: "/m/b.webm", mediaType: "video", transitionType: "cross_dissolve", transitionDuration: 1 }),
                clip("b", { trackType: "video", trackIndex: 2, startTime: 2, endTime: 4, mediaUrl: "/m/a.webm", mediaType: "video" }),
            ],
        }));
        expect(mediaTime(lanes(unsplit.drawList(70)).find((op) => op.transition)!.a)).toBeCloseTo(70 / 30 + 0.5 / 30, 3);
        // The body of b continues the media past the cut.
        const body = lanes(p.drawList(100)).find((op) => !op.transition)!;
        expect(mediaTime(body.a)).toBeCloseTo(100 / 30 + 0.5 / 30, 3);
    });
});
