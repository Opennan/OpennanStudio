import type { ControllerSnapshot } from "@opennan/timeline-core";
import { LocalBackend, createMemoryPersistence } from "@opennan/timeline-core";
import { exportFileNameFor, exportFormatLabel, exportInputFromSnapshot, loadEffectCatalog } from "./export-input";

const snapshot = {
    projectId: "p", project: { id: "p", name: "Trip", musicUrl: "/m.mp3", musicVolume: 0.4, aspectRatio: "9:16" }, tracks: [], clips: [], scenes: [],
} as unknown as ControllerSnapshot;

describe("export input", () => {
    it("exports what the controller snapshot holds", () => {
        expect(exportInputFromSnapshot(snapshot, [])).toEqual({
            project: { aspectRatio: "9:16", musicUrl: "/m.mp3", musicVolume: 0.4 }, tracks: [], clips: [], scenes: [], effects: [],
        });
    });

    it("labels the produced format", () => {
        expect(exportFormatLabel({ container: "mp4", encoder: "libx264" })).toBe("MP4 (H.264, AAC)");
        expect(exportFormatLabel({ container: "mp4", encoder: "h264_videotoolbox" })).toBe("MP4 (H.264, AAC)");
        expect(exportFormatLabel({ container: "mp4", encoder: "mpeg4" })).toBe("MP4 (MPEG-4 Part 2, AAC)");
        expect(exportFormatLabel({ container: "webm", encoder: "libvpx-vp9" })).toBe("WebM (VP9, Opus)");
    });

    it("names the file after the project with the produced container", () => {
        expect(exportFileNameFor("Export test", { container: "mp4" })).toBe("export-test.mp4");
        expect(exportFileNameFor("Export test", { container: "webm" })).toBe("export-test.webm");
    });

    it("loadEffectCatalog lists the built-in effects and the backend's catalog", async () => {
        const backend = new LocalBackend({ persistence: createMemoryPersistence(), effectCatalog: [{ id: "glow", kind: "effect", name: "Glow" } as never] });
        const effects = await loadEffectCatalog(backend);
        expect(effects).toHaveLength(21);
        expect(effects.map((e) => e.id)).toContain("glow");
        expect(effects.filter((e) => e.ownerScope === "builtin")).toHaveLength(20);
    });
});
