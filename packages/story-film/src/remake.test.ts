// "Remake from your video": the copied video cut into shots (cuts found, pieces under 2 s joined, over 15 s split), the
// draft's shots placed on the real ones, and Animate remaking each shot from its real shot (the clip as @Video1, the
// cast sheets and the keyframe as images) when the video model takes reference videos, else from its keyframe. A
// reference out of the model's limits never runs; the reference clip is part of what makes a clip (never paid twice).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PriceAnswer, ProviderModel } from "@opennan/provider-sdk";
import { reelInputOf } from "./assemble";
import { copyDraftRequest, parseDraftReply } from "./draft";
import { mergeStory } from "./edit";
import { estimateStep, isStale, keepsMotion, remakeMode, remakeOf, runStep, storyItem, storyItems, withVideoModel, type StoryFilmHost, type StoryRunResult } from "./pipeline";
import { copyKeyframePrompt, editPrompt, redrawPrompt, remakePrompt } from "./recipe";
import { CUT_DETECTION, SCENE_SCORE_CUTS, findCuts, remakeSeconds, shotSheetTimes, splitShots, storySecondsOf, withShotSources } from "./shots";
import { rainCheck } from "./test-story";
import type { StoryFilm } from "./types";
import { parseStoryFilm, readStoryJson, storyJson } from "./validate";

interface Series { times: number[]; scores: number[] }
/** "Romance of an Umbrella" (1909, public domain): ffmpeg's scene score of every frame, the editor's frame differences, and a steady pan's. */
const umbrella = () => JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/umbrella-cuts.json"), "utf8")) as {
    cuts: number[]; sceneScores: Series; frameDiffs: { fps: number; diffs: number[] }; pan: { sceneScores: Series; frameDiffs: { fps: number; diffs: number[] } };
};

const SEEDANCE_25: ProviderModel = {
    id: "seedance-2-5", label: "Seedance 2.5", durations: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    referenceVideos: { max: 3, minSeconds: 2, maxSeconds: 30, totalSeconds: 30, modes: ["reference", "editing", "extension"], formats: ["mp4", "mov"], minPixels: 409_600, minFps: 24, maxFps: 60, editMinSeconds: 4 },
};
const MINI: ProviderModel = { id: "seedance-2-mini", label: "Seedance 2 Mini", durations: [4, 5, 6, 8, 10, 12, 15] };

const asset = (url: string) => ({ url, key: "k" });

/** Rain Check copied from a video: every sheet and keyframe drawn, shots placed on real shots, keep motion on, seedance-2-5. */
function copied(options: { keepMotion?: boolean; model?: ProviderModel; clips?: boolean } = {}): StoryFilm {
    const base = rainCheck();
    const drawn: StoryFilm = {
        ...base,
        source: { kind: "copy", cast: "original", mediaUrl: "opennan-local://media/source", keepMotion: options.keepMotion ?? true },
        characters: base.characters.map((c) => ({ ...c, sheet: asset(`opennan-local://media/${c.id}-sheet`) })),
        shots: base.shots.map((s) => ({ ...s, keyframe: asset(`opennan-local://media/${s.id}-key`) })),
    };
    const ranges = drawn.shots.map((_, i) => ({ start: i * 4.6, end: i * 4.6 + 4.6, ...(options.clips === false ? {} : { clip: `opennan-local://media/shot-${i + 1}` }) }));
    return withVideoModel(withShotSources(drawn, ranges), options.model ?? SEEDANCE_25);
}

function fakeHost() {
    const sent: Array<{ capability: string; input: Record<string, unknown> }> = [];
    const priced: Array<{ input: Record<string, unknown>; units: Record<string, unknown> }> = [];
    let n = 0;
    const host: StoryFilmHost = {
        async run(capability, input): Promise<StoryRunResult> {
            sent.push({ capability, input });
            n += 1;
            return { ok: true, media: [{ url: `opennan-local://media/clip-${n}.mp4` }], costUsd: 3.6894 };
        },
        async price(_capability, input, units): Promise<PriceAnswer> {
            priced.push({ input, units: { ...units } });
            return { kind: "estimate", estimate: { microUsd: 3_689_410, usd: 3.68941, label: "≈ $3.69", units: 10, capped: false } };
        },
    };
    return { host, sent, priced };
}

