import { parsePreviewTextStyle } from "../lib/preview-text-draw";
import { getTimelineCaptionPosition, getTimelineTextClipKind, parseTimelineTextStyle } from "../lib/timeline-text-style";
import { fontByFamily, primaryFontFamily } from "./fonts";
import { CAPTION_STYLES, captionStyleById, captionStyleJson, captionWords } from "./captions";

describe("caption styles", () => {
    it("has the eight catalog styles", () => {
        expect(CAPTION_STYLES.map((s) => s.id)).toEqual(["classic", "pill", "bold_yellow", "boxed", "neon", "minimal", "karaoke_highlight", "karaoke_box"]);
        expect(captionStyleById("nope")).toBeUndefined();
    });

    it("are caption-kind styles at the bottom using bundled fonts", () => {
        for (const entry of CAPTION_STYLES) {
            const json = JSON.stringify(entry.style);
            expect(getTimelineTextClipKind(json), entry.id).toBe("caption");
            expect(getTimelineCaptionPosition(json), entry.id).toBe("bottom");
            expect(fontByFamily(primaryFontFamily(String(entry.style.fontFamily))), entry.id).toBeDefined();
        }
    });

    it("karaoke styles set karaoke and a highlight colour", () => {
        expect(parsePreviewTextStyle(JSON.stringify(captionStyleById("karaoke_highlight")!.style))).toMatchObject({ karaoke: "highlight" });
        expect(parsePreviewTextStyle(JSON.stringify(captionStyleById("karaoke_box")!.style))).toMatchObject({ karaoke: "box" });
        for (const id of ["karaoke_highlight", "karaoke_box"]) expect(parsePreviewTextStyle(JSON.stringify(captionStyleById(id)!.style)).highlightColor).not.toBe("");
        expect(CAPTION_STYLES.filter((s) => s.style.karaoke).map((s) => s.id)).toEqual(["karaoke_highlight", "karaoke_box"]);
        expect(CAPTION_STYLES.find((s) => s.id === "karaoke_box")!.karaoke).toBe(true);
    });

    it("classic is the pre-10b caption preset look", () => {
        expect(captionStyleById("classic")!.style).toMatchObject({ fontSize: 56, bgColor: "rgba(0,0,0,0.62)", shadowBlur: 4 });
    });

    it("keeps the prior position, wrapping, and subtitle kind", () => {
        const prior = JSON.stringify({ captionKind: "subtitle", textClipKind: "subtitle", captionPosition: "top", wordsPerLine: "single", maxWidthRatio: 0.6 });
        expect(parseTimelineTextStyle(captionStyleJson("neon", prior))).toMatchObject({ captionKind: "subtitle", textClipKind: "subtitle", captionPosition: "top", wordsPerLine: "single", maxWidthRatio: 0.6 });
        expect(parseTimelineTextStyle(captionStyleJson("neon", JSON.stringify({ captionPosition: "center" })))).toMatchObject({ captionKind: "caption", captionPosition: "center" });
        expect(captionStyleJson("missing")).toBeNull();
    });
});

describe("captionWords", () => {
    const clip = (textContent: string, words: unknown, start = 10, end = 12) => ({
        textContent, captionWordsJson: words === null ? null : JSON.stringify(words), startTime: start, endTime: end,
    });

    it("uses stored words when the normalized text matches", () => {
        const words = [{ start: 0.1, end: 0.5, text: " hello," }, { start: 0.6, end: 1.2, text: "WORLD" }];
        expect(captionWords(clip("Hello world!", words))).toEqual([
            { start: 0.1, end: 0.5, text: "Hello" },
            { start: 0.6, end: 1.2, text: "world!" },
        ]);
    });

    it("splits stored multi-word entries and merges stored punctuation tokens", () => {
        const words = [{ start: 0, end: 1, text: "ab cdef" }, { start: 1, end: 1.5, text: "gh" }, { start: 1.5, end: 1.6, text: "." }];
        const result = captionWords(clip("ab cdef gh.", words));
        expect(result.map((w) => w.text)).toEqual(["ab", "cdef", "gh."]);
        expect(result[0]).toMatchObject({ start: 0, end: 1 / 3 });
        expect(result[1].start).toBeCloseTo(1 / 3);
        expect(result[2]).toMatchObject({ start: 1, end: 1.6 });
    });

    it("clamps stored words into the clip", () => {
        const result = captionWords(clip("a b", [{ start: -1, end: 0.5, text: "a" }, { start: 1.5, end: 9, text: "b" }]));
        expect(result).toEqual([{ start: 0, end: 0.5, text: "a" }, { start: 1.5, end: 2, text: "b" }]);
    });

    it("estimates by character length when the text was edited", () => {
        const result = captionWords(clip("one three", [{ start: 0, end: 1, text: "one" }, { start: 1, end: 2, text: "two" }]));
        expect(result.map((w) => w.text)).toEqual(["one", "three"]);
        expect(result[0].start).toBe(0);
        expect(result[1].end).toBeCloseTo(2);
        expect(result[0].end).toBeCloseTo(result[1].start);
        expect(result[1].end - result[1].start).toBeGreaterThan(result[0].end - result[0].start);
    });

    it("estimates without stored words, at least 0.05 s each when there is room", () => {
        const result = captionWords(clip("a bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", null, 0, 1));
        expect(result[0].end - result[0].start).toBeGreaterThanOrEqual(0.05 - 1e-12);
        expect(result[1].end).toBeCloseTo(1);
        const crowded = captionWords(clip("a b c d", null, 0, 0.1));
        expect(crowded.map((w) => w.end - w.start).every((d) => Math.abs(d - 0.025) < 1e-12)).toBe(true);
    });

    it("handles empty text and bad JSON", () => {
        expect(captionWords(clip("   ", null))).toEqual([]);
        expect(captionWords({ textContent: "a b", captionWordsJson: "{bad", startTime: 0, endTime: 1 })).toHaveLength(2);
        expect(captionWords({ textContent: null, captionWordsJson: null, startTime: 0, endTime: 1 })).toEqual([]);
    });
});
