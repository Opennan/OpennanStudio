import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { encoderChoice, gplFiltersIn } from "@opennan/export";
import type { AiJobEvent } from "../../shared/bridge";
import { resolveFfmpeg } from "../export/ffmpeg-paths";
import { createDesktopMediaPreparer } from "./prepare-media";
import { STABILIZE_BUSY, createStabilizeService, stabilizeGraph, stabilizedName, type StabilizeServiceOptions } from "./stabilize";

const ID = "3f2b8c1e-1d2a-4c3b-9e8f-0a1b2c3d4e5f";
const PROJECT = "11111111-2222-4333-8444-555555555555";
const MEDIA = `opennan-local://media/${ID}`;
const VT = encoderChoice("h264_videotoolbox", { videoBitrateKbps: 8000, audioBitrateKbps: 192 });

describe("stabilize graph", () => {
    it("is deshake (LGPL, built in), never vid.stab or another GPL filter", () => {
        const graph = stabilizeGraph(VT);
        expect(graph).toBe("deshake,scale=trunc(iw/2)*2:trunc(ih/2)*2");
        expect(gplFiltersIn(graph)).toEqual([]);
        expect(graph).not.toMatch(/vidstab/);
    });

    it("names the result after the clip's file", () => {
        expect(stabilizedName("Beach walk.mov", ".mp4")).toBe("Beach walk (stabilized).mp4");
        expect(stabilizedName("../../etc/passwd", ".mp4")).toBe("..-..-etc-passwd (stabilized).mp4");
        expect(stabilizedName(null, ".webm")).toBe("clip (stabilized).webm");
    });
});

describe("createStabilizeService", () => {
    let dir: string;
    let imported: Array<{ projectId: string; path: string; kind: string; existed: boolean }>;
    let ran: string[][];
    beforeEach(() => {
        dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "opennan-stab-")));
        imported = [];
        ran = [];
    });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    function service(overrides: Partial<StabilizeServiceOptions> = {}) {
        return createStabilizeService({
            ffmpeg: { ffmpegPath: "/ff/ffmpeg", ffprobePath: "/ff/ffprobe" },
            tempDir: dir,
            mediaStore: {
                info: () => ({ id: ID, projectId: PROJECT, fileName: `${ID}.mov`, mimeType: "video/quicktime", size: 1, originalName: "Walk.mov", durationSeconds: 6 }),
                importPath: async ({ projectId, path: file, kind }) => {
                    imported.push({ projectId, path: file, kind, existed: fs.existsSync(file) });
                    return { id: "9f2b8c1e-1d2a-4c3b-9e8f-0a1b2c3d4e5f", url: "opennan-local://media/9f2b8c1e-1d2a-4c3b-9e8f-0a1b2c3d4e5f", name: path.basename(file), size: 2048, mimeType: "video/mp4", durationSeconds: 2, width: 1920, height: 1080 };
                },
            },
            preparer: {
                resolveSource: async (url) => {
                    if (url !== MEDIA) throw new Error("Only media imported into this project can be sent to an AI tool.");
                    return "/media/walk.mov";
                },
                inputGuards: ["-protocol_whitelist", "file,pipe"],
                mediaDuration: async () => 2,
                mediaInfo: async () => ({ durationSeconds: 6, hasVideo: true, hasAudio: true, width: 1920, height: 1080 }),
                encoder: async () => VT,
            },
            run: async (_command, args, options) => {
                ran.push(args);
                options?.onStdoutLine?.("out_time_us=1000000");
                fs.writeFileSync(args.at(-1)!, "mp4");
                return { code: 0, stdout: "", stderr: "" };
            },
            ...overrides,
        });
    }
    const events = (s: ReturnType<typeof service>) => {
        const seen: AiJobEvent[] = [];
        s.subscribe((event) => seen.push(event));
        return seen;
    };
    const settled = (seen: AiJobEvent[]) => vi.waitFor(() => expect(seen.some((e) => ["succeeded", "failed", "cancelled"].includes(e.status))).toBe(true));

    it("deshakes the used range with the audio kept, imports the result, and leaves no temp files", async () => {
        const s = service();
        const seen = events(s);
        const { jobId } = await s.start({ projectId: PROJECT, source: { mediaUrl: MEDIA, startSeconds: 1, endSeconds: 3 } });
        await settled(seen);
        expect(seen.at(-1)).toEqual({
            jobId, status: "succeeded", progress: 1,
            output: {
                media: [{ kind: "video", url: "opennan-local://media/9f2b8c1e-1d2a-4c3b-9e8f-0a1b2c3d4e5f", name: "Walk (stabilized).mp4", mimeType: "video/mp4", sizeBytes: 2048, durationSeconds: 2, width: 1920, height: 1080 }],
                sourceSize: { width: 1920, height: 1080 },
            },
        });
        expect(ran).toHaveLength(1);
        const args = ran[0];
        expect(args).toEqual(expect.arrayContaining(["-ss", "1", "-t", "2", "-i", "/media/walk.mov", "-map", "0:a:0?", "-c:v", "h264_videotoolbox", "-c:a", "aac", "-progress", "pipe:1"]));
        expect(args[args.indexOf("-vf") + 1]).toMatch(/^deshake,/);
        expect(args.join(" ")).not.toMatch(/copy|vidstab|-an\b/);
        expect(imported).toEqual([{ projectId: PROJECT, path: expect.stringMatching(/Walk \(stabilized\)\.mp4$/), kind: "video", existed: true }]);
        expect(seen.some((e) => e.status === "running" && e.progress !== undefined && e.progress > 0.4 && e.message === "Stabilizing")).toBe(true);
        expect(fs.readdirSync(dir)).toEqual([]);
    });

    it("refuses media that is not imported, and refuses without ffmpeg", async () => {
        await expect(service().start({ projectId: PROJECT, source: { mediaUrl: "https://cdn.example/a.mp4" } })).rejects.toThrow(/imported into this project/);
        expect(service({ ffmpeg: null }).status()).toEqual({ available: false, reason: expect.stringMatching(/ffmpeg/) });
        await expect(service({ ffmpeg: null }).start({ projectId: PROJECT, source: { mediaUrl: MEDIA } })).rejects.toThrow(/ffmpeg/);
        expect(ran).toEqual([]);
    });

    it("fails with a message when ffmpeg fails", async () => {
        const s = service({ run: async () => ({ code: 1, stdout: "", stderr: "boom" }) });
        const seen = events(s);
        await s.start({ projectId: PROJECT, source: { mediaUrl: MEDIA } });
        await settled(seen);
        expect(seen.at(-1)).toMatchObject({ status: "failed", error: "ffmpeg could not stabilize this clip." });
        expect(imported).toEqual([]);
        expect(fs.readdirSync(dir)).toEqual([]);
    });

    it("runs one job at a time; cancel kills ffmpeg and removes the temp folder", async () => {
        let killed = false;
        const s = service({
            run: (_command, args, options) => new Promise((_resolve, reject) => {
                fs.writeFileSync(args.at(-1)!, "partial");
                const kill = () => setTimeout(() => {
                    killed = true;
                    reject(new Error("Export cancelled."));
                }, 20);
                // Like runProcess: a signal that is already aborted kills at once.
                if (options?.signal?.aborted) kill();
                else options?.signal?.addEventListener("abort", kill);
            }),
        });
        const seen = events(s);
        const { jobId } = await s.start({ projectId: PROJECT, source: { mediaUrl: MEDIA } });
        await expect(s.start({ projectId: PROJECT, source: { mediaUrl: MEDIA } })).rejects.toThrow(STABILIZE_BUSY);
        await vi.waitFor(() => expect(fs.readdirSync(dir)).toHaveLength(1));
        await s.cancel("job-other");
        await s.cancel(jobId);
        await settled(seen);
        expect(seen.at(-1)).toEqual({ jobId, status: "cancelled" });
        // The next start waits for the old ffmpeg to exit.
        const next = s.start({ projectId: PROJECT, source: { mediaUrl: MEDIA } });
        await next;
        expect(killed).toBe(true);
        await s.cancelAll();
        await vi.waitFor(() => expect(fs.readdirSync(dir)).toEqual([]));
        expect(imported).toEqual([]);
    });
});

