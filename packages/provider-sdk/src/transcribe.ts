// Transcription helpers: whisper's languages, caption cues from a transcript, and a timed text dump.
import type { Transcript, TranscriptWord } from "./transcribe-types";

/** whisper.cpp's languages (src/whisper.cpp g_lang, v1.9.5), in its order, with English names. */
const LANGUAGE_ROWS: ReadonlyArray<readonly [string, string]> = [
    ["en", "English"], ["zh", "Chinese"], ["de", "German"], ["es", "Spanish"], ["ru", "Russian"], ["ko", "Korean"], ["fr", "French"],
    ["ja", "Japanese"], ["pt", "Portuguese"], ["tr", "Turkish"], ["pl", "Polish"], ["ca", "Catalan"], ["nl", "Dutch"], ["ar", "Arabic"],
    ["sv", "Swedish"], ["it", "Italian"], ["id", "Indonesian"], ["hi", "Hindi"], ["fi", "Finnish"], ["vi", "Vietnamese"], ["he", "Hebrew"],
    ["uk", "Ukrainian"], ["el", "Greek"], ["ms", "Malay"], ["cs", "Czech"], ["ro", "Romanian"], ["da", "Danish"], ["hu", "Hungarian"],
    ["ta", "Tamil"], ["no", "Norwegian"], ["th", "Thai"], ["ur", "Urdu"], ["hr", "Croatian"], ["bg", "Bulgarian"], ["lt", "Lithuanian"],
    ["la", "Latin"], ["mi", "Maori"], ["ml", "Malayalam"], ["cy", "Welsh"], ["sk", "Slovak"], ["te", "Telugu"], ["fa", "Persian"],
    ["lv", "Latvian"], ["bn", "Bengali"], ["sr", "Serbian"], ["az", "Azerbaijani"], ["sl", "Slovenian"], ["kn", "Kannada"],
    ["et", "Estonian"], ["mk", "Macedonian"], ["br", "Breton"], ["eu", "Basque"], ["is", "Icelandic"], ["hy", "Armenian"],
    ["ne", "Nepali"], ["mn", "Mongolian"], ["bs", "Bosnian"], ["kk", "Kazakh"], ["sq", "Albanian"], ["sw", "Swahili"], ["gl", "Galician"],
    ["mr", "Marathi"], ["pa", "Punjabi"], ["si", "Sinhala"], ["km", "Khmer"], ["sn", "Shona"], ["yo", "Yoruba"], ["so", "Somali"],
    ["af", "Afrikaans"], ["oc", "Occitan"], ["ka", "Georgian"], ["be", "Belarusian"], ["tg", "Tajik"], ["sd", "Sindhi"],
    ["gu", "Gujarati"], ["am", "Amharic"], ["yi", "Yiddish"], ["lo", "Lao"], ["uz", "Uzbek"], ["fo", "Faroese"], ["ht", "Haitian Creole"],
    ["ps", "Pashto"], ["tk", "Turkmen"], ["nn", "Nynorsk"], ["mt", "Maltese"], ["sa", "Sanskrit"], ["lb", "Luxembourgish"],
    ["my", "Myanmar"], ["bo", "Tibetan"], ["tl", "Tagalog"], ["mg", "Malagasy"], ["as", "Assamese"], ["tt", "Tatar"], ["haw", "Hawaiian"],
    ["ln", "Lingala"], ["ha", "Hausa"], ["ba", "Bashkir"], ["jw", "Javanese"], ["su", "Sundanese"], ["yue", "Cantonese"],
];

export const WHISPER_LANGUAGES: ReadonlyArray<{ code: string; name: string }> = LANGUAGE_ROWS.map(([code, name]) => ({ code, name }));

const CODES = new Set(LANGUAGE_ROWS.map(([code]) => code));

/** "auto" or one of WHISPER_LANGUAGES' codes (exact, lowercase). */
export function isTranscribeLanguage(value: unknown): value is string {
    return typeof value === "string" && (value === "auto" || CODES.has(value));
}

export interface CaptionCue {
    startTime: number;
    endTime: number;
    text: string;
    /** The cue's words in order, absolute seconds like the cue (inside it); spelling `text` joined by spaces. Absent without timings. */
    words?: TranscriptWord[];
}

export interface CaptionCueOptions {
    /** Longest caption line in characters. Default 42. */
    maxChars?: number;
    /** Longest caption in seconds. Default 6. */
    maxSeconds?: number;
}

/** Shorter cues are dropped after overlaps are clamped (subtitle-import's minimum). */
const MIN_CUE_SECONDS = 0.1;

/** Non-speech markers caption text drops: "[BLANK_AUDIO]", "[Music playing]", ♪. */
const MARKERS = [/\[[^\]]*\]/g, /[♪♫]/g];

function cleanText(text: string): string {
    const stripped = MARKERS.reduce((value, marker) => value.replace(marker, " "), text)
        .replace(/\s+/g, " ")
        .trim();
    // A segment that is only a parenthetical sound note: "(music)", "(laughs)".
    return /^\([^()]*\)$/.test(stripped) ? "" : stripped;
}

/**
 * The words that survive cleanText, or undefined when they cannot be trusted: a timing is not finite, or the
 * kept words do not spell `cleaned` (the segment's cleaned text) joined by spaces. Markers are found on the
 * words joined by spaces, so "[Music" "playing]" go together.
 */
