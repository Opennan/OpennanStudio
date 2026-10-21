import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LocalBackend, TimelineController, createEditorStore, createMemoryPersistence } from "@opennan/timeline-core";
import { openDatabase, type DesktopDatabase } from "../store/database";
import { createMediaStore, type MediaStore } from "../store/media-store";
import { FFMPEG_MISSING, adaptPort, createDesktopExporter, slug, uniquePath, type MainPortLike } from "./desktop-exporter";

const FFMPEG = process.env.OPENNAN_FFMPEG ?? "/opt/homebrew/bin/ffmpeg";
const FFPROBE = process.env.OPENNAN_FFPROBE ?? "/opt/homebrew/bin/ffprobe";
const HAVE_FFMPEG = fs.existsSync(FFMPEG) && fs.existsSync(FFPROBE);
if (process.env.OPENNAN_REQUIRE_FFMPEG === "1" && !HAVE_FFMPEG) throw new Error(`ffmpeg is required but missing: ${FFMPEG}`);

describe("export helpers", () => {
    it("slugs project names", () => {
        expect(slug("Beach Trip!")).toBe("beach-trip");
        expect(slug("Café déjà vu")).toBe("cafe-deja-vu");
        expect(slug("../../etc/passwd")).toBe("etc-passwd");
        expect(slug("")).toBe("export");
        expect(slug(null)).toBe("export");
        expect(slug("x".repeat(100))).toHaveLength(60);
    });

    it("never reuses an existing export path", () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opennan-unique-"));
        const now = new Date(2026, 9, 19, 8, 5, 9);
        const first = uniquePath(dir, "trip", "mp4", now);
        expect(path.basename(first)).toBe("trip-20261019-080509.mp4");
        fs.writeFileSync(first, "");
        expect(path.basename(uniquePath(dir, "trip", "mp4", now))).toBe("trip-20261019-080509-2.mp4");
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it("adapts MessagePortMain without transfer lists", () => {
        const emitter = new EventEmitter();
        const port = {
            on: (e: string, l: (...a: unknown[]) => void) => emitter.on(e, l), off: (e: string, l: (...a: unknown[]) => void) => emitter.off(e, l),
            postMessage: vi.fn(), start: vi.fn(), close: vi.fn(),
        } as unknown as MainPortLike & { postMessage: ReturnType<typeof vi.fn> };
        const bridge = adaptPort(port);
        const listener = vi.fn();
        bridge.addEventListener("message", listener);
        emitter.emit("message", { data: 1 });
        bridge.removeEventListener("message", listener);
        emitter.emit("message", { data: 2 });
        expect(listener).toHaveBeenCalledTimes(1);
        bridge.postMessage({ x: 1 }, [new ArrayBuffer(4)]);
        expect(port.postMessage).toHaveBeenCalledWith({ x: 1 });
    });
});

describe("createDesktopExporter", () => {
    it("answers clearly without ffmpeg", async () => {
        const { exporter, available } = createDesktopExporter({ ffmpeg: null, mediaStore: { pathOf: () => null, root: "/m" }, exportsDir: "/e" });
        expect(available).toBe(false);
        await expect(exporter.onExport({}, {} as never)).resolves.toEqual({ error: FFMPEG_MISSING });
        await expect(exporter.frameRenderer.renderFrame({} as never)).rejects.toThrow(FFMPEG_MISSING);
        expect(exporter.getState()).toEqual({ status: "idle" });
    });

    describe.skipIf(!HAVE_FFMPEG)("with native ffmpeg", () => {
        let dir: string;
        let db: DesktopDatabase;
        let media: MediaStore;
        beforeEach(() => {
            dir = fs.mkdtempSync(path.join(os.tmpdir(), "opennan-export-"));
            db = openDatabase(":memory:");
            media = createMediaStore({ db, root: path.join(dir, "media") });
        });
        afterEach(() => {
            db.close();
            fs.rmSync(dir, { recursive: true, force: true });
        });

        async function snapshotWith(videoUrl: string) {
            const backend = new LocalBackend({ persistence: createMemoryPersistence() });
            await backend.seedProject("p", { meta: { name: "Smoke Test" } });
            const controller = new TimelineController({ backend, store: createEditorStore(), projectId: "p" });
            await controller.load();
            await controller.execute({ type: "scene.add", input: { afterOrder: -1, cardType: "source_clip", videoUrl, sourceVideoUrl: videoUrl, duration: 2 } as never });
            return controller.snapshot();
        }

        it("exports imported media to the exports folder and refuses other sources", async () => {
            const source = path.join(dir, "clip.mkv");
            execFileSync(FFMPEG, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30:duration=2",
                "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-c:v", "ffv1", "-c:a", "flac", "-shortest", source]);
            const imported = await media.importPath({ projectId: randomUUID(), path: source, kind: "video" });
            const exportsDir = path.join(dir, "exports");
            const desktop = createDesktopExporter({ ffmpeg: { ffmpegPath: FFMPEG, ffprobePath: FFPROBE }, mediaStore: media, exportsDir });
            desktop.setTarget("Smoke Test");
            const outcome = await desktop.exporter.onExport({ resolution: "720p" }, await snapshotWith(imported.url));
            const done = await desktop.exporter.settled((outcome as { jobId: string }).jobId);
            expect(done).toMatchObject({ status: "done", container: "mp4" });
            const file = (done as { output: { path: string } }).output.path;
            expect(path.dirname(file)).toBe(exportsDir);
            expect(path.basename(file)).toMatch(/^smoke-test-\d{8}-\d{6}\.mp4$/);
            const duration = Number(execFileSync(FFPROBE, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file], { encoding: "utf8" }));
            expect(duration).toBeGreaterThan(1.9);
            expect(duration).toBeLessThan(2.1);

            desktop.exporter.reset();
            const refused = await desktop.exporter.onExport({ resolution: "720p" }, await snapshotWith("file:///etc/hosts"));
            const result = await desktop.exporter.settled((refused as { jobId: string }).jobId);
            expect(JSON.stringify(result)).toContain("media-unreadable");
        }, 120_000);
    });
});
