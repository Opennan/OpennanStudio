// The 40-item bench (phase 10b): 40 main-track scenes with a filter, Adjust, and a transition on every cut,
// plus overlay clips, compiled at 320×180 and exported to an MP4 to completion on ffmpeg.wasm in Node (the
// web runner's engine, with its arguments) and on native ffmpeg. Records the input count, the wasm heap peak,
// and timings (`[bench]` lines).
//
// Measured 2026-10-19 (Apple M-series, 12 cores), 40.0 s of video:
//   ffmpeg.wasm 5.1.4  heap peak 1269 MB unshared → 1170 MB shared inputs → 882 MB with the runner's still
//                      probe size (STILL_PROBE_BYTES); about 175 s.
//   native 7.1.5       about 140 s, 2.5 GB RSS, with -filter_complex_threads capped (see below).
// Time: about 97 % is the transition windows' per-pixel xfade expressions (single-threaded on both hosts):
// the same 10 scenes export in 1.5 s natively without transitions, 41.6 s with them.
// Memory grows about 22 MB per scene: each scene read keeps its decoder, a 3 MB haldclut LUT (64³ floats),
// and its links' frame pools until the export ends; one read per scene (lanes.ts) would remove most of it.
import { encoderChoice } from "../src/encoders";
import { buildFfmpegArgs, filterScriptFlag } from "../src/args";
import { compileExport } from "../src/compile";
import type { ExportPlan } from "../src/types";
import { withStillProbe } from "../src/web/wasm-runner";
import { BENCH_MEDIA_INFO, benchMedia, benchProject } from "./bench-project";
import { ffmpegHosts, type FfmpegHost } from "./ffmpeg";

// 320×180 instead of a 720p preset: the bench measures graph size and memory, not pixels.
vi.mock("../src/presets", async (importOriginal) => {
    const presets = await importOriginal<typeof import("../src/presets")>();
    return {
        ...presets,
        resolveOutputFormat: (...args: Parameters<typeof presets.resolveOutputFormat>) => ({ ...presets.resolveOutputFormat(...args), width: 320, height: 180, frameScale: 180 / 1080 }),
    };
});

const hosts = await ffmpegHosts();
const MB = 2 ** 20;
/** ffmpeg.wasm 0.12's heap stops at 2 GB; measured 882 MB, budget with about 40 % headroom. */
const WASM_HEAP_BUDGET = 1280 * MB;
/**
 * Native FFmpeg 7.1 gives every scale filter (and every auto-inserted one) its own swscale thread pool of
 * -filter_complex_threads (default: the CPU count) threads; this graph's ~350 scalers then pass macOS's
 * 4096 threads per process and the export fails with EAGAIN ("Failed to configure output pad on
 * auto_scale_N", "Error reinitializing filters!"). The cap keeps the bench running; the desktop runner
 * (src/node/runner.ts) has no cap yet. Time is the same at 1, 2, or 3 threads (the xfade expressions run
 * single-threaded).
 */
const NATIVE_FILTER_THREADS = ["-filter_complex_threads", "2"];

function benchPlan(): ExportPlan {
    return compileExport(benchProject(), { resolution: "720p" }, { media: BENCH_MEDIA_INFO, rasters: new Map(), gl: false });
}

/**
 * The inputs the plan would open without shared inputs (compile/shared-inputs.ts): every user of a split
 * job file had its own input before phase 10b.
 */
function unsharedInputCount(plan: ExportPlan): number {
    let count = plan.inputs.length;
    for (const match of plan.filterGraph.matchAll(/^\[(\d+):v\][^;]*split=(\d+)/gm)) {
        if (plan.inputs[Number(match[1])].kind === "file") count += Number(match[2]) - 1;
    }
    return count;
}

describe("40-item bench graph", () => {
    it("opens one input per unique CLUT, mask, and grain image (before: 304 inputs, after: 150)", () => {
        const plan = benchPlan();
        const files = plan.inputs.filter((input) => input.kind === "file");
        // Without sharing: 304 inputs, 183 of them job files (a CLUT per scene read, a mask or grain image per
        // read that uses one). Shared: 150, 29 job files (23 CLUTs: 20 scene looks and 3 overlay looks; 3
        // vignette masks and 3 grain images, one per size). The 121 media reads are lanes.ts's: head, body,
        // and tail of a scene with transitions are separate reads (10b Architecture 10c, not shared here).
        expect(unsharedInputCount(plan)).toBe(304);
        expect(plan.inputs).toHaveLength(150);
        expect(files).toHaveLength(29);
        expect(new Set(files.map((input) => input.source)).size).toBe(files.length);
    });
});

async function exportOn(host: FfmpegHost, compiled: ExportPlan, media: Record<string, Uint8Array>): Promise<{ bytes: number; seconds: number }> {
    const wasm = host.heapBytes !== undefined;
    const plan = wasm ? withStillProbe(compiled) : compiled;
    const encoder = encoderChoice("mpeg4", { videoBitrateKbps: 800, audioBitrateKbps: 96 });
    const files: Record<string, Uint8Array> = { "graph.txt": new TextEncoder().encode(plan.filterGraph) };
    for (const file of plan.files) files[file.name] = file.data;
    const inputPaths = plan.inputs.map((input, i) => {
        if (input.kind === "file") return input.source;
        const name = `m${i}${input.source.slice(input.source.lastIndexOf("."))}`;
        files[name] = media[input.source];
        return name;
    });
    const major = Number(host.version.split(".")[0]);
    // The leading "-hide_banner -y -loglevel info" is the harness's own (it logs errors only).
    const args = [
        ...(wasm ? [] : NATIVE_FILTER_THREADS),
        ...buildFfmpegArgs({ plan, encoder, inputPaths, filterScriptPath: "graph.txt", scriptFlag: filterScriptFlag(major), outputPath: "out.mp4" }).slice(4),
    ];
    const started = performance.now();
    const out = await host.run({ files, args, outputName: "out.mp4" });
    return { bytes: out.length, seconds: (performance.now() - started) / 1000 };
}

describe.each(hosts.map((h) => [h.name, h] as const))("40-item bench export on %s", (_name, host) => {
    it("exports the whole project to an MP4", async () => {
        const plan = benchPlan();
        const media = await benchMedia(hosts[0]);
        const heapBefore = host.heapBytes?.() ?? 0;
        const { bytes, seconds } = await exportOn(host, plan, media);
        const heap = host.heapBytes?.();
        // stderr: vitest does not print a passing test's console.log.
        process.stderr.write(`[bench] ${host.name}: ${plan.durationSeconds.toFixed(1)} s, ${plan.inputs.length} inputs, ${seconds.toFixed(1)} s to export, ${(bytes / MB).toFixed(1)} MB${heap ? `, wasm heap ${(heapBefore / MB).toFixed(0)} → ${(heap / MB).toFixed(0)} MB` : ""}\n`);
        expect(bytes).toBeGreaterThan(100_000);
        if (heap !== undefined) expect(heap).toBeLessThan(WASM_HEAP_BUDGET);
    }, 1_800_000);
});
