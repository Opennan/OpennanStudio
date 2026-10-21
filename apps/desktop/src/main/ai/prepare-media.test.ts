import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { encoderChoice, gplFiltersIn, type ExportRunner, type MediaInfo } from "@opennan/export";
import type { MediaPreparePurpose } from "@opennan/provider-sdk";
import { resolveFfmpeg } from "../export/ffmpeg-paths";
import {
    MEDIA_SOURCE_REFUSED, audioArgs, createDesktopMediaPreparer, imageArgs, preparedRange, videoArgs, videoFilterGraph,
    type DesktopMediaPreparerOptions,
} from "./prepare-media";

const ID = "3f2b8c1e-1d2a-4c3b-9e8f-0a1b2c3d4e5f";
const GUARDS = ["-protocol_whitelist", "file,pipe", "-format_whitelist", "mov,matroska"];
const MB = 1024 * 1024;
const WAV: MediaPreparePurpose = { output: "audio", sampleRate: 16_000, maxBytes: 200 * MB, maxSeconds: 1800, contentTypes: ["audio/wav"] };
const VIDEO: MediaPreparePurpose = { output: "video", maxBytes: 200 * MB, maxSeconds: 60, contentTypes: ["video/mp4", "video/webm"] };
const IMAGE: MediaPreparePurpose = { output: "image", maxBytes: 20 * MB, contentTypes: ["image/png", "image/jpeg", "image/webp"] };
const VT = encoderChoice("h264_videotoolbox", { videoBitrateKbps: 8000, audioBitrateKbps: 192 });

describe("preparedRange", () => {
    it("takes the asked range, cut to the tool's length", () => {
        expect(preparedRange({ mediaUrl: "x", startSeconds: 2, endSeconds: 5 }, null)).toEqual({ startSeconds: 2, durationSeconds: 3 });
        expect(preparedRange({ mediaUrl: "x", startSeconds: 2, endSeconds: 500 }, null, 60)).toEqual({ startSeconds: 2, durationSeconds: 60 });
        // No end: the media's own length (when known), still cut to the tool's length.
        expect(preparedRange({ mediaUrl: "x", startSeconds: 4 }, 10)).toEqual({ startSeconds: 4, durationSeconds: 6 });
        expect(preparedRange({ mediaUrl: "x" }, 100, 30)).toEqual({ startSeconds: 0, durationSeconds: 30 });
        expect(preparedRange({ mediaUrl: "x" }, null)).toEqual({ startSeconds: 0 });
        expect(() => preparedRange({ mediaUrl: "x", startSeconds: 12 }, 10)).toThrow(/empty/);
    });
});

