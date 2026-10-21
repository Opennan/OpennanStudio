// Caption styles and word timings (phase 10b). Eight caption looks for auto-captions and the
// inspector (caption-kind textStyle objects at the bottom), and `captionWords`, the clip-local word
// timings karaoke uses: stored words (captionWordsJson) while the clip text still matches them, else
// an estimate by character length that covers the clip.
import { parseTimelineTextStyle } from "../lib/timeline-text-style";
import { fontStack } from "./fonts";

export interface CaptionStyle {
    id: string;
    /** Highlights the current word (needs word timings). */
    karaoke: boolean;
    style: Record<string, unknown>;
}

const CAPTION_BASE = {
    textClipKind: "caption",
    captionKind: "caption",
    captionPosition: "bottom",
    wordsPerLine: "multiple",
    maxWidthRatio: 0.78,
    textAlign: "center",
} as const;

const caption = (id: string, style: Record<string, unknown>): CaptionStyle => ({
    id, karaoke: typeof style.karaoke === "string", style: { ...CAPTION_BASE, ...style },
});

export const CAPTION_STYLES: readonly CaptionStyle[] = [
    // The pre-10b caption preset (lib/timeline-text-style.ts), so applying it to old captions changes nothing visible.
    caption("classic", {
        fontSize: 56, fontWeight: "700", fontFamily: "Inter, sans-serif", color: "#ffffff", strokeWidth: 0, strokeColor: "#000000",
        bgColor: "rgba(0,0,0,0.62)", letterSpacing: 0, shadowColor: "rgba(0,0,0,0.7)", shadowBlur: 4, shadowOffsetY: 2,
    }),
    caption("pill", { fontSize: 54, fontWeight: "800", fontFamily: fontStack("Poppins"), color: "#111111", bgColor: "#FFFFFF", bgPadding: 16, bgRadius: 999 }),
    caption("bold_yellow", { fontSize: 60, fontWeight: "900", fontFamily: fontStack("Montserrat"), color: "#FFE14D", strokeWidth: 6, strokeColor: "#000000" }),
    caption("boxed", { fontSize: 52, fontWeight: "600", fontFamily: fontStack("Poppins"), color: "#FFFFFF", bgColor: "rgba(17,17,17,0.9)", bgPadding: 14, bgRadius: 8 }),
    caption("neon", { fontSize: 56, fontWeight: "700", fontFamily: fontStack("Montserrat"), color: "#F0FFFF", glowColor: "#00E5FF", glowSize: 14 }),
    caption("minimal", { fontSize: 46, fontWeight: "400", fontFamily: fontStack("Inter"), color: "#FFFFFF", shadowColor: "rgba(0,0,0,0.6)", shadowBlur: 4, shadowOffsetY: 1 }),
    caption("karaoke_highlight", {
        fontSize: 60, fontWeight: "900", fontFamily: fontStack("Montserrat"), color: "#FFFFFF", strokeWidth: 6, strokeColor: "#000000",
        karaoke: "highlight", highlightColor: "#FFE14D",
    }),
    caption("karaoke_box", {
        fontSize: 56, fontWeight: "800", fontFamily: fontStack("Poppins"), color: "#FFFFFF", shadowColor: "rgba(0,0,0,0.6)", shadowBlur: 6, shadowOffsetY: 2,
        karaoke: "box", highlightColor: "#7C3AED",
    }),
];

export function captionStyleById(id: string): CaptionStyle | undefined {
    return CAPTION_STYLES.find((s) => s.id === id);
}

/**
 * Applies a caption style, keeping the prior's position and wrap layout (captionPosition, wordsPerLine,
 * maxWidthRatio) and a subtitle kind. Null for unknown ids.
 */
export function captionStyleJson(id: string, prior?: string | null): string | null {
    const entry = captionStyleById(id);
    if (!entry) return null;
    const previous = parseTimelineTextStyle(prior);
    const next: Record<string, unknown> = { ...entry.style };
    for (const key of ["captionPosition", "wordsPerLine", "maxWidthRatio"]) {
        if (previous[key] !== undefined && previous[key] !== null) next[key] = previous[key];
    }
    if (previous.captionKind === "subtitle" || previous.textClipKind === "subtitle") {
        next.captionKind = "subtitle";
        next.textClipKind = "subtitle";
    }
    return JSON.stringify(next);
}

/** A word's clip-local timing, seconds. */
export interface CaptionWord {
    start: number;
    end: number;
    text: string;
}

export interface CaptionWordsClip {
    textContent: string | null;
    captionWordsJson?: string | null;
    startTime: number;
    endTime: number;
}

export const MIN_ESTIMATED_WORD_SECONDS = 0.05;

/** The display words of a caption: whitespace-separated tokens (the same words layout wraps). */
export function captionTokens(text: string | null | undefined): string[] {
    return (text ?? "").split(/\s+/).filter(Boolean);
}

