// window.opennan: the only object the renderer gets from the preload (spec §7.2 "typed preload bridge").
// It carries no channel names, no ipcRenderer, and no filesystem or process API.
import type { ExportSessionState } from "@opennan/export";
import type {
    AudioInput, JobStatus, MediaSourceRef, PriceAnswer, PriceRequest, ProviderCapability, ProviderInfo, ProviderModel, ProviderVoice, Transcript,
} from "@opennan/provider-sdk";
import type { SessionNotice, SessionStatus } from "@opennan/provider-opennan";
import type { ControllerSnapshot, ExportCommandOutcome, LocalProjectState, MediaKind, UploadedMedia } from "@opennan/timeline-core";
import type { DesktopSettings, SecretName, SecretStatus, TerminalProfileId } from "./settings";

export interface McpInfo {
    running: boolean;
    url: string | null;
    port: number | null;
    projectId: string | null;
    /** Where the token file is (agents read it through the bridge; the token itself never reaches the renderer). */
    tokenFile: string;
    /** Per CLI: the config entry the terminal writes (stdio bridge), as text. */
    configs: Record<"claude" | "codex" | "gemini", string> & Partial<Record<"opencode" | "antigravity", string>>;
}

export interface AppInfo {
    version: string;
    platform: string;
    arch: string;
    ffmpeg: { available: boolean };
    whisper: { available: boolean };
}

/**
 * Main → renderer: one on-device job's state (transcription or stabilize). The last event carries the transcript, the
 * output (stabilize: the imported video), or the error.
 */
export interface AiJobEvent {
    jobId: string;
    status: JobStatus;
    progress?: number;
    message?: string;
    error?: string;
    transcript?: Transcript;
    output?: { media: ImportedOutputMedia[]; sourceSize?: PixelSize };
}

export interface ImportedOutputMedia {
    kind: "video" | "image" | "audio";
    /** opennan-local://media/<id>: main already stored the file. */
    url: string;
    name: string;
    mimeType: string;
    sizeBytes: number;
    durationSeconds?: number;
    /** Pixel size of a video or image (probed at import). */
    width?: number;
    height?: number;
}

/** Pixel size of the media a tool was given (a resized result is stacked at the source's size). */
export interface PixelSize {
    width: number;
    height: number;
}

export type ProviderErrorKind = "unavailable" | "insufficient-credits" | "failed";

/**
 * Main → renderer: one cloud provider job's state; the last event carries the output (imported media), the transcript
 * (cloud captions), or the error.
 */
export interface ProviderJobEvent {
    jobId: string;
    status: JobStatus;
    progress?: number;
    message?: string;
    /** false once the provider refused a cancel (its paid step started): the job will finish and be charged. */
    cancellable?: boolean;
    error?: string;
    errorKind?: ProviderErrorKind;
    /** The provider's error code (e.g. insufficient_balance, price_changed). */
    code?: string;
    /** The provider says the failed run was not charged. */
    refunded?: boolean;
    output?: { media: ImportedOutputMedia[]; result?: unknown; costUsd?: number; sourceSize?: PixelSize };
    transcript?: Transcript;
}

export type GpuVideoCodec = "avc" | "vp9" | "av1" | "vp8";

export interface GpuJobProgressReport {
    phase: "probe" | "raster" | "render" | "mux";
    ratio: number;
    etaSeconds?: number;
}

export interface GpuJobErrorReport {
    code: "empty-timeline" | "resolution-unsupported" | "no-encoder" | "media-read-failed" | "ffmpeg-failed" | "too-large" | "core-unavailable" | "no-audio" | "runner-unsupported" | "cancelled" | "unknown";
    message: string;
}

export type ConsolePageName = "billing" | "usage" | "keys";

export type SessionResponder = (method: string, args: unknown[]) => Promise<unknown>;

import type { AgentChatBridge } from "./agent-chat";

