// End to end: a compiled export graph (looks, transition windows, transparent lanes) runs on both
// ffmpeg hosts and matches the JS reference within YUV 4:2:0 round-trip error.
import { describe, expect, it } from "vitest";
import { encodePng } from "@opennan/timeline-core/looks/png";
import { itemLook } from "@opennan/timeline-core/looks/look-plan";
import { renderLookReference, renderTransitionReference, type RawFrame } from "@opennan/timeline-core/looks/reference";
import { transitionById } from "@opennan/timeline-core/looks/transitions";
import { compileExport } from "../src/compile";
import { clip, input, scene } from "../src/compile/test-helpers";
import { ffmpegHosts } from "./ffmpeg";
import { compareFrames, splitFrames } from "./frames";
import { runPlanVideo } from "./plan-runner";

const hosts = await ffmpegHosts();
const W = 1280;
const H = 720;

function smooth(seed: number): RawFrame {
    const data = new Uint8Array(W * H * 3);
    for (let y = 0; y < H; y += 1) {
        for (let x = 0; x < W; x += 1) {
            const o = (y * W + x) * 3;
            data[o] = Math.round(40 + 170 * (x / W) + seed * 10);
            data[o + 1] = Math.round(30 + 190 * (y / H));
            data[o + 2] = Math.round(120 + 100 * Math.sin((x + y + seed * 50) / 160));
        }
    }
    return { width: W, height: H, channels: 3, data };
}

const A = smooth(0);
const B = smooth(3);
const media = {
    "/m/a.png": encodePng({ width: W, height: H, channels: 3, data: A.data }),
    "/m/b.png": encodePng({ width: W, height: H, channels: 3, data: B.data }),
};
const still = { durationSeconds: 0, hasVideo: true, hasAudio: false, width: W, height: H };

describe.each(hosts.map((h) => [h.name, h] as const))("compiled looks and transitions on %s", (_name, host) => {
    it("renders a filtered scene, a centered transition window, and the next scene", async () => {
        const sceneA = scene("a", 0, 0.5, {
            cardType: "image", sourceVideoUrl: null, startImageUrl: "/m/a.png",
            visualFilter: "teal_orange", filterIntensity: 0.8, adjustmentsJson: '{"exposure":0.2,"vignette":0.5}',
            visualTransition: "wipe_left", visualTransitionDuration: 0.4,
        });
        const sceneB = scene("b", 0.5, 0.5, { cardType: "image", sourceVideoUrl: null, startImageUrl: "/m/b.png", effects: [
            { id: "e", clipId: null, sceneId: "b", effectId: "fx_sepia", order: 0, paramsJson: '{"amount":0.7}', enabled: true, ownerScope: "project" },
        ] });
        const plan = compileExport(input({ scenes: [sceneA, sceneB] }), { resolution: "720p" }, {
            media: new Map([["/m/a.png", still], ["/m/b.png", still]]), rasters: new Map(), gl: false,
        });
        const frames = splitFrames(await runPlanVideo(host, plan, media), W * H * 3);
        expect(frames).toHaveLength(30);
        const lookA = renderLookReference(A, itemLook({ kind: "scene", ...sceneA }));
        const lookB = renderLookReference(B, itemLook({ kind: "scene", ...sceneB }));
        const wipe = transitionById("wipe_left")!;
        // window: frames 9..20 (half = 0.2 s = 6 frames on each side of the cut at frame 15)
        const expected = (k: number) => (k < 9 ? lookA : k >= 21 ? lookB : renderTransitionReference(wipe, lookA, lookB, (k - 9) / 12));
        if (process.env.PARITY_DEBUG && host.name.startsWith(process.env.PARITY_DEBUG)) {
            for (const k of [9, 12, 15, 18, 20, 21]) {
                const scores = Array.from({ length: 13 }, (_, j) => compareFrames(frames[k], renderTransitionReference(wipe, lookA, lookB, j / 12).data).mean.toFixed(2));
                console.log(host.name, k, scores.join(" "));
            }
        }
        for (const k of [2, 12, 15, 18, 25]) {
            const diff = compareFrames(frames[k], expected(k).data);
            expect(diff.mean, `frame ${k}`).toBeLessThan(2.5);
            expect(diff.p999, `frame ${k}`).toBeLessThan(24);
        }
    }, 600_000);
});

describe.each(hosts.map((h) => [h.name, h] as const))("compiled overlays, transparent lanes, and effect spans on %s", (_name, host) => {
    const sticker = smooth(5);
    const stickerRgba = new Uint8Array(W * H * 4);
    for (let i = 0; i < W * H; i += 1) {
        stickerRgba.set(sticker.data.subarray(i * 3, i * 3 + 3), i * 4);
        stickerRgba[i * 4 + 3] = (i % W) < W / 2 ? 255 : 0;
    }
    const files = { ...media, "/m/s.png": encodePng({ width: W, height: H, channels: 4, data: stickerRgba }) };
    const mediaInfo = new Map([["/m/a.png", still], ["/m/b.png", still], ["/m/s.png", still]]);
    const base = () => [
        scene("a", 0, 1, { cardType: "image", sourceVideoUrl: null, startImageUrl: "/m/a.png" }),
        scene("v2a", 0, 0.5, { cardType: "image", sourceVideoUrl: null, startImageUrl: "/m/b.png", trackIndex: 2, visualTransition: "circle_open", visualTransitionDuration: 0.3, visualFilter: "mono" }),
        scene("v2b", 0.5, 0.5, { cardType: "image", sourceVideoUrl: null, startImageUrl: "/m/s.png", trackIndex: 2 }),
    ];

    it("runs every alpha path and applies an effect-track span to the composite", async () => {
        const overlay = clip("st", { trackType: "sticker", trackIndex: 1, startTime: 0, endTime: 1, mediaUrl: "/m/s.png", mediaType: "image", scale: 0.25, visualFilter: "vivid", adjustmentsJson: '{"grain":0.3,"sharpen":0.4}' });
        const span = clip("fx", { trackType: "effect", trackIndex: 1, startTime: 0.4, endTime: 0.8, effects: [{ id: "r", clipId: "fx", sceneId: null, effectId: "fx_rgb_split", order: 0, paramsJson: '{"amount":0.6}', enabled: true, ownerScope: "project" }] });
        const without = compileExport(input({ scenes: base(), clips: [overlay] }), { resolution: "720p" }, { media: mediaInfo, rasters: new Map(), gl: false });
        const withSpan = compileExport(input({ scenes: base(), clips: [overlay, span] }), { resolution: "720p" }, { media: mediaInfo, rasters: new Map(), gl: false });
        const f0 = splitFrames(await runPlanVideo(host, without, files), W * H * 3);
        const f1 = splitFrames(await runPlanVideo(host, withSpan, files), W * H * 3);
        expect(f0).toHaveLength(30);
        expect(f1).toHaveLength(30);
        expect(compareFrames(f0[5], f1[5]).max).toBe(0);
        expect(compareFrames(f0[26], f1[26]).max).toBe(0);
        const plan = itemLook({ kind: "scene", effects: span.effects })!;
        for (const k of [12, 20]) {
            const expected = renderLookReference({ width: W, height: H, channels: 3, data: f0[k] }, plan, k / 30 - 0.4);
            const diff = compareFrames(f1[k], expected.data);
            expect(diff.mean, `frame ${k}`).toBeLessThan(2.5);
        }
    }, 600_000);
});
