import { readFileSync } from "node:fs";
import { parseProgressLine, parseWhisperJson } from "./whisper-output";

const fixture = (name: string) => readFileSync(new URL(`../test/fixtures/${name}`, import.meta.url), "utf8");

describe("parseWhisperJson (whisper-cli -oj)", () => {
    it("reads the jfk run: language, segments in seconds, trimmed text", () => {
        expect(parseWhisperJson(fixture("jfk.json"))).toEqual({
            language: "en",
            segments: [
                { start: 0, end: 5.41, text: "And so, my fellow Americans, ask not what" },
                { start: 5.41, end: 9.04, text: "your country can do for you, ask what you" },
                { start: 9.04, end: 10.5, text: "can do for your country." },
            ],
        });
    });

    it("decodes escapes and non-Latin text and drops reversed or negative offsets", () => {
        const transcript = parseWhisperJson(fixture("multilingual.json"));
        expect(transcript.language).toBe("th");
        expect(transcript.segments.map((s) => s.text)).toEqual(["สวัสดีครับ", "こんにちは、\"世界\"", "café \\ back"]);
        expect(transcript.segments[2]).toMatchObject({ start: 4, end: 5.25 });
    });

    it("keeps marker segments (caption cues drop them later)", () => {
        expect(parseWhisperJson(fixture("blank.json")).segments).toEqual([{ start: 0, end: 3, text: "[BLANK_AUDIO]" }]);
    });

    it("shifts by an offset", () => {
        expect(parseWhisperJson(fixture("jfk.json"), { offsetSeconds: 10 }).segments[0]).toMatchObject({ start: 10, end: 15.41 });
    });

    it("refuses output that is not whisper JSON", () => {
        expect(() => parseWhisperJson("{ not json")).toThrow("whisper output is not valid JSON");
        expect(() => parseWhisperJson("{}")).toThrow(/no transcription/);
        expect(() => parseWhisperJson("[]")).toThrow(/no transcription/);
        expect(parseWhisperJson('{"transcription":[{"offsets":{"from":0,"to":1000}}]}').segments).toEqual([]);
        expect(parseWhisperJson('{"transcription":[]}').language).toBe("auto");
    });
});

const W = (start: number, end: number, text: string) => ({ start, end, text });

/** One -ojf segment: [text, from ms, to ms] tokens. */
function full(segments: Array<{ from: number; to: number; text: string; tokens?: Array<[string, number, number]> }>): string {
    return JSON.stringify({
        result: { language: "en" },
        transcription: segments.map((s) => ({
            offsets: { from: s.from, to: s.to },
            text: s.text,
            ...(s.tokens ? { tokens: s.tokens.map(([text, from, to], id) => ({ text, offsets: { from, to }, id, p: 0.9, t_dtw: -1 })) } : {}),
        })),
    });
}

