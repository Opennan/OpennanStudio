import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as mediabunny from "mediabunny";
import { audioOnlyPlan, type MuxPlan } from "../compile/mux";
import { streamMux } from "./stream-mux";

const FFMPEG = process.env.OPENNAN_FFMPEG ?? "/opt/homebrew/bin/ffmpeg";
const FFPROBE = process.env.OPENNAN_FFPROBE ?? "/opt/homebrew/bin/ffprobe";
const HAS_FFMPEG = spawnSync(FFMPEG, ["-version"]).status === 0 && spawnSync(FFMPEG, ["-hide_banner", "-encoders"], { encoding: "utf8" }).stdout?.includes("libx264");

describe("audioOnlyPlan", () => {
    it("drops the video input and renumbers the graph's input pads", () => {
        const plan: MuxPlan = {
            format: { width: 1280, height: 720, fps: 30, aspectRatio: 16 / 9, refWidth: 1920, refHeight: 1080, frameScale: 2 / 3 },
            durationSeconds: 2,
            inputs: [{ kind: "file", source: "gpu-video", options: [] }, { kind: "media", source: "/a.webm", options: [] }, { kind: "media", source: "/m.mp3", options: [] }],
            filterGraph: "[1:a]atrim=0:2,asetpts=PTS-STARTPTS[a0];[2:a]volume=0.5[a1];[a0][a1]amix=inputs=2[a12]",
            audioLabel: "a12", audioBitrateKbps: 192, warnings: [],
        };
        const audio = audioOnlyPlan(plan);
        expect(audio.inputs.map((input) => input.source)).toEqual(["/a.webm", "/m.mp3"]);
        expect(audio.filterGraph).toBe("[0:a]atrim=0:2,asetpts=PTS-STARTPTS[a0];[1:a]volume=0.5[a1];[a0][a1]amix=inputs=2[a12]");
        expect(() => audioOnlyPlan({ ...plan, filterGraph: "[0:v]null[x]" })).toThrow();
    });
});

/** A memory stream target that records where each chunk landed. */
function memoryTarget() {
    let bytes = new Uint8Array(0);
    const writable = new WritableStream<{ type: "write"; data: Uint8Array; position: number }>({
        write({ data, position }) {
            if (position + data.byteLength > bytes.byteLength) {
                const grown = new Uint8Array(position + data.byteLength);
                grown.set(bytes);
                bytes = grown;
            }
            bytes.set(data, position);
        },
    });
    return { writable, bytes: () => bytes };
}

describe.skipIf(!HAS_FFMPEG)("streamMux", () => {
    let dir: string;
    beforeAll(() => {
        dir = mkdtempSync(path.join(tmpdir(), "opennan-streammux-"));
        const run = (args: string[]) => execFileSync(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", ...args]);
        run(["-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30:duration=3", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "60", path.join(dir, "video.mp4")]);
        run(["-f", "lavfi", "-i", "sine=frequency=440:duration=3", "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "2", path.join(dir, "audio.m4a")]);
        run(["-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30:duration=3", "-c:v", "libvpx-vp9", "-b:v", "500k", "-deadline", "realtime", path.join(dir, "video.webm")]);
        run(["-f", "lavfi", "-i", "sine=frequency=440:duration=3", "-c:a", "libopus", "-b:a", "128k", path.join(dir, "audio.webm")]);
    });
    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    const probe = (file: string) => JSON.parse(execFileSync(FFPROBE, [
        "-v", "error", "-count_packets", "-show_entries", "stream=codec_name,codec_type,nb_read_packets:format=duration", "-of", "json", file,
    ], { encoding: "utf8" })) as { streams: Array<{ codec_name: string; codec_type: string; nb_read_packets: string }>; format: { duration: string } };

    const packets = (file: string, stream: "v" | "a") => execFileSync(FFPROBE, ["-v", "error", "-select_streams", stream, "-show_entries", "packet=size", "-of", "csv=p=0", file], { encoding: "utf8" });

    it("copies every video and audio packet into a Fast Start MP4 without re-encoding", async () => {
        const target = memoryTarget();
        const progress: number[] = [];
        await streamMux({
            mediabunny, video: new Blob([readFileSync(path.join(dir, "video.mp4"))]), audio: new Uint8Array(readFileSync(path.join(dir, "audio.m4a"))),
            container: "mp4", writable: target.writable, onProgress: (r) => progress.push(r),
        });
        const out = path.join(dir, "out.mp4");
        writeFileSync(out, target.bytes());
        const info = probe(out);
        expect(info.streams.map((s) => `${s.codec_type}:${s.codec_name}`).sort()).toEqual(["audio:aac", "video:h264"]);
        expect(Number(info.format.duration)).toBeCloseTo(3, 1);
        // Same packets as the inputs (sizes in order), so nothing was re-encoded.
        expect(packets(out, "v")).toBe(packets(path.join(dir, "video.mp4"), "v"));
        expect(packets(out, "a")).toBe(packets(path.join(dir, "audio.m4a"), "a"));
        // Fast Start: the movie header comes before the media data.
        const text = Buffer.from(target.bytes()).toString("latin1");
        expect(text.indexOf("moov")).toBeLessThan(text.indexOf("mdat"));
        expect(progress.at(-1)).toBe(1);
    });

    it("muxes VP9 and Opus into WebM", async () => {
        const target = memoryTarget();
        await streamMux({
            mediabunny, video: new Blob([readFileSync(path.join(dir, "video.webm"))]), audio: new Uint8Array(readFileSync(path.join(dir, "audio.webm"))),
            container: "webm", writable: target.writable,
        });
        const out = path.join(dir, "out.webm");
        writeFileSync(out, target.bytes());
        const info = probe(out);
        expect(info.streams.map((s) => `${s.codec_type}:${s.codec_name}`).sort()).toEqual(["audio:opus", "video:vp9"]);
        expect(packets(out, "v")).toBe(packets(path.join(dir, "video.webm"), "v"));
    });

    it("stops on abort and leaves the caller to discard the partial file", async () => {
        const controller = new AbortController();
        controller.abort();
        await expect(streamMux({
            mediabunny, video: new Blob([readFileSync(path.join(dir, "video.mp4"))]), audio: new Uint8Array(readFileSync(path.join(dir, "audio.m4a"))),
            container: "mp4", writable: memoryTarget().writable, signal: controller.signal,
        })).rejects.toThrow(/cancelled/);
    });
});
