// The story film pipeline on a fake host: what it sends, what it skips, what it stores, redo, failures, cancel, prices,
// and the cast check after each keyframe (pass, a redraw that fixes it, a shot flagged after its last try, off).
import type { PriceAnswer, PriceUnits } from "@opennan/provider-sdk";
import { storyProgress } from "./edit";
import {
    estimateCastCheck, estimateStep, isFlagged, isStale, itemsToRun, runStep, storyItem, storyItems, videoModelChoices, type StoryFilmHost, type StoryRunResult,
} from "./pipeline";
import { rainCheck } from "./test-story";
import type { StoryFilm } from "./types";
import { readStoryJson, storyJson } from "./validate";

interface Sent {
    capability: string;
    input: Record<string, unknown>;
}

/** A look's answer: the characters that do not match and why (default: every one matches), or a reply that does not read. */
type Look = Record<string, string> | "garbage";

function fakeHost(options: {
    fail?: (sent: Sent, n: number) => string | null;
    wait?: () => Promise<void>;
    price?: (capability: string, input: Record<string, unknown>, units: PriceUnits) => PriceAnswer;
    /** The cast check's answer for the shot whose keyframe prompt this look follows (`look`: 1 for the first look at it). */
    look?: (frame: string, look: number) => Look;
} = {}) {
    const sent: Sent[] = [];
    let n = 0;
    let lastFrame = "";
    const looks = new Map<string, number>();
    const host: StoryFilmHost = {
        async run(capability, input, { signal }): Promise<StoryRunResult> {
            const call = { capability, input };
            sent.push(call);
            n += 1;
            await options.wait?.();
            if (signal?.aborted) return { ok: false, error: "Cancelled.", cancelled: true };
            const error = options.fail?.(call, n);
            if (error) return { ok: false, error };
            if (capability === "image.generate") lastFrame = String(input.description);
            if (capability === "text.generate") {
                // A look at the keyframe drawn last: the ids it lists, answered as the test says.
                const ids = [...String(input.prompt).matchAll(/^- ([a-z0-9_-]+) \(image/gm)].map((m) => m[1]!);
                const key = lastFrame.replace(/ Most important:.*$/s, "");
                looks.set(key, (looks.get(key) ?? 0) + 1);
                const answer = options.look?.(key, looks.get(key)!) ?? {};
                const text = answer === "garbage" ? "They look about right to me." : JSON.stringify({ characters: ids.map((id) => ({ id, match: !(id in answer), reason: answer[id] ?? "" })) });
                return { ok: true, media: [], result: { text }, costUsd: 0.003 };
            }
            const kind = capability === "image.generate" ? "png" : capability === "audio.music" ? "mp3" : "mp4";
            return { ok: true, media: [{ url: `opennan-local://media/${n}.${kind}`, ...(kind === "png" ? { width: 2752, height: 1536 } : {}) }], costUsd: kind === "mp4" ? 0.26 : 0.05 };
        },
        async price(capability, input, units) {
            if (options.price) return options.price(capability, input, units);
            const usd = capability === "video.image-to-video" ? 0.26 : capability === "audio.music" ? 0.02 : capability === "text.generate" ? 0.004 : 0.05 + 0.002 * (units.images ?? 0);
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
        const drawn = sent.filter((s) => s.capability === "image.generate");
        const [theo, mae] = cast.characters.map((c) => ({ mediaUrl: c.sheet!.url }));
        expect(drawn[0]!.input).toMatchObject({ image: theo, images: [mae] });
        expect(drawn[0]!.input.description).not.toMatch(/previous shot/);
        // Shot 2 anchors on shot 1's keyframe; shot 6 (Mae alone) sends her sheet and shot 5's keyframe.
        expect(drawn[1]!.input).toMatchObject({ image: theo, images: [mae, { mediaUrl: out.story.shots[0]!.keyframe!.url }] });
        expect(drawn[5]!.input).toMatchObject({ image: mae, images: [{ mediaUrl: out.story.shots[4]!.keyframe!.url }] });
        expect(drawn[1]!.input.description).toMatch(/Match the art style, line weight and colour palette of the last reference image/);
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
        // Sheets, keyframes and one passing look at each, clips, music.
        expect(count).toBe(2 + 12 + 12 + 12 + 1);
        for (const step of ["cast", "frames", "animate", "music"] as const) expect((await runStep(host, story, step)).made).toEqual([]);
        expect(sent.length).toBe(count);
        const redo = await runStep(host, story, "frames", { only: ["s04"], redo: true });
        expect(redo.made).toEqual(["s04"]);
        expect(sent.slice(count).map((s) => s.capability)).toEqual(["image.generate", "text.generate"]);
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
        const frames = await estimateStep(host, cast, "frames", { castCheck: 0 });
        expect(frames.ready).toBe(true);
        expect(frames.checkMicroUsd).toBeUndefined();
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

describe("cast check", () => {
    const sheets = async (host: StoryFilmHost) => (await runStep(host, rainCheck(), "cast")).story;
    /** s09: Mae in a close-up two-shot (the shot that lost her ponytail in the prototype). */
    const isS09 = (frame: string) => frame.includes("Close-up two-shot in the rain");
    const LOST = { mae: "her hair is short and loose, no chestnut ponytail" };

    it("looks at each new keyframe once with the shot's sheets and keeps it when the cast matches", async () => {
        const { host, sent } = fakeHost();
        const cast = await sheets(host);
        sent.length = 0;
        const out = await runStep(host, cast, "frames");
        expect(out).toMatchObject({ made: expect.any(Array), redrawn: [], flagged: [] });
        expect(sent.map((s) => s.capability)).toEqual(Array.from({ length: 24 }, (_, i) => (i % 2 === 0 ? "image.generate" : "text.generate")));
        const look = sent[1]!.input;
        // The keyframe first, then the cast's sheets in cast order; strict JSON, a small output cap.
        expect(look.images).toEqual([{ mediaUrl: out.story.shots[0]!.keyframe!.url }, ...cast.characters.map((c) => ({ mediaUrl: c.sheet!.url }))]);
        expect(look.instruction).toMatch(/hair \(style and colour\), the same outfit and the same colours/);
        expect(look.instruction).toMatch(/Answer with one JSON object and nothing else/);
        expect(look.prompt).toBe("Characters to check:\n- theo (image 2): Theo. Look: " + cast.characters[0]!.look + "\n- mae (image 3): Mae. Look: " + cast.characters[1]!.look);
        expect(look.maxTokens).toBe(1000);
        expect(out.story.shots[0]!.check).toMatchObject({ keyframeUrl: out.story.shots[0]!.keyframe!.url, ok: true, tries: 1, misses: [], costUsd: 0.003 });
        expect(out.story.shots.some(isFlagged)).toBe(false);
        // 12 keyframes at $0.05 and 12 looks at $0.003 on top of the sheets.
        expect(out.spentUsd).toBe(0.636);
        expect(out.story.spentUsd).toBe(0.736);
    });

    it("redraws a keyframe whose character is off their sheet once, with the look restated, then keeps the one that matches", async () => {
        const { host, sent } = fakeHost({ look: (frame, n) => (isS09(frame) && n === 1 ? LOST : {}) });
        const cast = await sheets(host);
        const out = await runStep(host, cast, "frames");
        expect(out.redrawn).toEqual(["s09"]);
        expect(out.flagged).toEqual([]);
        const s09 = out.story.shots[8]!;
        expect(s09.check).toMatchObject({ ok: true, tries: 2, misses: [], costUsd: 0.006 });
        const draws = sent.filter((s) => s.capability === "image.generate" && isS09(String(s.input.description)));
        expect(draws).toHaveLength(2);
        // The redraw is the same request (same references) with Mae's look restated first and what was wrong.
        const [first, again] = draws.map((d) => d.input);
        expect({ ...again, description: undefined }).toEqual({ ...first, description: undefined });
        expect(again!.description).toBe(`${first!.description} Most important: Mae must look exactly like reference image 2: ${cast.characters[1]!.look}. Same hair, same outfit, same colours. The last drawing got this wrong: ${LOST.mae}`);
        // The redrawn keyframe is the shot's (made from the shot's request, not "changed"), and shot 10 anchors on it.
        expect(isStale(storyItem(out.story, "frames", "s09")!)).toBe(false);
        const s10 = sent.filter((s) => s.capability === "image.generate" && (s.input.images as unknown[] | undefined)?.some((i) => (i as { mediaUrl?: string }).mediaUrl === s09.keyframe!.url));
        expect(s10).toHaveLength(1);
        // Both drawings and both looks are paid for.
        expect(out.spentUsd).toBe(Math.round((13 * 0.05 + 13 * 0.003) * 1e6) / 1e6);
    });

    it("flags a shot still off after its last redraw: the frame stays, the shot says check it, nothing loops", async () => {
        const { host, sent } = fakeHost({ look: (frame) => (isS09(frame) ? LOST : {}) });
        const cast = await sheets(host);
        sent.length = 0;
        const out = await runStep(host, cast, "frames");
        expect(out.made).toHaveLength(12);
        expect(out.redrawn).toEqual(["s09"]);
        expect(out.flagged).toEqual([{ id: "s09", misses: [{ id: "mae", reason: LOST.mae }] }]);
        expect(sent.filter((s) => s.capability === "image.generate")).toHaveLength(13);
        expect(sent.filter((s) => s.capability === "text.generate")).toHaveLength(13);
        const s09 = out.story.shots[8]!;
        expect(s09.keyframe).toBeTruthy();
        expect(s09.check).toMatchObject({ keyframeUrl: s09.keyframe!.url, ok: false, tries: 2, misses: [{ id: "mae", reason: LOST.mae }] });
        expect(isFlagged(s09)).toBe(true);
        expect(storyProgress(out.story).find((p) => p.step === "frames")!.flagged).toEqual(["s09"]);
        // Two redraws when the option allows them.
        const two = fakeHost({ look: (frame) => (isS09(frame) ? LOST : {}) });
        const twice = await runStep(two.host, await sheets(two.host), "frames", { castCheck: 2 });
        expect(twice.story.shots[8]!.check).toMatchObject({ ok: false, tries: 3 });
        // The flag stays on the story, and a redo of the shot (a new keyframe) starts unchecked, then is looked at.
        const stored = readStoryJson(storyJson(out.story))!;
        expect(isFlagged(stored.shots[8]!)).toBe(true);
        const fixed = await runStep(fakeHost().host, stored, "frames", { only: ["s09"], redo: true });
        expect(fixed.story.shots[8]!.check).toMatchObject({ ok: true, tries: 1 });
    });

    it("never redraws on an answer that does not read: the shot is kept and flagged as unchecked", async () => {
        const { host, sent } = fakeHost({ look: (frame) => (isS09(frame) ? "garbage" : {}) });
        const out = await runStep(host, await sheets(host), "frames");
        expect(out.redrawn).toEqual([]);
        expect(out.flagged).toEqual([{ id: "s09", misses: [], unread: true }]);
        expect(out.story.shots[8]!.check).toMatchObject({ ok: false, unread: true, tries: 1 });
        expect(sent.filter((s) => s.capability === "image.generate")).toHaveLength(2 + 12);
    });

    it("turned off (castCheck 0): no look, no check on the story, the estimate is the keyframes alone", async () => {
        const { host, sent } = fakeHost({ look: () => LOST });
        const cast = await sheets(host);
        sent.length = 0;
        const out = await runStep(host, cast, "frames", { castCheck: 0 });
        expect(sent.every((s) => s.capability === "image.generate")).toBe(true);
        expect(sent).toHaveLength(12);
        expect(out.story.shots.every((s) => s.check === undefined)).toBe(true);
        expect(out.redrawn).toEqual([]);
    });

    it("a re-run pays for no look again: checks are stored with their keyframes", async () => {
        const { host, sent } = fakeHost();
        const done = (await runStep(host, await sheets(host), "frames")).story;
        const count = sent.length;
        expect((await runStep(host, readStoryJson(storyJson(done))!, "frames")).made).toEqual([]);
        expect(sent).toHaveLength(count);
        // A check about another keyframe never reads back.
        const moved = { ...done, shots: done.shots.map((s, i) => (i === 0 ? { ...s, keyframe: { ...s.keyframe!, url: "opennan-local://media/other.png" } } : s)) };
        expect(readStoryJson(storyJson(moved))!.shots[0]!.check).toBeUndefined();
    });

    it("counts every look and the worst-case redraw at its image price in the estimate, and never runs unpriced", async () => {
        const { host } = fakeHost();
        const cast = await sheets(host);
        const bare = await estimateStep(host, cast, "frames", { castCheck: 0 });
        const checked = await estimateStep(host, cast, "frames");
        const twice = await estimateStep(host, cast, "frames", { castCheck: 2 });
        // Each shot: its keyframe plus one redraw at the same price, and two looks at $0.004.
        expect(checked.microUsd).toBe(bare.microUsd * 2 + 12 * 2 * 4_000);
        expect(twice.microUsd).toBe(bare.microUsd * 3 + 12 * 3 * 4_000);
        expect(checked.checkMicroUsd).toBe(4_000);
        expect(checked.holdUsd).toBeCloseTo(bare.holdUsd * 2 + 12 * 2 * 0.004, 6);
        expect(await estimateCastCheck(host, rainCheck())).toMatchObject({ kind: "estimate", estimate: { microUsd: 4_000 } });
        // Never under: the worst run (every shot off twice) costs no more than the estimate.
        const worst = fakeHost({ look: () => LOST });
        const ran = await runStep(worst.host, await sheets(worst.host), "frames");
        expect(ran.redrawn).toHaveLength(12);
        expect(Math.round(ran.spentUsd * 1e6)).toBeLessThanOrEqual(checked.microUsd);
        // A look without a price stops the step before anything is sent.
        const unpriced = fakeHost({ price: (capability) => (capability === "text.generate" ? { kind: "unknown" } : { kind: "estimate", estimate: { microUsd: 50_000, usd: 0.05, label: "≈ $0.050", units: 1, capped: false } }) });
        const refused = await estimateStep(unpriced.host, cast, "frames");
        expect(refused).toMatchObject({ ready: false, reason: "Cast check: The price could not be read. Try again in a moment. Turn the check off to draw without it." });
        expect((await estimateStep(unpriced.host, cast, "frames", { castCheck: 0 })).ready).toBe(true);
    });
});

describe("videoModelChoices", () => {
    it("offers the proven models first and only what the provider sells", () => {
        const models = [{ id: "kling-3", label: "Kling 3" }, { id: "kling-o3", label: "Kling O3" }, { id: "seedance-2-mini", label: "Seedance 2 Mini" }];
        expect(videoModelChoices(models).map((m) => m.id)).toEqual(["seedance-2-mini", "kling-o3", "kling-3"]);
        expect(videoModelChoices([{ id: "seedance-2", label: "S2" }]).map((m) => m.id)).toEqual(["seedance-2"]);
    });
});
