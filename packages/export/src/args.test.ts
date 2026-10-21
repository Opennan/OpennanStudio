
describe("filter thread cap", () => {
    it("caps -filter_complex_threads so every scaler's thread pool fits the process limit", async () => {
        const { filterThreadCap } = await import("./args");
        expect(filterThreadCap("scale=2:2", 1, 12)).toBe(12);
        const big = Array.from({ length: 350 }, () => "scale=2:2").join(",");
        const cap = filterThreadCap(big, 150, 12);
        expect(cap).toBeGreaterThanOrEqual(1);
        expect(cap * (350 + 150)).toBeLessThanOrEqual(2048);
        expect(filterThreadCap(Array.from({ length: 5000 }, () => "scale=1:1").join(","), 10, 12)).toBe(1);
        // format= filters count too: each may get an auto-inserted scaler.
        expect(filterThreadCap(Array.from({ length: 900 }, () => "format=rgba").join(","), 150, 12)).toBe(1);
    });
});

describe("input thread cap", () => {
    it("gives each decoder a share of a fixed thread budget on large graphs (a 40-scene project ran out of threads)", async () => {
        const { inputThreadCap } = await import("./args");
        expect(inputThreadCap(3, 12)).toBeUndefined();
        const cap = inputThreadCap(150, 12)!;
        expect(cap).toBeGreaterThanOrEqual(1);
        expect(cap * 150).toBeLessThanOrEqual(1024);
        expect(inputThreadCap(5000, 12)).toBe(1);
    });

    it("puts -threads before every input's -i when capped", async () => {
        const { buildFfmpegArgs } = await import("./args");
        const plan = {
            format: { width: 2, height: 2, fps: 30, aspectRatio: 1, refWidth: 2, refHeight: 2, frameScale: 1 }, durationSeconds: 1,
            inputs: [{ kind: "media" as const, source: "/a.mp4", options: ["-t", "1"] }, { kind: "media" as const, source: "/b.mp4", options: [] }],
            filterGraph: "[0:v][1:v]overlay[vout];[0:a]anull[aout]", videoLabel: "vout", audioLabel: "aout", files: [], glPasses: [], warnings: [],
            videoBitrateKbps: 1, audioBitrateKbps: 1,
        };
        const encoder = { name: "mpeg4", container: "mp4" as const, gpl: false, globalArgs: [], videoFilters: [], videoArgs: [], audioArgs: [] };
        const args = buildFfmpegArgs({ plan, encoder, inputPaths: ["a.mp4", "b.mp4"], filterScriptPath: "g", scriptFlag: "-/filter_complex", outputPath: "o.mp4", inputThreads: 2 });
        expect(args.join(" ")).toContain("-threads 2 -t 1 -i a.mp4 -threads 2 -i b.mp4");
        expect(buildFfmpegArgs({ plan, encoder, inputPaths: ["a.mp4", "b.mp4"], filterScriptPath: "g", scriptFlag: "-/filter_complex", outputPath: "o.mp4" })).not.toContain("-threads");
    });
});