describe("cutting a video into shots", () => {
    it("finds a cut where a frame stands out from the second around it, never on steady motion or flicker", () => {
        const times = Array.from({ length: 40 }, (_, i) => i / 4);
        const diffs = times.map((_, i) => (i === 12 ? 0.5 : i === 30 ? 0.2 : 0.03 + (i % 3) * 0.005));
        expect(findCuts(times, diffs)).toEqual([3, 7.5]);
        // A steady pan (every frame changes a lot) has no cut; nor does a still.
        expect(findCuts(times, times.map(() => 0.2))).toEqual([]);
        expect(findCuts(times, times.map((_, i) => 0.18 + (i % 4) * 0.01))).toEqual([]);
        expect(findCuts(times, times.map(() => 0.01))).toEqual([]);
        // One cut per jump: the frame after a cut that still differs a lot is not another cut.
        expect(findCuts(times, times.map((_, i) => (i === 12 ? 0.5 : i === 13 ? 0.3 : 0.02)))).toEqual([3]);
    });

    it("finds all thirteen cuts of a flickering 1909 film with ffmpeg's scene score, including the faint ones a fixed 0.3 missed", () => {
        const film = umbrella();
        const cuts = findCuts(film.sceneScores.times, film.sceneScores.scores, SCENE_SCORE_CUTS);
        expect(cuts).toHaveLength(13);
        for (const [i, cut] of film.cuts.entries()) expect(Math.abs(cuts[i]! - cut)).toBeLessThan(0.06);
        // The two faint cuts (0.271 at 9.21 s, 0.238 at 10.46 s) are found; the old fixed threshold missed both.
        const score = (t: number) => film.sceneScores.scores[film.sceneScores.times.findIndex((x) => Math.abs(x - t) < 0.02)]!;
        expect(score(9.208)).toBeLessThan(0.3);
        expect(score(10.458)).toBeLessThan(0.3);
        expect(cuts.some((c) => Math.abs(c - 9.21) < 0.06) && cuts.some((c) => Math.abs(c - 10.46) < 0.06)).toBe(true);
        // A steady pan scores on every frame and is never cut.
        expect(findCuts(film.pan.sceneScores.times, film.pan.sceneScores.scores, SCENE_SCORE_CUTS)).toEqual([]);
        // The shots: pieces under 2 s (a reference video's minimum) join a neighbour, so each shot starts on a real cut.
        const shots = splitShots(cuts, 17.667).shots;
        for (const shot of shots.slice(1)) expect(cuts).toContain(shot.start);
        for (const shot of shots) expect(shot.end - shot.start).toBeGreaterThanOrEqual(2);
    });

    it("finds the same cuts with the editor's frame difference sampled six times a second", () => {
        const film = umbrella();
        const times = film.frameDiffs.diffs.map((_, i) => i / film.frameDiffs.fps);
        const cuts = findCuts(times, film.frameDiffs.diffs, CUT_DETECTION);
        // Every cut after the opening, each within one sample (1/6 s) of the real one.
        const real = film.cuts.slice(1);
        const after = cuts.filter((c) => c > 2);
        expect(after).toHaveLength(real.length);
        for (const [i, cut] of real.entries()) expect(Math.abs(after[i]! - cut)).toBeLessThanOrEqual(1 / 6 + 0.01);
        // The opening's flicker gives at most one cut before 2 s (it joins the next shot either way).
        expect(cuts.filter((c) => c <= 2).length).toBeLessThanOrEqual(1);
        for (const shot of splitShots(cuts, 17.667).shots.slice(1)) expect(cuts).toContain(shot.start);
        const panTimes = film.pan.frameDiffs.diffs.map((_, i) => i / 6);
        expect(findCuts(panTimes, film.pan.frameDiffs.diffs, CUT_DETECTION)).toEqual([]);
    });

    it("joins pieces under 2 s to their shorter neighbour and splits pieces over 15 s evenly", () => {
        expect(splitShots([4, 4.8, 12], 20).shots).toEqual([{ start: 0, end: 4.8 }, { start: 4.8, end: 12 }, { start: 12, end: 20 }]);
        // A 1 s piece between a 3 s and a 10 s piece joins the 3 s one.
        expect(splitShots([3, 4], 14).shots).toEqual([{ start: 0, end: 4 }, { start: 4, end: 14 }]);
        // 40 s without a cut: three equal shots of 13.333 s.
        expect(splitShots([], 40).shots).toEqual([{ start: 0, end: 13.333 }, { start: 13.333, end: 26.667 }, { start: 26.667, end: 40 }]);
        // Short at the start and the end.
        expect(splitShots([0.5, 10, 12.5], 12.9).shots).toEqual([{ start: 0, end: 10 }, { start: 10, end: 12.9 }]);
        expect(splitShots([0.5, 10, 11.2], 11.6).shots).toEqual([{ start: 0, end: 11.6 }]);
        const every = splitShots(Array.from({ length: 200 }, (_, i) => (i + 1) * 1.1), 221).shots;
        for (const shot of every) expect(shot.end - shot.start).toBeGreaterThanOrEqual(2 - 1e-9);
        expect(splitShots([], 3).shots).toEqual([{ start: 0, end: 3 }]);
        expect(splitShots([], 1.2).shots).toEqual([{ start: 0, end: 1.2 }]);
        expect(splitShots([], 0).shots).toEqual([]);
        const many = splitShots(Array.from({ length: 60 }, (_, i) => (i + 1) * 3), 183);
        expect(many.shots).toHaveLength(40);
        expect(many.truncated).toBe(true);
    });

    it("samples the contact sheet shot by shot and rounds lengths to story seconds and the model's lengths", () => {
        expect(shotSheetTimes([{ start: 0, end: 6 }, { start: 6, end: 9 }], 4)).toEqual([{ time: 1.5, shot: 0 }, { time: 4.5, shot: 0 }, { time: 6.75, shot: 1 }, { time: 8.25, shot: 1 }]);
        expect(shotSheetTimes(Array.from({ length: 30 }, (_, i) => ({ start: i * 3, end: i * 3 + 3 })), 24)).toHaveLength(30);
        expect([2.2, 4.4, 7.6, 15].map(storySecondsOf)).toEqual([4, 4, 8, 15]);
        expect(remakeSeconds(2.5, SEEDANCE_25.durations)).toBe(4);
        expect(remakeSeconds(6.5, SEEDANCE_25.durations)).toBe(7);
        expect(remakeSeconds(7, [5, 10])).toBe(5);
        expect(remakeSeconds(7.5, [5, 10])).toBe(10);
        expect(remakeSeconds(7.4, undefined)).toBe(7);
    });

    it("places the draft's shots on the real shots in order; the copy prompt lists them", () => {
        const request = copyDraftRequest({
            sheet: "https://x/sheet.jpg", frames: 4, everySeconds: 0, durationSeconds: 9.2, cast: "original",
            shots: [{ start: 0, end: 4.6, firstFrame: 1, lastFrame: 2 }, { start: 4.6, end: 9.2, firstFrame: 3, lastFrame: 4 }],
        });
        expect(request.input.prompt).toMatch(/exactly 2 shots \(cut to cut\):\n- shot 1: 0-4\.6 s \(4\.6 s\), frames 1-2\n- shot 2: 4\.6-9\.2 s/);
        expect(request.input.prompt).toMatch(/Write exactly 2 story shots, in this order/);
        const parsed = parseDraftReply(JSON.stringify({ ...rainCheck(), shots: rainCheck().shots.slice(0, 3).map((s) => ({ ...s, source: { start: 0, end: 99 } })) }), { kind: "copy", cast: "original", keepMotion: true, mediaUrl: "opennan-local://media/source" });
        if (!parsed.ok) throw new Error(parsed.errors.join("; "));
        // A draft never carries sources; the real shots are placed after.
        expect(parsed.story.shots.every((s) => !s.source)).toBe(true);
        const placed = withShotSources(parsed.story, [{ start: 0, end: 4.6, clip: "opennan-local://media/shot-1" }, { start: 4.6, end: 6.8 }]);
        expect(placed.shots.map((s) => [s.seconds, s.source])).toEqual([[5, { start: 0, end: 4.6, clip: "opennan-local://media/shot-1" }], [4, { start: 4.6, end: 6.8 }], [rainCheck().shots[2]!.seconds, undefined]]);
        expect(placed.source).toEqual({ kind: "copy", cast: "original", keepMotion: true, mediaUrl: "opennan-local://media/source" });
        // Stored and read back; an edit of the text keeps each shot's place.
        const stored = readStoryJson(storyJson(placed))!;
        expect(stored.shots[0]!.source).toEqual({ start: 0, end: 4.6, clip: "opennan-local://media/shot-1" });
        const edited = parseStoryFilm({ ...stored, shots: stored.shots.map(({ source: _source, ...s }) => ({ ...s, motion: "changed" })) });
        if (!edited.ok) throw new Error("edit");
        expect(mergeStory(stored, edited.story).shots[1]!.source).toEqual({ start: 4.6, end: 6.8 });
        expect(parseStoryFilm({ ...stored, shots: [{ ...stored.shots[0], source: { start: 5, end: 2 } }] }).ok && true).toBe(true);
    });
});

