import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { encoderChoice } from "@opennan/export";
import { LOCAL_PROTOCOLS, MEDIA_DEMUXERS } from "@opennan/export/node";
import { CapabilityUnavailableError, JobFailedError } from "@opennan/provider-sdk";
import { writeProjectFile } from "./project-file";
import { connectInMemory } from "./testing/connect";
import { fixtureProject } from "./testing/fixture";
import { openHeadlessProject } from "./headless";
import {
    MEDIA_TOOLS_NEED_FFMPEG, ONLY_PROJECT_MEDIA, createFfmpegAnalyzer, createHeadlessMediaPreparer, createStoryShotsMaker, createStorySheetMaker, framesAtTimes, minPixelsScale, projectMediaPath,
} from "./headless-media";

// Same lookup as headless.test.ts: OPENNAN_FFMPEG / OPENNAN_FFPROBE, else Homebrew.
const FFMPEG = process.env.OPENNAN_FFMPEG ?? "/opt/homebrew/bin/ffmpeg";
const FFPROBE = process.env.OPENNAN_FFPROBE ?? "/opt/homebrew/bin/ffprobe";
const HAS_FFMPEG = existsSync(FFMPEG) && existsSync(FFPROBE);
if (process.env.OPENNAN_REQUIRE_FFMPEG === "1" && !HAS_FFMPEG) throw new Error(`OPENNAN_REQUIRE_FFMPEG=1, but ${FFMPEG} or ${FFPROBE} is missing`);

const AUDIO = { output: "audio", sampleRate: 44_100, maxBytes: 200 * 1024 * 1024, maxSeconds: 600, contentTypes: ["audio/wav"] } as const;
const VIDEO = { output: "video", maxBytes: 200 * 1024 * 1024, maxSeconds: 60, contentTypes: ["video/mp4"] } as const;

let dir: string;
let mediaDir: string;
beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "opennan-headless-media-"));
    mediaDir = path.join(dir, "p.opennan.json.media");
    await mkdir(mediaDir);
});
afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
});

