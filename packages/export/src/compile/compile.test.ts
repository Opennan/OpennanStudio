import type { EffectDef } from "@opennan/timeline-core";
import { gplFiltersIn } from "../lgpl-filters";
import { collectMediaUrls, compileExport, staticExportWarnings } from "./index";
import { clip, info, input, raster, scene } from "./test-helpers";

describe("compileExport", () => {
    const scenes = [
        scene("a", 0, 2, { visualTransition: "cross_dissolve", visualTransitionDuration: 1, cardConfig: JSON.stringify({ trimStart: 0.5 }) }),
        scene("b", 2, 2),
    ];
    const media = new Map([["/m/a.webm", info()], ["/m/b.webm", info({ hasAudio: false })]]);

    it("builds the V1 lane with trims, fit, and a centered dissolve window", () => {
        const plan = compileExport(input({ scenes }), { resolution: "720p" }, { media, rasters: new Map(), gl: false });
        expect(plan.durationSeconds).toBe(4);
        expect(plan.format).toMatchObject({ width: 1280, height: 720, fps: 30 });
        // Scene a is read twice: its body [0, 1.5) and the tail [1.5, 2) the dissolve holds.
        expect(plan.inputs[0]).toEqual({ kind: "media", source: "/m/a.webm", options: ["-ss", "0.500", "-t", "1.500"] });
        expect(plan.inputs[1]).toEqual({ kind: "media", source: "/m/a.webm", options: ["-ss", "2.000", "-t", "0.500"] });
        expect(plan.filterGraph).toContain("scale=1280:720");
        // A 1 s dissolve is a window centered on the cut: 0.5 s held on each side.
        expect(plan.filterGraph).toContain("tpad=stop_mode=clone:stop=17");
        expect(plan.filterGraph).toContain("tpad=start_mode=clone:start=15:stop_mode=clone:stop=2");
        expect(plan.filterGraph).toContain("xfade=transition=custom:duration=1:offset=0:threads=1:expr='");
        expect(plan.videoLabel).toBe("vout");
        expect(plan.audioLabel).toBe("aout");
        // Scene a's embedded audio plays from its trim (two video reads plus the audio read); b has none.
        expect(plan.inputs.filter((i) => i.options.includes("-ss") && i.source === "/m/a.webm")).toHaveLength(3);
        expect(plan.filterGraph).toMatch(/amix=inputs=1:normalize=0/);
    });

    it("overlays text bitmaps and media clips with enable windows", () => {
        const plan = compileExport(input({
            scenes: scenes.slice(1),
            clips: [
                clip("v", { trackType: "video", trackIndex: 2, startTime: 1, endTime: 3, mediaUrl: "/m/v.webm", scale: 0.5, positionX: 1, positionY: 0 }),
                clip("t", { trackType: "text", trackIndex: 1, startTime: 0, endTime: 4, textContent: "Hi", positionX: 0.5, positionY: 0.5 }),
            ],
        }), { resolution: "1080p" }, { media: new Map([...media, ["/m/v.webm", info()]]), rasters: new Map([["text-t", raster]]), gl: false });
        expect(plan.inputs.find((i) => i.source === "/m/v.webm" && !i.options.includes("-ss"))).toEqual({ kind: "media", source: "/m/v.webm", options: ["-t", "2.000"] });
        expect(plan.filterGraph).toContain("scale=320:180");
        expect(plan.filterGraph).toContain("overlay=x=1600:y=0:eof_action=pass:format=auto:enable='between(t,1,3)'");
        expect(plan.inputs.find((i) => i.kind === "file")).toEqual({ kind: "file", source: "raster-0.png", options: ["-loop", "1", "-framerate", "30", "-t", "4.000"] });
        expect(plan.filterGraph).toContain("overlay=x=900:y=510:eof_action=pass:format=auto:enable='between(t,0,4)'");
        expect(plan.files).toEqual([{ name: "raster-0.png", data: raster.png }]);
    });

    it("scales a capped text or emoji bitmap (smaller than its padded box) back up to the box", () => {
        // The rasterizer caps a single bitmap at 4096 px per side and reports the unshrunk box (canvas-rasterizer.ts).
        const capped = { ...raster, width: 4096, height: 1024, boxWidth: 8172, boxHeight: 2028, pad: 10 };
        const text = (bitmap: typeof raster) => compileExport(input({
            clips: [clip("t", { trackType: "text", trackIndex: 1, startTime: 0, endTime: 4, textContent: "Huge", positionX: 0.5, positionY: 0.5 })],
        }), { resolution: "1080p" }, { media: new Map(), rasters: new Map([["text-t", bitmap]]), gl: false }).filterGraph;
        const graph = text(capped);
        expect(graph).toContain("trim=duration=4.000,scale=8192:2048");
        // Placed exactly as the unshrunk bitmap would be (same layer size, same anchor).
        const full = text({ ...capped, width: 8192, height: 2048 });
        const placement = (g: string) => g.match(/overlay=x=-?\d+:y=-?\d+/)?.[0];
        expect(placement(graph)).toBe(placement(full));
        const emoji = compileExport(input({
            clips: [clip("e", { trackType: "sticker", trackIndex: 1, startTime: 0, endTime: 4, textContent: "★" })],
        }), { resolution: "1080p" }, { media: new Map(), rasters: new Map([["emoji-e", { ...raster, id: "emoji-e", width: 4096, height: 4096, boxWidth: 6000, boxHeight: 6000, pad: 1500 }]]), gl: false });
        expect(emoji.filterGraph).toContain("scale=9000:9000");
    });

    it("sped-up overlay clips and gifs read their source span plus slack", () => {
        const plan = compileExport(input({
            clips: [
                clip("v", { trackType: "video", trackIndex: 2, startTime: 0, endTime: 2, mediaUrl: "/m/v.webm", playbackSpeed: 2 }),
                clip("g", { trackType: "video", trackIndex: 2, startTime: 0, endTime: 2, mediaUrl: "/m/g.gif", playbackSpeed: 0.5 }),
            ],
        }), { resolution: "720p" }, { media: new Map([["/m/v.webm", info()], ["/m/g.gif", info()]]), rasters: new Map(), gl: false });
        expect(plan.inputs.find((i) => i.source === "/m/v.webm" && !i.options.includes("-ss"))?.options).toEqual(["-t", "4.250"]);
        expect(plan.inputs.find((i) => i.source === "/m/g.gif")?.options).toEqual(["-ignore_loop", "0", "-min_delay", "1", "-t", "1.250"]);
    });

    it("scales media overlays from the media's own pixel size, also when the frame scale equals it", () => {
        // 1920x1080 at 720p (frameScale 2/3) and at 4K (frameScale 2) both land on whole pixel sizes.
        const full = clip("v", { trackType: "video", trackIndex: 2, startTime: 0, endTime: 2, mediaUrl: "/m/v.webm" });
        const big = new Map([["/m/v.webm", info({ width: 1920, height: 1080 })]]);
        for (const [resolution, size] of [["720p", "1280:720"], ["4k", "3840:2160"]] as const) {
            const plan = compileExport(input({ clips: [full] }), { resolution }, { media: big, rasters: new Map(), gl: false });
            expect(plan.filterGraph, resolution).toContain(`trim=duration=2.000,scale=${size}`);
        }
        const plan = compileExport(input({ clips: [full] }), { resolution: "1080p" }, { media: big, rasters: new Map(), gl: false });
        expect(plan.filterGraph).not.toContain("trim=duration=2.000,scale=");
    });

    it("names raster files itself, never from clip ids, and reports text without a bitmap", () => {
        const id = "../../../../Users/x/Library/LaunchAgents/evil";
        const plan = compileExport(input({
            clips: [
                clip(id, { trackType: "text", trackIndex: 1, startTime: 0, endTime: 2, textContent: "Hi" }),
                clip("nobitmap", { trackType: "text", trackIndex: 1, startTime: 0, endTime: 2, textContent: "Lost" }),
            ],
        }), { resolution: "720p" }, { media: new Map(), rasters: new Map([[`text-${id}`, { ...raster, id: `text-${id}` }]]), gl: false });
        expect(plan.files.map((f) => f.name)).toEqual(["raster-0.png"]);
        expect(plan.inputs.filter((i) => i.kind === "file").map((i) => i.source)).toEqual(["raster-0.png"]);
        expect(JSON.stringify({ inputs: plan.inputs, files: plan.files.map((f) => f.name), graph: plan.filterGraph })).not.toContain("LaunchAgents");
        expect(plan.warnings).toEqual([expect.objectContaining({ code: "text-unsupported", clipId: "nobitmap" })]);
    });

    it("animates keyframed overlays with per-frame scale, rotate, and overlay position", () => {
        const plan = compileExport(input({
            clips: [clip("k", {
                trackType: "sticker", trackIndex: 1, startTime: 0, endTime: 2, mediaUrl: "/m/s.png", mediaType: "image",
                keyframesJson: JSON.stringify([{ time: 0, opacity: 0, rotation_degrees: 0 }, { time: 1, opacity: 1, rotation_degrees: 90 }]),
            })],
        }), { resolution: "720p" }, { media: new Map([["/m/s.png", info({ durationSeconds: 0, hasAudio: false, width: 100, height: 100 })]]), rasters: new Map(), gl: false });
        expect(plan.filterGraph).toContain("geq=lum='lum(X,Y)'");
        expect(plan.filterGraph).toContain("rotate=a='");
        expect(gplFiltersIn(plan.filterGraph)).toEqual([]);
    });

    it("silent timelines still get an audio track", () => {
        const plan = compileExport(input({ scenes: scenes.slice(1) }), { resolution: "720p" }, { media, rasters: new Map(), gl: false });
        expect(plan.filterGraph).toContain("anullsrc=r=48000:cl=stereo");
    });

    it("rejects an empty timeline", () => {
        expect(() => compileExport(input({}), { resolution: "720p" }, { media, rasters: new Map(), gl: false })).toThrow(/empty/);
    });
});

