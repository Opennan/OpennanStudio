import { buildWhisperArgs } from "./whisper-args";

const BASE = { modelPath: "/models/ggml-base.bin", wavPath: "/tmp/job/mix.wav", outputBase: "/tmp/job/out" };

describe("buildWhisperArgs", () => {
    it("builds one argv element per value", () => {
        expect(buildWhisperArgs({ ...BASE, language: "en", threads: 4 })).toEqual([
            "-m", "/models/ggml-base.bin", "-f", "/tmp/job/mix.wav", "-l", "en", "-t", "4",
            "-ojf", "-of", "/tmp/job/out", "-ml", "42", "-sow", "-pp", "-np", "-sns",
        ]);
    });

    it("defaults to auto-detect, four threads, and the GPU", () => {
        const args = buildWhisperArgs(BASE);
        expect(args.slice(args.indexOf("-l"), args.indexOf("-l") + 4)).toEqual(["-l", "auto", "-t", "4"]);
        expect(args).not.toContain("-ng");
        expect(buildWhisperArgs({ ...BASE, gpu: false })).toContain("-ng");
        expect(buildWhisperArgs({ ...BASE, maxLen: 60 })).toEqual(expect.arrayContaining(["-ml", "60"]));
    });

    it("keeps paths with spaces and quotes as single elements", () => {
        const args = buildWhisperArgs({ ...BASE, modelPath: "/Users/a b/my work/\"m\".bin" });
        expect(args[1]).toBe("/Users/a b/my work/\"m\".bin");
    });

    it("refuses languages outside whisper's list", () => {
        for (const language of ["en; rm -rf /", "EN", "", "english", "-h"]) expect(() => buildWhisperArgs({ ...BASE, language })).toThrow(/language/);
    });

    it("clamps threads and max length", () => {
        expect(buildWhisperArgs({ ...BASE, threads: 99 })).toEqual(expect.arrayContaining(["-t", "16"]));
        expect(buildWhisperArgs({ ...BASE, threads: 0 })).toEqual(expect.arrayContaining(["-t", "1"]));
        expect(buildWhisperArgs({ ...BASE, threads: Number.NaN })).toEqual(expect.arrayContaining(["-t", "4"]));
        expect(buildWhisperArgs({ ...BASE, maxLen: 2 })).toEqual(expect.arrayContaining(["-ml", "8"]));
    });

    it("refuses relative paths, NUL bytes, option-like values, and a .json output base", () => {
        expect(() => buildWhisperArgs({ ...BASE, modelPath: "models/x.bin" })).toThrow(/absolute/);
        expect(() => buildWhisperArgs({ ...BASE, wavPath: "/tmp/a\0b.wav" })).toThrow(/invalid/);
        expect(() => buildWhisperArgs({ ...BASE, outputBase: "/tmp/out.json" })).toThrow(/\.json/);
    });
});
