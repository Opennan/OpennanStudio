// Script to video, step 1: a plain script becomes subtitle cues (the project's SRT, from which the story plan makes one
// scene per cue). One cue per sentence (`.`, `!`, `?`, `…` and the CJK enders `。！？`, and every line break), timed
// at 2.5 words a second (CJK text 6 characters a second), at least 2 s each, 0.2 s apart. An SRT file is read and
// checked as the server checks it (each cue: its number, its times, its text) and sent as it is. A project takes at
// most 500 cues, a script 20,000 characters and subtitles 200,000 characters (the server's limits).

export interface Cue {
    /** Seconds. */
    start: number;
    end: number;
    text: string;
}

export type CueResult = { cues: Cue[]; error?: undefined } | { cues: Cue[]; error: string };

export const MAX_CUES = 500;
export const MAX_SCRIPT_CHARS = 20_000;
export const MAX_SRT_CHARS = 200_000;
export const WORDS_PER_SECOND = 2.5;
export const CJK_CHARS_PER_SECOND = 6;
export const MIN_CUE_SECONDS = 2;
export const CUE_GAP_SECONDS = 0.2;

const CJK = /[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯฀-๿]/gu;

/** The sentences of a script, in order (enders kept with their sentence). */
export function sentencesOf(text: string): string[] {
    const out: string[] = [];
    for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
        // A Latin ender ends a sentence before whitespace or the line's end ("3.5" and "e.g.x" stay); CJK enders always.
        const parts = line.split(/(?<=[.!?…]+)(?=\s|$)|(?<=[。！？]+)/u);
        for (const part of parts) {
            const sentence = part.trim();
            if (sentence && /[\p{L}\p{N}]/u.test(sentence)) out.push(sentence);
        }
    }
    return out;
}

/** Seconds a sentence takes to read: words at 2.5 a second, CJK and Thai characters at 6, at least 2 s. */
export function readingSeconds(sentence: string): number {
    const cjk = sentence.match(CJK)?.length ?? 0;
    const rest = sentence.replace(CJK, " ");
    const words = rest.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
    return Math.max(MIN_CUE_SECONDS, words / WORDS_PER_SECOND + cjk / CJK_CHARS_PER_SECOND);
}

function round3(value: number): number {
    return Math.round(value * 1000) / 1000;
}

export function cutScript(text: string): CueResult {
    if (text.length > MAX_SCRIPT_CHARS) return { cues: [], error: `Shorten the script: it is over ${MAX_SCRIPT_CHARS.toLocaleString("en-US")} characters.` };
    const sentences = sentencesOf(text);
    if (sentences.length === 0) return { cues: [], error: "Write or paste a script first." };
    if (sentences.length > MAX_CUES) return { cues: [], error: `Shorten the script: it makes ${sentences.length} subtitles and a project takes at most ${MAX_CUES}.` };
    const cues: Cue[] = [];
    let at = 0;
    for (const sentence of sentences) {
        const end = at + readingSeconds(sentence);
        cues.push({ start: round3(at), end: round3(end), text: sentence });
        at = end + CUE_GAP_SECONDS;
    }
    return { cues };
}

function stamp(seconds: number): string {
    const ms = Math.max(0, Math.round(seconds * 1000));
    const h = Math.floor(ms / 3_600_000);
    const m = Math.floor((ms % 3_600_000) / 60_000);
    const s = Math.floor((ms % 60_000) / 1000);
    const pad = (n: number, w = 2) => String(n).padStart(w, "0");
    return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms % 1000, 3)}`;
}

export function toSrt(cues: readonly Cue[]): string {
    return cues.map((cue, i) => `${i + 1}\n${stamp(cue.start)} --> ${stamp(cue.end)}\n${cue.text.replace(/\r?\n\s*\r?\n/g, "\n").trim()}\n`).join("\n");
}

const TIME = /^(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})$/;

function seconds(value: string): number | null {
    const match = TIME.exec(value.trim());
    if (!match) return null;
    const [, h, m, s, ms] = match;
    return Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(ms!.padEnd(3, "0")) / 1000;
}

/** Reads SRT text: its cues, or why it can't be used. */
export function parseSrt(text: string): CueResult {
    if (text.length > MAX_SRT_CHARS) return { cues: [], error: `These subtitles are over ${MAX_SRT_CHARS.toLocaleString("en-US")} characters.` };
    const blocks = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n").split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
    if (blocks.length === 0) return { cues: [], error: "This file has no subtitles." };
    const cues: Cue[] = [];
    for (const [i, block] of blocks.entries()) {
        const lines = block.split("\n");
        if (!/^\d+$/.test(lines[0]!.trim())) return { cues: [], error: `Subtitle ${i + 1} doesn't start with its number, so this isn't SRT.` };
        const times = (lines[1] ?? "").split("-->");
        const start = times.length === 2 ? seconds(times[0]!) : null;
        const end = times.length === 2 ? seconds(times[1]!.trim().split(/\s+/)[0]!) : null;
        if (start === null || end === null || end < start) return { cues: [], error: `Subtitle ${i + 1} has no valid times.` };
        cues.push({ start, end, text: lines.slice(2).join("\n").trim() });
    }
    if (cues.length > MAX_CUES) return { cues: [], error: `These subtitles have ${cues.length} cues and a project takes at most ${MAX_CUES}.` };
    return { cues };
}
