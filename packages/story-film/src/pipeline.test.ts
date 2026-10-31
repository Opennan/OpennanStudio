// The story film pipeline on a fake host: what it sends, what it skips, what it stores, redo, failures, cancel, prices.
import type { PriceAnswer, PriceUnits } from "@opennan/provider-sdk";
import { estimateStep, isStale, itemsToRun, runStep, storyItem, storyItems, videoModelChoices, type StoryFilmHost, type StoryRunResult } from "./pipeline";
import { rainCheck } from "./test-story";
import type { StoryFilm } from "./types";

interface Sent {
    capability: string;
    input: Record<string, unknown>;
}

function fakeHost(options: { fail?: (sent: Sent, n: number) => string | null; wait?: () => Promise<void>; price?: (capability: string, input: Record<string, unknown>, units: PriceUnits) => PriceAnswer } = {}) {
    const sent: Sent[] = [];
    let n = 0;
    const host: StoryFilmHost = {
        async run(capability, input, { signal }): Promise<StoryRunResult> {
            const call = { capability, input };
            sent.push(call);
            n += 1;
            await options.wait?.();
            if (signal?.aborted) return { ok: false, error: "Cancelled.", cancelled: true };
            const error = options.fail?.(call, n);
            if (error) return { ok: false, error };
            const kind = capability === "image.generate" ? "png" : capability === "audio.music" ? "mp3" : "mp4";
            return { ok: true, media: [{ url: `opennan-local://media/${n}.${kind}`, ...(kind === "png" ? { width: 2752, height: 1536 } : {}) }], costUsd: kind === "mp4" ? 0.26 : 0.05 };
        },
        async price(capability, input, units) {
            if (options.price) return options.price(capability, input, units);
            const usd = capability === "video.image-to-video" ? 0.26 : capability === "audio.music" ? 0.02 : 0.05 + 0.002 * (units.images ?? 0);
            const microUsd = Math.round(usd * 1_000_000);
            return { kind: "estimate", estimate: { microUsd, usd, label: `≈ $${usd}`, units: 1, capped: false } };
        },
    };
    return { host, sent };
}

const all = async (host: StoryFilmHost, story: StoryFilm) => {
    let s = (await runStep(host, story, "cast")).story;
    s = (await runStep(host, s, "frames")).story;
    s = (await runStep(host, s, "animate")).story;
    return (await runStep(host, s, "music")).story;
};

