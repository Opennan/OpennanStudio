// whisper-cli output: the -ojf (or older -oj) JSON file and the -pp progress lines on stderr.
import type { Transcript, TranscriptSegment, TranscriptWord } from "@opennan/provider-sdk";

interface WhisperToken {
    text?: unknown;
    offsets?: { from?: unknown; to?: unknown };
}

interface WhisperJson {
    result?: { language?: unknown };
    params?: { language?: unknown };
    transcription?: Array<{ offsets?: { from?: unknown; to?: unknown }; text?: unknown; tokens?: unknown }>;
}

/** whisper's control tokens: [_BEG_], [_TT_123], [_SOT_], <|endoftext|>, … */
const SPECIAL_TOKEN = /^\s*(\[_[^\]]*\]|<\|[^|]*\|>)\s*$/;
const SPOKEN = /[\p{L}\p{N}]/u;

interface WordDraft { text: string; pieces: Array<{ text: string; from: number; to: number }> }

/**
 * Words (seconds) from one -ojf segment's tokens: a piece starting with a space starts a word, the others join
 * the word before; punctuation-only pieces stay in the text but do not stretch the word's time. Words are
 * clamped inside the segment, in order, never overlapping; a zero-length word runs to the next word's start.
 * Undefined when the tokens cannot be trusted (missing or broken offsets, U+FFFD from a split multi-byte
 * character, or words that do not spell the segment's text): karaoke then estimates timings itself.
 */
function segmentWords(tokens: unknown, text: string, fromMs: number, toMs: number, offset: number): TranscriptWord[] | undefined {
    if (!Array.isArray(tokens) || tokens.length === 0) return undefined;
    const drafts: WordDraft[] = [];
    for (const raw of tokens as WhisperToken[]) {
        const piece = raw?.text;
        if (typeof piece !== "string") return undefined;
        if (piece.length === 0 || SPECIAL_TOKEN.test(piece)) continue;
        const from = Number(raw.offsets?.from);
        const to = Number(raw.offsets?.to);
        if (!Number.isFinite(from) || !Number.isFinite(to)) return undefined;
        const current = drafts.at(-1);
        if (!current || /^\s/.test(piece)) drafts.push({ text: piece.trim(), pieces: [{ text: piece, from, to }] });
        else {
            current.text += piece.trim();
            current.pieces.push({ text: piece, from, to });
        }
    }
    const kept = drafts.filter((d) => d.text.length > 0);
    if (kept.length === 0) return undefined;
    if (kept.some((d) => d.text.includes("\uFFFD") || /\s/.test(d.text))) return undefined;
    if (kept.map((d) => d.text).join(" ") !== text.replace(/\s+/g, " ")) return undefined;
    const timed: Array<{ text: string; start: number; end: number }> = [];
    let previousEnd = fromMs;
    for (const draft of kept) {
        const spoken = draft.pieces.filter((p) => SPOKEN.test(p.text));
        const pieces = spoken.length > 0 ? spoken : draft.pieces;
        const clamp = (ms: number) => Math.min(toMs, Math.max(fromMs, ms));
        const start = Math.max(previousEnd, clamp(Math.min(...pieces.map((p) => p.from))));
        const end = Math.max(start, clamp(Math.max(...pieces.map((p) => p.to))));
        timed.push({ text: draft.text, start, end });
        previousEnd = end;
    }
    return timed.map((word, i) => {
        const end = word.end > word.start ? word.end : Math.max(word.start, timed[i + 1]?.start ?? toMs);
        return { start: word.start / 1000 + offset, end: end / 1000 + offset, text: word.text };
    });
}

/**
 * whisper-cli's -ojf file → Transcript (seconds), with per-word timings from the tokens; the -oj shape (no
 * tokens) gives segments without words. Reversed, negative, or textless segments are dropped.
 */
export function parseWhisperJson(text: string, options: { offsetSeconds?: number } = {}): Transcript {
    let data: WhisperJson;
    try {
        data = JSON.parse(text) as WhisperJson;
    } catch {
        throw new Error("whisper output is not valid JSON");
    }
    if (!data || typeof data !== "object" || !Array.isArray(data.transcription)) throw new Error("whisper output has no transcription");
    const offset = options.offsetSeconds ?? 0;
    const segments: TranscriptSegment[] = [];
    for (const row of data.transcription) {
        const from = Number(row?.offsets?.from);
        const to = Number(row?.offsets?.to);
        if (typeof row?.text !== "string" || !Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to <= from) continue;
        const value = row.text.trim();
        if (!value) continue;
        const words = segmentWords(row.tokens, value, from, to, offset);
        segments.push({ start: from / 1000 + offset, end: to / 1000 + offset, text: value, ...(words ? { words } : {}) });
    }
    const language = typeof data.result?.language === "string" ? data.result.language
        : typeof data.params?.language === "string" ? data.params.language : "auto";
    return { language, segments };
}

const PROGRESS = /progress\s*=\s*(\d{1,3})%/;

/** "whisper_print_progress_callback: progress =  45%" → 0.45; other lines → null. */
export function parseProgressLine(line: string): number | null {
    const match = PROGRESS.exec(line);
    return match ? Math.min(1, Number(match[1]) / 100) : null;
}
