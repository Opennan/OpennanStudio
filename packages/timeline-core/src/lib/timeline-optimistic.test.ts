import type { TimelineClip, TimelineData } from "../model/timeline";
import {
  createOptimisticSplitTimelineData,
  optimisticTimelineClipFromInput,
  replaceOptimisticSplitWithServer,
  replacePendingClipsWithCreated,
  sameTimelineContent,
  sanitizeTimelineClipCreateInput,
} from "./timeline-optimistic";

function clip(id: string, partial: Partial<TimelineClip> = {}): TimelineClip {
  return { ...optimisticTimelineClipFromInput({ trackType: "video", trackIndex: 2, startTime: 0, endTime: 10 }, "p1", id), ...partial };
}

function timeline(clips: TimelineClip[]): TimelineData {
  return { tracks: [], clips, canUndo: false, canRedo: false };
}

describe("timeline optimistic helpers", () => {
  it("fills optimistic clip defaults from a create input", () => {
    const c = optimisticTimelineClipFromInput({ startTime: 1 }, "p1", "temp-1");
    expect(c).toMatchObject({ id: "temp-1", projectId: "p1", trackType: "text", trackIndex: 1, startTime: 1, endTime: 5, mediaType: "uploaded", positionX: 0.5, opacity: 1 });
  });

  it("keeps only create-safe fields, including transition params", () => {
    // opacity is a create field (SRC/hooks/use-timeline.ts:345); aiGenerationStatus and id are not (:319-380).
    expect(sanitizeTimelineClipCreateInput({ id: "c9", trackType: "text", startTime: 0, endTime: 1, opacity: 0.2, aiGenerationStatus: "generating", transitionParamsJson: "{}" }))
      .toEqual({ trackType: "text", startTime: 0, endTime: 1, opacity: 0.2, transitionParamsJson: "{}" });
  });

  it("splits a trimmed clip at its speed and moves the outgoing transition to the right half", () => {
    const source = clip("c1", { trimStart: 0, trimEnd: 10, mediaUrl: "/m/v.mp4", mediaType: "video", transitionType: "fade", transitionDuration: 0.5 });
    const result = createOptimisticSplitTimelineData(timeline([source]), ["c1"], 4);
    expect(result).not.toBeNull();
    const [left, right] = result!.timeline.clips;
    expect(left).toMatchObject({ id: "c1", endTime: 4, trimEnd: 4, transitionType: "none" });
    expect(right).toMatchObject({ startTime: 4, trimStart: 4, transitionType: "fade", fadeInDuration: 0 });
    expect(right.id.startsWith("optimistic-split-c1-")).toBe(true);
    expect(result!.createdClips).toEqual([right]);
  });

  it("refuses to split locked clips or within 0.1 s of an edge", () => {
    expect(createOptimisticSplitTimelineData(timeline([clip("c1", { locked: true })]), ["c1"], 4)).toBeNull();
    expect(createOptimisticSplitTimelineData(timeline([clip("c1")]), ["c1"], 0.05)).toBeNull();
  });

  it("replaces temp clips with created clips in place", () => {
    const data = timeline([clip("a"), clip("temp-1")]);
    const out = replacePendingClipsWithCreated(data, ["temp-1"], [clip("server-1")]);
    expect(out.clips.map((c) => c.id)).toEqual(["a", "server-1"]);
  });

  it("swaps optimistic split halves for the server group", () => {
    const split = createOptimisticSplitTimelineData(timeline([clip("c1")]), ["c1"], 4)!;
    const server = [clip("c1", { endTime: 4 }), clip("s2", { startTime: 4 })];
    const out = replaceOptimisticSplitWithServer(split.timeline, ["c1"], split.createdClips, server);
    expect(out.clips.map((c) => c.id)).toEqual(["c1", "s2"]);
  });

  it("detects identical timeline content", () => {
    const data = timeline([clip("a")]);
    expect(sameTimelineContent(data, data.tracks, [clip("a")])).toBe(true);
    expect(sameTimelineContent(data, data.tracks, [clip("b")])).toBe(false);
  });
});

