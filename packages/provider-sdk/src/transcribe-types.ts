// Transcription request and result shapes (audio.transcribe).

/** What to transcribe. "timeline": the mixed audio of a timeline snapshot, rendered by the host. */
/** "media": one media file, optionally a source range of it (phase 11: a clip's used range). */
export type AudioInput = { kind: "timeline"; snapshot: unknown } | { kind: "media"; url: string; startSeconds?: number; endSeconds?: number };

export interface TranscribeRequest {
    audio: AudioInput;
    /** "auto" or a language code from WHISPER_LANGUAGES. Default "auto". */
    language?: string;
    /** A model id from the provider's models(); default: the provider's default. */
    model?: string;
    /**
     * Paid engines (phase 11): the estimate the caller showed, in dollars. A provider that finds the prepared audio
     * would cost more stops before sending anything ("The price changed").
     */
    expectedMaxUsd?: number;
}

export interface TranscriptWord {
    start: number;
    end: number;
    text: string;
}

export interface TranscriptSegment {
    /** Seconds from the start of the audio. */
    start: number;
    end: number;
    text: string;
    words?: TranscriptWord[];
}

export interface Transcript {
    /** Detected or requested language code. */
    language: string;
    durationSeconds?: number;
    segments: TranscriptSegment[];
    model?: string;
    /** What a cloud provider charged for the transcription, in US dollars (phase 11). */
    costUsd?: number;
}
