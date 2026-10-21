// Filler words (phase 11, "Remove filler words"): per-language lists matched against word timings — whole tokens only
// (normalised: NFKC, lower case, punctuation stripped), never inside longer words; multi-word fillers ("you know")
// match consecutive tokens; English "like" counts only when it stands between pauses. Each found filler becomes a
// range padded on both sides without cutting into the neighbouring words; touching ranges merge. Pure.
import type { TimeRange } from "./host";

export interface FillerWord {
    text: string;
    start: number;
    end: number;
}

export interface FillerResult {
    /** Ranges to cut, padded and merged, ordered. */
    ranges: TimeRange[];
    /** The filler words found (as transcribed), in order. */
    words: FillerWord[];
}

export const FILLER_DEFAULT_PADDING = 0.05;
/** Pause around a standalone "like", seconds. */
export const STANDALONE_PAUSE = 0.15;

/** Filler lists per language (normalised forms; multi-word entries are space-separated). */
export const FILLER_WORDS: Record<string, readonly string[]> = {
    en: ["um", "uh", "erm", "er", "ah", "hmm", "mhm", "you know", "i mean"],
    th: ["เอ่อ", "อ่า", "อืม", "เออ"],
    ja: ["えーと", "えっと", "あの", "あのー", "その", "えー"],
    zh: ["嗯", "呃", "那个", "就是"],
    ko: ["음", "어", "그"],
    es: ["eh", "este", "o sea"],
    fr: ["euh", "ben", "bah"],
    de: ["äh", "ähm", "öhm"],
    pt: ["é", "tipo", "ahn"],
};

/** Words that are fillers only between pauses (they are common words otherwise). */
export const STANDALONE_FILLERS: Record<string, readonly string[]> = { en: ["like"] };

export function normalizeFillerToken(text: string): string {
    return text.normalize("NFKC").toLowerCase().replace(/[\p{P}\p{S}]/gu, "").trim();
}

/** The language of transcribed words by script: Thai, Japanese kana, Hangul, Han, else English. */
export function guessWordsLanguage(words: ReadonlyArray<{ text: string }>): string {
    const text = words.map((w) => w.text).join(" ");
    if (/\p{Script=Thai}/u.test(text)) return "th";
    if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text)) return "ja";
    if (/\p{Script=Hangul}/u.test(text)) return "ko";
    if (/\p{Script=Han}/u.test(text)) return "zh";
    return "en";
}

/** "en-US" → "en"; "auto", "" or missing → guessed from the words. */
export function fillerLanguage(language: string | undefined, words: ReadonlyArray<{ text: string }>): string {
    const code = (language ?? "").trim().toLowerCase().split(/[-_]/)[0];
    return !code || code === "auto" ? guessWordsLanguage(words) : code;
}

const round3 = (x: number) => Math.round(x * 1000) / 1000;

/** Filler words in word timings (any time base; ranges come back in the same one). Unknown languages find none. */
export function findFillers(words: readonly FillerWord[], language?: string, options: { padding?: number } = {}): FillerResult {
    const padding = Number.isFinite(options.padding) && options.padding! >= 0 ? options.padding! : FILLER_DEFAULT_PADDING;
    const ordered = words
        .filter((w) => w && typeof w.text === "string" && Number.isFinite(w.start) && Number.isFinite(w.end))
        .map((w) => ({ text: w.text, start: Math.min(w.start, w.end), end: Math.max(w.start, w.end), norm: normalizeFillerToken(w.text) }))
        .filter((w) => w.norm.length > 0)
        .sort((a, b) => a.start - b.start);
    const lang = fillerLanguage(language, ordered);
    const lists = (FILLER_WORDS[lang] ?? []).map((entry) => entry.split(" "));
    const standalone = new Set(STANDALONE_FILLERS[lang] ?? []);
    // Longest phrases first so "i mean" wins over a single-token match.
    lists.sort((a, b) => b.length - a.length);
    const found: Array<{ from: number; to: number }> = [];
    for (let i = 0; i < ordered.length; i += 1) {
        const match = lists.find((tokens) => tokens.every((token, k) => ordered[i + k]?.norm === token));
        if (match) {
            found.push({ from: i, to: i + match.length - 1 });
            i += match.length - 1;
            continue;
        }
        if (standalone.has(ordered[i].norm)) {
            const before = i === 0 ? Number.POSITIVE_INFINITY : ordered[i].start - ordered[i - 1].end;
            const after = i === ordered.length - 1 ? Number.POSITIVE_INFINITY : ordered[i + 1].start - ordered[i].end;
            if (before >= STANDALONE_PAUSE - 1e-9 && after >= STANDALONE_PAUSE - 1e-9) found.push({ from: i, to: i });
        }
    }
    const ranges: TimeRange[] = [];
    const out: FillerWord[] = [];
    let lastTo = -2;
    for (const { from, to } of found) {
        const first = ordered[from];
        const last = ordered[to];
        const prevEnd = from > 0 ? ordered[from - 1].end : Number.NEGATIVE_INFINITY;
        const nextStart = to < ordered.length - 1 ? ordered[to + 1].start : Number.POSITIVE_INFINITY;
        const start = Math.max(Math.min(first.start, Math.max(prevEnd, first.start - padding)), 0);
        const end = Math.max(last.end, Math.min(nextStart, last.end + padding));
        for (let k = from; k <= to; k += 1) out.push({ text: ordered[k].text, start: ordered[k].start, end: ordered[k].end });
        // Fillers next to each other (no word between them) or whose padding touches go out as one cut.
        const previous = ranges[ranges.length - 1];
        if (previous && (from === lastTo + 1 || start <= previous.end + 1e-6)) previous.end = round3(Math.max(previous.end, end));
        else ranges.push({ start: round3(start), end: round3(end) });
        lastTo = to;
    }
    return { ranges, words: out };
}
