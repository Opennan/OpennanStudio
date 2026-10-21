import { describe, expect, it } from "vitest";
import { compileExport } from "./index";
import { TRACKS, clip, info, input, scene, track } from "./test-helpers";
import type { MediaInfo } from "../types";
import type { SceneData, TimelineClip, TimelineTrack } from "@opennan/timeline-core";
import phase10a from "@opennan/timeline-core/motion/__fixtures__/phase10a-project.json";

const still = (patch: Partial<MediaInfo> = {}): MediaInfo => info({ durationSeconds: 0, hasAudio: false, width: 1920, height: 1080, ...patch });
const BASE = [scene("bg", 0, 4, { cardType: "image", sourceVideoUrl: null, startImageUrl: "/m/bg.png" })];
const v2 = (id: string, start: number, end: number, patch: Record<string, unknown> = {}) =>
    clip(id, { trackType: "video", trackIndex: 2, startTime: start, endTime: end, mediaUrl: `/m/${id}.png`, mediaType: "image", scale: 1, ...patch });
const media = (entries: Array<[string, MediaInfo]>) => new Map<string, MediaInfo>([["/m/bg.png", still()], ...entries]);
const compile = (clips: ReturnType<typeof clip>[], entries: Array<[string, MediaInfo]>) =>
    compileExport(input({ scenes: BASE, clips, tracks: [...TRACKS, track("video", 3)] }), { resolution: "720p" }, { media: media(entries), rasters: new Map(), gl: false });