describe("ffmpeg arguments", () => {
    it("audio: the range decoded to mono 16-bit WAV at the asked rate, metadata dropped", () => {
        expect(audioArgs({ input: "/m/a.webm", inputGuards: GUARDS, range: { startSeconds: 1.5, durationSeconds: 2.25 }, sampleRate: 16_000, codec: "wav", output: "/t/audio.wav" })).toEqual([
            "-hide_banner", "-loglevel", "error", "-nostdin", "-y", ...GUARDS, "-ss", "1.5", "-t", "2.25", "-i", "/m/a.webm",
            "-map", "0:a:0", "-vn", "-sn", "-dn", "-map_metadata", "-1", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "-f", "wav", "/t/audio.wav",
        ]);
        const aac = audioArgs({ input: "/m/a.webm", inputGuards: GUARDS, range: { startSeconds: 0 }, sampleRate: 44_100, codec: "aac", output: "/t/audio.m4a" });
        expect(aac).not.toContain("-ss");
        expect(aac.join(" ")).toContain("-c:a aac -b:a 192k");
        expect(aac.join(" ")).toContain("-f mp4");
    });

    it("video: always re-encoded with the working encoder (a stream copy would start at the previous key frame)", () => {
        const args = videoArgs({ input: "/m/v.mov", inputGuards: GUARDS, range: { startSeconds: 3, durationSeconds: 2 }, encoder: VT, keepAudio: false, output: "/t/video.mp4" });
        expect(args.slice(0, 13)).toEqual(["-hide_banner", "-loglevel", "error", "-nostdin", "-y", ...GUARDS, "-ss", "3", "-t", "2"].slice(0, 13));
        expect(args).toEqual(expect.arrayContaining(["-c:v", "h264_videotoolbox", "-an", "-movflags", "+faststart"]));
        expect(args.join(" ")).not.toMatch(/copy/);
        expect(args.indexOf("-i")).toBeLessThan(args.indexOf("-c:v"));
        expect(args.at(-1)).toBe("/t/video.mp4");
        const withAudio = videoArgs({ input: "/m/v.mov", inputGuards: GUARDS, range: { startSeconds: 0 }, encoder: VT, keepAudio: true, output: "/t/video.mp4", progress: true });
        expect(withAudio.join(" ")).toContain("-map 0:v:0 -map 0:a:0?");
        expect(withAudio.join(" ")).toContain("-c:a aac");
        expect(withAudio.join(" ")).toContain("-progress pipe:1 -nostats");
        expect(withAudio).not.toContain("-an");
        // VAAPI's device goes before the input; WebM gets FFmpeg's own Opus (the LGPL build has no libopus).
        const vaapi = encoderChoice("h264_vaapi", { videoBitrateKbps: 8000, audioBitrateKbps: 192 });
        const vaapiArgs = videoArgs({ input: "/m/v.mov", inputGuards: GUARDS, range: { startSeconds: 0 }, encoder: vaapi, keepAudio: false, output: "/t/v.mp4" });
        expect(vaapiArgs.indexOf("-vaapi_device")).toBeLessThan(vaapiArgs.indexOf("-i"));
        const vp9 = encoderChoice("libvpx-vp9", { videoBitrateKbps: 8000, audioBitrateKbps: 192 });
        const webm = videoArgs({ input: "/m/v.mov", inputGuards: GUARDS, range: { startSeconds: 0 }, encoder: vp9, keepAudio: true, output: "/t/v.webm" });
        expect(webm.join(" ")).toContain("-c:a opus -strict -2");
        expect(webm).not.toContain("+faststart");
    });

    it("keeps the filter graph LGPL: even sizes for 4:2:0, plus the encoder's own filters", () => {
        expect(videoFilterGraph([], VT)).toBe("scale=trunc(iw/2)*2:trunc(ih/2)*2");
        const graph = videoFilterGraph(["deshake"], encoderChoice("h264_vaapi", { videoBitrateKbps: 1, audioBitrateKbps: 1 }));
        expect(graph).toBe("deshake,scale=trunc(iw/2)*2:trunc(ih/2)*2,format=nv12,hwupload");
        expect(gplFiltersIn(graph)).toEqual([]);
    });

    it("image: one frame as PNG", () => {
        expect(imageArgs({ input: "/m/v.mp4", inputGuards: GUARDS, startSeconds: 1.25, output: "/t/image.png" })).toEqual([
            "-hide_banner", "-loglevel", "error", "-nostdin", "-y", ...GUARDS, "-ss", "1.25", "-i", "/m/v.mp4", "-frames:v", "1", "-map_metadata", "-1", "-c:v", "png", "-f", "image2", "/t/image.png",
        ]);
    });
});

