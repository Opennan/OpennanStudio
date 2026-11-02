import { LocalBackend, TimelineController, createEditorStore, createMemoryPersistence } from "@opennan/timeline-core";
import { rainCheck } from "./test-story";
import { castForSeries, dialoguePrompt, parseSeriesCast, speechContext } from "./voices";
import { parseStoryFilm, readStoryJson, storyJson } from "./validate";
import { persistStoryFilm } from "./save";
import { mergeStory } from "./edit";

const line = { id: "l1", characterId: "theo", text: "Hello.\nAre you listening?", start: 0, end: 3 };
describe("series voice continuity", () => {
    it("distinguishes unassigned, silence, speakers and silent listeners", () => {
        const story = rainCheck(), shot = story.shots[0]!;
        shot.cast = ["theo", "mae"];
        expect(speechContext(story, shot).status).toBe("unassigned");
        shot.dialogue = [];
        expect(speechContext(story, shot)).toMatchObject({ status: "silent", speaking: [], silent: ["theo", "mae"] });
        shot.dialogue = [line];
        expect(speechContext(story, shot)).toMatchObject({ status: "dialogue", speaking: ["theo"], silent: ["mae"] });
        expect(dialoguePrompt(story, shot)).toContain("Silent throughout: Mae");
        shot.cast = ["mae"];
        expect(dialoguePrompt(story, shot)).toContain("speaks off screen");
    });
    it("round trips voices and multiline dialogue, rejects unknown speakers and overlapping/out-of-shot timing", () => {
        const story = rainCheck(); story.characters[0]!.voice = { providerId: "opennan", id: "vc_theo" };
        story.shots[0]!.dialogue = [line];
        expect(readStoryJson(storyJson(story))).toEqual(story);
        for (const patch of [{ characterId: "someone" }, { end: 99 }, { start: -1 }, { end: 0 }]) {
            expect(parseStoryFilm({ ...story, shots: [{ ...story.shots[0], dialogue: [{ ...line, ...patch }] }] }).ok).toBe(false);
        }
        expect(parseStoryFilm({ ...story, shots: [{ ...story.shots[0], dialogue: [line, { ...line, id: "l2", start: 2 }] }] }).ok).toBe(false);
    });
    it("exports only stable identity and voice references, never source media, takes or credentials", () => {
        const story = rainCheck(); story.characters[0]!.voice = { providerId: "opennan", id: "vc_theo" };
        story.characters[0]!.sheet = { url: "https://private.example/sheet.png", key: "sheet" };
        const cast = parseSeriesCast({ ...castForSeries(story, "rain", "Rain"), secret: "hidden" });
        expect(cast.characters[0]).toMatchObject({ id: "theo", voice: { id: "vc_theo" } });
        expect(JSON.stringify(cast)).not.toMatch(/private|secret|sheet/);
        const next = structuredClone(story); delete next.characters[0]!.voice;
        expect(mergeStory(story, next).characters[0]!.voice?.id).toBe("vc_theo");
    });
    it("removes a previously placed take when a shot becomes silent, and rejects invalid merged edits", async () => {
        const backend = new LocalBackend({ persistence: createMemoryPersistence() });
        const project = await backend.createProject({ name: "Episode", aspectRatio: "16:9" });
        const controller = new TimelineController({ backend, store: createEditorStore(), projectId: project.id });
        await controller.load();
        const host = { snapshot: () => controller.snapshot(), execute: (command: Parameters<typeof controller.execute>[0]) => controller.execute(command) };
        const placed = await controller.execute({ type: "clip.create", input: { trackType: "audio", trackIndex: 0, startTime: 0, endTime: 2, mediaUrl: "opennan-local://media/speech.mp3" } });
        expect(placed.ok).toBe(true);
        const story = rainCheck(); story.shots[0]!.dialogue = [{ ...line, audio: { url: "opennan-local://media/speech.mp3", key: "take" }, placedClipId: placed.createdClipIds![0] }];
        await persistStoryFilm(story, host);
        const invalid = structuredClone(story); invalid.characters = invalid.characters.filter(c => c.id !== "theo");
        await expect(persistStoryFilm(invalid, host)).rejects.toThrow(/unknown|known/);
        expect(controller.snapshot().clips).toHaveLength(1);
        story.shots[0]!.dialogue = [];
        await persistStoryFilm(story, host);
        expect(controller.snapshot().clips).toHaveLength(0);
        expect(readStoryJson(controller.snapshot().project?.storyFilmJson)?.shots[0]!.dialogue).toEqual([]);
    });
});