describe("headless media", () => {
    it("reads only project media", () => {
        expect(projectMediaPath("/m", "opennan-local://media/abc-1")).toBe(path.join("/m", "abc-1"));
        expect(projectMediaPath("/m", "opennan-local://media/../../etc")).toBe(path.join("/m", "______etc"));
        expect(projectMediaPath("/m", "https://example.com/a.mp4")).toBeNull();
        expect(projectMediaPath("/m", "file:///etc/passwd")).toBeNull();
    });

    it("without ffmpeg, preparing answers what the tools need", async () => {
        const prepare = createHeadlessMediaPreparer({ mediaDir });
        const failed = prepare({ kind: "media", source: { mediaUrl: "opennan-local://media/a" } }, AUDIO, new AbortController().signal);
        await expect(failed).rejects.toBeInstanceOf(CapabilityUnavailableError);
        await expect(failed).rejects.toThrow(MEDIA_TOOLS_NEED_FFMPEG);
    });

    it("guards ffmpeg's input like the export's source policy and maps only the stream the tool needs", async () => {
        const { writeFile } = await import("node:fs/promises");
        await writeFile(path.join(mediaDir, "clip"), "media");
        const ran: string[][] = [];
        const prepare = createHeadlessMediaPreparer({
            mediaDir, ffmpeg: { ffmpegPath: "/ff/ffmpeg", ffprobePath: path.join(dir, "no-ffprobe") },
            run: async (_command, args) => {
                ran.push(args);
                await writeFile(args.at(-1)!, "out");
                return { code: 0, stdout: "", stderr: "" };
            },
            chooseEncoder: async () => encoderChoice("libx264", { videoBitrateKbps: 8000, audioBitrateKbps: 192 }),
        });
        const signal = new AbortController().signal;
        const source = { mediaUrl: "opennan-local://media/clip", startSeconds: 1, endSeconds: 3 };
        await prepare({ kind: "media", source }, AUDIO, signal);
        await prepare({ kind: "media", source }, VIDEO, signal);
        await prepare({ kind: "media", source }, { ...VIDEO, keepAudio: true }, signal);
        await prepare({ kind: "media", source }, { output: "image", maxBytes: 1024, contentTypes: ["image/png"] }, signal);
        for (const args of ran) {
            const input = args.indexOf("-i");
            const before = args.slice(0, input);
            expect(before).toEqual(expect.arrayContaining(["-protocol_whitelist", LOCAL_PROTOCOLS, "-format_whitelist", MEDIA_DEMUXERS]));
            expect(args.slice(input)).toEqual(expect.arrayContaining(["-map_metadata", "-1"]));
        }
        const [audio, video, withAudio, image] = ran.map((args) => args.slice(args.indexOf("-i")));
        expect(audio).toEqual(expect.arrayContaining(["-map", "0:a:0", "-vn", "-sn", "-dn"]));
        expect(video).toEqual(expect.arrayContaining(["-map", "0:v:0", "-an", "-sn", "-dn"]));
        expect(video).not.toContain("0:a:0?");
        expect(withAudio).toEqual(expect.arrayContaining(["-map", "0:v:0", "-map", "0:a:0?"]));
        expect(image).toEqual(expect.arrayContaining(["-map", "0:v:0", "-frames:v", "1"]));
    });

    it.skipIf(!HAS_FFMPEG)("trims project audio and video with ffmpeg and refuses other media", async () => {
        // 1 s tone, 1 s silence, 1 s tone; a 2 s 320×240 test picture.
        execFileSync(FFMPEG, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono:d=1",
            "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-filter_complex", "[0][1][2]concat=n=3:v=0:a=1", "-ar", "44100", "-f", "wav", path.join(mediaDir, "tone")]);
        execFileSync(FFMPEG, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=25:duration=2", "-pix_fmt", "yuv420p", "-f", "mp4", path.join(mediaDir, "pic")]);
        const prepare = createHeadlessMediaPreparer({ mediaDir, ffmpeg: { ffmpegPath: FFMPEG, ffprobePath: FFPROBE } });
        const signal = new AbortController().signal;
        const audio = await prepare({ kind: "media", source: { mediaUrl: "opennan-local://media/tone", startSeconds: 0.5, endSeconds: 2.5 } }, AUDIO, signal);
        expect(audio).toMatchObject({ contentType: "audio/wav", filename: "audio.wav" });
        expect(audio.durationSeconds).toBeCloseTo(2, 1);
        expect(new TextDecoder().decode((audio.data as Uint8Array).subarray(0, 4))).toBe("RIFF");
        expect(audio.sizeBytes).toBe((audio.data as Uint8Array).byteLength);
        const video = await prepare({ kind: "media", source: { mediaUrl: "opennan-local://media/pic", startSeconds: 0, endSeconds: 1 } }, VIDEO, signal);
        expect(video).toMatchObject({ contentType: "video/mp4", width: 320, height: 240 });
        expect(video.durationSeconds).toBeCloseTo(1, 0);
        await expect(prepare({ kind: "media", source: { mediaUrl: "https://example.com/a.wav" } }, AUDIO, signal)).rejects.toThrow(ONLY_PROJECT_MEDIA);
        await expect(prepare({ kind: "media", source: { mediaUrl: "opennan-local://media/missing" } }, AUDIO, signal)).rejects.toBeInstanceOf(JobFailedError);
    }, 60_000);

    it.skipIf(!HAS_FFMPEG)("reports the cut range's length when the prepared file cannot be measured", async () => {
        execFileSync(FFMPEG, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=3", "-ar", "44100", "-f", "wav", path.join(mediaDir, "tone")]);
        const prepare = createHeadlessMediaPreparer({ mediaDir, ffmpeg: { ffmpegPath: FFMPEG, ffprobePath: path.join(dir, "no-ffprobe") } });
        const audio = await prepare({ kind: "media", source: { mediaUrl: "opennan-local://media/tone", startSeconds: 0.5, endSeconds: 2.5 } }, AUDIO, new AbortController().signal);
        expect(audio.durationSeconds).toBe(2);
    }, 60_000);

    it.skipIf(!HAS_FFMPEG)("finds silences in a range with ffmpeg and the detectors (source seconds)", async () => {
        execFileSync(FFMPEG, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono:d=1",
            "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-filter_complex", "[0][1][2]concat=n=3:v=0:a=1", "-ar", "44100", "-f", "wav", path.join(mediaDir, "tone")]);
        const analyzer = createFfmpegAnalyzer({ mediaDir, ffmpegPath: FFMPEG });
        const outcome = await analyzer.analyze({ kind: "silences", mediaUrl: "opennan-local://media/tone", startSeconds: 0.5, endSeconds: 3, options: {} }, {});
        expect(outcome.silences).toHaveLength(1);
        expect(outcome.silences![0]!.start).toBeCloseTo(1.08, 1);
        expect(outcome.silences![0]!.end).toBeCloseTo(1.92, 1);
        expect(await analyzer.analyze({ kind: "beats", mediaUrl: "https://example.com/a.wav", startSeconds: 0, endSeconds: 3, options: {} }, {})).toEqual({ error: ONLY_PROJECT_MEDIA });
    }, 60_000);

    it.skipIf(!HAS_FFMPEG)("mcp serve --ffmpeg: remove_silences decodes the clip and cuts the pause", async () => {
        execFileSync(FFMPEG, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono:d=1",
            "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-filter_complex", "[0][1][2]concat=n=3:v=0:a=1", "-ar", "44100", "-f", "wav", path.join(mediaDir, "tone")]);
        const project = fixtureProject();
        project.clips = project.clips.map((c) => (c.id === "music" ? { ...c, mediaUrl: "opennan-local://media/tone", endTime: 3 } : c));
        const file = path.join(dir, "p.opennan.json");
        await writeProjectFile(file, project);
        const studio = await openHeadlessProject({ projectFile: file, ffmpeg: { ffmpegPath: FFMPEG, ffprobePath: FFPROBE } });
        const { client, close } = await connectInMemory(studio.session);
        try {
            const result = await client.callTool({ name: "remove_silences", arguments: { clip_id: "music" } });
            expect(result.isError).toBe(false);
            expect((result.structuredContent as { removedSeconds: number }).removedSeconds).toBeCloseTo(0.84, 1);
            const audio = studio.controller.snapshot().clips.filter((c) => c.trackType === "audio");
            expect(audio).toHaveLength(2);
            expect(Math.max(...audio.map((c) => c.endTime))).toBeCloseTo(2.16, 1);
        } finally {
            await close();
            await studio.close();
        }
    }, 60_000);
});

