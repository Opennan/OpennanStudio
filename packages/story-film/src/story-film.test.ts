// Story film: the validator on the prototype's story, the recipe's exact prompts, drafts, and the reel input.
import { reelInputOf, withAssembled } from "./assemble";
import { mergeStory, storyProgress, withNewerAssets } from "./edit";
import { copyDraftRequest, jsonObjectOf, parseDraftReply, writeDraftRequest } from "./draft";
import { keyframePrompt, motionPrompt, sheetPrompt } from "./recipe";
import type { StoryFilm } from "./types";
import { rainCheck } from "./test-story";
import { filmSeconds, parseStoryFilm, readStoryJson, storyJson } from "./validate";

describe("parseStoryFilm", () => {
    it("reads the prototype's story: 2 characters, 12 shots of 5 s, the music text", () => {
        const story = rainCheck();
        expect(story.title).toBe("Rain Check");
        expect(story.characters.map((c) => c.id)).toEqual(["theo", "mae"]);
        expect(story.shots).toHaveLength(12);
        expect(story.shots[5]!.cast).toEqual(["mae"]);
        expect(filmSeconds(story)).toBe(60);
        expect(story.music).toMatch(/^gentle romantic instrumental/);
    });

    it("lists every problem and fixes none silently", () => {
        const parsed = parseStoryFilm({
            title: "", style: "x", characters: [{ id: "Bad Id", name: "A", look: "b" }, { name: "Cleo", look: "c" }],
            shots: [{ id: "s1", cast: ["nobody"], frame: "f", motion: "m", seconds: 3 }, { id: "s1", cast: [], frame: "", motion: "m" }],
        });
        expect(parsed.ok).toBe(false);
        if (parsed.ok) return;
        expect(parsed.errors).toEqual(expect.arrayContaining([
            "title is required",
            "characters[0].id must be lowercase letters, digits, - or _ (at most 32)",
            "shots[0].cast names an unknown character \"nobody\"",
            "shots[0].seconds must be a whole number from 4 to 15",
            "shots[1].id s1 is used twice",
            "shots[1].frame is required",
        ]));
    });

    it("takes names in a cast, makes ids from names, and keeps only well-formed assets", () => {
        const parsed = parseStoryFilm({
            title: "T", style: "S", music: { prompt: "piano" },
            characters: [{ name: "Cléo Marsh", look: "red coat", sheet: { url: "opennan-local://media/c.png", key: "k1", costUsd: 0.05 } }],
            shots: [{ cast: ["Cléo Marsh"], frame: "f", motion: "m", keyframe: { url: "file:///etc/passwd", key: "x" } }],
        });
        if (!parsed.ok) throw new Error(parsed.errors.join("; "));
        expect(parsed.story.characters[0]).toMatchObject({ id: "cleo-marsh", sheet: { url: "opennan-local://media/c.png", key: "k1", costUsd: 0.05 } });
        expect(parsed.story.shots[0]).toMatchObject({ id: "s01", cast: ["cleo-marsh"] });
        expect(parsed.story.shots[0]!.keyframe).toBeUndefined();
        expect(parsed.story.music).toBe("piano");
    });

    it("round-trips through the project's storyFilmJson", () => {
        const story = rainCheck();
        expect(readStoryJson(storyJson(story))).toEqual(story);
        expect(readStoryJson("{not json")).toBeNull();
        expect(readStoryJson(null)).toBeNull();
    });
});

describe("prompts (the proven recipe, word for word)", () => {
    const story = rainCheck();
    const [theo, mae] = story.characters;

    it("draws a character sheet", () => {
        expect(sheetPrompt(story, theo!)).toBe(
            `Character design model sheet for an animated film. Theo: ${theo!.look}. Full body turnaround (front, three-quarter, side, back) plus four facial expressions (happy, surprised, shy, laughing), plain off-white background, consistent proportions. Style: ${story.style}`,
        );
    });

    it("draws a keyframe: each look restated next to its reference, the previous shot as the style anchor", () => {
        const shot = story.shots[1]!;
        expect(keyframePrompt(story, shot, true)).toBe(
            `A single frame from a hand-drawn animated short film. Characters: Theo (exactly as drawn in reference image 1: ${theo!.look}); Mae (exactly as drawn in reference image 2: ${mae!.look}). Scene: ${shot.frame} Match the art style, line weight and colour palette of the last reference image (previous shot of the same film). Style: ${story.style}`,
        );
        expect(keyframePrompt(story, story.shots[0]!, false)).not.toMatch(/Match the art style/);
    });

    it("animates from the keyframe; other mediums swap only the medium words", () => {
        const shot = story.shots[0]!;
        expect(motionPrompt(story, shot)).toBe(`${shot.motion} Keep the exact hand-drawn 2D animation style, character designs and colours of the first frame. Smooth classic cel animation, no morphing, no text.`);
        expect(motionPrompt({ medium: "3d" }, shot)).toMatch(/Keep the exact 3D animation style/);
        expect(keyframePrompt({ ...story, medium: "stop-motion" }, shot, false)).toMatch(/^A single frame from a stop-motion animated short film\./);
    });
});