describe("phase 10b clip fields", () => {
    it("keeps animation, speed curve, pitch, sticker, and caption words on create", async () => {
        const { optimisticTimelineClipFromInput, sanitizeTimelineClipCreateInput, normalizeServerTimelineClip } = await import("./timeline-optimistic");
        const input = {
            trackType: "sticker", startTime: 1, endTime: 4, animationJson: '{"in":{"id":"fade_in","duration":0.5}}',
            speedCurveJson: '{"id":"hero","points":[[0,1],[1,1]]}', preservePitch: false, stickerId: "twemoji:1f525",
            captionWordsJson: '[{"start":0,"end":0.5,"text":"hi"}]', unknownKey: 1,
        };
        const clean = sanitizeTimelineClipCreateInput(input);
        expect(clean).not.toHaveProperty("unknownKey");
        const clip = optimisticTimelineClipFromInput(clean, "p", "c1");
        expect(clip.animationJson).toBe(input.animationJson);
        expect(clip.speedCurveJson).toBe(input.speedCurveJson);
        expect(clip.preservePitch).toBe(false);
        expect(clip.stickerId).toBe("twemoji:1f525");
        expect(clip.captionWordsJson).toBe(input.captionWordsJson);
        expect(normalizeServerTimelineClip({ ...clean, id: "c1", projectId: "p" }).stickerId).toBe("twemoji:1f525");
    });

    it("leaves older clips without the new keys", async () => {
        const { optimisticTimelineClipFromInput } = await import("./timeline-optimistic");
        const clip = optimisticTimelineClipFromInput({ trackType: "text", startTime: 0, endTime: 1 }, "p", "c");
        for (const key of ["animationJson", "speedCurveJson", "preservePitch", "stickerId", "captionWordsJson"]) expect(clip).not.toHaveProperty(key);
    });
});

describe("caption words on split", () => {
    const words = (json: string | null) => (json === null ? null : JSON.parse(json));

    it("splits words at the cut, re-basing the right half to its own start", async () => {
        const { splitClipCaptionWordsJson } = await import("./timeline-optimistic");
        const json = JSON.stringify([
            { start: 0, end: 0.5, text: "one" },
            // 0.1 s before the cut, 0.3 s after: the right half holds most of it.
            { start: 0.9, end: 1.3, text: "two" },
            { start: 1.4, end: 2, text: "three" },
        ]);
        const [left, right] = splitClipCaptionWordsJson(json, 1);
        expect(words(left)).toEqual([{ start: 0, end: 0.5, text: "one" }]);
        expect(words(right)).toEqual([{ start: 0, end: 0.3, text: "two" }, { start: 0.4, end: 1, text: "three" }]);
    });

    it("gives a straddling word to the side holding most of it, ties to the left", async () => {
        const { splitClipCaptionWordsJson } = await import("./timeline-optimistic");
        const [left, right] = splitClipCaptionWordsJson(JSON.stringify([{ start: 0.7, end: 1.1, text: "a" }, { start: 1.2, end: 1.4, text: "b" }]), 1);
        expect(words(left)).toEqual([{ start: 0.7, end: 1, text: "a" }]);
        expect(words(right)).toEqual([{ start: 0.2, end: 0.4, text: "b" }]);
        const [tieLeft, tieRight] = splitClipCaptionWordsJson(JSON.stringify([{ start: 0.8, end: 1.2, text: "tie" }]), 1);
        expect(words(tieLeft)).toEqual([{ start: 0.8, end: 1, text: "tie" }]);
        expect(tieRight).toBeNull();
    });

    it("returns null for an empty side and passes unreadable JSON through", async () => {
        const { splitClipCaptionWordsJson } = await import("./timeline-optimistic");
        expect(splitClipCaptionWordsJson(null, 1)).toEqual([null, null]);
        expect(splitClipCaptionWordsJson(undefined, 1)).toEqual([null, null]);
        const [left, right] = splitClipCaptionWordsJson(JSON.stringify([{ start: 2, end: 3, text: "late" }, { start: "x", end: 3, text: "bad" }]), 1);
        expect(left).toBeNull();
        expect(words(right)).toEqual([{ start: 1, end: 2, text: "late" }]);
        expect(splitClipCaptionWordsJson("{bad", 1)).toEqual(["{bad", "{bad"]);
        expect(splitClipCaptionWordsJson('{"a":1}', 1)).toEqual(['{"a":1}', '{"a":1}']);
    });

    it("splits a caption clip's words with the clip, and leaves clips without words alone", () => {
        const json = JSON.stringify([{ start: 0.2, end: 1, text: "Hello" }, { start: 2.5, end: 3.5, text: "there" }]);
        const caption = optimisticTimelineClipFromInput({ trackType: "text", trackIndex: 1, startTime: 10, endTime: 14, textContent: "Hello there", captionWordsJson: json }, "p1", "t1");
        const split = createOptimisticSplitTimelineData(timeline([caption]), ["t1"], 12)!;
        const [left, right] = split.timeline.clips;
        expect(words(left.captionWordsJson ?? null)).toEqual([{ start: 0.2, end: 1, text: "Hello" }]);
        expect(words(right.captionWordsJson ?? null)).toEqual([{ start: 0.5, end: 1.5, text: "there" }]);
        const plain = createOptimisticSplitTimelineData(timeline([clip("c1")]), ["c1"], 4)!;
        for (const half of plain.timeline.clips) expect(half).not.toHaveProperty("captionWordsJson");
    });
});