describe("clip transition lanes (upper-track clip cuts)", () => {
    it("blends touching V2 clips with a library transition in a transparent lane on gbrap and overlays the lane once", () => {
        const plan = compile([
            v2("a", 0, 2, { transitionType: "wipe_left", transitionDuration: 1 }),
            v2("b", 2, 4),
        ], [["/m/a.png", still()], ["/m/b.png", still()]]);
        const graph = plan.filterGraph;
        // Each piece places its clip on a clear full frame; the window mixes the pieces with the shared expression.
        expect(graph).toContain("color=c=black@0:s=1280x720:r=30:d=1.500,format=yuva420p,settb=1/30");
        expect(graph).toContain("color=c=black@0:s=1280x720:r=30:d=1.000,format=yuva420p,settb=1/30");
        expect(graph).toMatch(/format=gbrap\[wa\d+\]/);
        expect(graph).toMatch(/xfade=transition=custom:duration=1:offset=0:threads=1:expr='if\(eq\(PLANE,0\),.*eq\(PLANE,2\)/);
        expect(graph).toContain(",trim=end_frame=30,format=yuva420p,settb=1/30");
        // Stills have full handles: nothing is cloned but the window's spare frames.
        expect(graph).toContain("tpad=stop_mode=clone:stop=2,setpts=N/30/TB,fps=30,format=gbrap");
        expect(graph).toContain("tpad=start_mode=clone:start=0:stop_mode=clone:stop=2,setpts=N/30/TB,fps=30,format=gbrap");
        // The lane: 4 s from 0, overlaid on the composite in one step; no per-clip timeline overlays.
        expect(graph).toMatch(/concat=n=3:v=1:a=0,settb=1\/30,setpts=PTS-STARTPTS\+0\/TB\[cl\d+\]/);
        expect(graph).toMatch(/overlay=0:0:eof_action=pass:format=auto:enable='between\(t,0,4\)'\[ov\d+\]/);
        expect(graph).not.toContain("enable='between(t,2,4)'");
        // The image read covers each piece (b's head starts half a second before its own start).
        expect(plan.inputs.filter((i) => i.source === "/m/b.png").map((i) => i.options.join(" "))).toEqual(["-loop 1 -framerate 30 -t 1.000", "-loop 1 -framerate 30 -t 1.500"]);
    });

    it("video clips: the outgoing tail reads real media after the clip (probed length), the incoming head holds its first frame", () => {
        const plan = compile([
            v2("a", 0, 2, { mediaUrl: "/m/a.mp4", mediaType: "video", transitionType: "push_left", transitionDuration: 1 }),
            v2("b", 2, 4, { mediaUrl: "/m/b.mp4", mediaType: "video" }),
        ], [["/m/a.mp4", info({ durationSeconds: 2.2 })], ["/m/b.mp4", info()]]);
        const reads = plan.inputs.filter((i) => i.source.endsWith(".mp4")).slice(0, 4).map((i) => `${i.source} ${i.options.join(" ")}`);
        // a: body 0..1.5, tail 1.5..2.2 (0.2 s of real media after its end: 6 live frames, 9 cloned).
        expect(reads).toEqual([
            "/m/a.mp4 -ss 0.000 -t 1.500", "/m/a.mp4 -ss 1.500 -t 0.700", "/m/b.mp4 -ss 0.000 -t 0.500", "/m/b.mp4 -ss 0.500 -t 1.500",
        ]);
        expect(plan.filterGraph).toContain("fps=30,trim=end_frame=21,setpts=N/30/TB");
        expect(plan.filterGraph).toContain("tpad=stop_mode=clone:stop=11,setpts=N/30/TB,fps=30,format=gbrap");
        expect(plan.filterGraph).toContain("tpad=start_mode=clone:start=15:stop_mode=clone:stop=2,setpts=N/30/TB,fps=30,format=gbrap");
    });

    it("drops the fades the window replaces and keeps the others", () => {
        const plan = compile([
            v2("a", 0, 2, { transitionType: "wipe_left", transitionDuration: 1, fadeInDuration: 0.4, fadeOutDuration: 0.8 }),
            v2("b", 2, 4, { fadeInDuration: 1, fadeOutDuration: 0.3 }),
        ], [["/m/a.png", still()], ["/m/b.png", still()]]);
        const fades = new Set(plan.filterGraph.match(/fade=t=(in|out):st=[\d.]+:d=[\d.]+:alpha=1/g));
        expect([...fades]).toEqual(["fade=t=in:st=0:d=0.4:alpha=1", "fade=t=out:st=1.7:d=0.3:alpha=1"]);
        // b's fade-out runs on its item-local clock in its body piece (which starts at item second 0.5).
        expect(plan.filterGraph).toContain("setpts=PTS+0.5/TB,format=yuva444p,fade=t=out:st=1.7:d=0.3:alpha=1,setpts=PTS-STARTPTS");
    });

    it("keeps a phase 10a transition preset (fade-out equal to its duration) on the per-clip fade path", () => {
        // The 10a fixture's c3 → c4 cut on V2: cross_dissolve written by the old preset with fadeIn = fadeOut = 0.5.
        // 10a exported c3 fading in and out over V1; a window here would turn that into a dissolve into c4.
        const fixture = phase10a as unknown as { tracks: TimelineTrack[]; scenes: SceneData[]; clips: TimelineClip[] };
        const plan = compileExport(
            input({ tracks: fixture.tracks, scenes: fixture.scenes, clips: fixture.clips.filter((c) => c.id === "c3" || c.id === "c4") }),
            { resolution: "720p" },
            { media: new Map([["opennan-local://media/m1", info({ durationSeconds: 6 })]]), rasters: new Map(), gl: false },
        );
        expect(plan.filterGraph).not.toContain("gbrap");
        expect(plan.filterGraph).toContain("fade=t=in:st=0:d=0.5:alpha=1,fade=t=out:st=0.5:d=0.5:alpha=1");
        expect(plan.filterGraph).toContain("enable='between(t,4,5)'");
        expect(plan.filterGraph).toContain("enable='between(t,5,6)'");
    });

    it("keeps clips without a library transition, apart, or with unreadable media on the per-clip path", () => {
        const plan = compile([
            v2("a", 0, 2, { transitionType: "wipe_left", transitionDuration: 1 }),
            v2("b", 2.5, 4),
            v2("c", 0, 2, { trackIndex: 3, transitionType: "cross_dissolve", transitionDuration: 1 }),
            v2("d", 2, 4, { trackIndex: 3 }),
        ], [["/m/a.png", still()], ["/m/b.png", still()], ["/m/c.png", still()]]);
        expect(plan.filterGraph).not.toContain("gbrap");
        expect(plan.filterGraph).toContain("enable='between(t,0,2)'");
        expect(plan.warnings).toEqual([expect.objectContaining({ code: "media-unreadable", clipId: "d" })]);
    });

    it("composites lanes and single clips in track order", () => {
        const plan = compile([
            v2("top", 1, 3, { trackIndex: 3 }),
            v2("a", 0, 2, { transitionType: "wipe_left", transitionDuration: 1 }),
            v2("b", 2, 4),
        ], [["/m/a.png", still()], ["/m/b.png", still()], ["/m/top.png", still()]]);
        const graph = plan.filterGraph;
        expect(graph.indexOf("between(t,0,4)")).toBeLessThan(graph.indexOf("between(t,1,3)"));
    });

    it("a chain on a later start snaps the lane to frames and times its overlay from there", () => {
        const plan = compile([
            v2("a", 1, 2, { transitionType: "cross_dissolve", transitionDuration: 0.5 }),
            v2("b", 2, 3),
        ], [["/m/a.png", still()], ["/m/b.png", still()]]);
        expect(plan.filterGraph).toMatch(/setpts=PTS-STARTPTS\+1\/TB\[cl\d+\]/);
        expect(plan.filterGraph).toContain("enable='between(t,1,3)'");
    });

    it("trimmed video clips read from their trimStart: a split pair's incoming head shows the real media before the cut", () => {
        const plan = compile([
            v2("a", 0, 2, { mediaUrl: "/m/v.mp4", mediaType: "video", trimStart: 0, trimEnd: 2, transitionType: "push_left", transitionDuration: 1 }),
            v2("b", 2, 4, { mediaUrl: "/m/v.mp4", mediaType: "video", trimStart: 2, trimEnd: 4 }),
        ], [["/m/v.mp4", info({ durationSeconds: 10, hasAudio: false })]]);
        // a: body 0..1.5, tail 1.5..2.5 (live after its end); b: head from 1.5 (0.5 s live before its trimStart), body from 2.5.
        expect(plan.inputs.filter((i) => i.source === "/m/v.mp4").map((i) => i.options.join(" "))).toEqual([
            "-ss 0.000 -t 1.500", "-ss 1.500 -t 1.000", "-ss 1.500 -t 1.000", "-ss 2.500 -t 1.500",
        ]);
        expect(plan.filterGraph).not.toContain("tpad=start_mode=clone:start=15,");
    });

    it("sped-up, reversed, and frozen lane clips decode the whole clip from their trimStart", () => {
        const plan = compile([
            v2("a", 0, 2, { mediaUrl: "/m/a.mp4", mediaType: "video", trimStart: 1, playbackSpeed: 2, transitionType: "cross_dissolve", transitionDuration: 1 }),
            v2("b", 2, 4, { mediaUrl: "/m/b.mp4", mediaType: "video", trimStart: 3, reversePlayback: true, transitionType: "cross_dissolve", transitionDuration: 1 }),
            v2("c", 4, 6, { mediaUrl: "/m/c.mp4", mediaType: "video", trimStart: 0.5, freezeFrame: true }),
        ], [["/m/a.mp4", info({ hasAudio: false })], ["/m/b.mp4", info({ hasAudio: false })], ["/m/c.mp4", info({ hasAudio: false })]]);
        const reads = (url: string) => [...new Set(plan.inputs.filter((i) => i.source === url).map((i) => i.options.join(" ")))];
        expect(reads("/m/a.mp4")).toEqual(["-ss 1.000 -t 4.250"]);
        expect(reads("/m/b.mp4")).toEqual(["-ss 3.000 -t 2.000"]);
        expect(reads("/m/c.mp4")).toEqual(["-ss 0.500 -t 2.000"]);
    });
});
