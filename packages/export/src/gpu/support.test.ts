import { clip, input, scene } from "../compile/test-helpers";
import { gpuExportSupport } from "./support";

const overlay = (patch: Record<string, unknown>) =>
    clip("o", { trackType: "video", trackIndex: 2, startTime: 0, endTime: 2, mediaUrl: "/m/v.webm", mediaType: "video", ...patch });

describe("gpuExportSupport", () => {
    it("accepts looks, transitions, motion, speed, text, and stickers", () => {
        const timeline = input({
            scenes: [scene("a", 0, 2, { visualFilter: "warm", visualTransition: "spin", visualTransitionDuration: 1, playbackSpeed: 2 }), scene("b", 2, 2)],
            clips: [
                overlay({ keyframesJson: '[{"time":0,"scale":0.5},{"time":2,"scale":1}]', freezeFrame: true, horizontalFlip: true, cropLeft: 0.1, mosaicStrength: 4 }),
                clip("t", { trackType: "text", trackIndex: 1, startTime: 0, endTime: 2, textContent: "Hi" }),
                clip("s", { trackType: "sticker", trackIndex: 1, startTime: 0, endTime: 2, stickerId: "twemoji:1f525" }),
            ],
        });
        expect(gpuExportSupport(timeline, { gl: false })).toEqual({ ok: true, reasons: [] });
    });

    it("renders the legacy blur slider, chroma key, and blend modes (phase 10d)", () => {
        const timeline = input({
            scenes: [scene("a", 0, 2)],
            clips: [overlay({ chromaKeyEnabled: true, chromaKeyColor: "#00ff00", blurStrength: 3, blendMode: "screen" })],
        });
        expect(gpuExportSupport(timeline, { gl: false })).toEqual({ ok: true, reasons: [] });
    });

    it("renders reverse playback and animated GIFs (phase 10d)", () => {
        const timeline = input({ scenes: [scene("a", 0, 2)], clips: [overlay({ reversePlayback: true }), clip("g", { trackType: "sticker", trackIndex: 1, startTime: 0, endTime: 2, mediaUrl: "/m/party.gif" })] });
        expect(gpuExportSupport(timeline, { gl: false })).toEqual({ ok: true, reasons: [] });
    });

    it("takes catalog GLSL effects with or without a GL frame processor (without one they are left out with a warning, as on ffmpeg.wasm)", () => {
        const legacy = [{ id: "e", clipId: null, sceneId: "a", effectId: "catalog_glow", order: 0, paramsJson: null, enabled: true, ownerScope: "user" }];
        const timeline = input({ scenes: [scene("a", 0, 2, { effects: legacy } as never)] });
        expect(gpuExportSupport(timeline, { gl: false }).ok).toBe(true);
        expect(gpuExportSupport(timeline, { gl: true }).ok).toBe(true);
    });
});
