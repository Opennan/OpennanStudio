import { optimisticTimelineClipFromInput } from "@opennan/timeline-core/lib/timeline-optimistic";
import { textStatePlan } from "@opennan/timeline-core/text/text-states";
import { resolveOutputFormat } from "../presets";
import { MAX_STICKER_SIDE, isBundledSticker, isEmojiSticker, planRasterJobs, stickerJobId } from "./jobs";

const clip = (id: string, input: Record<string, unknown>) => optimisticTimelineClipFromInput(input, "p", id);
const format = resolveOutputFormat("16:9", "720p");

describe("planRasterJobs: text states", () => {
    it("adds the state list to text jobs whose animation changes pixels", () => {
        const animated = clip("t", { trackType: "text", textContent: "Hello", startTime: 0, endTime: 3, animationJson: JSON.stringify({ in: { id: "typewriter", duration: 1 } }) });
        const [job] = planRasterJobs([animated], format);
        expect(job).toMatchObject({ kind: "text", id: "text-t", text: "Hello" });
        expect(job.kind === "text" && job.states).toEqual(textStatePlan(animated).states);
    });

    it("keeps today's job (no states key) for static and transform-only text", () => {
        for (const animationJson of [null, JSON.stringify({ in: { id: "fade", duration: 0.5 } })]) {
            const [job] = planRasterJobs([clip("t", { trackType: "text", textContent: "Hi", animationJson })], format);
            expect(job).toEqual({ kind: "text", id: "text-t", clipId: "t", text: "Hi", textStyle: null, scale: 1, frameScale: format.frameScale, frameWidth: 1280 });
        }
    });

    it("draws text whose animation grows it at the peak scale, wrapping exactly as at its layout scale", () => {
        // pulse peaks at 1 + 0.03·2 at half a period; the wrap width grows with the font, so the lines stay the same.
        const pulsing = clip("t", { trackType: "text", textContent: "Hi", startTime: 0, endTime: 3, scale: 1.5, animationJson: JSON.stringify({ loop: { id: "pulse", period: 1 } }) });
        const [job] = planRasterJobs([pulsing], format);
        expect(job.kind === "text" && job.scale).toBeCloseTo(1.5 * 1.06, 12);
        expect(job.kind === "text" && job.frameWidth).toBeCloseTo(1280 * 1.06, 9);
        // Keyframed scale keeps the 10a reference (its peak is also the layout scale): the wrap width is the frame's.
        const keyed = clip("k", { trackType: "text", textContent: "Hi", startTime: 0, endTime: 2, keyframesJson: JSON.stringify([{ time: 0, scale: 0.5 }, { time: 2, scale: 2 }]) });
        expect(planRasterJobs([keyed], format)[0]).toMatchObject({ scale: 2, frameWidth: 1280 });
    });

    it("sizes bundled sticker bitmaps for the animation's largest scale", () => {
        const zoom = clip("s", { trackType: "sticker", stickerId: "opennan:arrow-right", startTime: 0, endTime: 2, animationJson: JSON.stringify({ in: { id: "zoom_out", duration: 0.5 } }) });
        const plain = clip("p", { trackType: "sticker", stickerId: "opennan:arrow-right", startTime: 0, endTime: 2 });
        const [a, b] = planRasterJobs([zoom, plain], format);
        // zoom_out starts at 1.6× and settles at 1×.
        if (a.kind !== "sticker" || b.kind !== "sticker") throw new Error("expected sticker jobs");
        expect(a.scale).toBeCloseTo(1.6, 12);
        expect(b.scale).toBe(1);
        expect(a.width).toBe(Math.round(b.width * 1.6));
    });

    it("carries karaoke states built from stored word timings", () => {
        const karaoke = clip("k", {
            trackType: "text", textContent: "one two", startTime: 0, endTime: 2,
            textStyle: JSON.stringify({ karaoke: "highlight", highlightColor: "#ff0" }),
            captionWordsJson: JSON.stringify([{ start: 0, end: 1, text: "one" }, { start: 1, end: 2, text: "two" }]),
        });
        const [job] = planRasterJobs([karaoke], format);
        expect(job.kind === "text" && job.states).toEqual([{ kind: "full" }, { kind: "karaoke", word: 0 }, { kind: "karaoke", word: 1 }]);
    });
});

describe("planRasterJobs: bundled stickers", () => {
    it("recognises sticker clips with a catalog id (not emoji, not media)", () => {
        const bundled = clip("s", { trackType: "sticker", stickerId: "opennan:arrow-right", textContent: "→" });
        expect(isBundledSticker(bundled)).toBe(true);
        expect(isEmojiSticker(bundled)).toBe(false);
        expect(isBundledSticker(clip("u", { trackType: "sticker", stickerId: "opennan:nope" }))).toBe(false);
        expect(isBundledSticker(clip("v", { trackType: "video", stickerId: "opennan:arrow-right" }))).toBe(false);
        expect(isEmojiSticker(clip("e", { trackType: "sticker", textContent: "★" }))).toBe(true);
    });

    it("draws the SVG at the sticker box times the largest scale the clip reaches", () => {
        const jobs = planRasterJobs([
            clip("s", { trackType: "sticker", stickerId: "opennan:arrow-right", scale: 0.5 }),
            clip("k", { trackType: "sticker", stickerId: "twemoji:1f525", scale: 1, keyframesJson: JSON.stringify([{ time: 0, scale: 1 }, { time: 1, scale: 3 }]) }),
        ], format);
        // 720p 16:9: the 240×140 reference box is two thirds as large.
        expect(jobs).toEqual([
            { kind: "sticker", id: stickerJobId("s"), clipId: "s", stickerId: "opennan:arrow-right", scale: 0.5, width: 80, height: 47 },
            { kind: "sticker", id: stickerJobId("k"), clipId: "k", stickerId: "twemoji:1f525", scale: 3, width: 480, height: 480 },
        ]);
    });

    it("caps the bitmap's longest side and keeps the aspect ratio", () => {
        const [job] = planRasterJobs([clip("s", { trackType: "sticker", stickerId: "opennan:arrow-right", scale: 40 })], resolveOutputFormat("16:9", "4k"));
        expect(job).toMatchObject({ kind: "sticker", scale: 40, width: MAX_STICKER_SIDE, height: Math.round((MAX_STICKER_SIDE * 140) / 240) });
        expect(MAX_STICKER_SIDE).toBe(2048);
    });

    it("leaves unknown sticker ids and image stickers to the other paths", () => {
        expect(planRasterJobs([
            clip("u", { trackType: "sticker", stickerId: "opennan:nope" }),
            clip("img", { trackType: "sticker", mediaUrl: "/s.png" }),
        ], format)).toEqual([]);
    });
});