describe("splitting caption clips with word timings", () => {
    it("splits the text with the words so each half keeps exact karaoke timings", async () => {
        const { createOptimisticSplitClip, optimisticTimelineClipFromInput } = await import("./timeline-optimistic");
        const clip = optimisticTimelineClipFromInput({
            trackType: "text", startTime: 10, endTime: 12, textContent: "Hello big world",
            captionWordsJson: JSON.stringify([{ start: 0, end: 0.5, text: "Hello" }, { start: 0.6, end: 1, text: "big" }, { start: 1.2, end: 1.8, text: "world" }]),
        }, "p", "c");
        const split = createOptimisticSplitClip(clip, 11.1, 0)!;
        expect(split.left.textContent).toBe("Hello big");
        expect(split.right.textContent).toBe("world");
        expect(JSON.parse(split.right.captionWordsJson!)[0]).toEqual({ start: 0.1, end: 0.7, text: "world" });
    });

    it("keeps the full text when the words no longer match it", async () => {
        const { createOptimisticSplitClip, optimisticTimelineClipFromInput } = await import("./timeline-optimistic");
        const clip = optimisticTimelineClipFromInput({
            trackType: "text", startTime: 0, endTime: 2, textContent: "Edited text",
            captionWordsJson: JSON.stringify([{ start: 0, end: 0.5, text: "Hello" }, { start: 1.2, end: 1.8, text: "world" }]),
        }, "p", "c");
        const split = createOptimisticSplitClip(clip, 1, 0)!;
        expect(split.left.textContent).toBe("Edited text");
        expect(split.right.textContent).toBe("Edited text");
    });
});

describe("phase 10c mask field", () => {
    const maskJson = '{"shape":"circle","x":0.5,"y":0.5,"width":0.6,"height":0.6,"rotation":0,"feather":0,"roundness":0,"invert":false}';

    it("keeps maskJson on create, in optimistic clips, and from the server; older clips stay without it", async () => {
        const { optimisticTimelineClipFromInput, sanitizeTimelineClipCreateInput, normalizeServerTimelineClip } = await import("./timeline-optimistic");
        const clean = sanitizeTimelineClipCreateInput({ trackType: "video", trackIndex: 2, startTime: 0, endTime: 2, maskJson });
        expect(clean.maskJson).toBe(maskJson);
        expect(optimisticTimelineClipFromInput(clean, "p", "c").maskJson).toBe(maskJson);
        expect(normalizeServerTimelineClip({ ...clean, id: "c", projectId: "p" }).maskJson).toBe(maskJson);
        expect(optimisticTimelineClipFromInput({ trackType: "video", startTime: 0, endTime: 1 }, "p", "c")).not.toHaveProperty("maskJson");
    });

    it("split halves both keep the mask; duplicates copy it", async () => {
        const { createClipInput } = await import("./timeline-editing-properties");
        const source = clip("c1", { maskJson });
        const result = createOptimisticSplitTimelineData(timeline([source]), ["c1"], 4)!;
        expect(result.timeline.clips.map((c) => c.maskJson)).toEqual([maskJson, maskJson]);
        expect(createClipInput(source as never).maskJson).toBe(maskJson);
    });
});

describe("splitting media clips writes each half's source range", () => {
    it("an untrimmed video clip gets trims from media zero (the right half starts where the left ends)", async () => {
        const { createOptimisticSplitClip, optimisticTimelineClipFromInput } = await import("./timeline-optimistic");
        const clip = optimisticTimelineClipFromInput({ trackType: "video", trackIndex: 2, startTime: 1, endTime: 5, mediaUrl: "/m/v.mp4", mediaType: "video" }, "p", "c");
        expect(clip.trimStart).toBeNull();
        const split = createOptimisticSplitClip(clip, 2.5, 0)!;
        expect([split.left.trimStart, split.left.trimEnd]).toEqual([0, 1.5]);
        expect([split.right.trimStart, split.right.trimEnd]).toEqual([1.5, 4]);
    });

    it("follows the clip's constant speed and keeps an existing trimStart", async () => {
        const { createOptimisticSplitClip, optimisticTimelineClipFromInput } = await import("./timeline-optimistic");
        const clip = optimisticTimelineClipFromInput({ trackType: "audio", trackIndex: 1, startTime: 0, endTime: 4, mediaUrl: "/m/a.mp3", mediaType: "audio", playbackSpeed: 2, trimStart: 1 }, "p", "c");
        const split = createOptimisticSplitClip(clip, 1, 0)!;
        expect([split.left.trimStart, split.left.trimEnd]).toEqual([1, 3]);
        expect([split.right.trimStart, split.right.trimEnd]).toEqual([3, 9]);
    });

    it("images and text keep null trims", async () => {
        const { createOptimisticSplitClip, optimisticTimelineClipFromInput } = await import("./timeline-optimistic");
        const image = optimisticTimelineClipFromInput({ trackType: "video", trackIndex: 2, startTime: 0, endTime: 4, mediaUrl: "/m/a.png", mediaType: "image" }, "p", "c");
        expect(createOptimisticSplitClip(image, 2, 0)!.right.trimStart).toBeNull();
        const text = optimisticTimelineClipFromInput({ trackType: "text", startTime: 0, endTime: 4, textContent: "Hi" }, "p", "t");
        expect(createOptimisticSplitClip(text, 2, 0)!.right.trimStart).toBeNull();
    });
});

