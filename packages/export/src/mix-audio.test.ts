import { mixTimelineAudio } from "./mix-audio";
import type { ExportRunner } from "./runner";
import { FEATURE_MEDIA, input, scene } from "./compile/test-helpers";
import type { AudioMixPlan } from "./compile/audio-mix";

function stubRunner(overrides: Partial<ExportRunner> = {}): ExportRunner & { rendered: Array<[AudioMixPlan, string]>; probed: string[][] } {
    const rendered: Array<[AudioMixPlan, string]> = [];
    const probed: string[][] = [];
    return {
        kind: "node", supportsGl: false, maxResolution: "4k", rendered, probed,
        probe: async (urls) => {
            probed.push(urls);
            return new Map([...FEATURE_MEDIA].filter(([url]) => urls.includes(url)));
        },
        chooseEncoder: async () => { throw new Error("not used"); },
        run: async () => { throw new Error("not used"); },
        renderAudio: async (plan, outputPath, options) => {
            options?.onProgress?.(0.5);
            rendered.push([plan, outputPath]);
        },
        ...overrides,
    };
}

describe("mixTimelineAudio", () => {
    it("probes the timeline media, compiles the mix, and renders it", async () => {
        const runner = stubRunner();
        const progress: number[] = [];
        const result = await mixTimelineAudio(input({ scenes: [scene("a", 0, 2)] }), { runner, outputPath: "/tmp/mix.wav", onProgress: (r) => progress.push(r) });
        expect(runner.probed).toEqual([["/m/a.webm"]]);
        expect(runner.rendered[0][1]).toBe("/tmp/mix.wav");
        expect(runner.rendered[0][0].sourceCount).toBe(1);
        expect(result).toEqual({ durationSeconds: 2, sourceCount: 1, warnings: [] });
        expect(progress).toEqual([0.5]);
    });

    it("refuses runners without renderAudio and timelines without audio", async () => {
        await expect(mixTimelineAudio(input({ scenes: [scene("a", 0, 2)] }), { runner: stubRunner({ renderAudio: undefined }), outputPath: "x" }))
            .rejects.toMatchObject({ code: "runner-unsupported" });
        const runner = stubRunner();
        await expect(mixTimelineAudio(input({ scenes: [scene("b", 0, 2)] }), { runner, outputPath: "x" })).rejects.toMatchObject({ code: "no-audio" });
        expect(runner.rendered).toEqual([]);
    });

    it("stops when the signal is aborted", async () => {
        const abort = new AbortController();
        abort.abort();
        await expect(mixTimelineAudio(input({ scenes: [scene("a", 0, 2)] }), { runner: stubRunner(), outputPath: "x", signal: abort.signal })).rejects.toMatchObject({ code: "cancelled" });
    });
});
