// The MCP StudioSession of the project open in the editor (spec §5.7, §7.2). Editor calls run on the
// renderer's controller over the validated RPC; previews, exports, uploads, screenshots, and file reads
// stay in main. Commands carrying media desktop does not serve are refused here, before the renderer sees them.
// Phase 11: prices come from main's provider host (the keys live here); the agent's own ai.run calls are kept as job
// records for check_generation_status (the renderer's job tray keeps the person's). Phase 9a: cloud project tools run
// on the renderer's cloud runtime over the same RPC (answers checked in renderer-rpc.ts and copied field by field).
// Phase 9b: the project pipeline seam (StudioCloud.pipelines) runs there too, over the renderer's CloudApi proxy (the
// key stays in main's cloud host); a step's task is followed in the renderer, whose controller records its result.
import type {
    PriceRegistry, StudioCloud, StudioCloudPipelines, StudioCloudProject, StudioCloudShares, StudioShareLink, StudioExporter, StudioHost, StudioPipelineQuote, StudioPipelineResult, StudioPipelineStep,
    StudioSession, StudioUiState,
} from "@opennan/mcp";
import { ShareNotAllowedError, createLocalFileReader, priceOnRegistry, voicesOnRegistry } from "@opennan/mcp";
import type { AiJobRecord } from "@opennan/provider-sdk";
import {
    timelineDurationSeconds, type CommandResult, type ControllerSnapshot, type EditorCommand, type EffectDef, type HistoryDepth,
    type MediaKind, type PreviewFrameResult, type RenderedFrame, type UploadedMedia,
} from "@opennan/timeline-core";
import { disallowedMediaUrls } from "../../shared/media-policy";
import type { MediaStore } from "../store/media-store";
import { RendererTimeoutError, type RendererRpc } from "./renderer-rpc";

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
    /** Whether an agent's share link needs the person's yes (9c.1); a fresh one per session when absent (always asks). */
    shareConsent?: ShareConsent;
    /** Main's own deadline for the person's answer (SHARE_CONFIRM_TIMEOUT_MS); tests shorten it. */
    shareConfirmTimeoutMs?: number;
}

/**
 * When an agent may make a public share link without asking (9c.1): the person turned asking off in Settings, or
 * chose "Allow for this project during this session" (kept in memory until the app quits).
 */
export interface ShareConsent {
    withoutAsking(): boolean;
    allowedForSession(projectId: string): boolean;
    allowForSession(projectId: string): void;
}

export function createShareConsent(withoutAsking: () => boolean): ShareConsent {
    const allowed = new Set<string>();
    return {
        withoutAsking,
        allowedForSession: (projectId) => allowed.has(projectId),
        allowForSession: (projectId) => void allowed.add(projectId),
    };
}

/**
 * The renderer closes the question as unanswered after 2 minutes (SHARE_CONFIRM_MS there); main waits a little longer
 * and counts its own deadline as unanswered too.
 */
export const SHARE_CONFIRM_TIMEOUT_MS = 2 * 60_000 + 15_000;

/** Save to OpenNan uploads the project's media first: far longer than an edit. */
export const CLOUD_SAVE_TIMEOUT_MS = 30 * 60_000;

/** A project pipeline task runs up to an hour (director-client's deadline), then its result is pulled into the editor. */
export const PIPELINE_RUN_TIMEOUT_MS = 65 * 60_000;
/** A no-charge scene edit answers at once, then waits a few seconds for the editor to pull it. */
export const PIPELINE_EDIT_TIMEOUT_MS = 60_000;

const stepOf = (step: StudioPipelineStep) => ({
    tool: step.tool, ...(step.sceneId !== undefined ? { sceneId: step.sceneId } : {}), ...(step.index !== undefined ? { index: step.index } : {}), body: step.body, label: step.label,
});

/**
 * The pipeline seam of a desktop session. Signals cannot cross IPC, and a submitted step is not cancelled when the MCP
 * call stops waiting: the task keeps running on OpenNan and its result still lands in the editor through sync.
 */
export function createDesktopPipelines(rpc: RendererRpc): StudioCloudPipelines {
    return {
        async quote(step) {
            const value = (await rpc.call("cloud.quote", [{ step: stepOf(step) }])) as StudioPipelineQuote;
            if (value.kind === "quote") return { kind: "quote", priceUsd: value.priceUsd, holdUsd: value.holdUsd };
            if (value.kind === "refused") return { kind: "refused", code: value.code, message: value.message };
            return { kind: "unavailable" };
        },
        async run(step, options = {}) {
            const value = (await rpc.call("cloud.run", [{ step: stepOf(step), ...(options.maxHoldUsd !== undefined ? { maxHoldUsd: options.maxHoldUsd } : {}) }], { timeoutMs: PIPELINE_RUN_TIMEOUT_MS })) as StudioPipelineResult;
            return {
                taskId: value.taskId, status: value.status, chargedUsd: value.chargedUsd, projectRevision: value.projectRevision, synced: value.synced, undoable: value.undoable,
                error: value.error ? { message: value.error.message, code: value.error.code, refunded: value.error.refunded } : null,
            };
        },
        async editScene(edit) {
            const value = (await rpc.call("cloud.edit", [{ ...edit }], { timeoutMs: PIPELINE_EDIT_TIMEOUT_MS })) as { synced: boolean };
            return { synced: value.synced };
        },
        async setScript(texts) {
            await rpc.call("cloud.script", [{ ...texts }]);
        },
    };
}