function cleanWords(words: TranscriptWord[] | undefined, cleaned: string): TranscriptWord[] | undefined {
    if (!Array.isArray(words) || words.length === 0) return undefined;
    if (!words.every((w) => w && typeof w.text === "string" && Number.isFinite(w.start) && Number.isFinite(w.end))) return undefined;
    const texts = words.map((w) => w.text.trim());
    const joined = texts.join(" ");
    const removed = new Uint8Array(joined.length);
    for (const marker of MARKERS) {
        for (const match of joined.matchAll(marker)) removed.fill(1, match.index, match.index + match[0].length);
    }
    const kept: TranscriptWord[] = [];
    let at = 0;
    for (let i = 0; i < words.length; i += 1) {
        let text = "";
        for (let c = at; c < at + texts[i].length; c += 1) if (!removed[c]) text += joined[c];
        at += texts[i].length + 1;
        text = text.replace(/\s+/g, " ").trim();
        if (text) kept.push({ start: words[i].start, end: Math.max(words[i].start, words[i].end), text });
    }
    return kept.length > 0 && kept.map((w) => w.text).join(" ") === cleaned ? kept : undefined;
}

/** Words clamped inside [start, end], in order. */
function clampWords(words: TranscriptWord[], start: number, end: number): TranscriptWord[] {
    let previous = start;
    return words.map((word) => {
        const wordStart = Math.max(previous, Math.min(end, word.start));
        previous = wordStart;
        return { start: wordStart, end: Math.max(wordStart, Math.min(end, word.end)), text: word.text };
    });
}

interface Piece { words: string[]; timed: TranscriptWord[]; start?: number; end?: number }

function splitSegment(start: number, end: number, text: string, words: TranscriptWord[] | undefined, maxChars: number, maxSeconds: number): CaptionCue[] {
    const duration = end - start;
    if (text.length <= maxChars && duration <= maxSeconds) return [{ startTime: start, endTime: end, text, ...(words ? { words } : {}) }];
    const tokens = text.split(" ");
    const timed = words && words.length === tokens.length && words.every((w) => Number.isFinite(w.start) && Number.isFinite(w.end)) ? words : null;
    const count = Math.max(Math.ceil(text.length / maxChars), Math.ceil(duration / maxSeconds), 1);
    const target = Math.ceil(text.length / count);
    const pieces: Piece[] = [];
    let current: Piece = { words: [], timed: [] };
    let length = 0;
    // Break before a word that would make the line longer than the target (timings: maxChars, maxSeconds).
    const limit = timed ? maxChars : target;
    tokens.forEach((token, i) => {
        const added = length === 0 ? token.length : length + 1 + token.length;
        const tooLong = timed && current.start !== undefined && timed[i].end - current.start > maxSeconds;
        if (current.words.length > 0 && (added > limit || tooLong)) {
            pieces.push(current);
            current = { words: [], timed: [] };
        }
        length = current.words.length === 0 ? token.length : length + 1 + token.length;
        current.words.push(token);
        if (timed) {
            current.timed.push(timed[i]);
            current.start ??= timed[i].start;
            current.end = timed[i].end;
        }
    });
    if (current.words.length > 0) pieces.push(current);
    if (timed) {
        return pieces.map((piece) => ({ startTime: piece.start!, endTime: piece.end!, text: piece.words.join(" "), words: piece.timed }));
    }
    // No word timings: share the segment's time by characters.
    const total = pieces.reduce((sum, piece) => sum + piece.words.join(" ").length, 0);
    let cursor = start;
    return pieces.flatMap((piece, i) => {
        const share = duration * (piece.words.join(" ").length / total);
        const next = i === pieces.length - 1 ? end : cursor + share;
        const cue = { startTime: cursor, endTime: next, text: piece.words.join(" ") };
        cursor = next;
        // A piece still longer than maxSeconds (long words beside short ones) is split again.
        return cue.endTime - cue.startTime > maxSeconds && piece.words.length > 1
            ? splitSegment(cue.startTime, cue.endTime, cue.text, undefined, maxChars, maxSeconds)
            : [cue];
    });
}

/**
 * Caption cues (timeline seconds) from a transcript: markers dropped, long lines split, never overlapping. Word
 * timings, when a segment has trustworthy ones, choose the split points and travel with their cue.
 */
export function transcriptToCaptionCues(transcript: Transcript, options: CaptionCueOptions = {}): CaptionCue[] {
    const maxChars = Math.max(8, options.maxChars ?? 42);
    const maxSeconds = Math.max(0.5, options.maxSeconds ?? 6);
    const cues: CaptionCue[] = [];
    for (const segment of transcript.segments) {
        const text = cleanText(segment.text ?? "");
        const start = Math.max(0, Number(segment.start));
        const end = Number(segment.end);
        if (!text || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
        cues.push(...splitSegment(start, end, text, cleanWords(segment.words, text), maxChars, maxSeconds));
    }
    cues.sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime);
    const out: CaptionCue[] = [];
    cues.forEach((cue, i) => {
        const next = cues[i + 1];
        const endTime = next ? Math.min(cue.endTime, next.startTime) : cue.endTime;
        if (endTime - cue.startTime < MIN_CUE_SECONDS) return;
        out.push(cue.words ? { ...cue, endTime, words: clampWords(cue.words, cue.startTime, endTime) } : { ...cue, endTime });
    });
    return out;
}

function clock(seconds: number): string {
    const tenths = Math.round(Math.max(0, seconds) * 10);
    const minutes = Math.floor(tenths / 600);
    const rest = (tenths - minutes * 600) / 10;
    return `${minutes}:${rest.toFixed(1).padStart(4, "0")}`;
}

/** One "[m:ss.s-m:ss.s] text" line per segment. */
export function transcriptText(transcript: Transcript): string {
    return transcript.segments.map((s) => `[${clock(s.start)}-${clock(s.end)}] ${s.text.trim()}`).join("\n");
}
