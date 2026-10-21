// Phase 10d projects open unchanged in 11 (no beatsJson, nothing rewritten), and the phase 11 writes — beats on an audio
// clip, a stacked AI result over a clip, voice isolation owning a scene's sound — round-trip through persistence, one
// undo step each. The only new stored field is beatsJson (optional, like captionWordsJson).
import { describe, expect, it } from "vitest";
import { LocalBackend } from "../backend/local-backend";
import { createMemoryPersistence, type LocalProjectState } from "../backend/persistence";
import { createEditorStore } from "../store/editor-store";
import { timelineOwnsSceneAudioAtTime } from "../lib/preview-timeline-clips";
import { clipBeatTimes } from "../analysis/beat-plan";
import type { AiPlacement } from "./ai-run";
import { TimelineController } from "./timeline-controller";
import phase10d from "./__fixtures__/phase10d-project.json";

async function seeded() {
    const persistence = createMemoryPersistence();
    await persistence.saveProject("legacy10d", structuredClone(phase10d) as unknown as LocalProjectState);
    return persistence;
}

async function open(persistence: ReturnType<typeof createMemoryPersistence>, placement?: () => AiPlacement) {
    const backend = new LocalBackend({ persistence });
    const store = createEditorStore();
    const controller = new TimelineController({
        backend, store, projectId: "legacy10d", onToast: vi.fn(),
        onAiRun: placement ? async () => ({ jobId: "job", placement: placement() }) : undefined,
    });
    await controller.load();
    const clip = (id: string) => store.getState().timelineData!.clips.find((c) => c.id === id)!;
    return { store, controller, clip, backend };
}

describe("phase 10d projects in 11", () => {
    it("open with the same tracks, clips, and scenes, and no beats", async () => {
        const { store } = await open(await seeded());
        const fixture = phase10d as unknown as LocalProjectState;
        const sortById = <T extends { id: string }>(list: T[]) => [...list].sort((a, b) => a.id.localeCompare(b.id));
        expect(store.getState().timelineData!.tracks).toEqual(fixture.tracks);
        expect(sortById(store.getState().timelineData!.clips)).toEqual(sortById(fixture.clips));
        expect(store.getState().serverScenes).toEqual(fixture.scenes);
        expect(store.getState().timelineData!.clips.some((c) => "beatsJson" in c)).toBe(false);
    });

    it("round-trip beats, a stacked result, and owned scene audio through persistence, one undo step each", async () => {
        const persistence = await seeded();
        const placements: AiPlacement[] = [
            { kind: "stack-video", source: { clipId: "c3" }, media: { url: "opennan-local://media/upscaled", durationSeconds: 2 } },
            { kind: "replace-audio", source: { sceneId: "s1" }, media: [{ url: "opennan-local://media/voice", role: "vocals" }] },
        ];
        const first = await open(persistence, () => placements.shift()!);
        const steps = () => first.controller.historyDepth().recorded;

        let before = steps();
        expect((await first.controller.execute({ type: "beats.set", clipId: "a1", beats: [0.5, 1, 1.5, 2] })).ok).toBe(true);
        expect(steps()).toBe(before + 1);

        before = steps();
        const stacked = await first.controller.execute({ type: "ai.run", capability: "video.upscale", input: {} });
        expect(stacked.ok, stacked.error).toBe(true);
        expect(steps()).toBe(before + 1);

        before = steps();
        const voice = await first.controller.execute({ type: "ai.run", capability: "audio.isolate-voice", input: {} });
        expect(voice.ok, voice.error).toBe(true);
        expect(steps()).toBe(before + 1);

        // A split keeps the beats on both halves (source seconds stay aligned).
        expect((await first.controller.execute({ type: "clip.split", clipIds: ["a1"], atSeconds: 1.2 })).ok).toBe(true);

        const second = await open(persistence);
        const clips = second.store.getState().timelineData!.clips;
        const halves = clips.filter((c) => c.mediaUrl === "opennan-local://media/m2").sort((a, b) => a.startTime - b.startTime);
        expect(halves).toHaveLength(2);
        expect(halves.map((c) => c.beatsJson)).toEqual(["[0.5,1,1.5,2]", "[0.5,1,1.5,2]"]);
        expect(halves.flatMap((c) => clipBeatTimes(c))).toEqual([0.5, 1, 1.5, 2]);
        const result = clips.find((c) => c.mediaUrl === "opennan-local://media/upscaled")!;
        expect(result).toMatchObject({ trackType: "video", trackIndex: 3, startTime: 4, endTime: 5, volume: 0 });
        expect(second.clip("c3").opacity).toBe(0);
        const owned = clips.find((c) => c.mediaUrl === "opennan-local://media/voice")!;
        expect(owned).toMatchObject({ trackType: "audio", sceneId: "s1" });
        expect(timelineOwnsSceneAudioAtTime("s1", clips, 3)).toBe(true);
        expect(second.store.getState().timelineData!.tracks.find((t) => t.type === "audio" && t.index === owned.trackIndex)?.label).toBe("Vocals");
    });
});