/** Comparison form of a token: NFKC, lower case, punctuation and symbols stripped ("" for pure punctuation). */
function normalizeToken(token: string): string {
    return token.normalize("NFKC").toLowerCase().replace(/[\p{P}\p{S}]/gu, "");
}

interface TimedToken {
    norm: string;
    start: number;
    end: number;
}

function parseStoredWords(json: string | null | undefined, duration: number): CaptionWord[] | null {
    if (!json) return null;
    let raw: unknown;
    try {
        raw = JSON.parse(json);
    } catch {
        return null;
    }
    if (!Array.isArray(raw)) return null;
    const words: CaptionWord[] = [];
    for (const item of raw) {
        if (!item || typeof item !== "object") return null;
        const { start, end, text } = item as Record<string, unknown>;
        const s = Number(start);
        const e = Number(end);
        if (!Number.isFinite(s) || !Number.isFinite(e) || typeof text !== "string") return null;
        const cs = Math.min(duration, Math.max(0, s));
        words.push({ start: cs, end: Math.min(duration, Math.max(cs, e)), text });
    }
    return words.sort((a, b) => a.start - b.start);
}

/** Stored words as timed normalized tokens: multi-word entries split by character length, punctuation merged into the previous token. */
function storedTokens(words: CaptionWord[]): TimedToken[] {
    const tokens: TimedToken[] = [];
    for (const word of words) {
        const parts = captionTokens(word.text);
        const total = parts.reduce((sum, part) => sum + Math.max(1, part.length), 0);
        let cursor = word.start;
        parts.forEach((part, index) => {
            const end = index === parts.length - 1 ? word.end : cursor + ((word.end - word.start) * Math.max(1, part.length)) / total;
            const norm = normalizeToken(part);
            if (norm) tokens.push({ norm, start: cursor, end });
            else if (tokens.length > 0) tokens[tokens.length - 1].end = Math.max(tokens[tokens.length - 1].end, end);
            cursor = end;
        });
    }
    return tokens;
}

function estimateWords(tokens: string[], duration: number): CaptionWord[] {
    const weights = tokens.map((token) => Math.max(1, Array.from(token).length));
    const total = weights.reduce((a, b) => a + b, 0);
    const floor = tokens.length * MIN_ESTIMATED_WORD_SECONDS <= duration ? MIN_ESTIMATED_WORD_SECONDS : duration / tokens.length;
    const spare = Math.max(0, duration - floor * tokens.length);
    const words: CaptionWord[] = [];
    let cursor = 0;
    tokens.forEach((text, index) => {
        const end = index === tokens.length - 1 ? duration : cursor + floor + (spare * weights[index]) / total;
        words.push({ start: cursor, end, text });
        cursor = end;
    });
    return words;
}

/**
 * Clip-local word timings, one per display word: the stored words when their normalized text equals
 * the clip's (pure-punctuation display words take a zero-length slot at the previous word's end), else
 * an estimate by character length (at least 0.05 s each when the clip has room) covering the clip.
 */
export function captionWords(clip: CaptionWordsClip): CaptionWord[] {
    const duration = Math.max(0, clip.endTime - clip.startTime);
    const tokens = captionTokens(clip.textContent);
    if (tokens.length === 0) return [];
    const stored = parseStoredWords(clip.captionWordsJson, duration);
    if (stored) {
        const timed = storedTokens(stored);
        const norms = tokens.map(normalizeToken);
        const wanted = norms.filter(Boolean);
        if (wanted.length > 0 && wanted.length === timed.length && wanted.every((norm, i) => norm === timed[i].norm)) {
            const words: CaptionWord[] = [];
            let next = 0;
            tokens.forEach((text, index) => {
                if (norms[index]) {
                    const t = timed[next];
                    next += 1;
                    words.push({ start: t.start, end: t.end, text });
                } else {
                    const at = words.length > 0 ? words[words.length - 1].end : timed[0].start;
                    words.push({ start: at, end: at, text });
                }
            });
            return words;
        }
    }
    return estimateWords(tokens, duration);
}

const LAYOUT_KEYS = new Set(["captionPosition", "wordsPerLine", "maxWidthRatio", "captionKind", "textClipKind"]);

/**
 * The caption style a clip's textStyle was made from (captionStyleJson): the style whose look fields all match, layout
 * and kind aside. Null for other text styles.
 */
export function captionStyleIdOf(textStyle: string | null | undefined): string | null {
    const style = parseTimelineTextStyle(textStyle);
    if (Object.keys(style).length === 0) return null;
    const match = CAPTION_STYLES.find((entry) => Object.entries(entry.style).every(([key, value]) => LAYOUT_KEYS.has(key) || style[key] === value));
    return match?.id ?? null;
}