describe("keyframes copy the original framing", () => {
    it("redraws a copied shot's keyframe from its own first frame: an image edit, the frame first, then the cast sheets and the previous keyframe", async () => {
        const base = copied();
        const story = withShotSources({ ...base, shots: base.shots.map((s) => ({ ...s, keyframe: null })) }, base.shots.map((s, i) => ({ ...s.source!, frame: `opennan-local://media/frame-${i + 1}.jpg` })));
        const first = storyItem(story, "frames", "s01")!;
        expect(first.capability).toBe("image.edit");
        expect(first.copied).toBe(true);
        expect(first.input).toEqual({
            description: copyKeyframePrompt(story, story.shots[0]!, false), aspectRatio: "16:9", model: "nano-banana-pro", size: "2K",
            image: { mediaUrl: "opennan-local://media/frame-1.jpg" }, images: [{ mediaUrl: "opennan-local://media/theo-sheet" }, { mediaUrl: "opennan-local://media/mae-sheet" }],
        });
        expect(String(first.input.description)).toMatch(/^Redraw reference image 1 exactly: the same composition, camera angle, framing, poses and places of everyone and everything in it, as a single frame from a hand-drawn animated short film\. The people in it are: Theo \(exactly as drawn in reference image 2: .*\); Mae \(exactly as drawn in reference image 3: /);
        const { host, sent } = fakeHost();
        const out = await runStep(host, story, "frames", { castCheck: 0 });
        expect(out.made).toEqual(story.shots.map((s) => s.id));
        // Shot 2: its own frame, its cast's sheets, then shot 1's keyframe (the style anchor).
        expect(sent[1]!.capability).toBe("image.edit");
        expect(sent[1]!.input.image).toEqual({ mediaUrl: "opennan-local://media/frame-2.jpg" });
        expect(sent[1]!.input.images).toEqual([...story.shots[1]!.cast.map((id) => ({ mediaUrl: `opennan-local://media/${id}-sheet` })), { mediaUrl: out.story.shots[0]!.keyframe!.url }]);
        expect(String(sent[1]!.input.description)).toMatch(/Match the art style, line weight and colour palette of the last reference image/);
        // Without a saved frame, the moment of the source video (two frames into the shot) is sent.
        const unsaved = copied();
        expect(storyItem(unsaved, "frames", "s02")!.input.image).toEqual({ mediaUrl: "opennan-local://media/source", startSeconds: 4.68 });
        // A written story's keyframes are drawn as before.
        expect(storyItem(rainCheck(), "frames", "s01")!.capability).toBe("image.generate");
        // A redraw after the cast check restates the look with the sheets' numbers after the frame.
        expect(redrawPrompt(story, story.shots[0]!, false, [{ id: "mae", reason: "no ponytail" }], true)).toMatch(/Most important: Mae must look exactly like reference image 3: .*no ponytail$/);
    });
});

describe("remake animate", () => {
    it("edits a shot long enough to edit: @Video1 restyled with the cast sheets and the keyframe, every movement and framing kept", async () => {
        const story = copied();
        const { host, sent } = fakeHost();
        const out = await runStep(host, story, "animate", { only: ["s01"] });
        expect(out.made).toEqual(["s01"]);
        expect(sent).toEqual([{
            capability: "video.image-to-video",
            input: {
                description: editPrompt(story, story.shots[0]!, true),
                referenceVideos: [{ mediaUrl: "opennan-local://media/shot-1", seconds: 4.65 }], referenceMode: "editing",
                referenceImages: [{ mediaUrl: "opennan-local://media/theo-sheet" }, { mediaUrl: "opennan-local://media/mae-sheet" }, { mediaUrl: "opennan-local://media/s01-key" }],
                durationSeconds: 5, aspectRatio: "16:9", model: "seedance-2-5", quality: "720p", generateAudio: false,
            },
        }]);
        expect(sent[0]!.input).not.toHaveProperty("image");
        const prompt = String(sent[0]!.input.description);
        expect(prompt).toMatch(/^Turn @Video1 into a hand-drawn animated short film: classic 2D/);
        expect(prompt).toMatch(/The people become Theo \(@Image1: tall lanky young man.*\) and Mae \(@Image2: graceful young woman.*\), exactly as drawn in their reference sheets\./);
        expect(prompt).toMatch(/Match the look of @Image3 \(this shot's first frame, redrawn\)\./);
        expect(prompt).toMatch(/Keep every movement, the timing, the framing and the camera of @Video1 exactly\./);
        // An edit is as long as its video: priced and recorded on the real shot's seconds.
        expect(storyItem(story, "animate", "s01")!.units).toEqual({ seconds: 4.6, referenceSeconds: 4.6 });
        expect(out.story.shots[0]!.clip).toMatchObject({ url: "opennan-local://media/clip-1.mp4", model: "seedance-2-5", durationSeconds: 4.6 });
    });

    it("copies the motion of a shot too short to edit (reference mode), starting exactly like its keyframe", () => {
        const story = copied();
        story.shots = story.shots.map((s, i) => (i === 0 ? { ...s, source: { start: 0, end: 3.4, clip: "opennan-local://media/shot-1" } } : s));
        const item = storyItem(story, "animate", "s01")!;
        expect(item.referenceMode).toBe("reference");
        expect(item.input).toMatchObject({ referenceMode: "reference", durationSeconds: 4, description: remakePrompt(story, story.shots[0]!, true) });
        expect(item.units).toEqual({ seconds: 4, referenceSeconds: 3.4 });
        const prompt = String(item.input.description);
        expect(prompt).toMatch(/^Recreate @Video1 exactly: same motion, timing, blocking and camera move/);
        expect(prompt).toMatch(/Replace the people with @Image1 \(Theo: .*\) and @Image2 \(Mae: .*\)\./);
        expect(prompt).toMatch(/Start exactly like @Image3 \(this shot's first frame, same framing\)/);
        // The edit minimum with a frame of margin; a model that does not edit always copies the motion.
        expect(remakeMode(4.05, SEEDANCE_25.referenceVideos!)).toBe("reference");
        expect(remakeMode(4.1, SEEDANCE_25.referenceVideos!)).toBe("editing");
        expect(remakeMode(12, { ...SEEDANCE_25.referenceVideos!, modes: ["reference"] })).toBe("reference");
    });

    it("cuts the range from the source video when there is no clip, and prices the reference seconds", async () => {
        const story = copied({ clips: false });
        const item = storyItem(story, "animate", "s02")!;
        expect(item.input.referenceVideos).toEqual([{ mediaUrl: "opennan-local://media/source", startSeconds: 4.6, endSeconds: 9.2 }]);
        expect(item.units).toEqual({ seconds: 4.6, referenceSeconds: 4.6 });
        const { host, priced } = fakeHost();
        const estimate = await estimateStep(host, story, "animate");
        expect(estimate.ready).toBe(true);
        expect(priced.every((p) => (p.units.referenceSeconds as number) > 0 && Array.isArray(p.input.referenceVideos))).toBe(true);
    });

    it("animates from the keyframe when the model takes no reference videos, keep motion is off, or a shot has no real shot", async () => {
        for (const story of [copied({ model: MINI }), copied({ keepMotion: false })]) {
            const item = storyItem(story, "animate", "s01")!;
            expect(item.remake).toBeUndefined();
            expect(item.input).toEqual(expect.objectContaining({ image: { mediaUrl: "opennan-local://media/s01-key" }, durationSeconds: 5, model: story.settings!.videoModel }));
            expect(item.input).not.toHaveProperty("referenceVideos");
        }
        const partial = copied();
        partial.shots = partial.shots.map((s, i) => (i === 1 ? { ...s, source: undefined } : s));
        expect(storyItems(partial, "animate").map((i) => Boolean(i.remake))).toEqual(partial.shots.map((_, i) => i !== 1));
        expect(remakeOf(rainCheck(), rainCheck().shots[0]!)).toBeNull();
        expect(keepsMotion(copied())).toBe(true);
        expect(keepsMotion(copied({ keepMotion: false }))).toBe(false);
    });

    it("never runs a reference shot out of the model's limits, and says why", async () => {
        const story = copied();
        story.shots = story.shots.map((s, i) => (i === 0 ? { ...s, source: { start: 0, end: 1.4, clip: "opennan-local://media/shot-1" } } : s));
        const item = storyItem(story, "animate", "s01")!;
        expect(item.blocked).toMatch(/The original shot is 1\.4 s: the video model takes reference shots of 2 s at least/);
        const { host, sent } = fakeHost();
        const estimate = await estimateStep(host, story, "animate");
        expect(estimate.ready).toBe(false);
        expect(estimate.reason).toMatch(/^Shot 1: The original shot is 1\.4 s/);
        const out = await runStep(host, story, "animate", { only: ["s01"] });
        expect(out.failed[0]!.error).toMatch(/1\.4 s/);
        expect(sent).toHaveLength(0);
        // A missing keyframe or sheet blocks too.
        const unsheeted = copied();
        unsheeted.characters = unsheeted.characters.map((c) => ({ ...c, sheet: null }));
        expect(storyItem(unsheeted, "animate", "s01")!.blocked).toBe("Draw Theo and Mae first.");
    });

    it("the reference clip is part of what makes a clip: a new clip marks the made one changed, the same one is never paid twice", async () => {
        const story = copied();
        const { host, sent } = fakeHost();
        const made = (await runStep(host, story, "animate")).story;
        expect(sent).toHaveLength(story.shots.length);
        expect(storyItems(made, "animate").every((i) => !isStale(i))).toBe(true);
        expect((await runStep(host, made, "animate")).made).toEqual([]);
        expect(sent).toHaveLength(story.shots.length);
        const recut = { ...made, shots: made.shots.map((s, i) => (i === 0 ? { ...s, source: { ...s.source!, clip: "opennan-local://media/shot-1-recut" } } : s)) };
        expect(isStale(storyItem(recut, "animate", "s01")!)).toBe(true);
        expect(isStale(storyItem(recut, "animate", "s02")!)).toBe(false);
        // Switching to keyframe animation is another request too.
        expect(isStale(storyItem({ ...made, source: { ...made.source!, keepMotion: false } } as StoryFilm, "animate", "s01")!)).toBe(true);
    });

    it("keeps the model's facts on the story, and the reel keeps the original cut", () => {
        const story = copied();
        expect(story.settings).toMatchObject({ videoModel: "seedance-2-5", videoDurations: SEEDANCE_25.durations, videoReference: { minSeconds: 2, maxSeconds: 30, modes: ["reference", "editing", "extension"] } });
        expect(readStoryJson(storyJson(story))!.settings).toEqual(story.settings);
        expect(withVideoModel(story, MINI).settings).toEqual({ videoModel: "seedance-2-mini", videoDurations: MINI.durations });
        const clipped = { ...story, shots: story.shots.map((s, i) => ({ ...s, clip: { url: `opennan-local://media/c${i}.mp4`, key: "k", durationSeconds: 5 } })) };
        const reel = reelInputOf(clipped);
        if (!reel.ok) throw new Error(reel.error);
        expect(reel.input.clips[0]!.durationSeconds).toBe(4.6);
        const keyframed = reelInputOf({ ...clipped, source: { ...clipped.source!, keepMotion: false } } as StoryFilm);
        if (!keyframed.ok) throw new Error(keyframed.error);
        expect(keyframed.input.clips[0]!.durationSeconds).toBe(5);
    });
});