export interface DesktopBridge {
    chat: AgentChatBridge;
    readonly e2e: boolean;
    persistence: {
        load(projectId: string): Promise<LocalProjectState | null>;
        save(projectId: string, state: LocalProjectState): Promise<void>;
        list(): Promise<LocalProjectState[]>;
        delete(projectId: string): Promise<void>;
    };
    media: {
        import(projectId: string, file: File, kind: MediaKind): Promise<UploadedMedia>;
        /** Deletes a media file the project owns (main refuses files of other projects). */
        delete(projectId: string, id: string): Promise<void>;
    };
    exports: {
        start(options: Record<string, unknown>, snapshot: ControllerSnapshot): Promise<ExportCommandOutcome>;
        cancel(): Promise<void>;
        reset(): Promise<void>;
        state(): Promise<ExportSessionState>;
        onState(listener: (state: ExportSessionState) => void): () => void;
        fileInfo(path: string): Promise<{ size: number }>;
        reveal(path: string): Promise<void>;
        /** GPU export (phase 10c): open a job for the editor's encoded video, stream it, add the audio in main. */
        gpuBegin(options: { resolution?: "720p" | "1080p" | "4k"; format?: "video" | "gif" }, snapshot: ControllerSnapshot, container: "mp4" | "webm", codec?: GpuVideoCodec): Promise<{ jobId: string } | { error: string }>;
        gpuChunk(jobId: string, position: number, bytes: Uint8Array): Promise<void>;
        gpuMux(jobId: string): Promise<{ path: string }>;
        /** Ends the job: cancelled, or failed with `error` (main shows it to agents). */
        gpuAbort(jobId: string, error?: GpuJobErrorReport): Promise<void>;
        /** The job's progress for main's job state (agents' get_export_status). */
        gpuProgress(jobId: string, progress: GpuJobProgressReport): Promise<void>;
        /** The GPU path cannot take the project: main's native export runs it from the job's own snapshot. */
        gpuFallback(jobId: string): Promise<ExportCommandOutcome>;
        /** Main asks this window to stop its GPU job (a cancel that reached main, e.g. from an agent host). */
        onGpuCancel(listener: (jobId: string) => void): () => void;
    };
    session: {
        /** Serves the open project's editor to the MCP server in main; resolves to a detach function. */
        attach(projectId: string, respond: SessionResponder): Promise<() => Promise<void>>;
    };
    terminal: {
        start(projectId: string, profile: TerminalProfileId, cols: number, rows: number): Promise<string>;
        input(terminalId: string, data: string): void;
        resize(terminalId: string, cols: number, rows: number): void;
        kill(terminalId: string): void;
        onData(listener: (terminalId: string, data: string) => void): () => void;
        onExit(listener: (terminalId: string, code: number) => void): () => void;
    };
    settings: {
        get(): Promise<DesktopSettings>;
        update(patch: Partial<DesktopSettings>): Promise<DesktopSettings>;
    };
    secrets: {
        list(): Promise<SecretStatus[]>;
        set(name: SecretName, value: string): Promise<void>;
        remove(name: SecretName): Promise<void>;
    };
    mcp: { info(): Promise<McpInfo> };
    app: { info(): Promise<AppInfo> };
    /** Sign in with OpenNan: the account lives in main; the renderer sees statuses (never a key). */
    account: {
        status(): Promise<SessionStatus>;
        start(signup: boolean): Promise<void>;
        reopen(): Promise<void>;
        cancel(): Promise<void>;
        signOut(): Promise<void>;
        switchAccount(): Promise<void>;
        refresh(): Promise<void>;
        openConsole(page: ConsolePageName): Promise<void>;
        /** "OpenNan API key (advanced)": the one call that carries a key, typed by the person, into main. */
        connectKey(key: string): Promise<void>;
        onChanged(listener: (status: SessionStatus) => void): () => void;
        onNotice(listener: (notice: SessionNotice) => void): () => void;
    };
    /** Cloud providers whose jobs run in main (OpenNan, and fal with a stored key). */
    providers: {
        list(): Promise<ProviderInfo[]>;
        models(providerId: string, capability: ProviderCapability): Promise<ProviderModel[]>;
        run(request: { providerId: string; capability: ProviderCapability; input: Record<string, unknown>; projectId: string }): Promise<{ jobId: string }>;
        /** Cloud captions (audio.transcribe); the job's last event carries the transcript. */
        transcribe(request: { providerId: string; audio: AudioInput; language?: string; model?: string; expectedMaxUsd?: number }): Promise<{ jobId: string }>;
        /** false: the provider refused (its paid step started) and the job runs on. */
        cancel(jobId: string): Promise<{ cancelled: boolean; message?: string }>;
        price(providerId: string, request: PriceRequest): Promise<PriceAnswer>;
        voices(providerId: string): Promise<ProviderVoice[]>;
        onJob(listener: (event: ProviderJobEvent) => void): () => void;
    };
    /** On-device AI in main: transcription (provider-local, whisper.cpp) and stabilize (ffmpeg deshake). */
    ai: {
        status(): Promise<{ available: boolean; reason: string | null }>;
        models(): Promise<ProviderModel[]>;
        /**
         * Starts transcribing the snapshot's timeline audio, or one imported media's range (source); progress and the
         * result arrive through onJob.
         */
        transcribe(input: { language?: string; model?: string } & ({ snapshot: ControllerSnapshot } | { source: MediaSourceRef })): Promise<{ jobId: string }>;
        /** Stabilizes one imported media's range with ffmpeg's deshake; the last event carries the imported video. */
        stabilize(input: { projectId: string; source: MediaSourceRef }): Promise<{ jobId: string }>;
        cancel(jobId: string): Promise<void>;
        onJob(listener: (event: AiJobEvent) => void): () => void;
    };
}

/** Largest path-less file the preload reads into memory for an import (matches main's cap). */
export const MAX_IN_MEMORY_IMPORT = 512 * 1024 * 1024;
export const EXPORT_PORTS_MESSAGE = "opennan:export-ports";
export const E2E_ARGUMENT = "--opennan-e2e";