describe("warnings and media urls", () => {
    const def: EffectDef = { id: "glow", name: "Glow", kind: "effect", category: "", params: [], glsl: "x", thumbnail: null, ownerScope: "builtin" };
    const fx = { ...clip("fx", { trackType: "effect", trackIndex: 1, startTime: 0, endTime: 1 }), effects: [{ id: "r", clipId: "fx", sceneId: null, effectId: "glow", order: 0, paramsJson: null, enabled: true, ownerScope: "p" }] };
    const doc = input({
        project: { aspectRatio: "16:9", musicUrl: "/m/music.mp3", musicVolume: 1 },
        scenes: [scene("a", 0, 2, { audioUrl: "/m/vo.mp3" })],
        clips: [fx, clip("rm", { trackType: "remotion", trackIndex: 1, startTime: 0, endTime: 1 }), clip("au", { trackType: "audio", trackIndex: 2, startTime: 0, endTime: 1, mediaUrl: "/m/sfx.wav" })],
        effects: [def],
    });

    it("reports remotion and GL effects the runner cannot render", () => {
        expect(staticExportWarnings(doc, { gl: false }).map((w) => w.code)).toEqual(["remotion-unsupported", "gl-effect-unsupported"]);
        expect(staticExportWarnings(doc, { gl: true }).map((w) => w.code)).toEqual(["remotion-unsupported"]);
    });

    it("warns before probing when an item has more Adjust keyframes than the export blends", () => {
        const many = JSON.stringify(Array.from({ length: 9 }, (_, i) => ({ time: i / 4, adj_exposure: (i % 2) / 2 })));
        const eight = JSON.stringify(Array.from({ length: 8 }, (_, i) => ({ time: i / 4, adj_exposure: (i % 2) / 2 })));
        const warnings = staticExportWarnings(input({
            scenes: [scene("s", 0, 2, { keyframesJson: many }), scene("ok", 2, 2, { keyframesJson: eight })],
            clips: [clip("c", { trackType: "video", trackIndex: 2, startTime: 0, endTime: 2, mediaUrl: "/m/v.webm", keyframesJson: many })],
        }), { gl: true });
        expect(warnings.filter((w) => w.code === "look-keyframes-limited").map((w) => w.clipId ?? w.sceneId)).toEqual(["c", "s"]);
    });

    it("plans GL passes when the runner supports them", () => {
        const plan = compileExport(doc, { resolution: "720p" }, { media: new Map([["/m/a.webm", info()]]), rasters: new Map(), gl: true });
        expect(plan.glPasses).toEqual([{ start: 0, end: 1, effects: [{ id: "glow", glsl: "x", floatParams: {} }] }]);
    });

    it("collects every media url once", () => {
        expect(collectMediaUrls(doc).sort()).toEqual(["/m/a.webm", "/m/music.mp3", "/m/sfx.wav", "/m/vo.mp3"]);
    });
});