/** The cloud seam of a desktop session: the renderer answers from runtime.cloud (signed out: an error to show); `ask` gets the person's yes before an agent's public link. */
export function createDesktopCloud(rpc: RendererRpc, ask: (signal?: AbortSignal) => Promise<void>): StudioCloud {
    const opened = (value: unknown) => {
        const v = value as { projectId: string; name: string };
        return { projectId: v.projectId, name: v.name };
    };
    return {
        async listProjects({ trash, cursor }) {
            const page = (await rpc.call("cloud.list", [{ trash: trash === true, cursor: cursor ?? null }])) as { projects: StudioCloudProject[]; nextCursor: string | null };
            return {
                projects: page.projects.map((p) => ({
                    id: p.id, name: p.name, aspectRatio: p.aspectRatio, durationSeconds: p.durationSeconds, mediaBytes: p.mediaBytes, updatedAt: p.updatedAt,
                    lastEditedDevice: p.lastEditedDevice, origin: p.origin, deletedAt: p.deletedAt,
                })),
                nextCursor: page.nextCursor,
            };
        },
        saveCurrentProject: async () => opened(await rpc.call("cloud.save", [{}], { timeoutMs: CLOUD_SAVE_TIMEOUT_MS })),
        openProject: async (projectId) => opened(await rpc.call("cloud.open", [{ projectId }])),
        async syncStatus(projectId) {
            const status = (await rpc.call("cloud.status", [projectId === undefined ? {} : { projectId }])) as { projectId: string; state: string; label: string; pending: number; conflicts: string[] } | null;
            return status ? { projectId: status.projectId, state: status.state, label: status.label, pending: status.pending, conflicts: [...status.conflicts] } : null;
        },
        pipelines: createDesktopPipelines(rpc),
        shares: createDesktopShares(rpc, ask),
    };
}

/**
 * Asks the person in the editor before an agent makes a public link of `projectId` (9c.1), unless their setting or an
 * earlier "Allow for this project during this session" says not to. Throws ShareNotAllowedError on a no or no answer.
 */
export function createShareAsk(rpc: RendererRpc, projectId: string, consent: ShareConsent, timeoutMs = SHARE_CONFIRM_TIMEOUT_MS): (signal?: AbortSignal) => Promise<void> {
    return async (signal) => {
        if (signal?.aborted) throw new ShareNotAllowedError("unanswered");
        if (consent.withoutAsking() || consent.allowedForSession(projectId)) return;
        let answer: unknown;
        let onAbort: (() => void) | null = null;
        try {
            answer = await Promise.race([
                rpc.call("confirmShare", [{}], { timeoutMs }),
                // The agent's call ended (cancelled, timed out): the question closes in the editor and counts as no answer.
                new Promise<never>((_resolve, reject) => {
                    onAbort = () => {
                        void rpc.call("cancelConfirmShare").catch(() => undefined);
                        reject(new ShareNotAllowedError("unanswered"));
                    };
                    signal?.addEventListener("abort", onAbort, { once: true });
                }),
            ]);
        } catch (error) {
            if (error instanceof RendererTimeoutError) throw new ShareNotAllowedError("unanswered");
            throw error;
        } finally {
            if (onAbort) signal?.removeEventListener("abort", onAbort);
        }
        if (signal?.aborted) throw new ShareNotAllowedError("unanswered");
        if (answer === "allow") return;
        if (answer === "allow-session") {
            consent.allowForSession(projectId);
            return;
        }
        throw new ShareNotAllowedError(answer === "timeout" ? "unanswered" : "declined");
    };
}

/** Share links of the open cloud project (phase 9c): the renderer answers over its cloud API client (the key stays in main). */
function createDesktopShares(rpc: RendererRpc, ask: (signal?: AbortSignal) => Promise<void>): StudioCloudShares {
    const link = (value: unknown): StudioShareLink => {
        const v = value as StudioShareLink;
        return { id: v.id, url: v.url, status: v.status, allowDownload: v.allowDownload, expiresAt: v.expiresAt, createdAt: v.createdAt, revokedAt: v.revokedAt, views: v.views, lastViewedAt: v.lastViewedAt };
    };
    return {
        // A public link: the person says yes first (9c.1). Listing and turning off never ask.
        create: async (options, run = {}) => {
            await ask(run.signal);
            if (run.signal?.aborted) throw new ShareNotAllowedError("unanswered");
            return link(await rpc.call("cloud.shareCreate", [{ ...options }]));
        },
        list: async () => ((await rpc.call("cloud.shareList", [{}])) as unknown[]).map(link),
        revoke: async (shareId) => ((await rpc.call("cloud.shareRevoke", [shareId ? { shareId } : {}])) as unknown[]).map(link),
    };
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
        cloud: createDesktopCloud(rpc, createShareAsk(rpc, projectId, options.shareConsent ?? createShareConsent(() => false), options.shareConfirmTimeoutMs)),
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
