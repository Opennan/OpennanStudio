// The renderer ↔ main contract: channel names and one zod schema per renderer → main payload. Every such
// call is an ipcRenderer.invoke checked by main/ipc/handle.ts (sender origin first, then the schema), so a
// compromised renderer can only send what these schemas allow. Bounds keep payloads finite.
import type { ExportErrorCode } from "@opennan/export";
import { OPEN_CAPABILITIES, OPENNAN_CAPABILITIES } from "@opennan/provider-sdk";
import { z } from "zod";
import { IPC } from "./channels";
import { CHAT_PROFILES } from "./agent-chat";
import { UUID } from "./ids";
import { localMediaId } from "./media-policy";
import { SECRET_NAMES, SettingsPatchSchema, TERMINAL_PROFILES } from "./settings";

export { IPC, EVENTS } from "./channels";

export const MAX_STATE_BYTES = 64 * 1024 * 1024;
export const MAX_IMPORT_BYTES = 512 * 1024 * 1024;
/** One GPU export chunk (mediabunny's chunked stream target writes 16 MiB). */
export const MAX_GPU_CHUNK_BYTES = 32 * 1024 * 1024;
export const MAX_GPU_CHUNK_POSITION = 32 * 1024 * 1024 * 1024;
/** Longest error message the editor may report for its GPU export job. */
export const MAX_GPU_ERROR_MESSAGE = 2000;
/** Largest time-left estimate the editor may report (a week); main clamps to it. */
export const MAX_GPU_ETA_SECONDS = 7 * 24 * 3600;
/** The GPU export's phases (ExportProgress["phase"] without the ffmpeg path's encode). */
export const GPU_PHASES = ["probe", "raster", "render", "mux"] as const;
/** ExportErrorCode (@opennan/export) plus "unknown": the only error codes a GPU job may report. */
export const EXPORT_ERROR_CODES = [
    "empty-timeline", "resolution-unsupported", "no-encoder", "media-read-failed", "ffmpeg-failed", "too-large", "core-unavailable", "no-audio",
    "runner-unsupported", "cancelled", "unknown",
] as const satisfies ReadonlyArray<ExportErrorCode | "unknown">;
/** WebCodecs codecs of the GPU export (GPU_CODECS in @opennan/export); avc goes in MP4, the rest in WebM. */
export const GPU_VIDEO_CODECS = ["avc", "vp9", "av1", "vp8"] as const;

export const Uuid = z.string().regex(UUID, "must be an id");
/** A project the editor can open: a local project's id (projects stay on this device). */
export const ProjectRef = Uuid;
/** createJob ids (job-<base36>). */
export const AiJobId = z.string().regex(/^job-[A-Za-z0-9_-]{1,64}$/, "must be a job id");
/** provider host job ids (job-main<n>). */
export const ProviderJobId = z.string().regex(/^job-main\d{1,9}$/, "must be a provider job id");
export const ProviderIdSchema = z.enum(["opennan", "fal"]);
export const ProviderCapabilitySchema = z.enum([...OPEN_CAPABILITIES, ...OPENNAN_CAPABILITIES]);
export const MAX_PROVIDER_INPUT_BYTES = 64 * 1024;
export const MediaKindSchema = z.enum(["video", "audio", "image"]);
const Row = z.record(z.string(), z.unknown());
const SourceSeconds = z.number().finite().min(0).max(86_400);
/** A range of media imported into the project (MediaSourceRef): AI tools in main never take links or paths. */
export const LocalMediaSourceSchema = z.object({
    mediaUrl: z.string().max(4096).refine((url) => localMediaId(url) !== null, { message: "must be media imported into the project" }),
    startSeconds: SourceSeconds.optional(),
    endSeconds: SourceSeconds.optional(),
}).strict().refine((ref) => ref.startSeconds === undefined || ref.endSeconds === undefined || ref.endSeconds > ref.startSeconds, { message: "endSeconds must come after startSeconds" });
const Empty = z.object({}).strict();