describe("runStep", () => {
    it("draws one sheet per character at 2K 16:9 on the default image model, with no references", async () => {
        const { host, sent } = fakeHost();
        const saved: StoryFilm[] = [];
        const out = await runStep(host, rainCheck(), "cast", { onStory: (s) => void saved.push(s) });
        expect(out.made).toEqual(["theo", "mae"]);
        expect(sent.map((s) => s.input)).toEqual([
            expect.objectContaining({ model: "nano-banana-pro", size: "2K", aspectRatio: "16:9", description: expect.stringMatching(/^Character design model sheet .* Theo:/) }),
            expect.objectContaining({ description: expect.stringMatching(/Mae:/) }),
        ]);
        expect(sent.every((s) => s.input.image === undefined && s.input.images === undefined)).toBe(true);
        expect(out.story.characters[0]!.sheet).toMatchObject({ url: expect.stringMatching(/^opennan-local:\/\/media\/\d\.png$/), costUsd: 0.05, model: "nano-banana-pro", width: 2752 });
        expect(out.story.spentUsd).toBe(0.1);
        expect(out.spentUsd).toBe(0.1);
        expect(saved.at(-1)).toEqual(out.story);
    });

    it("draws keyframes in order: the cast's sheets in cast order, then the previous keyframe", async () => {
        const { host, sent } = fakeHost();
        const cast = (await runStep(host, rainCheck(), "cast")).story;
        sent.length = 0;
        const out = await runStep(host, cast, "frames");
        expect(out.made).toHaveLength(12);
        const [theo, mae] = cast.characters.map((c) => ({ mediaUrl: c.sheet!.url }));
        expect(sent[0]!.input).toMatchObject({ image: theo, images: [mae] });
        expect(sent[0]!.input.description).not.toMatch(/previous shot/);
        // Shot 2 anchors on shot 1's keyframe; shot 6 (Mae alone) sends her sheet and shot 5's keyframe.
        expect(sent[1]!.input).toMatchObject({ image: theo, images: [mae, { mediaUrl: out.story.shots[0]!.keyframe!.url }] });
        expect(sent[5]!.input).toMatchObject({ image: mae, images: [{ mediaUrl: out.story.shots[4]!.keyframe!.url }] });
        expect(sent[1]!.input.description).toMatch(/Match the art style, line weight and colour palette of the last reference image/);
    });

    it("animates each keyframe as the first frame, 5 s 16:9 720p without sound, on seedance-2-mini", async () => {
        const { host, sent } = fakeHost();
        let story = (await runStep(host, rainCheck(), "cast")).story;
        story = (await runStep(host, story, "frames")).story;
        sent.length = 0;
        const out = await runStep(host, story, "animate");
        expect(out.made).toHaveLength(12);
        expect(sent[0]!).toEqual({
            capability: "video.image-to-video",
            input: {
                description: expect.stringMatching(/Keep the exact hand-drawn 2D animation style/), image: { mediaUrl: story.shots[0]!.keyframe!.url },
                durationSeconds: 5, aspectRatio: "16:9", model: "seedance-2-mini", quality: "720p", generateAudio: false,
            },
        });
        expect(out.story.shots[0]!.clip).toMatchObject({ durationSeconds: 5, costUsd: 0.26 });
    });

    it("makes music the film's length, instrumental", async () => {
        const { host, sent } = fakeHost();
        const out = await runStep(host, rainCheck(), "music");
        expect(sent[0]).toEqual({ capability: "audio.music", input: { description: expect.stringMatching(/^gentle romantic/), durationSeconds: 60, instrumental: true } });
        expect(out.story.musicAsset).toMatchObject({ url: expect.stringMatching(/\.mp3$/), durationSeconds: 60 });
    });

    it("never pays twice: a re-run skips everything made, redo makes one item again", async () => {
        const { host, sent } = fakeHost();
        const story = await all(host, rainCheck());
        const count = sent.length;
        expect(count).toBe(2 + 12 + 12 + 1);
        for (const step of ["cast", "frames", "animate", "music"] as const) expect((await runStep(host, story, step)).made).toEqual([]);
        expect(sent.length).toBe(count);
        const redo = await runStep(host, story, "frames", { only: ["s04"], redo: true });
        expect(redo.made).toEqual(["s04"]);
        expect(sent.length).toBe(count + 1);
        expect(redo.story.shots[3]!.keyframe!.url).not.toBe(story.shots[3]!.keyframe!.url);
        // The new keyframe changes shot 5's anchor and shot 4's clip: both show as made from an older request.
        expect(isStale(storyItem(redo.story, "frames", "s05")!)).toBe(true);
        expect(isStale(storyItem(redo.story, "animate", "s04")!)).toBe(true);
        expect(isStale(storyItem(redo.story, "frames", "s06")!)).toBe(false);
    });

    it("marks an edited text's asset as changed and keeps it until it is redone", async () => {
        const { host } = fakeHost();
        let story = (await runStep(host, rainCheck(), "cast")).story;
        story = { ...story, characters: story.characters.map((c) => (c.id === "mae" ? { ...c, look: `${c.look}, red beret` } : c)) };
        const items = storyItems(story, "cast");
        expect(items.map((i) => [i.id, isStale(i)])).toEqual([["theo", false], ["mae", true]]);
        expect(itemsToRun(story, "cast")).toEqual([]);
        expect(itemsToRun(story, "cast", { only: ["mae"], redo: true }).map((i) => i.id)).toEqual(["mae"]);
    });

    it("stops the keyframes at a failure (later shots anchor on it), keeps the old asset on a failed redo", async () => {
        const { host } = fakeHost({ fail: (sent) => (sent.capability === "image.generate" && /picnic|fountain/.test(String(sent.input.description)) ? "The model refused." : null) });
        const cast = (await runStep(host, rainCheck(), "cast")).story;
        const out = await runStep(host, cast, "frames");
        expect(out.made).toEqual(["s01", "s02"]);
        expect(out.failed).toEqual([{ id: "s03", error: "The model refused." }]);
        expect(out.story.shots[3]!.keyframe).toBeUndefined();
        const failing = fakeHost({ fail: () => "Down." });
        const redo = await runStep(failing.host, out.story, "frames", { only: ["s01"], redo: true });
        expect(redo.story.shots[0]!.keyframe).toEqual(out.story.shots[0]!.keyframe);
    });

    it("needs the sheets before keyframes and the keyframe before a clip", async () => {
        const { host, sent } = fakeHost();
        const out = await runStep(host, rainCheck(), "frames");
        expect(out.failed[0]).toEqual({ id: "s01", error: "Draw Theo and Mae first." });
        expect(sent).toEqual([]);
        expect((await runStep(host, rainCheck(), "animate", { only: ["s02"] })).failed).toEqual([{ id: "s02", error: "Draw the keyframe first." }]);
    });

    it("cancels: what runs is cancelled and nothing more starts", async () => {
        const abort = new AbortController();
        let release!: () => void;
        const gate = new Promise<void>((resolve) => (release = resolve));
        const { host, sent } = fakeHost({ wait: () => gate });
        const updates: string[] = [];
        const running = runStep(host, rainCheck(), "music", { signal: abort.signal, onItem: (u) => updates.push(`${u.id}:${u.status}`) });
        await Promise.resolve();
        abort.abort();
        release();
        const out = await running;
        expect(out.cancelled).toBe(true);
        expect(out.made).toEqual([]);
        expect(sent).toHaveLength(1);
        expect(updates).toEqual(["music:queued", "music:running", "music:cancelled"]);
    });
});