describe("createDesktopMediaPreparer", () => {
    let dir: string;
    let tempDir: string;
    let media: string;
    let ran: string[][];
    beforeEach(() => {
        dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "opennan-prep-")));
        fs.mkdirSync(path.join(dir, "media"));
        tempDir = path.join(dir, "tmp");
        fs.mkdirSync(tempDir);
        media = path.join(dir, "media", `${ID}.webm`);
        fs.writeFileSync(media, "webm");
        ran = [];
    });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    /** A fake ffmpeg: writes `bytes` to the output path (the last argument). */
    function preparer(overrides: Partial<DesktopMediaPreparerOptions> = {}, bytes = 1000, probed: Partial<MediaInfo> | null = { durationSeconds: 2 }) {
        return createDesktopMediaPreparer({
            ffmpeg: { ffmpegPath: "/ff/ffmpeg", ffprobePath: "/ff/ffprobe" },
            mediaStore: { root: path.join(dir, "media"), pathOf: (id) => (id === ID ? media : null) },
            tempDir,
            run: async (_command, args) => {
                ran.push(args);
                fs.writeFileSync(args.at(-1)!, Buffer.alloc(bytes));
                return { code: 0, stdout: "", stderr: "" };
            },
            probe: async () => (probed ? { durationSeconds: 0, hasVideo: false, hasAudio: true, width: 0, height: 0, ...probed } : null),
            chooseEncoder: async () => VT,
            ...overrides,
        });
    }
    const signal = () => new AbortController().signal;
    const leftovers = () => fs.readdirSync(tempDir);

    it("prepares a media range as WAV, returns its bytes, and leaves no temp files", async () => {
        const prepared = await preparer().prepareMedia({ kind: "media", source: { mediaUrl: `opennan-local://media/${ID}`, startSeconds: 1, endSeconds: 2.5 } }, WAV, signal());
        expect(prepared).toMatchObject({ contentType: "audio/wav", filename: "audio.wav", sizeBytes: 1000, durationSeconds: 2 });
        expect(prepared.data).toBeInstanceOf(Uint8Array);
        expect((prepared.data as Uint8Array).byteLength).toBe(1000);
        expect(ran).toHaveLength(1);
        expect(ran[0]).toEqual(expect.arrayContaining(["-ss", "1", "-t", "1.5", "-i", media, "-c:a", "pcm_s16le", "-ar", "16000"]));
        expect(ran[0].slice(5, 9)).toEqual(["-protocol_whitelist", "file,pipe", "-format_whitelist", expect.stringContaining("matroska")]);
        expect(leftovers()).toEqual([]);
    });

    it("reports the longer of the measured length and the asked range", async () => {
        const prepared = await preparer({}, 1000, { durationSeconds: 1.2 }).prepareMedia({ kind: "media", source: { mediaUrl: `opennan-media://blob/${ID}`, startSeconds: 0, endSeconds: 1.5 } }, WAV, signal());
        expect(prepared.durationSeconds).toBe(1.5);
    });

    it("reports the asked range's length when the prepared file cannot be measured", async () => {
        const prepared = await preparer({}, 1000, null).prepareMedia({ kind: "media", source: { mediaUrl: `opennan-local://media/${ID}`, startSeconds: 1, endSeconds: 2.5 } }, WAV, signal());
        expect(prepared.durationSeconds).toBe(1.5);
    });

    it("refuses anything but imported media before ffmpeg runs", async () => {
        const p = preparer();
        for (const mediaUrl of ["https://cdn.example/a.mp4", "file:///etc/passwd", "blob:opennan-app://app/x", "/etc/passwd", "opennan-local://media/../../etc/passwd", "opennan-local://media/11111111-2222-4333-8444-555555555555"]) {
            await expect(p.prepareMedia({ kind: "media", source: { mediaUrl } }, WAV, signal())).rejects.toThrow(mediaUrl.endsWith("555555555555") ? /no longer in the media library/ : MEDIA_SOURCE_REFUSED);
        }
        expect(ran).toEqual([]);
    });

    it("refuses without ffmpeg", async () => {
        await expect(preparer({ ffmpeg: null }).prepareMedia({ kind: "media", source: { mediaUrl: `opennan-local://media/${ID}` } }, WAV, signal())).rejects.toThrow(/ffmpeg/);
    });

    it("switches to AAC when WAV would pass the size cap and audio/mp4 is accepted; refuses when it is not", async () => {
        const purpose: MediaPreparePurpose = { output: "audio", sampleRate: 44_100, maxBytes: 50 * MB, maxSeconds: 900, contentTypes: ["audio/wav", "audio/mp4"] };
        // 900 s of 44.1 kHz mono WAV is ~79 MB.
        const long = { kind: "media" as const, source: { mediaUrl: `opennan-local://media/${ID}`, startSeconds: 0, endSeconds: 900 } };
        const prepared = await preparer({}, 1000, { durationSeconds: 900 }).prepareMedia(long, purpose, signal());
        expect(prepared).toMatchObject({ contentType: "audio/mp4", filename: "audio.m4a" });
        expect(ran[0]).toEqual(expect.arrayContaining(["-c:a", "aac"]));
        ran = [];
        await expect(preparer().prepareMedia(long, { ...purpose, contentTypes: ["audio/wav"] }, signal())).rejects.toThrow(/larger than the 50 MB/);
        expect(ran).toEqual([]);
    });

    it("prefers the destination's first accepted type", async () => {
        const purpose: MediaPreparePurpose = { output: "audio", sampleRate: 44_100, maxBytes: 50 * MB, maxSeconds: 900, contentTypes: ["audio/mp4", "audio/wav"] };
        const prepared = await preparer().prepareMedia({ kind: "media", source: { mediaUrl: `opennan-local://media/${ID}`, endSeconds: 2 } }, purpose, signal());
        expect(prepared.contentType).toBe("audio/mp4");
    });

    it("enforces the size cap on the file it made", async () => {
        await expect(preparer({}, 3 * MB).prepareMedia({ kind: "media", source: { mediaUrl: `opennan-local://media/${ID}`, endSeconds: 2 } }, { ...WAV, maxBytes: 2 * MB }, signal())).rejects.toThrow(/larger than the 2 MB/);
        expect(leftovers()).toEqual([]);
    });

    it("re-encodes video to MP4 with the working encoder, cut to the tool's length", async () => {
        const prepared = await preparer({}, 5000, { durationSeconds: 60, hasVideo: true, width: 640, height: 360 }).prepareMedia({ kind: "media", source: { mediaUrl: `opennan-local://media/${ID}`, startSeconds: 10, endSeconds: 200 } }, VIDEO, signal());
        expect(prepared).toMatchObject({ contentType: "video/mp4", filename: "video.mp4", durationSeconds: 60, width: 640, height: 360 });
        expect(ran[0]).toEqual(expect.arrayContaining(["-ss", "10", "-t", "60", "-c:v", "h264_videotoolbox", "-an"]));
        // No end asked: the source's length from its probe.
        ran = [];
        await preparer({}, 5000, { durationSeconds: 30, hasVideo: true, width: 1279, height: 721 }).prepareMedia({ kind: "media", source: { mediaUrl: `opennan-local://media/${ID}`, startSeconds: 10 } }, VIDEO, signal());
        expect(ran[0]).toEqual(expect.arrayContaining(["-ss", "10", "-t", "20"]));
    });

    it("refuses a video the encoder's container cannot give the destination", async () => {
        const vp9 = encoderChoice("libvpx-vp9", { videoBitrateKbps: 8000, audioBitrateKbps: 192 });
        await expect(preparer({ chooseEncoder: async () => vp9 }).prepareMedia({ kind: "media", source: { mediaUrl: `opennan-local://media/${ID}`, endSeconds: 2 } }, { ...VIDEO, contentTypes: ["video/mp4"] }, signal())).rejects.toThrow(/encoder/);
    });

    it("sends an accepted image as it is, and converts others to PNG", async () => {
        const png = path.join(dir, "media", `${ID}.png`);
        fs.writeFileSync(png, "png!");
        const asIs = preparer({ mediaStore: { root: path.join(dir, "media"), pathOf: () => png } });
        const prepared = await asIs.prepareMedia({ kind: "media", source: { mediaUrl: `opennan-local://media/${ID}` } }, IMAGE, signal());
        expect(prepared).toMatchObject({ contentType: "image/png", filename: "image.png", sizeBytes: 4 });
        expect(ran).toEqual([]);
        const frame = await preparer({}, 77, { durationSeconds: 6, width: 640, height: 360 }).prepareMedia({ kind: "media", source: { mediaUrl: `opennan-local://media/${ID}`, startSeconds: 2 } }, IMAGE, signal());
        expect(frame).toMatchObject({ contentType: "image/png", sizeBytes: 77, width: 640, height: 360 });
        expect(ran[0]).toEqual(expect.arrayContaining(["-ss", "2", "-frames:v", "1", "-c:v", "png"]));
    });

    it("kills ffmpeg on cancel and cleans up", async () => {
        const controller = new AbortController();
        let started!: () => void;
        const running = new Promise<void>((resolve) => {
            started = resolve;
        });
        const p = preparer({
            run: (_command, args, options) => new Promise((_resolve, reject) => {
                fs.writeFileSync(args.at(-1)!, "partial");
                started();
                options?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("Export cancelled."), { code: "cancelled" })));
            }),
        });
        const job = p.prepareMedia({ kind: "media", source: { mediaUrl: `opennan-local://media/${ID}`, endSeconds: 2 } }, WAV, controller.signal);
        await running;
        controller.abort();
        await expect(job).rejects.toThrow();
        expect(leftovers()).toEqual([]);
    });

    it("mixes a timeline snapshot to WAV at the asked rate; refuses an invalid snapshot", async () => {
        const rendered: Array<{ path: string; sampleRate?: number }> = [];
        const createRunner: DesktopMediaPreparerOptions["createRunner"] = (runnerOptions) => ({
            kind: "node", supportsGl: false, maxResolution: "4k",
            async probe(urls) {
                const out = new Map<string, MediaInfo>();
                for (const url of urls) if (await runnerOptions.resolveSource!(url)) out.set(url, { durationSeconds: 2, hasVideo: false, hasAudio: true, width: 0, height: 0 });
                return out;
            },
            chooseEncoder: async () => { throw new Error("unused"); },
            run: async () => { throw new Error("unused"); },
            async renderAudio(_plan, outputPath, options) {
                rendered.push({ path: outputPath, sampleRate: options?.sampleRate });
                fs.writeFileSync(outputPath, Buffer.alloc(320));
            },
        }) as ExportRunner;
        const p = preparer({ createRunner });
        const snapshot = {
            projectId: "p", project: { id: "p", name: "P", aspectRatio: "16:9" }, tracks: [{ type: "audio", index: 1, label: "A1", muted: false, locked: false, visible: true, volume: 1 }],
            clips: [{ id: "c1", projectId: "p", trackType: "audio", trackIndex: 1, startTime: 0, endTime: 2, mediaUrl: `opennan-local://media/${ID}`, mediaType: "audio" }], scenes: [],
        };
        const prepared = await p.prepareMedia({ kind: "timeline", snapshot }, { ...WAV, sampleRate: 44_100 }, signal());
        expect(prepared).toMatchObject({ contentType: "audio/wav", filename: "timeline.wav", sizeBytes: 320, durationSeconds: 2 });
        expect(rendered).toEqual([{ path: expect.stringMatching(/timeline\.wav$/), sampleRate: 44_100 }]);
        expect(leftovers()).toEqual([]);
        await expect(p.prepareMedia({ kind: "timeline", snapshot: { tracks: "nope" } }, WAV, signal())).rejects.toThrow(/not valid/);
        await expect(p.prepareMedia({ kind: "timeline", snapshot }, VIDEO, signal())).rejects.toThrow(/audio/);
    });
});

