// Runs a compiled ExportPlan's video or audio graph on a parity host and returns raw frames or samples (test-only).
import type { ExportPlan } from "../src/types";
import type { FfmpegHost } from "./ffmpeg";

function planInputs(plan: ExportPlan, media: Record<string, Uint8Array>): { files: Record<string, Uint8Array>; args: string[] } {
    const files: Record<string, Uint8Array> = {};
    const args: string[] = [];
    // Every job file (an image-sequence input names its frames with a pattern, not one file).
    for (const file of plan.files) files[file.name] = file.data;
    plan.inputs.forEach((input, i) => {
        let name: string;
        if (input.kind === "file") {
            const pattern = input.source.includes("%05d") ? new RegExp(`^${input.source.replace(/[.]/g, "\\.").replace("%05d", "\\d{5}")}$`) : null;
            if (pattern ? !plan.files.some((f) => pattern.test(f.name)) : !plan.files.some((f) => f.name === input.source)) throw new Error(`missing plan file ${input.source}`);
            name = input.source;
        } else {
            const data = media[input.source];
            if (!data) throw new Error(`missing media ${input.source}`);
            name = `media-${i}${input.source.slice(input.source.lastIndexOf("."))}`;
            files[name] = data;
        }
        args.push(...input.options, "-i", name);
    });
    return { files, args };
}

/**
 * Raw rgb24 frames of the plan's video. `probe` (optional filters, e.g. a crop and a tiny neighbor scale) runs
 * on the output first, so tests that read a few pixels per frame move little data through ffmpeg.wasm.
 */
export async function runPlanVideo(host: FfmpegHost, plan: ExportPlan, media: Record<string, Uint8Array>, probe?: string): Promise<Uint8Array> {
    const { files, args } = planInputs(plan, media);
    const video = probe ? `;[${plan.videoLabel}]${probe}[probe]` : "";
    args.push(
        "-filter_complex", `${plan.filterGraph}${video};[${plan.audioLabel}]anullsink`, "-map", probe ? "[probe]" : `[${plan.videoLabel}]`,
        "-fps_mode", "passthrough", "-f", "rawvideo", "-pix_fmt", "rgb24", "out.raw",
    );
    return host.run({ files, args, outputName: "out.raw" });
}

/** The plan's audio as mono float samples at 48 kHz (the video is discarded). */
export async function runPlanAudio(host: FfmpegHost, plan: ExportPlan, media: Record<string, Uint8Array>): Promise<Float32Array> {
    const { files, args } = planInputs(plan, media);
    args.push("-filter_complex", `${plan.filterGraph};[${plan.videoLabel}]nullsink`, "-map", `[${plan.audioLabel}]`, "-ac", "1", "-f", "f32le", "out.raw");
    const bytes = await host.run({ files, args, outputName: "out.raw" });
    return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}