describe("estimateStep", () => {
    it("sums the provider's estimates of what a run would make, counting keyframes it draws first as references", async () => {
        const { host } = fakeHost();
        const cast = (await runStep(host, rainCheck(), "cast")).story;
        const frames = await estimateStep(host, cast, "frames");
        expect(frames.ready).toBe(true);
        // Shot 1: two sheets; shots 2-12: their sheets plus the previous keyframe.
        const refs = cast.shots.map((s, i) => s.cast.length + (i > 0 ? 1 : 0));
        expect(frames.microUsd).toBe(refs.reduce((sum, r) => sum + Math.round((0.05 + 0.002 * r) * 1_000_000), 0));
        const animate = await estimateStep(host, cast, "animate");
        expect(animate.ready).toBe(false);
        expect(animate.reason).toBe("Shot 1: Draw the keyframe first.");
    });

    it("is not ready when any price cannot be read, and says when nothing is left to make", async () => {
        const { host } = fakeHost({ price: () => ({ kind: "unknown" }) });
        expect(await estimateStep(host, rainCheck(), "cast")).toMatchObject({ ready: false, reason: "The price could not be read. Try again in a moment." });
        const done = await all(fakeHost().host, rainCheck());
        expect(await estimateStep(host, done, "animate")).toMatchObject({ ready: false, microUsd: 0, reason: "Nothing to make: everything is made." });
    });

    it("prices one redo only", async () => {
        const { host } = fakeHost();
        const done = await all(host, rainCheck());
        const one = await estimateStep(host, done, "animate", { only: ["s03"], redo: true });
        expect(one).toMatchObject({ ready: true, microUsd: 260_000, items: [{ id: "s03" }] });
    });
});

describe("videoModelChoices", () => {
    it("offers the proven models first and only what the provider sells", () => {
        const models = [{ id: "kling-3", label: "Kling 3" }, { id: "kling-o3", label: "Kling O3" }, { id: "seedance-2-mini", label: "Seedance 2 Mini" }];
        expect(videoModelChoices(models).map((m) => m.id)).toEqual(["seedance-2-mini", "kling-o3", "kling-3"]);
        expect(videoModelChoices([{ id: "seedance-2", label: "S2" }]).map((m) => m.id)).toEqual(["seedance-2"]);
    });
});
