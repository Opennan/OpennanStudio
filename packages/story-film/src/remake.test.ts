// "Remake from your video": the copied video cut into shots (cuts found, pieces under 2 s joined, over 15 s split), the
// draft's shots placed on the real ones, and Animate remaking each shot from its real shot (the clip as @Video1, the
// cast sheets and the keyframe as images) when the video model takes reference videos, else from its keyframe. A
// reference out of the model's limits never runs; the reference clip is part of what makes a clip (never paid twice).
import type { PriceAnswer, ProviderModel } from "@opennan/provider-sdk";
import { reelInputOf } from "./assemble";
import { copyDraftRequest, parseDraftReply } from "./draft";
import { mergeStory } from "./edit";
import { estimateStep, isStale, keepsMotion, remakeOf, runStep, storyItem, storyItems, withVideoModel, type StoryFilmHost, type StoryRunResult } from "./pipeline";
import { remakePrompt } from "./recipe";
import { findCuts, remakeSeconds, shotSheetTimes, splitShots, storySecondsOf, withShotSources } from "./shots";
import { rainCheck } from "./test-story";
import type { StoryFilm } from "./types";
import { parseStoryFilm, readStoryJson, storyJson } from "./validate";

const SEEDANCE_25: ProviderModel = {
    id: "seedance-2-5", label: "Seedance 2.5", durations: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    referenceVideos: { max: 3, minSeconds: 2, maxSeconds: 30, totalSeconds: 30, modes: ["reference", "editing", "extension"], formats: ["mp4", "mov"], minPixels: 409_600, minFps: 24, maxFps: 60 },
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
    it("finds a cut where a frame differs far more than the frames around it, never on steady motion", () => {
        const times = Array.from({ length: 40 }, (_, i) => i / 4);
        const diffs = times.map((_, i) => (i === 12 ? 0.5 : i === 30 ? 0.2 : 0.03 + (i % 3) * 0.005));
        expect(findCuts(times, diffs)).toEqual([3, 7.5]);
        // A steady pan (every frame changes a lot) has no cut.
        expect(findCuts(times, times.map(() => 0.2))).toEqual([]);
        expect(findCuts(times, times.map(() => 0.01))).toEqual([]);
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

describe("remake animate", () => {
    it("remakes each shot from its real shot: the clip as @Video1, the cast sheets then the keyframe as images, the model's length", async () => {
        const story = copied();
        const { host, sent } = fakeHost();
        const out = await runStep(host, story, "animate", { only: ["s01"] });
        expect(out.made).toEqual(["s01"]);
        expect(sent).toEqual([{
            capability: "video.image-to-video",
            input: {
                description: remakePrompt(story, story.shots[0]!, true),
                referenceVideos: [{ mediaUrl: "opennan-local://media/shot-1", seconds: 4.65 }], referenceMode: "reference",
                referenceImages: [{ mediaUrl: "opennan-local://media/theo-sheet" }, { mediaUrl: "opennan-local://media/mae-sheet" }, { mediaUrl: "opennan-local://media/s01-key" }],
                durationSeconds: 5, aspectRatio: "16:9", model: "seedance-2-5", quality: "720p", generateAudio: false,
            },
        }]);
        expect(sent[0]!.input).not.toHaveProperty("image");
        const prompt = String(sent[0]!.input.description);
        expect(prompt).toMatch(/^Recreate @Video1 exactly: same motion, timing, blocking and camera move/);
        expect(prompt).toMatch(/Replace the people with @Image1 \(Theo: tall lanky young man.*\) and @Image2 \(Mae: graceful young woman.*\)\. Keep their looks exactly as drawn in their reference sheets\./);
        expect(prompt).toMatch(/Match the art style, line weight and colours of @Image3 \(this shot's first frame\)\./);
        expect(prompt).toMatch(/Render as a hand-drawn animated short film: classic 2D/);
        expect(out.story.shots[0]!.clip).toMatchObject({ url: "opennan-local://media/clip-1.mp4", model: "seedance-2-5", durationSeconds: 5 });
    });

    it("cuts the range from the source video when there is no clip, and prices the reference seconds", async () => {
        const story = copied({ clips: false });
        const item = storyItem(story, "animate", "s02")!;
        expect(item.input.referenceVideos).toEqual([{ mediaUrl: "opennan-local://media/source", startSeconds: 4.6, endSeconds: 9.2 }]);
        expect(item.units).toEqual({ seconds: 5, referenceSeconds: 4.6 });
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
