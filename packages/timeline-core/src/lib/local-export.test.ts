// Tests for the pure ffmpeg.wasm argument builders used by the optional
// in-browser exporter. The wasm runtime itself is not exercised here.
import { describe, expect, it } from "vitest";
import { buildConcatArgs, buildConcatListFile, buildTrimArgs } from "./local-export";

describe("buildTrimArgs", () => {
    it("seeks and stream-copies the requested range", () => {
        expect(buildTrimArgs("in.mp4", { start: 1.5, duration: 4 }, "out.mp4")).toEqual([
            "-ss",
            "1.500",
            "-t",
            "4.000",
            "-i",
            "in.mp4",
            "-c",
            "copy",
            "out.mp4",
        ]);
    });

    it("never emits a negative duration", () => {
        const args = buildTrimArgs("in.mp4", { start: 0, duration: -3 }, "out.mp4");
        expect(args[args.indexOf("-t") + 1]).toBe("0.000");
    });
});

describe("buildConcatListFile", () => {
    it("writes one concat-demuxer entry per segment, in order", () => {
        expect(buildConcatListFile(["seg0.mp4", "seg1.mp4"])).toBe(
            "file 'seg0.mp4'\nfile 'seg1.mp4'\n",
        );
    });
});

describe("buildConcatArgs", () => {
    it("uses the concat demuxer with stream copy", () => {
        expect(buildConcatArgs("concat.txt", "out.mp4")).toEqual([
            "-f",
            "concat",
            "-safe",
            "0",
            "-i",
            "concat.txt",
            "-c",
            "copy",
            "out.mp4",
        ]);
    });
});
