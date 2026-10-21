// Every filter (three intensities), every adjustment (both directions), and combined looks, through the
// export's own look filters (applyLook) on both ffmpeg hosts, against the JS reference.
import { describe, expect, it } from "vitest";
import { ADJUSTMENT_KEYS, adjustmentRange } from "@opennan/timeline-core/looks/adjust";
import { FILTERS } from "@opennan/timeline-core/looks/filters";
import { itemLook, type LookSource } from "@opennan/timeline-core/looks/look-plan";
import { renderLookReference } from "@opennan/timeline-core/looks/reference";
import { FilterGraph } from "../src/graph";
import { applyLook } from "../src/looks/look-filters";
import { resolveOutputFormat } from "../src/presets";
import type { CompileContext } from "../src/compile/context";
import { ffmpegHosts, type FfmpegHost } from "./ffmpeg";
import { compareFrames, testFrame, type RgbFrame } from "./frames";

const hosts = await ffmpegHosts();
const W = 96;
const H = 54;

async function runLook(host: FfmpegHost, frame: RgbFrame, item: LookSource, t = 0): Promise<{ out: Uint8Array; expected: Uint8Array }> {
    const plan = itemLook(item);
    const graph = new FilterGraph();
    const ctx: CompileContext = { graph, format: resolveOutputFormat("16:9", "720p"), duration: 1, media: new Map(), rasters: new Map(), warnings: [], files: [], fileKeys: new Map() };
    graph.input("media", "frame.raw", []);
    const pad = applyLook(ctx, "0:v", plan, { width: W, height: H, alpha: frame.channels === 4, duration: 1, timeOffset: t });
    graph.chain([pad], [`format=${frame.channels === 4 ? "rgba" : "rgb24"}`], "out");
    const files: Record<string, Uint8Array> = { "frame.raw": frame.data };
    const args = ["-framerate", "30", "-f", "rawvideo", "-pix_fmt", frame.channels === 4 ? "rgba" : "rgb24", "-s", `${W}x${H}`, "-i", "frame.raw"];
    for (const input of graph.inputs.slice(1)) {
        const file = ctx.files.find((f) => f.name === input.source)!;
        files[file.name] = file.data;
        args.push(...input.options, "-i", file.name);
    }
    args.push("-filter_complex", graph.toString(), "-map", "[out]", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", frame.channels === 4 ? "rgba" : "rgb24", "out.raw");
    const out = await host.run({ files, args, outputName: "out.raw" });
    return { out, expected: renderLookReference(frame, plan, t).data };
}

const frame = testFrame(W, H, 41);
const alphaFrame = testFrame(W, H, 42, 4);

describe.each(hosts.map((h) => [h.name, h] as const))("looks through applyLook on %s", (_name, host) => {
    it("30 filters at 30, 80, and 100 %", async () => {
        for (const filter of FILTERS) {
            for (const intensity of [0.3, 0.8, 1]) {
                const { out, expected } = await runLook(host, frame, { kind: "scene", visualFilter: filter.id, filterIntensity: intensity });
                // arm64 builds may fuse multiply-adds in the trilinear lerp: one level, rarely.
                expect(compareFrames(out, expected).max, `${filter.id}@${intensity}`).toBeLessThanOrEqual(1);
            }
        }
    }, 300_000);

    it("13 adjustments at both ends and halfway", async () => {
        for (const key of ADJUSTMENT_KEYS) {
            const [lo, hi] = adjustmentRange(key);
            for (const value of [lo, hi, (lo + hi) / 2 || hi / 2]) {
                if (value === 0) continue;
                const { out, expected } = await runLook(host, frame, { kind: "scene", adjustmentsJson: JSON.stringify({ [key]: value }) }, 0.25);
                expect(compareFrames(out, expected).max, `${key}=${value}`).toBeLessThanOrEqual(1);
            }
        }
    }, 300_000);

    it("a full look with effects on a frame with alpha", async () => {
        const item: LookSource = {
            kind: "clip", visualFilter: "golden_hour", filterIntensity: 0.6, brightness: 0.1, contrast: 1.1, saturation: 1,
            adjustmentsJson: JSON.stringify({ sharpen: 0.5, vignette: 0.4, grain: 0.3, highlights: -0.3 }),
            effects: [
                { id: "1", effectId: "fx_duotone", order: 0, paramsJson: '{"hue":0.3,"amount":0.5}', enabled: true },
                { id: "2", effectId: "fx_vhs", order: 1, paramsJson: null, enabled: true },
            ],
        };
        const { out, expected } = await runLook(host, alphaFrame, item, 0.5);
        const diff = compareFrames(out, expected);
        expect(diff.mean).toBeLessThanOrEqual(0.05);
        expect(diff.p999).toBeLessThanOrEqual(1);
    }, 120_000);
});
