import { WHISPER_LANGUAGES, isTranscribeLanguage, transcriptText, transcriptToCaptionCues } from "./transcribe";
import type { Transcript } from "./transcribe-types";

const JFK: Transcript = {
    language: "en",
    segments: [
        { start: 0, end: 5.41, text: " And so, my fellow Americans, ask not what" },
        { start: 5.41, end: 9.04, text: " your country can do for you, ask what you" },
        { start: 9.04, end: 10.5, text: " can do for your country." },
    ],
};

describe("WHISPER_LANGUAGES", () => {
    it("lists whisper.cpp's 100 language codes with English names", () => {
        expect(WHISPER_LANGUAGES).toHaveLength(100);
        expect(WHISPER_LANGUAGES[0]).toEqual({ code: "en", name: "English" });
        expect(WHISPER_LANGUAGES.find((l) => l.code === "th")?.name).toBe("Thai");
        expect(new Set(WHISPER_LANGUAGES.map((l) => l.code)).size).toBe(100);
        expect(isTranscribeLanguage("auto")).toBe(true);
        expect(isTranscribeLanguage("yue")).toBe(true);
        expect(isTranscribeLanguage("EN")).toBe(false);
        expect(isTranscribeLanguage("en; rm")).toBe(false);
    });
});

describe("transcriptToCaptionCues", () => {
    it("keeps short segments as they are, trimmed", () => {
        expect(transcriptToCaptionCues(JFK)).toEqual([
            { startTime: 0, endTime: 5.41, text: "And so, my fellow Americans, ask not what" },
            { startTime: 5.41, endTime: 9.04, text: "your country can do for you, ask what you" },
            { startTime: 9.04, endTime: 10.5, text: "can do for your country." },
        ]);
    });

    it("splits long segments at word boundaries with contiguous times", () => {
        const words = Array.from({ length: 15 }, (_, i) => `word${String.fromCharCode(97 + i)}`);
        const cues = transcriptToCaptionCues({ language: "en", segments: [{ start: 2, end: 14, text: words.join(" ") }] });
        expect(cues).toHaveLength(3);
        for (const cue of cues) expect(cue.text.length).toBeLessThanOrEqual(42);
        expect(cues.map((c) => c.text).join(" ")).toBe(words.join(" "));
        expect(cues[0].startTime).toBe(2);
        expect(cues.at(-1)!.endTime).toBe(14);
        for (let i = 1; i < cues.length; i += 1) expect(cues[i].startTime).toBeCloseTo(cues[i - 1].endTime, 6);
    });

    it("splits by duration too", () => {
        const cues = transcriptToCaptionCues({ language: "en", segments: [{ start: 0, end: 20, text: "one two three four five six" }] }, { maxSeconds: 6 });
        expect(cues.length).toBeGreaterThanOrEqual(4);
        for (const cue of cues) expect(cue.endTime - cue.startTime).toBeLessThanOrEqual(6.0001);
    });

    it("uses word timings when present", () => {
        const cues = transcriptToCaptionCues({
            language: "en",
            segments: [{
                start: 0, end: 4, text: "alpha beta gamma delta",
                words: [{ start: 0, end: 0.5, text: "alpha" }, { start: 0.6, end: 1, text: "beta" }, { start: 2.5, end: 3, text: "gamma" }, { start: 3.2, end: 4, text: "delta" }],
            }],
        }, { maxChars: 11 });
        // Each piece keeps its own words (absolute seconds, like the cue times).
        expect(cues).toEqual([
            { startTime: 0, endTime: 1, text: "alpha beta", words: [{ start: 0, end: 0.5, text: "alpha" }, { start: 0.6, end: 1, text: "beta" }] },
            { startTime: 2.5, endTime: 4, text: "gamma delta", words: [{ start: 2.5, end: 3, text: "gamma" }, { start: 3.2, end: 4, text: "delta" }] },
        ]);
    });

    it("keeps the words of a segment that needs no split", () => {
        const words = [{ start: 0.32, end: 0.53, text: "And" }, { start: 0.6, end: 1.2, text: "so," }, { start: 1.3, end: 2, text: "yes" }];
        expect(transcriptToCaptionCues({ language: "en", segments: [{ start: 0, end: 2.4, text: " And so, yes ", words }] })).toEqual([
            { startTime: 0, endTime: 2.4, text: "And so, yes", words },
        ]);
    });

    it("gives no words to cues whose segment has none or words that do not spell its text", () => {
        const cues = transcriptToCaptionCues({
            language: "en",
            segments: [
                { start: 0, end: 1, text: "no words" },
                { start: 1, end: 2, text: "one two", words: [{ start: 1, end: 1.5, text: "one" }, { start: 1.5, end: 2, text: "three" }] },
                { start: 2, end: 3, text: "a b", words: [{ start: 2, end: 2.5, text: "a" }, { start: Number.NaN, end: 3, text: "b" }] },
                { start: 3, end: 20, text: "one two three four five six", words: [{ start: 3, end: 4, text: "one" }] },
            ],
        });
        expect(cues.length).toBeGreaterThan(3);
        for (const cue of cues) expect(cue).not.toHaveProperty("words");
    });

    it("drops the words of markers it strips from the text", () => {
        const cues = transcriptToCaptionCues({
            language: "en",
            segments: [
                { start: 4, end: 5, text: "[Music] Hello", words: [{ start: 4, end: 4.3, text: "[Music]" }, { start: 4.4, end: 5, text: "Hello" }] },
                {
                    start: 5, end: 7, text: "♪ la [Music playing] la ♪",
                    words: [
                        { start: 5, end: 5.1, text: "♪" }, { start: 5.2, end: 5.5, text: "la" }, { start: 5.6, end: 5.8, text: "[Music" },
                        { start: 5.8, end: 6, text: "playing]" }, { start: 6.1, end: 6.6, text: "la" }, { start: 6.7, end: 7, text: "♪" },
                    ],
                },
            ],
        });
        expect(cues).toEqual([
            { startTime: 4, endTime: 5, text: "Hello", words: [{ start: 4.4, end: 5, text: "Hello" }] },
            { startTime: 5, endTime: 7, text: "la la", words: [{ start: 5.2, end: 5.5, text: "la" }, { start: 6.1, end: 6.6, text: "la" }] },
        ]);
    });

    it("keeps words inside their cue when overlaps are clamped", () => {
        const cues = transcriptToCaptionCues({
            language: "en",
            segments: [
                { start: -0.5, end: 3.5, text: "first one", words: [{ start: -0.4, end: 1, text: "first" }, { start: 2.8, end: 3.5, text: "one" }] },
                { start: 3, end: 6, text: "second" },
            ],
        });
        expect(cues[0]).toEqual({ startTime: 0, endTime: 3, text: "first one", words: [{ start: 0, end: 1, text: "first" }, { start: 2.8, end: 3, text: "one" }] });
        expect(cues[1]).toEqual({ startTime: 3, endTime: 6, text: "second" });
    });

    it("drops non-speech markers and empty text", () => {
        const cues = transcriptToCaptionCues({
            language: "en",
            segments: [
                { start: 0, end: 1, text: " [BLANK_AUDIO]" },
                { start: 1, end: 2, text: "(music)" },
                { start: 2, end: 3, text: " ♪ ♪ " },
                { start: 3, end: 4, text: "   " },
                { start: 4, end: 5, text: "[Music] Hello" },
            ],
        });
        expect(cues).toEqual([{ startTime: 4, endTime: 5, text: "Hello" }]);
    });

    it("clamps overlaps, sorts, and drops reversed or tiny cues", () => {
        const cues = transcriptToCaptionCues({
            language: "en",
            segments: [
                { start: 3, end: 6, text: "second" },
                { start: 0, end: 3.5, text: "first" },
                { start: 7, end: 6, text: "reversed" },
                { start: 6, end: 6.02, text: "tiny" },
            ],
        });
        expect(cues).toEqual([
            { startTime: 0, endTime: 3, text: "first" },
            { startTime: 3, endTime: 6, text: "second" },
        ]);
    });
});

describe("transcriptText", () => {
    it("prints one timed line per segment", () => {
        expect(transcriptText(JFK)).toBe([
            "[0:00.0-0:05.4] And so, my fellow Americans, ask not what",
            "[0:05.4-0:09.0] your country can do for you, ask what you",
            "[0:09.0-0:10.5] can do for your country.",
        ].join("\n"));
        expect(transcriptText({ language: "en", segments: [{ start: 65, end: 3725.25, text: "x" }] })).toBe("[1:05.0-62:05.3] x");
        expect(transcriptText({ language: "en", segments: [] })).toBe("");
    });
});
