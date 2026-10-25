// The MCP StudioSession of the project open in the editor (spec §5.7, §7.2). Editor calls run on the
// renderer's controller over the validated RPC; previews, exports, uploads, screenshots, and file reads
// stay in main. Commands carrying media desktop does not serve are refused here, before the renderer sees them.
// Phase 11: prices come from main's provider host (the keys live here); the agent's own ai.run calls are kept as job
// records for check_generation_status (the renderer's job tray keeps the person's). Projects are local: the session
// has no OpenNan project pipelines (those tools answer unavailable).
import type { PriceRegistry, StudioExporter, StudioHost, StudioSession, StudioUiState } from "@opennan/mcp";
import { createLocalFileReader, priceOnRegistry, voicesOnRegistry } from "@opennan/mcp";
import type { AiJobRecord } from "@opennan/provider-sdk";
import {
    timelineDurationSeconds, type CommandResult, type ControllerSnapshot, type EditorCommand, type EffectDef, type HistoryDepth,
    type MediaKind, type PreviewFrameResult, type RenderedFrame, type UploadedMedia,
} from "@opennan/timeline-core";
import { disallowedMediaUrls } from "../../shared/media-policy";
import type { MediaStore } from "../store/media-store";
import type { RendererRpc } from "./renderer-rpc";

/** ai.run waits on a provider job (a model download, then whisper.cpp): far longer than an edit. */
export const AI_RUN_TIMEOUT_MS = 30 * 60_000;

export const MEDIA_REFUSED = "OpenNan Studio desktop only uses media imported into the project (opennan-local://media/…). Import the file first (publish_video_to_timeline, publish_audio_to_timeline, or the media bin)";

export interface DesktopSessionOptions {
    projectId: string;
    rpc: RendererRpc;
    exporter: StudioExporter;
    mediaStore: Pick<MediaStore, "putBlob">;
    projectDir: string;
    capturePage?(): Promise<RenderedFrame>;
    /** Main's provider registry (provider host): prices and voices for agents. */
    providers?: PriceRegistry;
    /**
     * The user's routing pick for captions (Settings → AI providers, stored in main's settings): a cloud provider id
     * makes captions without an explicit engine run (and be priced) in the cloud; absent or "local" keeps them on the device.
     */
    captionsRoute?(): string | null;
}

/** The agent's ai.run calls through this session, newest first (at most this many kept). */
export const MAX_AGENT_JOBS = 50;

/** Job records of the agent's ai.run calls: running while the renderer works, then the command's outcome. */
function createAgentJobs(now: () => number = Date.now) {
    const records: AiJobRecord[] = [];
    let serial = 0;
    return {
        start(capability: string): AiJobRecord {
            const record: AiJobRecord = { jobId: `agent-run-${++serial}`, capability, status: "running", cancellable: true, startedAt: now() };
            records.unshift(record);
            records.splice(MAX_AGENT_JOBS);
            return record;
        },
        finish(record: AiJobRecord, result: CommandResult | null, error?: string): void {
            if (result?.jobId) record.jobId = result.jobId;
            const cost = (result?.output as { costUsd?: unknown } | undefined)?.costUsd;
            if (result?.ok) record.status = "succeeded";
            else if (result?.cancelled) record.status = "cancelled";
            else {
                record.status = "failed";
                record.error = error ?? result?.error ?? "unknown error";
            }
            if (typeof cost === "number" && Number.isFinite(cost)) record.costUsd = cost;
            record.cancellable = false;
            record.finishedAt = now();
        },
        list: () => records.map((record) => ({ ...record })),
    };
}

export async function createDesktopSession(options: DesktopSessionOptions): Promise<StudioSession> {
    const { projectId, rpc, exporter } = options;
    const readFile = await createLocalFileReader({ baseDir: options.projectDir });
    const host: StudioHost = {
        readFile,
        activePanel: () => null,
        ...(options.capturePage ? { snapshotPage: options.capturePage } : {}),
    };
    const snapshot = async () => (await rpc.call("snapshot")) as ControllerSnapshot;
    const jobs = createAgentJobs();
    const providers = options.providers;
    const session: StudioSession = {
        projectId,
        host,
        async execute(command: EditorCommand, executeOptions?: { signal?: AbortSignal }): Promise<CommandResult> {
            const refused = disallowedMediaUrls(command);
            if (refused.length > 0) return { ok: false, changed: {}, error: `${MEDIA_REFUSED}; refused: ${refused[0].slice(0, 200)}` };
            if (command.type !== "ai.run") return (await rpc.call("execute", [command])) as CommandResult;
            // Signals cannot cross IPC: a cancelled or timed-out call asks the renderer to cancel its agent jobs, so
            // no captions land after the agent was told the call failed.
            const cancel = () => void rpc.call("cancelAiRun").catch(() => undefined);
            executeOptions?.signal?.addEventListener("abort", cancel, { once: true });
            const job = jobs.start(command.capability);
            try {
                const result = (await rpc.call("execute", [command], { timeoutMs: AI_RUN_TIMEOUT_MS })) as CommandResult;
                jobs.finish(job, result);
                return result;
            } catch (error) {
                jobs.finish(job, null, error instanceof Error ? error.message : String(error));
                cancel();
                throw error;
            } finally {
                executeOptions?.signal?.removeEventListener("abort", cancel);
            }
        },
        snapshot,
        describeTimeline: async () => (await rpc.call("describeTimeline")) as string,
        uiState: async () => (await rpc.call("uiState")) as StudioUiState,
        historyDepth: async () => (await rpc.call("historyDepth")) as HistoryDepth,
        listEffects: async (kind) => (await rpc.call("listEffects", [kind])) as EffectDef[],
        async previewFrame(seconds, frameOptions = {}): Promise<PreviewFrameResult> {
            const current = await snapshot();
            const end = timelineDurationSeconds(current);
            const at = Math.min(Math.max(0, Number.isFinite(seconds) ? seconds : 0), end);
            try {
                return { ok: true, seconds: at, frame: await exporter.frameRenderer.renderFrame({ snapshot: current, seconds: at, ...frameOptions }) };
            } catch (error) {
                return { ok: false, seconds: at, error: error instanceof Error ? error.message : String(error) };
            }
        },
        exportStatus: async (jobId) => exporter.status(jobId),
        async uploadFile(file: Blob, kind: MediaKind): Promise<UploadedMedia> {
            const name = (file as Blob & { name?: string }).name ?? `${kind}`;
            const { id: _id, ...media } = await options.mediaStore.putBlob(file, { projectId, name, mimeType: file.type, kind });
            await rpc.call("saveToLibrary", [media]);
            return media;
        },
        aiJobs: async () => jobs.list(),
    };
    if (providers) {
        session.estimate = async (question) => {
            // Captions run on the device (on-device first, free) unless the run asks for the cloud or the user routed captions
            // to a cloud provider in Settings: then they are priced like any paid run.
            if (question.capability === "audio.transcribe" && question.engine !== "cloud") {
                const routed = options.captionsRoute?.() ?? null;
                if (question.engine === "local" || !routed || routed === "local") return { kind: "free", providerName: "On this device" };
            }
            return priceOnRegistry(providers, question);
        };
        session.voices = () => voicesOnRegistry(providers);
    }
    return session;
}
