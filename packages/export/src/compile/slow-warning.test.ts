import { encoderChoice } from "../encoders";
import { exportTimeline } from "../export-timeline";
import type { ExportRunner } from "../runner";
import { compileExport, slowWebEffectSeconds, staticExportWarnings } from "./index";
import { COMPILE_OPTIONS, FEATURE_MEDIA, clip, input, scene } from "./test-helpers";

const fx = (id: string, effectId: string, owner: { clipId?: string; sceneId?: string }) => ({
    id, clipId: owner.clipId ?? null, sceneId: owner.sceneId ?? null, effectId, order: 0, paramsJson: null, enabled: true, ownerScope: "project" as const,
});
/** Scenes of `seconds` each, back to back; `patch(i)` styles scene i. */
const scenes = (count: number, seconds: number, patch: (i: number) => Record<string, unknown> = () => ({})) =>
    Array.from({ length: count }, (_, i) => scene(`s${i}`, i * seconds, seconds, patch(i)));
const slow = <T extends { code: string }>(warnings: T[]) => warnings.filter((w) => w.code === "slow-web-effect");

describe("slow-web-effect", () => {
    it("counts keyframed masks (geq on alpha) and leaves out static masks (a generated image)", () => {
        const mask = '{"shape":"circle"}';
        const moving = JSON.stringify({ keyframes: [{ time: 0, mask_x: 0.2 }, { time: 3, mask_x: 0.8 }] });
        const project = input({
            scenes: scenes(3, 4, (i) => (i === 0 ? { maskJson: mask, keyframesJson: moving } : i === 1 ? { maskJson: mask } : {})),
            clips: [clip("m", { trackType: "video", trackIndex: 2, startTime: 0, endTime: 5, mediaUrl: "/m/v.webm", mediaType: "video", scale: 1, maskJson: mask, keyframesJson: moving })],
        });
        expect(slowWebEffectSeconds(project)).toBeCloseTo(9, 6);
    });

    it("adds up scenes with geq effect passes, and leaves out CLUT-only effects and plain looks", () => {
        const project = input({
            scenes: scenes(6, 4, (i) => (i < 3
                ? { effects: [fx(`e${i}`, "fx_vhs", { sceneId: `s${i}` })] }
                : i === 3 ? { effects: [fx("e3", "fx_sepia", { sceneId: "s3" })], visualFilter: "warm" } : {})),
        });
        expect(slowWebEffectSeconds(project)).toBeCloseTo(12, 6);
    });

    it("counts effect-track spans and per-pixel opacity on full-size animated layers", () => {
        const fade = JSON.stringify([{ time: 0, opacity: 0 }, { time: 2, opacity: 1 }]);
        const project = input({
            scenes: [
                ...scenes(2, 5),
                scene("faded", 10, 6, { keyframesJson: fade }),
            ],
            clips: [
                { ...clip("span", { trackType: "effect", trackIndex: 1, startTime: 0, endTime: 8 }), effects: [fx("r", "fx_rgb_split", { clipId: "span" })] },
                clip("big", { trackType: "video", trackIndex: 2, startTime: 0, endTime: 5, mediaUrl: "/m/v.webm", mediaType: "video", scale: 1, keyframesJson: fade }),
                // Small layers and legacy alpha fades (the fade filter, no geq) do not count.
                clip("small", { trackType: "video", trackIndex: 2, startTime: 0, endTime: 9, mediaUrl: "/m/v.webm", mediaType: "video", scale: 0.3, keyframesJson: fade }),
                clip("legacy", { trackType: "video", trackIndex: 2, startTime: 0, endTime: 9, mediaUrl: "/m/v.webm", mediaType: "video", scale: 1, fadeInDuration: 1, fadeOutDuration: 1 }),
                // A CLUT-only effect span runs no geq.
                { ...clip("sepia", { trackType: "effect", trackIndex: 1, startTime: 0, endTime: 9 }), effects: [fx("s", "fx_sepia", { clipId: "sepia" })] },
            ],
        });
        expect(slowWebEffectSeconds(project)).toBeCloseTo(8 + 5 + 6, 6);
    });

    it("warns above 20 s, only on runners without native speed", () => {
        const project = input({ scenes: scenes(6, 4, (i) => ({ effects: [fx(`e${i}`, "fx_glitch", { sceneId: `s${i}` })] })) });
        expect(slowWebEffectSeconds(project)).toBeCloseTo(24, 6);
        const [warning] = slow(staticExportWarnings(project, { gl: false, nativeSpeed: false }));
        expect(warning.message).toMatch(/24 s/);
        expect(warning.message).toMatch(/desktop app/);
        expect(slow(staticExportWarnings(project, { gl: false }))).toEqual([]);
        expect(slow(staticExportWarnings(project, { gl: true, nativeSpeed: true }))).toEqual([]);
        const short = input({ scenes: scenes(5, 4, (i) => ({ effects: [fx(`e${i}`, "fx_glitch", { sceneId: `s${i}` })] })) });
        expect(slow(staticExportWarnings(short, { gl: false, nativeSpeed: false }))).toEqual([]);
    });

    it("reaches the plan's warnings through the compile options", () => {
        const project = input({ scenes: scenes(6, 4, (i) => ({ effects: [fx(`e${i}`, "fx_glitch", { sceneId: `s${i}` })] })) });
        expect(slow(compileExport(project, { resolution: "720p" }, { ...COMPILE_OPTIONS, nativeSpeed: false }).warnings)).toHaveLength(1);
        expect(slow(compileExport(project, { resolution: "720p" }, COMPILE_OPTIONS).warnings)).toHaveLength(0);
    });
});

describe("slow-web-effect in exportTimeline", () => {
    const runner = (kind: ExportRunner["kind"]): ExportRunner => ({
        kind, supportsGl: false, maxResolution: "1080p",
        probe: async () => new Map(FEATURE_MEDIA),
        chooseEncoder: async (o) => encoderChoice("mpeg4", o),
        run: async () => ({ kind: "bytes", data: new Uint8Array([1]) }),
    });
    const project = input({ scenes: scenes(6, 4, (i) => ({ sourceVideoUrl: "/m/a.webm", effects: [fx(`e${i}`, "fx_glitch", { sceneId: `s${i}` })] })) });

    it("warns on the wasm runner, not on native ffmpeg", async () => {
        expect(slow((await exportTimeline(project, { resolution: "720p" }, { runner: runner("wasm") })).warnings)).toHaveLength(1);
        expect(slow((await exportTimeline(project, { resolution: "720p" }, { runner: runner("node") })).warnings)).toHaveLength(0);
    });
});