/** JSON size in UTF-16 code units (a cheap bound that works in every process). */
function jsonBytes(value: unknown): number {
    try {
        return (JSON.stringify(value) ?? "").length;
    } catch {
        return Number.POSITIVE_INFINITY;
    }
}

export function projectStateSchema(maxBytes = MAX_STATE_BYTES) {
    return z.object({
        meta: z.object({ id: Uuid, name: z.string().max(500) }).passthrough(),
        tracks: z.array(Row).max(1000),
        clips: z.array(Row).max(100_000),
        scenes: z.array(Row).max(10_000),
        library: z.array(Row).max(100_000).optional(),
        uploads: z.array(z.string().max(100)).max(100_000).optional(),
        createdAt: z.number().finite().optional(),
        updatedAt: z.number().finite().optional(),
    }).passthrough().refine((state) => jsonBytes(state) <= maxBytes, { message: `project state is larger than ${maxBytes} bytes` });
}

export const SnapshotSchema = z.object({
    projectId: z.string().max(100).optional(),
    project: Row.nullable().optional(),
    tracks: z.array(Row).max(1000),
    clips: z.array(Row).max(100_000),
    scenes: z.array(Row).max(10_000),
}).passthrough().refine((snapshot) => jsonBytes(snapshot) <= MAX_STATE_BYTES, { message: "snapshot is too large" });

export function importBytesSchema(maxBytes = MAX_IMPORT_BYTES) {
    return z.object({
        projectId: ProjectRef,
        name: z.string().min(1).max(255),
        mimeType: z.string().max(127),
        kind: MediaKindSchema,
        bytes: z.instanceof(Uint8Array).refine((bytes) => bytes.byteLength <= maxBytes, { message: `larger than ${maxBytes} bytes` }),
    }).strict();
}

const Path = z.string().min(1).max(4096).refine((value) => !value.includes("\0"), { message: "invalid path" });
const Cols = z.number().int().min(2).max(1000);
const Rows = z.number().int().min(2).max(500);