describe("split trims agree with opennan.com (phase 11.1: the server's split rule)", () => {
    // The server's example clip: start 10, end 16 (span 6), trimStart 2, speed 2, split at 12 (2 s into the clip).
    async function split(partial: Partial<TimelineClip>, at = 12) {
        const { createOptimisticSplitClip, optimisticTimelineClipFromInput } = await import("./timeline-optimistic");
        const source = { ...optimisticTimelineClipFromInput({ trackType: "video", trackIndex: 2, startTime: 10, endTime: 16, mediaUrl: "/m/v.mp4", mediaType: "video", playbackSpeed: 2, trimStart: 2 }, "p", "c"), ...partial };
        const halves = createOptimisticSplitClip(source, at, 0)!;
        return [[halves.left.trimStart, halves.left.trimEnd], [halves.right.trimStart, halves.right.trimEnd]];
    }

    it("never reads trimEnd for the range: a stale out-point (an edge drag at speed 2) splits from the in-point at the speed", async () => {
        expect(await split({ trimEnd: 14 })).toEqual([[2, 6], [6, 14]]);
        expect(await split({ trimEnd: null })).toEqual([[2, 6], [6, 14]]);
        expect(await split({ trimEnd: 10 })).toEqual([[2, 6], [6, 14]]);
    });

    it("a reversed clip gives its first half the end of the range", async () => {
        expect(await split({ reversePlayback: true, trimEnd: 14 })).toEqual([[10, 14], [2, 10]]);
        expect(await split({ reversePlayback: true, trimEnd: null })).toEqual([[10, 14], [2, 10]]);
    });

    it("a frozen frame, a still, and text keep their trims on both halves", async () => {
        expect(await split({ freezeFrame: true, trimEnd: 14 })).toEqual([[2, 14], [2, 14]]);
        expect(await split({ mediaType: "image", mediaUrl: "/m/a.png", trimStart: 1, trimEnd: 3 })).toEqual([[1, 3], [1, 3]]);
        expect(await split({ trackType: "text", mediaUrl: null, mediaType: "uploaded", trimStart: 1, trimEnd: 3 })).toEqual([[1, 3], [1, 3]]);
    });

    it("degenerate trims split from the in-point; trims round to the microsecond like the server", async () => {
        expect(await split({ playbackSpeed: 1, trimStart: 0, trimEnd: 0 })).toEqual([[0, 2], [2, 6]]);
        expect(await split({ playbackSpeed: 1 / 3, trimStart: 0, trimEnd: null }, 11)).toEqual([[0, 0.333333], [0.333333, 2]]);
    });

    it("a speed ramp or curve splits where Studio plays it (its source-time map), not at the base speed the server uses", async () => {
        const { clipSpeedProfile, sourceSpan, sourceTimeAt } = await import("../motion/speed");
        const ramp = { playbackSpeed: 1, speedRamp: "hero", trimEnd: null };
        const profile = clipSpeedProfile(ramp as never);
        const cut = Math.round((2 + sourceTimeAt(profile, 2, 6)) * 1e6) / 1e6;
        const out = Math.round((2 + sourceSpan(profile, 6)) * 1e6) / 1e6;
        expect(await split(ramp)).toEqual([[2, cut], [cut, out]]);
        expect(cut).not.toBe(4);
    });

    it("a NaN trimStart counts as media zero", async () => {
        expect(await split({ trimStart: Number.NaN, trimEnd: null })).toEqual([[0, 4], [4, 12]]);
    });

    it("an animated GIF splits its range like a video (the server trims GIFs; only png, jpg and webp are stills)", async () => {
        expect(await split({ mediaUrl: "/m/loop.gif", mediaType: "video", trimEnd: null })).toEqual([[2, 6], [6, 14]]);
    });

    it("a reversed cut is worked out from the unrounded out-point, like the server", async () => {
        expect(await split({ reversePlayback: true, playbackSpeed: 1 / 3, trimStart: 0.1234567, trimEnd: null }, 11)).toEqual([[1.790123, 2.123457], [0.123457, 1.790123]]);
    });
});