describe("story film contact sheet", () => {
    it.skipIf(!HAS_FFMPEG)("tiles 16 evenly spaced frames of a project video, four across, on one JPEG saved to the project", async () => {
        const file = path.join(mediaDir, "clip");
        execFileSync(FFMPEG, ["-v", "error", "-f", "lavfi", "-i", "testsrc=duration=8:size=320x180:rate=10", "-c:v", "libvpx-vp9", "-f", "webm", "-y", file]);
        const saved: Array<{ name: string; type: string; size: number }> = [];
        const make = createStorySheetMaker({
            mediaDir, ffmpeg: { ffmpegPath: FFMPEG, ffprobePath: FFPROBE },
            save: async (blob, name) => {
                saved.push({ name, type: blob.type, size: blob.size });
                return "opennan-local://media/sheet";
            },
        });
        const sheet = await make("opennan-local://media/clip", 16);
        expect(sheet).toEqual({ url: "opennan-local://media/sheet", frames: 16, everySeconds: 0.5, durationSeconds: 8 });
        expect(saved).toEqual([{ name: "story-frames.jpg", type: "image/jpeg", size: expect.any(Number) }]);
        expect(saved[0]!.size).toBeGreaterThan(1000);
        await expect(make("https://example.com/v.mp4", 16)).rejects.toThrow(ONLY_PROJECT_MEDIA);
    });
});

