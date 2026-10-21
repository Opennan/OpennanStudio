// StudioSession: what the MCP server needs from a host. Hosts implement it over
// their own TimelineController (desktop, phase 6) or use createControllerSession.
import type {
    AudioTarget, CommandResult, ControllerSnapshot, EditorCommand, EditorStore, EffectDef, HistoryDepth, MediaKind,
    PreviewFrameOptions, PreviewFrameResult, RenderedFrame, SelectedTransition, TimelineBackend, TimelineController,
    TimelineMarker, TimelineToolMode, UploadedMedia,
} from "@opennan/timeline-core";
import type { AiJobBook, AiJobRecord, ProviderVoice } from "@opennan/provider-sdk";
import type { ExportJobStatus, StudioExporter } from "./export";
import { priceOnRegistry, voicesOnRegistry, type PriceQuestion, type PriceRegistry, type PriceReply } from "./prices";

export interface StudioUiState {
    currentTime: number;
    isPlaying: boolean;
    shuttleSpeed: number;
    zoom: number;
    toolMode: TimelineToolMode;
    snapEnabled: boolean;
    selection: {
        clipIds: string[];
        sceneId: string | null;
        transition: SelectedTransition | null;
        audioTarget: AudioTarget | null;
        markerId: string | null;
    };
    markers: TimelineMarker[];
    canUndo: boolean;
    canRedo: boolean;
    /** Open side panel of the editor UI; null in headless hosts. */
    activePanel: string | null;
}

/** Editor UI features. Every member is optional: headless hosts have none. */
export interface StudioHost {
    openPanel?(panel: string): Promise<void>;
    snapshotPage?(): Promise<RenderedFrame>;
    activePanel?(): string | null;
    /**
     * Reads a local file for publish_audio_to_timeline / publish_video_to_timeline.
     * Agents choose the path, so the host applies an access policy: headless mode
     * accepts only `kind` files inside the project folder or an --allow-dir root (Task 19b).
     */
    readFile?(path: string, kind: "audio" | "video"): Promise<File>;
    /** Installed graphics template ids. When present, add_graphics_clip refuses other ids. */
    graphicsTemplateIds?(): Promise<string[]>;
}

/** A cloud project as the cloud tools list it. */
export interface StudioCloudProject {
    id: string;
    name: string;
    aspectRatio: string;
    durationSeconds: number;
    mediaBytes: number;
    updatedAt: number;
    lastEditedDevice: string | null;
    origin: "studio" | "web";
    deletedAt: number | null;
}

/** The OpenNan project pipeline a priced step runs (the route's tool id, as POST /v1/quotes names it). */
export type StudioPipelineTool = "story-scenes" | "storyboard" | "smart-scene-video" | "copy-video-detect" | "copy-video-edit" | "copy-video-recreate";

/** One priced pipeline step on the open cloud project. */
export interface StudioPipelineStep {
    tool: StudioPipelineTool;
    /** The scene's id (every tool but story-scenes). */
    sceneId?: string;
    /** 0-based shot index (copy-video-edit). */
    index?: number;
    /** The route's JSON body, as the REST route takes it (snake_case; only that route's fields). */
    body: Record<string, unknown>;
    /** Plain words for the step, used for its undo entry ("Storyboard of scene 2"). */
    label: string;
}

/** OpenNan's price for a step (POST /v1/quotes): what a submit holds now; the run settles at most that. */
export type StudioPipelineQuote =
    | { kind: "quote"; priceUsd: number; holdUsd: number }
    /** The route refuses this step (with OpenNan's reason): it would not run. */
    | { kind: "refused"; code: string; message: string }
    /** No price right now (offline, an older server, busy): nothing runs unpriced. */
    | { kind: "unavailable" };

/** How a submitted step ended. */
export interface StudioPipelineResult {
    taskId: string;
    status: "succeeded" | "failed" | "cancelled";
    /** What the run settled at, when OpenNan reports it. */
    chargedUsd: number | null;
    /** The project revision the result landed in (a succeeded task). */
    projectRevision: number | null;
    /** The editor's project holds that revision. */
    synced: boolean;
    /** The result is one undo step in the editor's history. */
    undoable: boolean;
    error: { message: string; code: string | null; refunded: boolean } | null;
}