describe("V2+ video overlays honour trimStart", () => {
    const media = new Map([["/m/v.webm", info({ hasAudio: false })], ["/m/g.gif", info({ hasAudio: false })]]);
    const overlay = (patch: Record<string, unknown>) => compileExport(input({
        clips: [clip("v", { trackType: "video", trackIndex: 2, startTime: 1, endTime: 3, mediaUrl: "/m/v.webm", mediaType: "video", ...patch })],
    }), { resolution: "720p" }, { media, rasters: new Map(), gl: false });
    const read = (plan: ReturnType<typeof overlay>, url = "/m/v.webm") => plan.inputs.find((i) => i.source === url)?.options;

    it("a plain clip seeks to its trimStart and reads its span (untrimmed clips keep reading from media zero)", () => {
        expect(read(overlay({ trimStart: 2, trimEnd: 4 }))).toEqual(["-ss", "2.000", "-t", "2.000"]);
        expect(read(overlay({ trimStart: 0.0333 }))).toEqual(["-ss", "0.033", "-t", "2.000"]);
        expect(read(overlay({}))).toEqual(["-t", "2.000"]);
        expect(read(overlay({ trimStart: 0 }))).toEqual(["-t", "2.000"]);
    });

    it("speed, reverse, and freeze read from trimStart with their usual filters", () => {
        const sped = overlay({ trimStart: 2, playbackSpeed: 2 });
        expect(read(sped)).toEqual(["-ss", "2.000", "-t", "4.250"]);
        expect(sped.filterGraph).toContain("[0:v]setpts=PTS-STARTPTS,settb=AVTB,setpts='((clip(T,0,4)/2)");
        const reversed = overlay({ trimStart: 1.5, trimEnd: 3.5, reversePlayback: true });
        expect(read(reversed)).toEqual(["-ss", "1.500", "-t", "2.000"]);
        expect(reversed.filterGraph).toContain("[0:v]setpts=PTS-STARTPTS,reverse,fps=30,trim=duration=2.000");
        const frozen = overlay({ trimStart: 3, freezeFrame: true });
        expect(read(frozen)).toEqual(["-ss", "3.000", "-t", "2.000"]);
        expect(frozen.filterGraph).toContain("[0:v]setpts=PTS-STARTPTS,fps=30,trim=end_frame=1,");
    });

    it("GIFs keep looping from their first frame (the preview animates them freely)", () => {
        expect(read(overlay({ mediaUrl: "/m/g.gif", trimStart: 1 }), "/m/g.gif")).toEqual(["-ignore_loop", "0", "-min_delay", "1", "-t", "2.000"]);
    });
});