describe("drafts", () => {
    it("asks for one JSON story from a written story", () => {
        const request = writeDraftRequest({ text: "Two strangers share an umbrella.", shots: 10 });
        expect(request.capability).toBe("text.generate");
        expect(request.input.prompt).toMatch(/Two strangers share an umbrella\.[\s\S]*About 10 shots\./);
        expect(request.input.instruction).toMatch(/Answer with one JSON object/);
        expect(request.input.images).toBeUndefined();
    });

    it("copies a video with an original cast by default, and keeps it only when asked", () => {
        const sheet = { mediaUrl: "opennan-local://media/sheet.jpg" };
        const original = copyDraftRequest({ sheet, frames: 16, everySeconds: 3.75, durationSeconds: 60, cast: "original" });
        expect(original.input.images).toEqual([sheet]);
        expect(original.input.prompt).toMatch(/ORIGINAL cast: new character designs and new names[\s\S]*a new title/);
        expect(original.input.prompt).toMatch(/16 frames .* one every 3\.8 seconds of a 60-second video/);
        expect(copyDraftRequest({ sheet, frames: 16, everySeconds: 4, durationSeconds: 64, cast: "keep" }).input.prompt).toMatch(/person's own video/);
    });

    it("reads a reply's story out of code fences and words, without assets or costs", () => {
        const story = { title: "Paper Boats", style: "watercolour", characters: [{ id: "ina", name: "Ina", look: "yellow raincoat", sheet: { url: "https://x/a.png", key: "k" } }], shots: [{ id: "s01", cast: ["Ina"], frame: "A puddle {big}", motion: "Ina kneels", keyframe: { url: "https://x/k.png", key: "k" } }], music: "harp", spentUsd: 9 };
        const reply = `Here is your film:\n\`\`\`json\n${JSON.stringify(story)}\n\`\`\`\nEnjoy!`;
        expect(jsonObjectOf(reply)).toEqual(story);
        const parsed = parseDraftReply(reply, { kind: "copy", cast: "original" });
        if (!parsed.ok) throw new Error(parsed.errors.join("; "));
        expect(parsed.story.shots[0]!.cast).toEqual(["ina"]);
        expect(parsed.story.characters[0]!.sheet).toBeUndefined();
        expect(parsed.story.shots[0]!.keyframe).toBeUndefined();
        expect(parsed.story.spentUsd).toBeUndefined();
        expect(parsed.story.source).toEqual({ kind: "copy", cast: "original" });
        expect(parseDraftReply("Sorry, I can't.", { kind: "write" })).toEqual({ ok: false, errors: ["the story writer's answer had no story in it"] });
    });
});

describe("reelInputOf", () => {
    it("needs every clip, then lays out the clips at their shot lengths with the music, replacing the last placement", () => {
        const story = rainCheck();
        const missing = reelInputOf(story);
        expect(missing.ok).toBe(false);
        const done: StoryFilm = {
            ...story,
            shots: story.shots.map((s, i) => ({ ...s, clip: { url: `opennan-local://media/${s.id}.mp4`, key: "k", durationSeconds: i === 0 ? 4.9 : 5.04, width: 1280, height: 720 } })),
            musicAsset: { url: "opennan-local://media/music.mp3", key: "m", durationSeconds: 61 },
        };
        const placed = reelInputOf(withAssembled(done, { sceneIds: ["a", "b"], titleClipId: "t", musicClipId: "m" }));
        if (!placed.ok) throw new Error(placed.error);
        expect(placed.input.title).toBe("Rain Check");
        expect(placed.input.clips.map((c) => c.durationSeconds).slice(0, 2)).toEqual([4.9, 5]);
        expect(placed.input.music).toEqual({ mediaUrl: "opennan-local://media/music.mp3", durationSeconds: 61 });
        expect(placed.input.replace).toEqual({ sceneIds: ["a", "b"], clipIds: ["t", "m"] });
    });
});

describe("mergeStory and storyProgress", () => {
    it("keeps the files of ids that stay, drops the rest, and shows edited texts as changed", () => {
        const before = rainCheck();
        const drawn: StoryFilm = {
            ...before, spentUsd: 0.1,
            characters: before.characters.map((c) => ({ ...c, sheet: { url: `opennan-local://media/${c.id}.png`, key: "old" } })),
        };
        const next = { ...rainCheck(), characters: [rainCheck().characters[0]!, { id: "zed", name: "Zed", look: "tall" }], shots: rainCheck().shots.map((s) => ({ ...s, cast: s.cast.filter((c) => c !== "mae") })) };
        const merged = mergeStory(drawn, next);
        expect(merged.characters.map((c) => [c.id, c.sheet?.url ?? null])).toEqual([["theo", "opennan-local://media/theo.png"], ["zed", null]]);
        expect(merged.spentUsd).toBe(0.1);
        const progress = storyProgress(merged);
        expect(progress[0]).toEqual({ step: "cast", made: 1, total: 2, missing: ["zed"], changed: ["theo"] });
        expect(progress[1]).toMatchObject({ step: "frames", made: 0, total: 12 });
    });
});

describe("withNewerAssets", () => {
    it("keeps text edited during a run and takes the run's newer files", () => {
        const base = rainCheck();
        const stored: StoryFilm = { ...base, title: "Edited", characters: base.characters.map((c) => ({ ...c, sheet: { url: `opennan-local://media/old-${c.id}.png`, key: "k", at: "2026-10-31T10:00:00.000Z" } })) };
        const run: StoryFilm = { ...base, spentUsd: 0.05, characters: base.characters.map((c) => (c.id === "mae" ? { ...c, sheet: { url: "opennan-local://media/new-mae.png", key: "k", at: "2026-10-31T10:05:00.000Z" } } : c)) };
        const merged = withNewerAssets(stored, run);
        expect(merged.title).toBe("Edited");
        expect(merged.characters.map((c) => c.sheet?.url)).toEqual(["opennan-local://media/old-theo.png", "opennan-local://media/new-mae.png"]);
        expect(merged.spentUsd).toBe(0.05);
    });
});