/** A no-charge scene edit OpenNan makes at once (copy-video source, a copied shot's words). */
export type StudioSceneEdit =
    | { kind: "copy-video-source"; sceneId: string; videoUrl: string; trimStart?: number; trimEnd?: number }
    | { kind: "shot-text"; sceneId: string; index: number; action: string };

/**
 * OpenNan project pipelines of the open cloud project (phase 9b), answered by the host over its cloud API client (the
 * key stays with the host). The MCP handlers resolve scenes, check `accept_max_usd` against `quote` and only then
 * call `run`; prices are never estimated locally.
 */
export interface StudioCloudPipelines {
    quote(step: StudioPipelineStep): Promise<StudioPipelineQuote>;
    /**
     * Submits the step (a fresh Idempotency-Key), follows its task to the end and has the editor pull until it holds
     * the task's project revision (one undo step where the host supports it). With `maxHoldUsd` the host refuses
     * (throws) when its own quote is missing or above it. A refused submit (402, 409, …) throws with OpenNan's message.
     */
    run(step: StudioPipelineStep, options?: { maxHoldUsd?: number; signal?: AbortSignal }): Promise<StudioPipelineResult>;
    /** A no-charge scene edit; the editor pulls the change. */
    editScene(edit: StudioSceneEdit): Promise<{ synced: boolean }>;
    /** Stores the project's script text and/or SRT subtitles (null clears one; scenes are untouched). */
    setScript(texts: { scriptText?: string | null; srtContent?: string | null }): Promise<void>;
}

/** A view-only share link of a cloud project (phase 9c), as the host reports it: the link only while it is active. */
export interface StudioShareLink {
    id: string;
    /** https://opennan.com/s/<token> while active; null once turned off or expired. */
    url: string | null;
    status: "active" | "expired" | "revoked";
    allowDownload: boolean;
    expiresAt: number | null;
    createdAt: number | null;
    revokedAt: number | null;
    views: number;
    lastViewedAt: number | null;
}

/** Share links of the open cloud project (phase 9c), answered by the host over its cloud API client. */
export interface StudioCloudShares {
    /**
     * Creates the project's link (or replaces it: the old one stops at once). A public link: the host asks the person
     * first (or follows their setting) and throws ShareNotAllowedError when they decline or leave it unanswered (9c.1);
     * `signal` (the agent's call ended) closes an open question as unanswered.
     * Throws with OpenNan's reason otherwise.
     */
    create(options: { expiresInDays?: number; allowDownload?: boolean }, run?: { signal?: AbortSignal }): Promise<StudioShareLink>;
    list(): Promise<StudioShareLink[]>;
    /** Turns one link off, or (no id) every active one; answers exactly the links turned off. Never asks the person. */
    revoke(shareId?: string): Promise<StudioShareLink[]>;
}

/** OpenNan cloud projects on the host (phase 9a): the desktop app signed in to OpenNan. */
export interface StudioCloud {
    listProjects(options: { trash?: boolean; cursor?: string | null }): Promise<{ projects: StudioCloudProject[]; nextCursor: string | null }>;
    /** Moves the session's open local project to the cloud and opens it there. */
    saveCurrentProject(): Promise<{ projectId: string; name: string }>;
    openProject(projectId: string): Promise<{ projectId: string; name: string }>;
    /** The sync state of a cloud project (the open one when omitted); null when it is not a cloud project. */
    syncStatus(projectId?: string): Promise<{ projectId: string; state: string; label: string; pending: number; conflicts: string[] } | null>;
    /** Project pipelines of the open cloud project (phase 9b); absent on hosts without them. */
    pipelines?: StudioCloudPipelines;
    /** Share links of the open cloud project (phase 9c); absent on hosts without them. */
    shares?: StudioCloudShares;
}