export const PAYLOADS = {
    [IPC.chatAvailability]: Empty,
    [IPC.chatState]: z.object({ projectId: ProjectRef, profile: z.enum(CHAT_PROFILES) }).strict(),
    [IPC.chatSend]: z.object({ projectId: ProjectRef, profile: z.enum(CHAT_PROFILES), message: z.string().trim().min(1).max(12_000) }).strict(),
    [IPC.chatStop]: z.object({ projectId: ProjectRef, profile: z.enum(CHAT_PROFILES) }).strict(),
    [IPC.chatReset]: z.object({ projectId: ProjectRef, profile: z.enum(CHAT_PROFILES) }).strict(),
    [IPC.persistenceLoad]: z.object({ projectId: Uuid }).strict(),
    [IPC.persistenceSave]: z.object({ projectId: Uuid, state: projectStateSchema() }).strict(),
    [IPC.persistenceList]: Empty,
    [IPC.persistenceDelete]: z.object({ projectId: Uuid }).strict(),
    [IPC.mediaImportPath]: z.object({ projectId: ProjectRef, path: Path, kind: MediaKindSchema }).strict(),
    [IPC.mediaImportBytes]: importBytesSchema(),
    // Only a file the project owns.
    [IPC.mediaDelete]: z.object({ projectId: ProjectRef, id: Uuid }).strict(),
    [IPC.exportStart]: z.object({
        options: z.object({ resolution: z.enum(["720p", "1080p", "4k"]).optional(), format: z.enum(["video", "gif"]).optional() }).strict(),
        snapshot: SnapshotSchema,
    }).strict(),
    [IPC.exportCancel]: Empty,
    [IPC.exportReset]: Empty,
    [IPC.exportState]: Empty,
    [IPC.exportFileInfo]: z.object({ path: Path }).strict(),
    [IPC.exportGpuBegin]: z.object({
        options: z.object({ resolution: z.enum(["720p", "1080p", "4k"]).optional(), format: z.enum(["video", "gif"]).optional() }).strict(),
        snapshot: SnapshotSchema,
        container: z.enum(["mp4", "webm"]),
        codec: z.enum(GPU_VIDEO_CODECS).optional(),
    }).strict().refine((begin) => !begin.codec || (begin.codec === "avc") === (begin.container === "mp4"), { message: "codec does not match the container" }),
    [IPC.exportGpuChunk]: z.object({
        jobId: Uuid,
        position: z.number().int().nonnegative().max(MAX_GPU_CHUNK_POSITION),
        bytes: z.instanceof(Uint8Array).refine((bytes) => bytes.byteLength > 0 && bytes.byteLength <= MAX_GPU_CHUNK_BYTES, { message: "chunk size" }),
    }).strict(),
    [IPC.exportGpuMux]: z.object({ jobId: Uuid }).strict(),
    // Ends the window's GPU job: without an error it was cancelled; with one it failed (code from the list, short text).
    [IPC.exportGpuAbort]: z.object({
        jobId: Uuid,
        error: z.object({ code: z.enum(EXPORT_ERROR_CODES), message: z.string().max(MAX_GPU_ERROR_MESSAGE) }).strict().optional(),
    }).strict(),
    // Progress of the window's GPU job: numbers and an enum only (main adds engine "gpu" and clamps).
    [IPC.exportGpuProgress]: z.object({
        jobId: Uuid,
        phase: z.enum(GPU_PHASES),
        ratio: z.number().finite(),
        etaSeconds: z.number().finite().nonnegative().optional(),
    }).strict(),
    // The GPU path cannot take the project after all: main ends the job and runs its native export from the
    // snapshot the job began with (nothing else crosses).
    [IPC.exportGpuFallback]: z.object({ jobId: Uuid }).strict(),
    [IPC.exportReveal]: z.object({ path: Path }).strict(),
    [IPC.sessionAttach]: z.object({ projectId: ProjectRef }).strict(),
    [IPC.sessionDetach]: z.object({ projectId: ProjectRef }).strict(),
    [IPC.sessionResponse]: z.union([
        z.object({ id: z.number().int().nonnegative(), ok: z.literal(true), value: z.unknown() }).strict(),
        z.object({ id: z.number().int().nonnegative(), ok: z.literal(false), error: z.string().max(4000) }).strict(),
    ]),
    [IPC.terminalStart]: z.object({ projectId: ProjectRef, profile: z.enum(TERMINAL_PROFILES), cols: Cols, rows: Rows }).strict(),
    [IPC.terminalInput]: z.object({ terminalId: Uuid, data: z.string().max(64 * 1024) }).strict(),
    [IPC.terminalResize]: z.object({ terminalId: Uuid, cols: Cols, rows: Rows }).strict(),
    [IPC.terminalKill]: z.object({ terminalId: Uuid }).strict(),
    [IPC.settingsGet]: Empty,
    [IPC.settingsUpdate]: SettingsPatchSchema,
    [IPC.secretsList]: Empty,
    [IPC.secretsSet]: z.object({ name: z.enum(SECRET_NAMES), value: z.string().max(4096) }).strict(),
    [IPC.secretsRemove]: z.object({ name: z.enum(SECRET_NAMES) }).strict(),
    [IPC.mcpInfo]: Empty,
    [IPC.appInfo]: Empty,
    [IPC.aiStatus]: Empty,
    [IPC.aiModels]: Empty,
    // The language is checked against whisper's list in provider-local; models are the catalog's ids. The audio is the
    // timeline's mix (snapshot) or one imported media's range (source), never both.
    [IPC.aiTranscribe]: z.object({
        language: z.string().regex(/^(auto|[a-z]{2,3})$/, "must be auto or a language code").optional(),
        model: z.enum(["tiny", "base", "small"]).optional(),
        snapshot: SnapshotSchema.optional(),
        source: LocalMediaSourceSchema.optional(),
    }).strict().refine((input) => (input.snapshot === undefined) !== (input.source === undefined), { message: "send a snapshot or a media source" }),
    [IPC.aiCancel]: z.object({ jobId: AiJobId }).strict(),
    // Stabilize on this device: one imported media's range, the result imported into the project's media.
    [IPC.aiStabilize]: z.object({ projectId: ProjectRef, source: LocalMediaSourceSchema }).strict(),
    [IPC.accountStatus]: Empty,
    [IPC.accountStart]: z.object({ signup: z.boolean().optional() }).strict(),
    [IPC.accountReopen]: Empty,
    [IPC.accountCancel]: Empty,
    [IPC.accountSignOut]: Empty,
    [IPC.accountSwitch]: Empty,
    [IPC.accountRefresh]: Empty,
    [IPC.accountOpenConsole]: z.object({ page: z.enum(["billing", "usage", "keys"]) }).strict(),
    [IPC.accountConnectKey]: z.object({ key: z.string().trim().regex(/^sk-[A-Za-z0-9_-]{20,200}$/, "must be an OpenNan API key") }).strict(),
    [IPC.providersList]: Empty,
    [IPC.providersModels]: z.object({ providerId: ProviderIdSchema, capability: ProviderCapabilitySchema }).strict(),
    [IPC.providersRun]: z.object({
        providerId: ProviderIdSchema,
        capability: ProviderCapabilitySchema,
        input: Row.refine((input) => jsonBytes(input) <= MAX_PROVIDER_INPUT_BYTES, { message: `input is larger than ${MAX_PROVIDER_INPUT_BYTES} bytes` }),
        projectId: ProjectRef,
    }).strict(),
    [IPC.providersCancel]: z.object({ jobId: ProviderJobId }).strict(),
    // Cloud captions: the timeline's mix or one imported media's range; main prepares and uploads the audio.
    [IPC.providersTranscribe]: z.object({
        providerId: ProviderIdSchema,
        audio: z.union([
            z.object({ kind: z.literal("timeline"), snapshot: SnapshotSchema }).strict(),
            z.object({
                kind: z.literal("media"),
                url: z.string().max(4096).refine((url) => localMediaId(url) !== null, { message: "must be media imported into the project" }),
                startSeconds: SourceSeconds.optional(),
                endSeconds: SourceSeconds.optional(),
            }).strict().refine((audio) => audio.startSeconds === undefined || audio.endSeconds === undefined || audio.endSeconds > audio.startSeconds, { message: "endSeconds must come after startSeconds" }),
        ]),
        language: z.string().regex(/^(auto|[A-Za-z]{2,3})$/, "must be auto or a language code").optional(),
        model: z.string().regex(/^[A-Za-z0-9._-]{1,100}$/, "must be a model id").optional(),
        expectedMaxUsd: z.number().finite().nonnegative().max(100_000).optional(),
    }).strict(),
    // A price question: the run's input (small JSON) and the units Studio knows before sending.
    [IPC.providersPrice]: z.object({
        providerId: ProviderIdSchema,
        request: z.object({
            capability: ProviderCapabilitySchema,
            input: Row.refine((input) => jsonBytes(input) <= MAX_PROVIDER_INPUT_BYTES, { message: `input is larger than ${MAX_PROVIDER_INPUT_BYTES} bytes` }),
            units: z.object({
                seconds: z.number().finite().nonnegative().max(1_000_000).optional(),
                characters: z.number().int().nonnegative().max(100_000_000).optional(),
                segments: z.number().int().nonnegative().max(1_000_000).optional(),
                resolution: z.string().max(20).optional(),
                images: z.number().int().nonnegative().max(1000).optional(),
            }).strict(),
        }).strict(),
    }).strict(),
    [IPC.providersVoices]: z.object({ providerId: ProviderIdSchema }).strict(),
} as const;

export type IpcChannel = keyof typeof PAYLOADS;
export type IpcPayload<C extends IpcChannel> = z.infer<(typeof PAYLOADS)[C]>;