// The bundled LGPL ffmpeg (pnpm --filter @opennan/desktop fetch:ffmpeg); skipped without it.
const ffmpeg = resolveFfmpeg({ env: process.env, resourcesPath: "", appPath: path.resolve(__dirname, "../../.."), platform: process.platform, arch: process.arch, isPackaged: false });
const FIXTURE = path.resolve(__dirname, "../../../e2e/fixtures/testsrc-6s.webm");

describe.skipIf(!ffmpeg)("createDesktopMediaPreparer on the bundled ffmpeg", () => {
    it("trims a range to 16 kHz mono WAV and to a silent re-encoded MP4 of exactly that length", async () => {
        const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "opennan-prepn-")));
        try {
            fs.mkdirSync(path.join(dir, "media"));
            const media = path.join(dir, "media", `${ID}.webm`);
            fs.copyFileSync(FIXTURE, media);
            const p = createDesktopMediaPreparer({ ffmpeg, mediaStore: { root: path.join(dir, "media"), pathOf: (id) => (id === ID ? media : null) } });
            const source = { mediaUrl: `opennan-local://media/${ID}`, startSeconds: 1.3, endSeconds: 3.3 };
            const probeBytes = (bytes: Uint8Array, name: string) => {
                const file = path.join(dir, name);
                fs.writeFileSync(file, bytes);
                return JSON.parse(execFileSync(ffmpeg!.ffprobePath, ["-v", "error", "-show_entries", "format=duration:stream=codec_type,codec_name,sample_rate,channels", "-of", "json", file], { encoding: "utf8" }));
            };
            const audio = await p.prepareMedia({ kind: "media", source }, WAV, new AbortController().signal);
            const a = probeBytes(audio.data as Uint8Array, "a.wav");
            expect(a.streams).toEqual([expect.objectContaining({ codec_type: "audio", codec_name: "pcm_s16le", sample_rate: "16000", channels: 1 })]);
            expect(Number(a.format.duration)).toBeCloseTo(2, 1);
            expect(audio.durationSeconds).toBeGreaterThanOrEqual(2);
            const video = await p.prepareMedia({ kind: "media", source }, VIDEO, new AbortController().signal);
            const v = probeBytes(video.data as Uint8Array, video.filename);
            expect(v.streams.map((s: { codec_type: string }) => s.codec_type)).toEqual(["video"]);
            expect(Number(v.format.duration)).toBeGreaterThan(1.9);
            expect(Number(v.format.duration)).toBeLessThan(2.15);
            expect(video).toMatchObject({ width: 640, height: 360 });
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    }, 60_000);
});