export interface StudioSession {
    readonly projectId: string;
    readonly host: StudioHost;
    /** `signal` cancels a long command (ai.run's provider job) when the tool call times out or the client cancels. */
    execute(command: EditorCommand, options?: { signal?: AbortSignal }): Promise<CommandResult>;
    snapshot(): Promise<ControllerSnapshot>;
    describeTimeline(): Promise<string>;
    previewFrame(seconds: number, options?: PreviewFrameOptions): Promise<PreviewFrameResult>;
    uiState(): Promise<StudioUiState>;
    /** Undo depth (controller.historyDepth()). Without it, undo_last_edit counts single edits. */
    historyDepth?(): Promise<HistoryDepth>;
    listEffects?(kind: "effect" | "transition"): Promise<EffectDef[]>;
    uploadFile?(file: Blob, kind: MediaKind): Promise<UploadedMedia>;
    /** State of an export started through export.start (get_export_status); absent without an exporter. */
    exportStatus?(jobId: string): Promise<ExportJobStatus | null>;
    /**
     * What an ai.run would cost on the provider the host routes it to (phase 11: estimate_cost, and the estimate the
     * AI tools show and pass as expectedMaxUsd). Absent: the host cannot price runs.
     */
    estimate?(question: PriceQuestion): Promise<PriceReply>;
    /** The host's AI jobs, newest first (check_generation_status). Absent: the host keeps no job book. */
    aiJobs?(): Promise<AiJobRecord[]>;
    /** Voices of the routed text-to-speech provider (list_voices); null when no provider offers speech. */
    voices?(): Promise<ProviderVoice[] | null>;
    /** OpenNan cloud projects (list, save, open, sync status); absent on hosts without them (headless). */
    cloud?: StudioCloud;
}

export interface ControllerSessionOptions {
    controller: TimelineController;
    store: EditorStore;
    backend: TimelineBackend;
    host?: StudioHost;
    /** The exporter behind the controller's onExport (createStudioExporter); adds exportStatus. */
    exporter?: StudioExporter;
    /** The registry behind the controller's onAiRun (createAiRunner); adds estimate and voices. */
    providers?: PriceRegistry;
    /** The job book the controller's createAiRunner records into; adds aiJobs. */
    aiJobs?: Pick<AiJobBook, "list">;
}

/** A StudioSession over an in-process controller, store, and backend. */
export function createControllerSession(options: ControllerSessionOptions): StudioSession {
    const { controller, store, backend } = options;
    const host = options.host ?? {};
    const session: StudioSession = {
        projectId: controller.projectId,
        host,
        execute: (command, executeOptions) => controller.execute(command, executeOptions?.signal ? { signal: executeOptions.signal } : {}),
        snapshot: async () => controller.snapshot(),
        describeTimeline: async () => controller.describeTimeline(),
        previewFrame: (seconds, frameOptions) => controller.previewFrame(seconds, frameOptions),
        historyDepth: async () => controller.historyDepth(),
        uiState: async () => {
            const s = store.getState();
            return {
                currentTime: s.currentTime,
                isPlaying: s.isPlaying,
                shuttleSpeed: s.shuttleSpeed,
                zoom: s.timelineZoom,
                toolMode: s.toolMode,
                snapEnabled: s.snapEnabled,
                selection: {
                    clipIds: [...s.selectedClipIds],
                    sceneId: s.selectedSceneId,
                    transition: s.selectedTransition,
                    audioTarget: s.selectedAudioTarget,
                    markerId: s.selectedMarkerId,
                },
                markers: s.timelineMarkers.map((marker) => ({ ...marker })),
                canUndo: s.canUndo,
                canRedo: s.canRedo,
                activePanel: host.activePanel?.() ?? null,
            };
        },
    };
    const exporter = options.exporter;
    if (exporter) session.exportStatus = async (jobId) => exporter.status(jobId);
    const providers = options.providers;
    if (providers) {
        session.estimate = (question) => priceOnRegistry(providers, question);
        session.voices = () => voicesOnRegistry(providers);
    }
    const jobs = options.aiJobs;
    if (jobs) session.aiJobs = async () => jobs.list();
    if (backend.listEffects) {
        const listEffects = backend.listEffects.bind(backend);
        session.listEffects = (kind) => listEffects(kind);
    }
    // Like the editor's import (apps/web media bin): store the blob, then list it in the media bin.
    session.uploadFile = async (file, kind) => {
        const media = await backend.uploadFile(controller.projectId, file, kind);
        await backend.saveToLibrary?.(controller.projectId, media);
        return media;
    };
    return session;
}
