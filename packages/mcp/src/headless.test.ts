import { execFileSync } from "node:child_process";
import { existsSync, openAsBlob } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createEmptyProject } from "@opennan/timeline-core";
import { openHeadlessProject } from "./headless";
import { writeProjectFile } from "./project-file";
import { fixtureProject } from "./testing/fixture";

// Same lookup as the @opennan/export node-runner tests: OPENNAN_FFMPEG / OPENNAN_FFPROBE, else Homebrew.
const FFMPEG = process.env.OPENNAN_FFMPEG ?? "/opt/homebrew/bin/ffmpeg";
const FFPROBE = process.env.OPENNAN_FFPROBE ?? "/opt/homebrew/bin/ffprobe";
const HAS_FFMPEG = existsSync(FFMPEG) && existsSync(FFPROBE);
// CI's macOS golden job sets OPENNAN_REQUIRE_FFMPEG=1: there the native-ffmpeg case must run, never skip.
if (process.env.OPENNAN_REQUIRE_FFMPEG === "1" && !HAS_FFMPEG) {
    throw new Error(`OPENNAN_REQUIRE_FFMPEG=1, but ${FFMPEG} or ${FFPROBE} is missing`);
}

let dir: string;
let file: string;

beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "opennan-headless-"));
    file = path.join(dir, "fixture.opennan.json");
    await writeProjectFile(file, fixtureProject());
});

afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
});

describe("openHeadlessProject", () => {
    it("loads the file, saves edits back, and stores imported media next to it", async () => {
        const studio = await openHeadlessProject({ projectFile: file });
        expect(studio.projectId).toBe("fixture");
        await studio.session.execute({ type: "clip.delete", clipIds: ["title"] });
        await writeFile(path.join(dir, "beep.wav"), new Uint8Array([1, 2, 3]));
        const local = await studio.session.host.readFile?.("beep.wav", "audio");
        expect(local).toMatchObject({ name: "beep.wav", type: "audio/wav", size: 3 });
        const media = await studio.session.uploadFile?.(local as File, "audio");
        await studio.close();
        const saved = JSON.parse(await readFile(file, "utf8"));
        expect(saved.project.clips.map((c: { id: string }) => c.id)).toEqual(["music"]);
        expect(media?.url).toMatch(/^opennan-local:\/\/media\//);
        expect((await readdir(path.join(dir, "fixture.opennan.json.media"))).length).toBe(2);
    });

    it("never writes in read-only mode", async () => {
        const before = await readFile(file, "utf8");
        const studio = await openHeadlessProject({ projectFile: file, readOnly: true });
        await studio.session.execute({ type: "clip.delete", clipIds: ["title"] });
        expect((await studio.session.snapshot()).clips).toHaveLength(1);
        await studio.close();
        expect(await readFile(file, "utf8")).toBe(before);
    });

    it("refuses local paths that are not files", async () => {
        const studio = await openHeadlessProject({ projectFile: file, readOnly: true });
        await expect(studio.session.host.readFile?.("missing.wav", "audio")).rejects.toThrow(/Not a file/);
        await studio.close();
    });

    it("refuses a second writer and allows read-only opens", async () => {
        const first = await openHeadlessProject({ projectFile: file });
        await expect(openHeadlessProject({ projectFile: file })).rejects.toThrow(/is already open for writing \(pid \d+\)/);
        const reader = await openHeadlessProject({ projectFile: file, readOnly: true });
        await reader.close();
        await first.close();
        const again = await openHeadlessProject({ projectFile: file });
        await again.close();
    });

    it("answers exports and preview frames as unavailable without an ffmpeg", async () => {
        const studio = await openHeadlessProject({ projectFile: file, readOnly: true });
        expect(studio.exporter).toBeUndefined();
        await expect(studio.session.execute({ type: "export.start", options: {} })).resolves.toMatchObject({ ok: false, unavailable: true });
        await expect(studio.session.previewFrame(1)).resolves.toMatchObject({ ok: false, unavailable: true });
        await studio.close();
    });

    it.skipIf(!HAS_FFMPEG)("exports and renders frames with the native ffmpeg, reading only the project's media", async () => {
        const source = path.join(dir, "clip.mkv");
        execFileSync(FFMPEG, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30:duration=2",
            "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-c:v", "ffv1", "-c:a", "flac", "-shortest", source]);
        const projectFile = path.join(dir, "ffmpeg.opennan.json");
        await writeProjectFile(projectFile, createEmptyProject("ffmpeg"));
        const studio = await openHeadlessProject({ projectFile, ffmpeg: { ffmpegPath: FFMPEG, ffprobePath: FFPROBE } });
        const media = await studio.session.uploadFile?.(new File([await openAsBlob(source)], "clip.mkv", { type: "video/x-matroska" }), "video");
        await studio.session.execute({ type: "scene.add", input: { afterOrder: -1, cardType: "source_clip", videoUrl: media?.url, sourceVideoUrl: media?.url, duration: 2 } });
        // A clip that points outside <file>.media/ is never opened (it needs a V2 row to be playable at all).
        const tracks = (await studio.session.snapshot()).tracks;
        await studio.session.execute({ type: "track.update", tracks: [...tracks, { type: "video", index: 2, label: "V2", muted: false, locked: false, visible: true, volume: 1 }] });
        await studio.session.execute({ type: "clip.create", input: { trackType: "video", trackIndex: 2, startTime: 0, endTime: 1, mediaUrl: pathToFileURL(source).href, mediaType: "uploaded" } });
        const started = await studio.session.execute({ type: "export.start", options: { resolution: "720p" } });
        const done = await studio.exporter?.settled(started.jobId as string);
        expect(done).toMatchObject({ status: "done", width: 1280, height: 720 });
        if (done?.status !== "done" || done.output.kind !== "file") throw new Error("expected a file export");
        expect(path.dirname(done.output.path)).toBe(path.join(dir, "exports"));
        expect(existsSync(done.output.path)).toBe(true);
        expect(done.warnings.map((w) => w.code)).toContain("media-unreadable");
        const frame = await studio.session.previewFrame(1, { width: 320 });
        expect(frame).toMatchObject({ ok: true, frame: { mimeType: "image/png", width: 320, height: 180 } });
        expect(frame.ok ? [...frame.frame.data.subarray(0, 4)] : []).toEqual([137, 80, 78, 71]);
        await studio.close();
    }, 60_000);
});