// The bundled LGPL ffmpeg (pnpm --filter @opennan/desktop fetch:ffmpeg); skipped without it.
const ffmpeg = resolveFfmpeg({ env: process.env, resourcesPath: "", appPath: path.resolve(__dirname, "../../.."), platform: process.platform, arch: process.arch, isPackaged: false });
const FIXTURE = path.resolve(__dirname, "../../../e2e/fixtures/testsrc-6s.webm");

describe.skipIf(!ffmpeg)("createStabilizeService on the bundled ffmpeg", () => {
    it("stabilizes a 2 s range into a video with its audio", async () => {
        const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "opennan-stabn-")));
        try {
            fs.mkdirSync(path.join(dir, "media"));
            const media = path.join(dir, "media", `${ID}.webm`);
            fs.copyFileSync(FIXTURE, media);
            const kept = path.join(dir, "kept.mp4");
            const preparer = createDesktopMediaPreparer({ ffmpeg, mediaStore: { root: path.join(dir, "media"), pathOf: (id) => (id === ID ? media : null) } });
            const s = createStabilizeService({
                ffmpeg, preparer,
                mediaStore: {
                    importPath: async ({ path: file }) => {
                        fs.copyFileSync(file, kept);
                        return { id: ID, url: MEDIA, name: path.basename(file), size: fs.statSync(file).size, mimeType: "video/mp4" };
                    },
                },
            });
            const seen: AiJobEvent[] = [];
            s.subscribe((event) => seen.push(event));
            await s.start({ projectId: PROJECT, source: { mediaUrl: MEDIA, startSeconds: 1, endSeconds: 3 } });
            await vi.waitFor(() => expect(seen.some((e) => e.status === "succeeded" || e.status === "failed")).toBe(true), { timeout: 60_000 });
            expect(seen.at(-1)!.error).toBeUndefined();
            const probed = JSON.parse(execFileSync(ffmpeg!.ffprobePath, ["-v", "error", "-show_entries", "format=duration:stream=codec_type", "-of", "json", kept], { encoding: "utf8" }));
            expect(probed.streams.map((x: { codec_type: string }) => x.codec_type).sort()).toEqual(["audio", "video"]);
            expect(Number(probed.format.duration)).toBeGreaterThan(1.9);
            expect(Number(probed.format.duration)).toBeLessThan(2.2);
            expect(seen.at(-1)!.output).toMatchObject({ media: [{ kind: "video", durationSeconds: expect.any(Number) }], sourceSize: { width: 640, height: 360 } });
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    }, 60_000);
});
