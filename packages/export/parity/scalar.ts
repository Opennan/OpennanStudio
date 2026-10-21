// Scalar parity harness (test-only): evaluates per-frame ffmpeg expressions on a real host through aevalsrc,
// one audio sample per video frame (sample rate = fps, so sample n is frame n), stored as f64le doubles, so
// the export's motion expressions can be compared with timeline-core's evaluateScalar at the same frame times.
import { ffNumber, type Expr } from "@opennan/timeline-core/looks/expr";
import type { FfmpegHost } from "./ffmpeg";

/** Time variable aevalsrc evaluates: the frame index over the frame rate, as the layer filters write it. */
export const scalarTime = (fps: number) => `(n/${fps})`;

/**
 * Values of each expression (written over `scalarTime(fps)`) at frames 0 … frames − 1. Up to eight
 * expressions run as the channels of one aevalsrc; more are split into several runs.
 */
export async function evalScalarOnFfmpeg(host: FfmpegHost, exprs: string[], fps: number, frames: number): Promise<number[][]> {
    const out: number[][] = [];
    for (let i = 0; i < exprs.length; i += 8) {
        const group = exprs.slice(i, i + 8);
        for (const e of group) if (e.includes("|") || e.includes("'")) throw new Error(`expression cannot go through aevalsrc: ${e}`);
        const graph = `aevalsrc=exprs='${group.join("|")}':s=${fps}:d=${(frames / fps).toFixed(9)}[out]`;
        const bytes = await host.run({
            files: {},
            args: ["-filter_complex", graph, "-map", "[out]", "-f", "f64le", "-c:a", "pcm_f64le", "out.raw"],
            outputName: "out.raw",
        });
        const samples = new Float64Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
        if (samples.length !== frames * group.length) throw new Error(`expected ${frames * group.length} samples, got ${samples.length}`);
        group.forEach((_, c) => out.push(Array.from({ length: frames }, (_, n) => samples[n * group.length + c])));
    }
    return out;
}

/**
 * The expression with every constant as ffmpeg reads it: emitFfmpeg writes constants with ffNumber (at most
 * nine decimals), so this is the function ffmpeg evaluates, operation for operation. Comparing ffmpeg with
 * evaluateScalar of this tree checks the evaluation; comparing this tree with the original bounds the
 * constant rounding.
 */
export function asWritten(e: Expr): Expr {
    switch (e.k) {
        case "num": return { k: "num", v: Number(ffNumber(e.v).replace(/[()]/g, "")) };
        case "bin": return { ...e, a: asWritten(e.a), b: asWritten(e.b) };
        case "call": return { ...e, args: e.args.map(asWritten) };
        case "if": return { ...e, c: asWritten(e.c), a: asWritten(e.a), b: asWritten(e.b) };
        case "sample": return { ...e, x: asWritten(e.x), y: asWritten(e.y) };
        case "let": return { ...e, value: asWritten(e.value), body: asWritten(e.body) };
        default: return e;
    }
}
