import { describe, expect, it } from "vitest";
import { FILLER_WORDS, findFillers, fillerLanguage } from "./fillers";

/** Words laid out one after another: [text, duration, gap after]. */
function words(spec: Array<[string, number, number?]>, start = 0) {
    let t = start;
    return spec.map(([text, duration, gap = 0.05]) => {
        const word = { text, start: Math.round(t * 1000) / 1000, end: Math.round((t + duration) * 1000) / 1000 };
        t += duration + gap;
        return word;
    });
}

describe("findFillers", () => {
    it("finds English fillers as whole tokens, punctuation and case aside, padded without touching the neighbours", () => {
        const w = words([["So,", 0.3], ["Um,", 0.3, 0.2], ["the", 0.2], ["umbrella", 0.5], ["uh...", 0.25, 0.02], ["works.", 0.4]]);
        const result = findFillers(w, "en");
        expect(result.words.map((x) => x.text)).toEqual(["Um,", "uh..."]);
        // "Um," 0.35–0.65: 0.05 before (gap 0.05 to "So,"), 0.05 after (gap 0.2). "uh..." 1.65–1.9: the next word starts 0.02 after.
        expect(result.ranges).toEqual([{ start: 0.3, end: 0.7 }, { start: 1.6, end: 1.92 }]);
    });

    it("matches multi-word fillers and merges touching ranges", () => {
        const w = words([["Well", 0.3], ["you", 0.15, 0.01], ["know", 0.2, 0.01], ["um", 0.2], ["I", 0.1], ["mean", 0.2], ["yes", 0.3]]);
        const result = findFillers(w, "en-US", { padding: 0 });
        expect(result.words.map((x) => x.text)).toEqual(["you", "know", "um", "I", "mean"]);
        // No word stands between them: one cut from "you" to "mean".
        expect(result.ranges).toEqual([{ start: 0.35, end: 1.32 }]);
        const apart = words([["um", 0.2], ["so", 0.2], ["uh", 0.2]]);
        expect(findFillers(apart, "en", { padding: 0 }).ranges).toEqual([{ start: 0, end: 0.2 }, { start: 0.5, end: 0.7 }]);
    });

    it('counts "like" only between pauses', () => {
        const kept = words([["I", 0.1], ["like", 0.2], ["it", 0.2]]);
        expect(findFillers(kept, "en").words).toEqual([]);
        const filler = words([["It's", 0.2, 0.2], ["like", 0.2, 0.3], ["huge", 0.3]]);
        expect(findFillers(filler, "en").words.map((x) => x.text)).toEqual(["like"]);
    });

    it("uses each language's list and never matches inside longer words", () => {
        expect(findFillers(words([["เอ่อ", 0.3], ["สวัสดี", 0.5], ["อืม", 0.3]]), "th").words.map((x) => x.text)).toEqual(["เอ่อ", "อืม"]);
        expect(findFillers(words([["えーと", 0.3], ["あのー", 0.3], ["あのね", 0.3]]), "ja").words.map((x) => x.text)).toEqual(["えーと", "あのー"]);
        expect(findFillers(words([["嗯", 0.2], ["那个", 0.3], ["那个人", 0.4]]), "zh").words.map((x) => x.text)).toEqual(["嗯", "那个"]);
        expect(findFillers(words([["Euh", 0.2], ["bonjour", 0.3]]), "fr").words.map((x) => x.text)).toEqual(["Euh"]);
        expect(findFillers(words([["Ähm", 0.2], ["hallo", 0.3]]), "de").words.map((x) => x.text)).toEqual(["Ähm"]);
        expect(findFillers(words([["o", 0.1], ["sea", 0.2], ["bueno", 0.3]]), "es").words.map((x) => x.text)).toEqual(["o", "sea"]);
        expect(findFillers(words([["음", 0.2], ["안녕", 0.3]]), "ko").words.map((x) => x.text)).toEqual(["음"]);
        expect(findFillers(words([["tipo", 0.2], ["assim", 0.3]]), "pt").words.map((x) => x.text)).toEqual(["tipo"]);
        expect(findFillers(words([["um", 0.2]]), "it").words).toEqual([]);
        expect(Object.keys(FILLER_WORDS).sort()).toEqual(["de", "en", "es", "fr", "ja", "ko", "pt", "th", "zh"]);
    });

    it("guesses the language from the script when none is given", () => {
        expect(fillerLanguage(undefined, [{ text: "เอ่อ" }])).toBe("th");
        expect(fillerLanguage("auto", [{ text: "えっと" }])).toBe("ja");
        expect(fillerLanguage("", [{ text: "음" }])).toBe("ko");
        expect(fillerLanguage(undefined, [{ text: "嗯" }])).toBe("zh");
        expect(fillerLanguage(undefined, [{ text: "hello" }])).toBe("en");
        expect(findFillers(words([["เอ่อ", 0.3], ["ครับ", 0.3]])).words.map((x) => x.text)).toEqual(["เอ่อ"]);
    });

    it("does not pad before 0", () => {
        expect(findFillers([{ text: "um", start: 0.02, end: 0.3 }, { text: "ok", start: 0.6, end: 0.8 }], "en").ranges).toEqual([{ start: 0, end: 0.35 }]);
    });
});