describe("parseWhisperJson (whisper-cli -ojf word timings)", () => {
    it("builds words from the real jfk -ojf run: pieces merged, punctuation kept in the text, specials skipped", () => {
        const transcript = parseWhisperJson(fixture("jfk-full.json"));
        expect(transcript.segments.map((s) => s.text)).toEqual([
            "And so, my fellow Americans, ask not what",
            "your country can do for you, ask what you",
            "can do for your country.",
        ]);
        expect(transcript.segments[0].words).toEqual([
            // " And" is 320-320 in whisper's output: a zero-length word runs to the next word's start.
            W(0.32, 0.33, "And"), W(0.33, 0.53, "so,"), W(0.74, 0.95, "my"), W(0.95, 1.59, "fellow"),
            // The "," piece (2550-3000) does not stretch the spoken word.
            W(1.59, 2.1, "Americans,"), W(3.29, 3.65, "ask"), W(4.01, 4.28, "not"), W(4.65, 5.2, "what"),
        ]);
        expect(transcript.segments[2].words).toEqual([
            W(9.04, 9.35, "can"), W(9.35, 9.5, "do"), W(9.5, 9.71, "for"), W(9.72, 9.98, "your"), W(9.99, 10.35, "country."),
        ]);
        for (const segment of transcript.segments) {
            expect(segment.words!.map((w) => w.text).join(" ")).toBe(segment.text);
        }
    });

    it("merges sub-word pieces and skips every kind of special token", () => {
        const transcript = parseWhisperJson(full([{
            from: 1000, to: 3000, text: " Hello Americans!",
            tokens: [["[_BEG_]", 1000, 1000], ["<|startoftranscript|>", 1000, 1000], [" Hel", 1100, 1300], ["lo", 1300, 1500],
                [" Americ", 1600, 2000], ["ans", 2000, 2400], ["!", 2400, 2900], ["[_TT_150]", 3000, 3000], ["<|endoftext|>", 3000, 3000]],
        }]));
        expect(transcript.segments[0].words).toEqual([W(1.1, 1.5, "Hello"), W(1.6, 2.4, "Americans!")]);
    });

    it("clamps words inside their segment and keeps them in order without overlaps", () => {
        const transcript = parseWhisperJson(full([{
            from: 1000, to: 2000, text: "early overlap late",
            tokens: [["early", 800, 1200], [" overlap", 1100, 1500], [" late", 1900, 2300]],
        }]));
        expect(transcript.segments[0].words).toEqual([W(1, 1.2, "early"), W(1.2, 1.5, "overlap"), W(1.9, 2, "late")]);
    });

    it("shifts words by the offset like the segments", () => {
        const words = parseWhisperJson(fixture("jfk-full.json"), { offsetSeconds: 10 }).segments[1].words!;
        expect(words[0].text).toBe("your");
        expect(words[0].start).toBeCloseTo(15.41, 6);
        expect(words[0].end).toBeCloseTo(15.56, 6);
    });

    it("leaves words out when the tokens cannot be trusted", () => {
        const transcript = parseWhisperJson(full([
            // Old -oj shape: no tokens.
            { from: 0, to: 1000, text: " no tokens" },
            // A multi-byte character split across tokens reaches us as U+FFFD.
            { from: 1000, to: 2000, text: " สวัสดี", tokens: [[" \uFFFD", 1000, 1500], ["\uFFFD", 1500, 2000]] },
            // Tokens that do not spell the segment's text.
            { from: 2000, to: 3000, text: " one two", tokens: [[" one", 2000, 2500], [" three", 2500, 3000]] },
            // Tokens missing a word of the text.
            { from: 3000, to: 4000, text: " a b", tokens: [[" a", 3000, 3500]] },
            { from: 4000, to: 5000, text: " only specials", tokens: [["[_BEG_]", 4000, 4000]] },
        ]));
        expect(transcript.segments).toHaveLength(5);
        for (const segment of transcript.segments) expect(segment).not.toHaveProperty("words");
        expect(transcript.segments[1].text).toBe("สวัสดี");
    });

    it("leaves words out when a token has broken offsets instead of guessing", () => {
        const text = JSON.stringify({ transcription: [{ offsets: { from: 0, to: 1000 }, text: " hi there",
            tokens: [{ text: " hi", offsets: { from: 0, to: 400 } }, { text: " there", offsets: { from: "x" } }] }] });
        expect(parseWhisperJson(text).segments[0]).toEqual({ start: 0, end: 1, text: "hi there" });
    });
});

describe("parseProgressLine", () => {
    it("reads whisper's progress callback lines", () => {
        expect(parseProgressLine("whisper_print_progress_callback: progress =   0%")).toBe(0);
        expect(parseProgressLine("whisper_print_progress_callback: progress =  45%")).toBe(0.45);
        expect(parseProgressLine("whisper_print_progress_callback: progress = 100%")).toBe(1);
        expect(parseProgressLine("read_audio_data: reading audio data")).toBeNull();
        expect(parseProgressLine("progress = 250%")).toBe(1);
    });
});
