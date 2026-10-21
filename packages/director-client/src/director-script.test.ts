import { cutScript, parseSrt, readingSeconds, sentencesOf, toSrt, MAX_CUES } from "./director-script";

describe("sentencesOf", () => {
    it("cuts at sentence enders and line breaks, keeps decimals and CJK sentences", () => {
        expect(sentencesOf("Night falls. The car waits!\nIt costs 3.5 dollars? Yes…")).toEqual(["Night falls.", "The car waits!", "It costs 3.5 dollars?", "Yes…"]);
        expect(sentencesOf("夜が来た。車が待つ！本当？")).toEqual(["夜が来た。", "車が待つ！", "本当？"]);
        expect(sentencesOf("\n\n  ...  \n")).toEqual([]);
    });
});

describe("readingSeconds", () => {
    it("2.5 words a second, 6 CJK characters a second, at least 2 s", () => {
        expect(readingSeconds("one two three four five six seven eight nine ten")).toBe(4);
        expect(readingSeconds("Hi.")).toBe(2);
        expect(readingSeconds("一二三四五六七八九十一二三四五六七八")).toBe(3);
    });
});

describe("cutScript", () => {
    it("times one cue per sentence with 0.2 s gaps", () => {
        const { cues, error } = cutScript("Night falls on the quiet town tonight. A car waits.");
        expect(error).toBeUndefined();
        expect(cues).toEqual([
            { start: 0, end: 2.8, text: "Night falls on the quiet town tonight." },
            { start: 3, end: 5, text: "A car waits." },
        ]);
    });

    it("refuses an empty script, one over 20,000 characters, and one over 500 cues", () => {
        expect(cutScript("   ").error).toMatch(/script first/);
        expect(cutScript("a".repeat(20_001)).error).toMatch(/Shorten the script/);
        expect(cutScript(Array.from({ length: MAX_CUES + 1 }, (_, i) => `Line ${i}.`).join("\n")).error).toMatch(/at most 500/);
        expect(cutScript(Array.from({ length: MAX_CUES }, (_, i) => `Line ${i}.`).join("\n")).cues).toHaveLength(MAX_CUES);
    });
});

describe("SRT", () => {
    it("writes and reads back the same cues", () => {
        const { cues } = cutScript("Night falls. A car waits. 夜が来た。");
        const srt = toSrt(cues);
        expect(srt.split("\n").slice(0, 3)).toEqual(["1", "00:00:00,000 --> 00:00:02,000", "Night falls."]);
        expect(parseSrt(srt)).toEqual({ cues });
    });

    it("reads CRLF files with a BOM and multi-line cues, and refuses what isn't SRT", () => {
        expect(parseSrt("﻿1\r\n00:00:01,000 --> 00:00:02,500\r\nHello\r\nthere\r\n\r\n2\r\n00:00:03.000 --> 00:00:04,000\r\nBye\r\n").cues).toEqual([
            { start: 1, end: 2.5, text: "Hello\nthere" }, { start: 3, end: 4, text: "Bye" },
        ]);
        expect(parseSrt("Hello\n00:00:01,000 --> 00:00:02,000\nx").error).toMatch(/number/);
        expect(parseSrt("1\n00:00:05,000 --> 00:00:02,000\nx").error).toMatch(/times/);
        expect(parseSrt("").error).toMatch(/no subtitles/);
    });
});
