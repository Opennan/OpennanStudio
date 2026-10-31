// Reel layout (story film): the prototype's numbers, the commands it plans, and a real controller run on LocalBackend.
import { describe, expect, it } from "vitest";
import { LocalBackend } from "../backend/local-backend";
import { createMemoryPersistence } from "../backend/persistence";
import { createEditorStore } from "../store/editor-store";
import { TimelineController } from "../controller/timeline-controller";
import { sceneFitRect } from "../looks/fit";
import { applyReelLayout, filmOffsetPercent, planReelLayout, REEL_LAYOUT, titlePositionY } from "./reel";

const clips = [
    { mediaUrl: "opennan-local://media/s01.mp4", durationSeconds: 5, width: 1280, height: 720, label: "s01" },
    { mediaUrl: "opennan-local://media/s02.mp4", durationSeconds: 5, width: 1280, height: 720, label: "s02" },
];

describe("reel layout numbers", () => {
    it("fits a 16:9 film into the 9:16 frame at the prototype's place: 1080 wide, top at 656", () => {
        const rect = sceneFitRect("contain", { width: 1920, height: 1080 }, { width: REEL_LAYOUT.canvas.width, height: REEL_LAYOUT.canvas.height }, 1, 0, filmOffsetPercent());
        expect(rect.width).toBe(1080);
        expect(Math.round(rect.height)).toBe(REEL_LAYOUT.film.height);
        expect(Math.round(rect.y)).toBe(REEL_LAYOUT.film.y);
        expect(filmOffsetPercent()).toBe(0);
    });

    it("puts the title's baseline 34 px above the film", () => {
        const y = titlePositionY();
        const box = 46 * 1.3;
        const middle = y * (REEL_LAYOUT.canvas.height - box) + box / 2;
        // A middle-aligned line's baseline sits about 0.3 em below its middle.
        expect(Math.round(middle + 0.3 * 46)).toBe(REEL_LAYOUT.film.y - 34);
    });
});

describe("planReelLayout", () => {
    it("plans the canvas, one V1 scene per clip end to end, the title over the film and the music under it", () => {
        const planned = planReelLayout({ scenes: [], clips: [] }, { title: "Rain Check", clips, music: { mediaUrl: "opennan-local://media/m.mp3", durationSeconds: 61 } });
        if (!planned.ok) throw new Error(planned.error);
        const { plan } = planned;
        expect(plan.commands[0]).toEqual({ type: "project.update", patch: { aspectRatio: "9:16" } });
        const adds = plan.commands.filter((c) => c.type === "scene.add");
        expect(adds.map((c) => c.type === "scene.add" && c.input)).toMatchObject([
            { videoUrl: clips[0]!.mediaUrl, duration: 5, trackIndex: 1, timelinePositionSeconds: 0.001, afterOrder: -1 },
            { videoUrl: clips[1]!.mediaUrl, duration: 5, trackIndex: 1, timelinePositionSeconds: 5, afterOrder: 0 },
        ]);
        expect(plan.title).toMatchObject({ trackType: "text", startTime: 0, endTime: 10, textContent: "Rain Check", positionX: 0.5 });
        expect(JSON.parse(String(plan.title!.textStyle))).toMatchObject({ fontSize: 46, color: "#FFFFFF", fontWeight: "800" });
        // A row for the title's new text track (A1 is built in).
        const create = plan.commands.at(-1)!;
        expect(create.type === "clip.create" && create.tracks?.map((t) => [t.type, t.index])).toEqual([["text", 1]]);
        // The music is cut to the film and fades in 0.5 s and out 2.5 s.
        expect(plan.music).toMatchObject({ trackType: "audio", startTime: 0, endTime: 10, trimEnd: 10, fadeInDuration: 0.5, fadeOutDuration: 2.5 });
    });

    it("refuses what it cannot lay out", () => {
        expect(planReelLayout({ scenes: [], clips: [] }, { title: " ", clips })).toEqual({ ok: false, error: "the reel layout needs a title" });
        expect(planReelLayout({ scenes: [], clips: [] }, { title: "T", clips: [] }).ok).toBe(false);
        expect(planReelLayout({ scenes: [], clips: [] }, { title: "T", clips: [{ mediaUrl: "x", durationSeconds: 0 }] }).ok).toBe(false);
        expect(planReelLayout({ scenes: [], clips: [] }, { title: "x".repeat(81), clips }).ok).toBe(false);
    });
});

describe("applyReelLayout on a controller", () => {
    async function setup() {
        const persistence = createMemoryPersistence();
        await persistence.saveProject("p1", { meta: { id: "p1", name: "Film", musicUrl: null, musicVolume: 1, aspectRatio: "16:9" }, tracks: [], clips: [], scenes: [] });
        let n = 0;
        const backend = new LocalBackend({ persistence, idFactory: () => `id-${++n}` });
        const store = createEditorStore();
        const controller = new TimelineController({ backend, store, projectId: "p1", requestTimeoutMs: 1000 });
        await controller.load();
        return { controller, store };
    }

    it("lays the film out, then replaces it when applied again, and undo takes it back", async () => {
        const { controller } = await setup();
        const execute = (command: Parameters<typeof controller.execute>[0]) => controller.execute(command, { toastOnError: false });
        const first = await applyReelLayout(execute, controller.snapshot(), { title: "Rain Check", clips, music: { mediaUrl: "opennan-local://media/m.mp3", durationSeconds: 12 } });
        expect(first).toMatchObject({ ok: true, start: 0, end: 10 });
        expect(first.sceneIds).toHaveLength(2);
        let snap = controller.snapshot();
        expect(snap.project?.aspectRatio).toBe("9:16");
        expect(snap.scenes.map((s) => [s.videoUrl, s.fitMode, s.trackIndex, s.sourceWidth])).toEqual([
            [clips[0]!.mediaUrl, "contain", 1, 1280], [clips[1]!.mediaUrl, "contain", 1, 1280],
        ]);
        expect(snap.clips.find((c) => c.id === first.titleClipId)).toMatchObject({ trackType: "text", textContent: "Rain Check", startTime: 0, endTime: 10 });
        expect(snap.tracks.some((t) => t.type === "text" && t.index === 1)).toBe(true);
        expect(snap.clips.find((c) => c.id === first.musicClipId)).toMatchObject({ trackType: "audio", fadeInDuration: 0.5, fadeOutDuration: 2.5, endTime: 10 });

        const again = await applyReelLayout(execute, snap, { title: "Rain Check 2", clips, replace: { sceneIds: first.sceneIds, clipIds: [first.titleClipId!, first.musicClipId!] } });
        expect(again.ok).toBe(true);
        snap = controller.snapshot();
        expect(snap.scenes).toHaveLength(2);
        expect(snap.clips.map((c) => c.textContent).filter(Boolean)).toEqual(["Rain Check 2"]);
        expect(again.start).toBe(0);

        await controller.execute({ type: "history.undo", steps: again.steps });
        snap = controller.snapshot();
        expect(snap.clips.map((c) => c.textContent).filter(Boolean)).toEqual(["Rain Check"]);
    });

    it("keeps the story film on the project without an undo step", async () => {
        const { controller } = await setup();
        await controller.execute({ type: "scene.add", input: { afterOrder: -1, duration: 5 } });
        const before = controller.historyDepth();
        await controller.execute({ type: "project.update", patch: { storyFilmJson: "{\"title\":\"x\"}" } }, { recordHistory: false });
        expect(controller.snapshot().project?.storyFilmJson).toBe("{\"title\":\"x\"}");
        expect(controller.historyDepth()).toEqual(before);
    });
});