describe("story film shots (remake from your video)", () => {
    it("builds the filters: frames at chosen times, a picture scaled up to the minimum pixels", () => {
        expect(framesAtTimes([1, 7.5])).toBe("select='gte(t,1.000)*(isnan(prev_t)+lt(prev_t,1.000))+gte(t,7.500)*(isnan(prev_t)+lt(prev_t,7.500))'");
        expect(minPixelsScale(409_600)).toBe("scale='if(lt(iw*ih,409600),ceil(iw*sqrt(409600/(iw*ih))/2)*2,trunc(iw/2)*2)':'if(lt(iw*ih,409600),ceil(ih*sqrt(409600/(iw*ih))/2)*2,trunc(ih/2)*2)'");
    });

    it.skipIf(!HAS_FFMPEG)("finds the cut of a two-shot video, cuts each shot out as a project video, and samples a sheet per shot", async () => {
        const file = path.join(mediaDir, "two-shots");
        // 4 s of a test card, then 4 s of another pattern: one cut at 4 s.
        execFileSync(FFMPEG, [
            "-v", "error", "-f", "lavfi", "-i", "testsrc=duration=4:size=320x180:rate=25", "-f", "lavfi", "-i", "mandelbrot=size=320x180:rate=25",
            "-filter_complex", "[1:v]trim=0:4,setpts=PTS-STARTPTS[b];[0:v][b]concat=n=2:v=1:a=0[v]", "-map", "[v]", "-c:v", "libvpx-vp9", "-f", "webm", "-y", file,
        ]);
        const ffmpeg = { ffmpegPath: FFMPEG, ffprobePath: FFPROBE };
        const saved: Array<{ name: string; type: string }> = [];
        const save = async (blob: Blob, name: string) => {
            saved.push({ name, type: blob.type });
            return `opennan-local://media/${name}`;
        };
        const prepare = createHeadlessMediaPreparer({ mediaDir, ffmpeg });
        const shots = createStoryShotsMaker({ mediaDir, ffmpeg, save, prepare });
        const found = await shots("opennan-local://media/two-shots", true);
        expect(found.truncated).toBe(false);
        expect(found.durationSeconds).toBeCloseTo(8, 1);
        expect(found.shots).toHaveLength(2);
        expect(found.shots[0]!.start).toBe(0);
        expect(found.shots[0]!.end).toBeCloseTo(4, 1);
        expect(found.shots.map((s) => s.clip)).toEqual(["opennan-local://media/story-shot-01.mp4", "opennan-local://media/story-shot-02.mp4"]);
        expect(saved.map((s) => s.type)).toEqual(["video/mp4", "video/mp4"]);
        const uncut = await shots("opennan-local://media/two-shots", false);
        expect(uncut.shots.every((s) => s.clip === undefined)).toBe(true);
        const sheet = await createStorySheetMaker({ mediaDir, ffmpeg, save })("opennan-local://media/two-shots", 16, undefined, [1, 2, 3, 5, 6, 7]);
        expect(sheet.frames).toBe(6);
        // A small picture is scaled up to a reference video's minimum pixels.
        const up = await prepare({ kind: "media", source: { mediaUrl: "opennan-local://media/two-shots", startSeconds: 0, endSeconds: 3 } }, { ...VIDEO, minPixels: 409_600 }, new AbortController().signal);
        expect(up.width! * up.height!).toBeGreaterThanOrEqual(409_600);
    }, 60_000);
});
