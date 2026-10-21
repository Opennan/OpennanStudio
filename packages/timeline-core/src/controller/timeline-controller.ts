// TimelineController (spec §5.1, §5.1.1, §10): the single write path for the UI,
// shortcuts, MCP, and agents. Persisted commands: optimistic apply -> backend
// call(s) with a timeout (one retry for idempotent payloads) -> reconcile ->
// undo entry. On failure the optimistic patch is rolled back and onToast fires.
import type { ClipEffect, TimelineClip, TimelineData, TimelineTrack } from "../model/timeline";
import type { AudioTarget } from "../model/editor";
import type { SceneData, TimelineMarker } from "../timeline/canvas/types";
import type { CreateClipInput, ProjectMeta, SceneMove, TimelineBackend, TimelineClipUpdate } from "../backend/types";
import { GLOBAL_SCHEDULER, TimelineTimeoutError, withTimeout, type Scheduler } from "../backend/errors";
import type { EditorStore, SelectedTransition } from "../store/editor-store";
import { selectLiveScenes } from "../store/live-scenes";
import { createLocalTimelineHistory, type LocalTimelineHistory } from "../lib/local-timeline-history";
import {
    createOptimisticSplitTimelineData,
    optimisticTimelineClipFromInput,
    replaceOptimisticSplitWithServer,
    replacePendingClipsWithCreated,
    trimClipCaptionWordsJson,
} from "../lib/timeline-optimistic";
import { buildOptimisticClipEffect } from "../model/effects";
import { ADJUSTMENT_KEYS, DEFAULT_ADJUSTMENTS, LEGACY_CLIP_ADJUSTMENTS, applyAdjustmentPatch, itemAdjustments, legacyClipFields, serializeAdjustments } from "../looks/adjust";
import { normalizeFilterId } from "../looks/filters";
import { transitionById } from "../looks/transitions";
import { clipJunction, isLaneClip } from "../looks/windows";
import { clampJunctionDuration, sceneJunctions } from "../lib/scene-transitions";
import { getTimelineTransitionPresetUpdate, normalizeTimelineTransitionType } from "../lib/timeline-editing-navigation";
import { getSceneDuration, getSceneStart } from "../timeline/scene-timing";
import type { CommandResult, EditorCommand, EditorCommandType, ExecuteOptions, StartedCommand, TimelineToast } from "./commands";
import { emptyPatch, patchClipIds, patchSceneIds, type OptimisticPatch } from "./patch";
import { DEFAULT_COMMAND_ERROR_MESSAGES, DEFAULT_FALLBACK_ERROR_MESSAGE, DEFAULT_LOAD_ERROR_MESSAGE } from "./messages";
import { timelineDurationSeconds, type FrameRenderer, type PreviewFrameOptions, type PreviewFrameResult } from "./frame-renderer";
import type { AiPlacement, AiRunContext, AiRunOutcome, AiRunRequest } from "./ai-run";
import { planCaptionPlacement } from "../lib/caption-placement";
import { planAiPlacement, type AiPlacementPlan } from "../lib/ai-placement";
import { planAnimation, planCaptionStyle, planClipSpeed, planEffectLayer, planKeyframes, planSceneSpeed, planTextStyle, planTextTemplate } from "./motion-commands";
import { planMask } from "./mask-commands";
import { clipTakesMask } from "../looks/masks";
import { motionTarget } from "../motion/transform";
import {
    editableItems, planItemsDuplicate, planItemsPaste, planItemsTransform, planLookPatch, resolveTargets, type DuplicatePlan, type ItemPatches, type ItemsState,
} from "./items-plan";
import { isAttributeSnapshot, planAttributePaste, snapshotAttributes, type AttributeSnapshot } from "../attributes/attributes";
import { planTrackingApply, planTrackingFrames, resolveTrackedItem } from "../tracking/plan";
import type { MotionTrackerHost, TrackingJobOutcome, TrackingRunOutput } from "../tracking/host";
import type { AnalysisJobOutcome, MediaAnalyzerHost } from "../analysis/host";
import { aiMediaSourceResult } from "../ai/sources";
import { clampTimeRanges, planCuts, sourceRangesToTimeline } from "../analysis/cuts";
import { findFillers, fillerLanguage, type FillerWord } from "../analysis/fillers";
import { planAutoCut, planBeatsJson } from "../analysis/beat-plan";

export interface TimelineControllerOptions {
    backend: TimelineBackend;
    store: EditorStore;
    projectId: string;
    onToast?(toast: TimelineToast): string | void;
    errorMessages?: Partial<Record<EditorCommandType, string>>;
    loadErrorMessage?: string;
    /** Per backend call. Default 15 s (nle-timeline-utils.ts:121, use-timeline.ts:37). */
    requestTimeoutMs?: number;
    retryOnTimeout?: boolean;
    /** Default 50 (use-timeline.ts:34). */
    historyLimit?: number;
    scheduler?: Scheduler;
    logger?: Pick<Console, "error">;
    /**
     * Runs `export.start` (spec §5.8): hosts wire @opennan/export here. Without it the command
     * reports `unavailable`. Receives the command options and the current snapshot.
     */
    onExport?(options: Record<string, unknown>, snapshot: ControllerSnapshot): Promise<ExportCommandOutcome>;
    /** Runs `export.cancel` (phase 10d). Without it the command reports `unavailable`. */
    onExportCancel?(jobId: string | undefined): Promise<ExportCommandOutcome>;
    /**
     * Renders previewFrame() images (spec §5.1.1). Without it previewFrame() is unavailable.
     * @opennan/export's createExportFrameRenderer fits as is.
     */
    frameRenderer?: FrameRenderer;
    /**
     * Runs `ai.run` (spec §5.1.1): hosts pass @opennan/provider-sdk's createAiRunner(registry). Without it the
     * command reports `unavailable`. A returned placement is applied as one persisted command (one undo step).
     */
    onAiRun?(request: AiRunRequest, context: AiRunContext): Promise<AiRunOutcome>;
    /**
     * Runs `tracking.run` (phase 10d): the editor host's frame decoder and tracker (timeline-react's
     * createMotionTrackerHost). Without it the command reports `unavailable`; its `anchors` also give
     * `tracking.apply` the boxes of clips the host has laid out.
     */
    motionTracker?: MotionTrackerHost;
    /**
     * Runs `analysis.run` (phase 11): the editor host's audio decoder and detectors (timeline-react's browser analyzer).
     * Without it the command reports `unavailable`.
     */
    analyzer?: MediaAnalyzerHost;
}

/** Undo/redo depth (spec §5.1.1). `recorded` counts every undo entry ever recorded and never goes down. */
export interface HistoryDepth {
    undo: number;
    redo: number;
    recorded: number;
    limit: number;
}

export interface ExportCommandOutcome {
    jobId?: string;
    error?: string;
    /** No exporter is available (CommandResult.unavailable). */
    unavailable?: boolean;
}

export interface ControllerSnapshot {
    projectId: string;
    project: ProjectMeta | null;
    tracks: TimelineTrack[];
    clips: TimelineClip[];
    scenes: SceneData[];
    markers: TimelineMarker[];
    /** `sceneIds` (phase 10c): every selected scene; `sceneId` stays the primary scene of a scenes-only selection. */
    selection: { clipIds: string[]; sceneIds?: string[]; sceneId: string | null; transition: SelectedTransition | null; audioTarget: AudioTarget | null };
    currentTime: number;
    canUndo: boolean;
    canRedo: boolean;
}

interface HistorySnapshot {
    tracks: TimelineTrack[];
    clips: TimelineClip[];
    scenes: SceneData[];
}

interface EffectOwner {
    clipId: string | null;
    sceneId: string | null;
    effects: ClipEffect[];
}

const sortedRows = (rows: ClipEffect[] | null | undefined): ClipEffect[] => [...(rows ?? [])].sort((a, b) => a.order - b.order);
const reorderRows = (rows: ClipEffect[]): ClipEffect[] => rows.map((row, order) => (row.order === order ? row : { ...row, order }));

/** The timeline before or after a step another writer made (recordExternalStep). */
export interface ExternalSnapshot {
    tracks: TimelineTrack[];
    clips: TimelineClip[];
    scenes: SceneData[];
}

interface HistoryMeta {
    backendCalls: number;
    touchesScenes: boolean;
}

interface PersistOutcome {
    backendCalls: number;
    createdClips?: { tempIds: string[]; clips: TimelineClip[] };
    splitClips?: { clipIds: string[]; optimisticCreated: TimelineClip[]; serverClips: TimelineClip[] };
    upsertClips?: TimelineClip[];
    clipEffects?: { clipId: string; effects: ClipEffect[] };
    sceneEffects?: { sceneId: string; effects: ClipEffect[] };
    /** Several owners' whole stacks (attributes.paste), applied after the clip and scene writes. */
    effectStacks?: Array<{ clipId?: string; sceneId?: string; effects: ClipEffect[] }>;
    tracks?: TimelineTrack[];
    scenes?: SceneData[];
    /** The whole scene list, for commands that shift other scenes' order (scene.add/.duplicate/.delete/.split/.reorder). Replaces serverScenes. */
    allScenes?: SceneData[];
    removedSceneIds?: string[];
    sceneIdCommit?: { tempId: string; realId: string };
    createdSceneIds?: string[];
    project?: ProjectMeta;
}

interface PreparedCommand {
    patch: OptimisticPatch;
    idempotent: boolean;
    touchesScenes: boolean;
    changed: CommandResult["changed"];
    tempClipIds: string[];
    tempSceneIds: string[];
    /** `backend` is the controller's backend, or its withoutHistory() view for recordHistory: false. */
    persist(backend: TimelineBackend): Promise<PersistOutcome>;
    afterOptimistic?(): void;
    afterCommit?(outcome: PersistOutcome): void;
    /** CommandResult.output of a successful command. */
    resultOutput?: unknown;
}

type Prepared = { kind: "persist"; command: PreparedCommand } | { kind: "result"; result: CommandResult };

interface PendingPersist {
    timer: unknown;
    command: EditorCommand;
    prepared: PreparedCommand;
    before: HistorySnapshot;
    restores: Array<() => void>;
    resolve(result: CommandResult): void;
    options: ExecuteOptions;
}

const NOT_LOADED = "timeline is not loaded";
const NO_OPTIMISTIC = { clipIds: [] as string[], sceneIds: [] as string[] };

/** The clip is locked or sits on a locked track; a scene's video track is locked. */
function itemOnLockedTrack(tracks: TimelineTrack[], scene: SceneData | undefined, clip: TimelineClip | undefined): boolean {
    if (clip?.locked) return true;
    const type = scene ? "video" : clip?.trackType;
    const index = scene ? scene.trackIndex || 1 : clip?.trackIndex;
    return tracks.some((track) => track.type === type && track.index === index && track.locked);
}

function unavailable(error: string): Prepared {
    return { kind: "result", result: { ok: false, changed: {}, error, unavailable: true } };
}

function invalid(error: string): Prepared {
    return { kind: "result", result: { ok: false, changed: {}, error } };
}

function persisted(command: PreparedCommand): Prepared {
    return { kind: "persist", command };
}

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function parseRawShots(raw: string | null | undefined): unknown[] | null {
    try {
        const parsed = JSON.parse(raw || "[]");
        return Array.isArray(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

function mergeClipUpdates(clips: TimelineClip[], updates: TimelineClipUpdate[]): TimelineClip[] {
    const byId = new Map(updates.map((update) => [update.clipId, update]));
    return clips.filter((clip) => byId.has(clip.id)).map((clip) => {
        const { clipId: _clipId, ...patch } = byId.get(clip.id) as TimelineClipUpdate;
        return { ...clip, ...patch };
    });
}

type SpeedCommand = Extract<EditorCommand, { type: "speed.set" }>;

/** speed.set fields are absolute, so a gesture's request is its earlier fields with the later ones on top. */
function mergeSpeedCommands(earlier: SpeedCommand, later: SpeedCommand): SpeedCommand {
    const merged: SpeedCommand = { ...earlier };
    if (later.speed !== undefined) merged.speed = later.speed;
    if (later.curve !== undefined) merged.curve = later.curve;
    if (later.preservePitch !== undefined) merged.preservePitch = later.preservePitch;
    return merged;
}

const sameSpeedTarget = (a: SpeedCommand, b: SpeedCommand) => (
    a.clipId === b.clipId && a.sceneId === b.sceneId && JSON.stringify(a.clipIds ?? null) === JSON.stringify(b.clipIds ?? null)
);

/**
 * Caption words are clip-local: when an update moves a caption clip's left edge without moving its right edge
 * by the same amount (a left trim), its words shift so they stay where they are on the timeline. Planned from
 * `base` (the clips before the edit or the coalesced gesture), written when it differs from `base` or `shown`.
 */
function withCaptionWordRebase(updates: TimelineClipUpdate[], base: TimelineClip[], shown: TimelineClip[]): TimelineClipUpdate[] {
    return updates.map((update) => {
        if ("captionWordsJson" in update) return update;
        const was = base.find((clip) => clip.id === update.clipId);
        if (!was?.captionWordsJson) return update;
        const startDelta = (update.startTime ?? was.startTime) - was.startTime;
        const endDelta = (update.endTime ?? was.endTime) - was.endTime;
        const words = Math.abs(startDelta - endDelta) < 1e-9 ? was.captionWordsJson : trimClipCaptionWordsJson(was.captionWordsJson, startDelta);
        const now = shown.find((clip) => clip.id === update.clipId);
        return words === was.captionWordsJson && (!now || now.captionWordsJson === words) ? update : { ...update, captionWordsJson: words ?? null };
    });
}

export class TimelineController {
    readonly projectId: string;
    private readonly backend: TimelineBackend;
    private readonly store: EditorStore;
    private readonly options: TimelineControllerOptions;
    private readonly scheduler: Scheduler;
    private readonly timeoutMs: number;
    private readonly retryOnTimeout: boolean;
    private readonly historyLimit: number;
    private readonly history: LocalTimelineHistory<HistorySnapshot>;
    private undoMeta: HistoryMeta[] = [];
    private redoMeta: HistoryMeta[] = [];
    private recordedEntries = 0;
    private readonly pending = new Map<string, PendingPersist>();
    /** Temp clip id -> server id once its create settles (null when it failed). */
    private readonly pendingCreates = new Map<string, Promise<string | null>>();
    /** Backend calls this controller started (call()); tells whether another write landed between two of ours. */
    private backendCallsStarted = 0;
    /** While prepare() plans a later step of a coalesced gesture: the snapshot before the gesture's first step. */
    private gestureBase: HistorySnapshot | null = null;
    private tempCounter = 0;
    private disposed = false;
    private unsubscribe: (() => void) | null = null;

    constructor(options: TimelineControllerOptions) {
        this.options = options;
        this.projectId = options.projectId;
        this.backend = options.backend;
        this.store = options.store;
        this.scheduler = options.scheduler ?? GLOBAL_SCHEDULER;
        this.timeoutMs = options.requestTimeoutMs ?? 15_000;
        this.retryOnTimeout = options.retryOnTimeout ?? true;
        this.historyLimit = options.historyLimit ?? 50;
        this.history = createLocalTimelineHistory<HistorySnapshot>(this.historyLimit);
    }

    get capabilities(): { mergeShot: boolean; extractShot: boolean; reorderShots: boolean; deleteShot: boolean; clipEffects: boolean } {
        return {
            mergeShot: Boolean(this.backend.mergeShot),
            extractShot: Boolean(this.backend.extractShot),
            reorderShots: Boolean(this.backend.reorderShots),
            deleteShot: Boolean(this.backend.deleteShot),
            clipEffects: Boolean(this.backend.addClipEffect),
        };
    }

    // ── lifecycle ─────────────────────────────────────────
    async load(): Promise<void> {
        const s = this.store.getState();
        s.setTimelineLoading(true);
        try {
            const [meta, timeline, scenes] = await Promise.all([
                this.call(() => this.backend.loadProject(this.projectId), true),
                this.call(() => this.backend.loadTimeline(this.projectId), true),
                this.call(() => this.backend.loadScenes(this.projectId), true),
            ]);
            const state = this.store.getState();
            state.setProjectMeta(meta);
            state.setMusicVolume(meta.musicVolume);
            state.setTimelineData(timeline);
            state.replaceServerScenes(scenes);
            this.syncHistoryFlags();
            if (this.backend.subscribe && !this.unsubscribe) {
                this.unsubscribe = this.backend.subscribe(this.projectId, (change) => {
                    if (this.pending.size > 0 || this.store.getState().activeTimelineSaves > 0) return;
                    const current = this.store.getState();
                    if (change.type === "timeline") current.setTimelineData(change.data);
                    else if (change.type === "scenes") current.mergeServerScenes(change.scenes);
                    else current.setProjectMeta(change.meta);
                });
            }
        } catch (error) {
            this.toast({ kind: "error", message: this.options.loadErrorMessage ?? DEFAULT_LOAD_ERROR_MESSAGE });
            this.options.logger?.error("[TimelineController] load failed", error);
            throw error;
        } finally {
            this.store.getState().setTimelineLoading(false);
        }
    }

    /** Re-read timeline and scenes without discarding unconverged optimistic state (replaces onRefetch). */
    async refresh(): Promise<void> {
        const [timeline, scenes] = await Promise.all([
            this.call(() => this.backend.loadTimeline(this.projectId), true),
            this.call(() => this.backend.loadScenes(this.projectId), true),
        ]);
        const s = this.store.getState();
        if (this.pending.size === 0 && s.activeTimelineSaves === 0) s.setTimelineData(timeline);
        s.syncServerScenes(scenes);
    }

    /** false cancels pending debounced saves and rolls them back (nle-timeline.tsx:925-932). */
    setActive(active: boolean): void {
        if (!active) this.cancelPending(true);
    }

    /** Cancels pending debounced saves (all, or only the given coalesce keys). */
    cancelPending(rollback: boolean, keys?: Iterable<string>): void {
        const only = keys ? new Set(keys) : null;
        for (const [key, entry] of [...this.pending]) {
            if (only && !only.has(key)) continue;
            this.scheduler.clearTimeout(entry.timer);
            if (rollback) for (const restore of [...entry.restores].reverse()) restore();
            entry.resolve({ ok: false, changed: {}, cancelled: true });
            this.pending.delete(key);
        }
    }

    async flushPending(): Promise<void> {
        const entries = [...this.pending.values()];
        this.pending.clear();
        await Promise.all(entries.map(async (entry) => {
            this.scheduler.clearTimeout(entry.timer);
            entry.resolve(await this.runPersist(entry.command, entry.prepared, entry.before, entry.restores, entry.options));
        }));
    }

    /** Unmount: drop pending debounced work without rolling back (nle-timeline.tsx:941-945). */
    dispose(): void {
        this.cancelPending(false);
        this.unsubscribe?.();
        this.unsubscribe = null;
        this.disposed = true;
    }

    /**
     * Undoes dispose(). React StrictMode runs effect cleanups once in development and
     * then mounts again with the same memoized controller; TimelineProvider calls this
     * on every mount so that controller keeps accepting commands.
     */
    resume(): void {
        this.disposed = false;
    }

    snapshot(): ControllerSnapshot {
        const s = this.store.getState();
        return {
            projectId: this.projectId,
            project: s.projectMeta,
            tracks: s.timelineData?.tracks ?? [],
            clips: s.timelineData?.clips ?? [],
            scenes: selectLiveScenes(s),
            markers: s.timelineMarkers,
            selection: { clipIds: [...s.selectedClipIds], sceneIds: [...s.selectedSceneIds], sceneId: s.selectedSceneId, transition: s.selectedTransition, audioTarget: s.selectedAudioTarget },
            currentTime: s.currentTime,
            canUndo: s.canUndo,
            canRedo: s.canRedo,
        };
    }

    /** Plain-text summary of snapshot() for agents and MCP (spec §5.1.1 read API). */
    describeTimeline(): string {
        const snap = this.snapshot();
        const sec = (n: number) => `${Math.round(n * 100) / 100}s`;
        const selectedScenes = snap.selection.sceneIds?.length ? snap.selection.sceneIds : snap.selection.sceneId ? [snap.selection.sceneId] : [];
        const selection = [
            snap.selection.clipIds.length > 0 ? `clips ${snap.selection.clipIds.join(", ")}` : "",
            selectedScenes.length > 0 ? `${selectedScenes.length > 1 ? "scenes" : "scene"} ${selectedScenes.join(", ")}` : "",
        ].filter(Boolean).join("; ") || "none";
        return [
            `Project ${snap.projectId}${snap.project ? ` "${snap.project.name}" (${snap.project.aspectRatio})` : ""}; playhead ${sec(snap.currentTime)}.`,
            `Scenes (${snap.scenes.length}):`,
            ...snap.scenes.map((scene, i) => `  ${scene.id} V${scene.trackIndex ?? 1} at ${sec(getSceneStart(scene, snap.scenes, i))} for ${sec(getSceneDuration(scene))}${scene.caption ? ` "${scene.caption}"` : ""}`),
            `Tracks (${snap.tracks.length}): ${snap.tracks.map((t) => `${t.type}${t.index}${t.muted ? " muted" : ""}${t.locked ? " locked" : ""}`).join(", ")}`,
            `Clips (${snap.clips.length}):`,
            ...snap.clips.map((clip) => `  ${clip.id} ${clip.trackType}${clip.trackIndex} ${sec(clip.startTime)}-${sec(clip.endTime)}${clip.label ? ` "${clip.label}"` : ""}`),
            `Markers: ${snap.markers.length}. Selection: ${selection}.`,
        ].join("\n");
    }

    /**
     * Undo/redo depth. Agent hosts compare `recorded` before and after a group of
     * commands to undo the group as one step (MCP undo_last_edit), also after the
     * oldest entries fall off `limit`.
     */
    historyDepth(): HistoryDepth {
        return { undo: this.undoMeta.length, redo: this.redoMeta.length, recorded: this.recordedEntries, limit: this.historyLimit };
    }

    /**
     * Records a change another writer made (an AI turn or a pipeline task applied on the server and arrived through
     * sync, phase 9b) as one undo entry of one backend step. `record` asks the backend to add that step to its own
     * history and answers the timeline as it was before the step (what undo shows first); null records nothing. This
     * controller's own writes in flight finish first, so the backend's history and this one keep the same order.
     */
    async recordExternalStep(record: () => Promise<{ before: ExternalSnapshot; after?: ExternalSnapshot } | null>): Promise<boolean> {
        if (this.disposed) return false;
        await this.flushPending();
        await this.whenNoSaves();
        const result = await record();
        if (!result || this.disposed) return false;
        // Recorded at once (no await in between), so a write started meanwhile records after it, as in the backend.
        const snap = (x: ExternalSnapshot): HistorySnapshot => ({ tracks: x.tracks, clips: x.clips, scenes: x.scenes });
        // A step that changes nothing on screen joins the newest entry (both histories stay aligned): it has no undo of its own.
        const own = this.record(snap(result.before), { backendCalls: 1, touchesScenes: true }, result.after ? snap(result.after) : undefined);
        try {
            const [timeline, scenes] = await Promise.all([
                this.call(() => this.backend.loadTimeline(this.projectId), true),
                this.call(() => this.backend.loadScenes(this.projectId), true),
            ]);
            const s = this.store.getState();
            if (this.pending.size === 0 && s.activeTimelineSaves === 0) {
                s.setTimelineData(timeline);
                s.replaceServerScenes(scenes);
            }
        } catch (error) {
            this.options.logger?.error("[TimelineController] refresh after an external step failed", error);
        }
        return own;
    }

    /** Resolves once no save of this controller is pending or in flight (bounded: 15 s). */
    private whenNoSaves(): Promise<void> {
        const idle = () => this.pending.size === 0 && this.store.getState().activeTimelineSaves === 0;
        if (idle()) return Promise.resolve();
        return new Promise((resolve) => {
            let timer: unknown = null;
            const done = () => {
                unsubscribe();
                if (timer !== null) this.scheduler.clearTimeout(timer);
                resolve();
            };
            const unsubscribe = this.store.subscribe(() => {
                if (idle()) done();
            });
            timer = this.scheduler.setTimeout(done, 15_000);
        });
    }

    /** One rendered frame of the live timeline (spec §5.1.1 read API). Never throws. */
    async previewFrame(seconds: number, options: PreviewFrameOptions = {}): Promise<PreviewFrameResult> {
        const snapshot = this.snapshot();
        const end = timelineDurationSeconds(snapshot);
        const at = Math.min(Math.max(0, Number.isFinite(seconds) ? seconds : 0), end);
        const renderer = this.options.frameRenderer;
        if (!renderer) return { ok: false, seconds: at, unavailable: true, error: "previewFrame needs a frame renderer (@opennan/export)" };
        try {
            return { ok: true, seconds: at, frame: await renderer.renderFrame({ snapshot, seconds: at, ...options }) };
        } catch (error) {
            return { ok: false, seconds: at, error: errorText(error) };
        }
    }

    // ── execution ─────────────────────────────────────────
    execute(command: EditorCommand, options: ExecuteOptions = {}): Promise<CommandResult> {
        return this.start(command, options).settled;
    }

    start(command: EditorCommand, options: ExecuteOptions = {}): StartedCommand {
        if (this.disposed) return { optimistic: NO_OPTIMISTIC, settled: Promise.resolve({ ok: false, changed: {}, error: "controller disposed" }) };
        if (command.type === "history.undo" || command.type === "history.redo") {
            return { optimistic: NO_OPTIMISTIC, settled: this.runHistory(command.type === "history.undo", command.steps ?? 1) };
        }
        if (command.type === "clip.delete" && command.clipIds.some((id) => this.pendingCreates.has(id))) {
            return { optimistic: NO_OPTIMISTIC, settled: this.deleteAfterCreate(command.clipIds, options) };
        }
        if (command.type === "export.start" && this.options.onExport) {
            return { optimistic: NO_OPTIMISTIC, settled: this.runExport(command.options) };
        }
        if (command.type === "export.cancel" && this.options.onExportCancel) {
            return { optimistic: NO_OPTIMISTIC, settled: this.runExportCancel(command.jobId) };
        }
        if (command.type === "ai.run" && this.options.onAiRun) {
            return { optimistic: NO_OPTIMISTIC, settled: this.runAi(command, options) };
        }
        if (command.type === "tracking.run") {
            return { optimistic: NO_OPTIMISTIC, settled: this.runTracking(command, options) };
        }
        if (command.type === "analysis.run") {
            return { optimistic: NO_OPTIMISTIC, settled: this.runAnalysis(command, options) };
        }
        const local = this.applyLocal(command);
        if (local) return { optimistic: NO_OPTIMISTIC, settled: Promise.resolve(local) };

        let prepared: Prepared;
        const gesture = this.gestureFor(command, options);
        if (gesture) command = gesture.command;
        try {
            this.gestureBase = gesture?.base ?? null;
            prepared = this.prepare(command);
        } catch (error) {
            return { optimistic: NO_OPTIMISTIC, settled: Promise.resolve({ ok: false, changed: {}, error: errorText(error) }) };
        } finally {
            this.gestureBase = null;
        }
        if (prepared.kind === "result") return { optimistic: NO_OPTIMISTIC, settled: Promise.resolve(prepared.result) };

        const prep = prepared.command;
        const before = this.historySnapshot();
        const restore = this.applyPatch(prep.patch);
        this.markWrite(prep);
        prep.afterOptimistic?.();
        const optimistic = { clipIds: prep.tempClipIds, sceneIds: prep.tempSceneIds };
        const debounceMs = options.debounceMs ?? 0;
        // A command that saves now first flushes debounced saves made before it, so backend writes keep
        // the order the user made them in (a reset right after a slider drag must not be overwritten).
        const settled = options.coalesceKey && debounceMs > 0 && prep.idempotent
            ? this.schedule(options.coalesceKey, debounceMs, command, prep, before, restore, options)
            : this.pending.size > 0
                ? this.flushPending().then(() => this.runPersist(command, prep, before, [restore], options))
                : this.runPersist(command, prep, before, [restore], options);
        this.trackPendingCreates(prep.tempClipIds, settled);
        return { optimistic, settled };
    }

    /**
     * A later step of a coalesced gesture (a pending save under the same key): only the last step's write is
     * saved, so commands whose plan depends on the state they start from (speed.set, caption word re-basing)
     * plan every step from the snapshot before the gesture. speed.set steps also merge their fields.
     */
    private gestureFor(command: EditorCommand, options: ExecuteOptions): { command: EditorCommand; base: HistorySnapshot } | null {
        if (!options.coalesceKey || !((options.debounceMs ?? 0) > 0)) return null;
        const pending = this.pending.get(options.coalesceKey);
        if (!pending || pending.command.type !== command.type) return null;
        if (command.type === "speed.set") {
            const earlier = pending.command as SpeedCommand;
            if (!sameSpeedTarget(earlier, command)) return null;
            return { command: mergeSpeedCommands(earlier, command), base: pending.before };
        }
        if (command.type === "clip.update" || command.type === "clip.updateMany" || command.type === "clip.move") return { command, base: pending.before };
        return null;
    }

    private async runExport(options: Record<string, unknown>): Promise<CommandResult> {
        try {
            const outcome = await this.options.onExport!(options, this.snapshot());
            if (outcome.unavailable) return { ok: false, changed: {}, unavailable: true, error: outcome.error };
            return outcome.error ? { ok: false, changed: {}, error: outcome.error } : { ok: true, changed: {}, jobId: outcome.jobId };
        } catch (error) {
            return { ok: false, changed: {}, error: errorText(error) };
        }
    }

    private async runExportCancel(jobId: string | undefined): Promise<CommandResult> {
        try {
            const outcome = await this.options.onExportCancel!(jobId);
            if (outcome.unavailable) return { ok: false, changed: {}, unavailable: true, error: outcome.error };
            return outcome.error ? { ok: false, changed: {}, error: outcome.error } : { ok: true, changed: {}, jobId: outcome.jobId ?? jobId };
        } catch (error) {
            return { ok: false, changed: {}, error: errorText(error) };
        }
    }

    private async runAi(command: Extract<EditorCommand, { type: "ai.run" }>, options: ExecuteOptions): Promise<CommandResult> {
        let outcome: AiRunOutcome;
        try {
            outcome = await this.options.onAiRun!(
                { capability: command.capability, input: command.input, placeAt: command.placeAt },
                { snapshot: this.snapshot(), signal: options.signal, onProgress: options.onProgress },
            );
        } catch (error) {
            if (options.toastOnError !== false) this.toast({ kind: "error", message: this.errorMessage("ai.run") });
            return { ok: false, changed: {}, error: errorText(error) };
        }
        const job = outcome.jobId === undefined ? {} : { jobId: outcome.jobId };
        if (outcome.cancelled) return { ok: false, changed: {}, ...job, cancelled: true };
        if (outcome.unavailable) return { ok: false, changed: {}, ...job, unavailable: true, error: outcome.error };
        if (outcome.error !== undefined) {
            if (options.toastOnError !== false) this.toast({ kind: "error", message: this.errorMessage("ai.run") });
            return { ok: false, changed: {}, ...job, error: outcome.error };
        }
        const done: CommandResult = { ok: true, changed: {}, ...job, ...(outcome.output === undefined ? {} : { output: outcome.output }) };
        if (!outcome.placement) return done;
        if (this.disposed) return { ok: false, changed: {}, ...job, error: "controller disposed" };
        if ((outcome.placement.kind === "captions-track" || outcome.placement.kind === "captions-track-translated") && outcome.placement.cues.length === 0) return { ...done, createdClipIds: [] };
        const prep = this.preparePlacement(outcome.placement);
        if (!prep) return { ok: false, changed: {}, ...job, error: NOT_LOADED };
        if ("error" in prep) {
            if (options.toastOnError !== false) this.toast({ kind: "error", message: this.errorMessage("ai.run") });
            return { ok: false, changed: {}, ...job, error: prep.error, ...(outcome.output === undefined ? {} : { output: outcome.output }) };
        }
        if (prep.tempClipIds.length === 0) return { ...done, createdClipIds: [] };
        const before = this.historySnapshot();
        const restore = this.applyPatch(prep.patch);
        const settled = this.runPersist(command, prep, before, [restore], options);
        this.trackPendingCreates(prep.tempClipIds, settled);
        const placed = await settled;
        const kept = prep.keptTracks();
        const current = this.store.getState().timelineData;
        if (!placed.ok && kept && current) this.store.getState().setTimelineData({ ...current, tracks: kept });
        return placed.ok ? { ...placed, ...job, ...(outcome.output === undefined ? {} : { output: outcome.output }) } : { ...placed, ...job };
    }

    /** tracking.run: plans the frames from the live timeline and runs the host's tracker; changes nothing. */
    private async runTracking(command: Extract<EditorCommand, { type: "tracking.run" }>, options: ExecuteOptions): Promise<CommandResult> {
        const tracker = this.options.motionTracker;
        if (!tracker) return { ok: false, changed: {}, unavailable: true, error: "tracking.run needs a motion tracker (an editor host that can decode video)" };
        const state = this.itemsState();
        if (!state) return { ok: false, changed: {}, error: NOT_LOADED };
        const item = resolveTrackedItem(state, command);
        if (!item.ok) return { ok: false, changed: {}, error: item.error };
        const plan = planTrackingFrames(item.value, command);
        if (!plan.ok) return { ok: false, changed: {}, error: plan.error };
        let outcome: TrackingJobOutcome;
        try {
            outcome = await tracker.track(
                { owner: item.value.owner, mediaUrl: item.value.mediaUrl, frames: plan.value.frames, startIndex: plan.value.startIndex, region: command.region, fps: plan.value.fps },
                { signal: options.signal, onProgress: (fraction) => options.onProgress?.({ jobId: "tracking", status: "running", progress: Math.max(0, Math.min(1, fraction)) }) },
            );
        } catch (error) {
            if (options.signal?.aborted) return { ok: false, changed: {}, cancelled: true };
            if (options.toastOnError !== false) this.toast({ kind: "error", message: this.errorMessage("tracking.run") });
            return { ok: false, changed: {}, error: errorText(error) };
        }
        if (outcome.cancelled || options.signal?.aborted) return { ok: false, changed: {}, cancelled: true };
        if (outcome.unavailable) return { ok: false, changed: {}, unavailable: true, error: outcome.error };
        if (outcome.error !== undefined || !outcome.samples) {
            if (options.toastOnError !== false) this.toast({ kind: "error", message: this.errorMessage("tracking.run") });
            return { ok: false, changed: {}, error: outcome.error ?? "the tracker returned no samples" };
        }
        const output: TrackingRunOutput = {
            samples: outcome.samples, source: outcome.source ?? null, fps: plan.value.fps, lost: outcome.samples.filter((s) => s.lost).length,
        };
        return { ok: true, changed: {}, output };
    }

    /** analysis.run: decodes the item's used range on the host's analyzer and maps the result to the timeline; changes nothing. */
    private async runAnalysis(command: Extract<EditorCommand, { type: "analysis.run" }>, options: ExecuteOptions): Promise<CommandResult> {
        const analyzer = this.options.analyzer;
        if (!analyzer) return { ok: false, changed: {}, unavailable: true, error: "analysis.run needs an audio analyzer (an editor host that can decode audio)" };
        if (command.kind !== "silences" && command.kind !== "beats") return { ok: false, changed: {}, error: 'analysis.run kind must be "silences" or "beats"' };
        const state = this.itemsState();
        if (!state) return { ok: false, changed: {}, error: NOT_LOADED };
        if (!command.clipId && !command.sceneId) return { ok: false, changed: {}, error: "analysis.run needs a clipId or a sceneId" };
        const resolved = aiMediaSourceResult(state, command);
        if (!resolved.ok) return { ok: false, changed: {}, error: resolved.error };
        const source = resolved.source;
        if (!source.hasAudio) return { ok: false, changed: {}, error: source.target.sceneId ? "This scene has no audio" : "This clip has no audio" };
        let outcome: AnalysisJobOutcome;
        try {
            outcome = await analyzer.analyze(
                { kind: command.kind, mediaUrl: source.mediaUrl, startSeconds: source.startSeconds, endSeconds: source.endSeconds, options: { ...(command.options ?? {}) } },
                { signal: options.signal, onProgress: (fraction) => options.onProgress?.({ jobId: "analysis", status: "running", progress: Math.max(0, Math.min(1, fraction)) }) },
            );
        } catch (error) {
            if (options.signal?.aborted) return { ok: false, changed: {}, cancelled: true };
            if (options.toastOnError !== false) this.toast({ kind: "error", message: this.errorMessage("analysis.run") });
            return { ok: false, changed: {}, error: errorText(error) };
        }
        if (outcome.cancelled || options.signal?.aborted) return { ok: false, changed: {}, cancelled: true };
        if (outcome.unavailable) return { ok: false, changed: {}, unavailable: true, error: outcome.error };
        const missing = command.kind === "silences" ? !outcome.silences : !outcome.beats;
        if (outcome.error !== undefined || missing) {
            if (options.toastOnError !== false) this.toast({ kind: "error", message: this.errorMessage("analysis.run") });
            return { ok: false, changed: {}, error: outcome.error ?? "the analyzer returned no result" };
        }
        if (command.kind === "silences") {
            const sourceRanges = clampTimeRanges(outcome.silences!, source.startSeconds, source.endSeconds);
            return { ok: true, changed: {}, output: { kind: "silences", ranges: sourceRangesToTimeline(source, sourceRanges), sourceRanges } };
        }
        const speed = source.speed > 0 ? source.speed : 1;
        const sourceTimes = outcome.beats!.times.filter((t) => Number.isFinite(t) && t >= source.startSeconds - 1e-6 && t <= source.endSeconds + 1e-6);
        const times = sourceTimes.map((t) => Math.round((source.timelineStart + (t - source.startSeconds) / speed) * 1e6) / 1e6);
        return { ok: true, changed: {}, output: { kind: "beats", bpm: outcome.beats!.bpm, times, sourceTimes } };
    }

    /** analysis.fillers: filler words in the given words, or in the caption words over the item's window. Pure. */
    private runFillers(command: Extract<EditorCommand, { type: "analysis.fillers" }>): CommandResult {
        const state = this.itemsState();
        if (!state) return { ok: false, changed: {}, error: NOT_LOADED };
        if (!command.clipId && !command.sceneId) return { ok: false, changed: {}, error: "analysis.fillers needs a clipId or a sceneId" };
        const resolved = aiMediaSourceResult(state, command);
        if (!resolved.ok) return { ok: false, changed: {}, error: resolved.error };
        const { timelineStart: start, timelineEnd: end } = resolved.source;
        let words: FillerWord[];
        if (command.words) {
            if (!Array.isArray(command.words)) return { ok: false, changed: {}, error: "words must be a list of { text, start, end }" };
            words = command.words.filter((w) => w && typeof w.text === "string" && Number.isFinite(w.start) && Number.isFinite(w.end));
        } else {
            words = [];
            for (const clip of state.clips) {
                if (clip.trackType !== "text" || !clip.captionWordsJson || clip.endTime <= start || clip.startTime >= end) continue;
                let parsed: unknown;
                try {
                    parsed = JSON.parse(clip.captionWordsJson);
                } catch {
                    continue;
                }
                if (!Array.isArray(parsed)) continue;
                for (const raw of parsed) {
                    const word = raw as { text?: unknown; start?: unknown; end?: unknown };
                    if (typeof word?.text !== "string" || typeof word.start !== "number" || typeof word.end !== "number") continue;
                    words.push({ text: word.text, start: clip.startTime + word.start, end: clip.startTime + word.end });
                }
            }
        }
        words = words.filter((w) => (w.start + w.end) / 2 >= start && (w.start + w.end) / 2 <= end);
        if (words.length === 0) {
            return { ok: false, changed: {}, error: command.words ? "no words inside the item" : "No word timings over this item: add captions with Auto captions first" };
        }
        const language = fillerLanguage(command.language, words);
        const found = findFillers(words, language, { padding: command.padding });
        return { ok: true, changed: {}, output: { ranges: clampTimeRanges(found.ranges, start, end), words: found.words, language } };
    }

    /**
     * Places an ai.run result as one persisted command (one undo entry). captions-track: a new text track and its caption
     * clips (updateTracks + createClips); the other kinds (lib/ai-placement.ts): tracks, clip and scene field updates, new
     * clips, then deletes, each failure taking the earlier writes back.
     */
    private preparePlacement(placement: AiPlacement): (PreparedCommand & { keptTracks(): TimelineTrack[] | null }) | { error: string } | null {
        const timeline = this.store.getState().timelineData;
        if (!timeline) return null;
        if (placement.kind !== "captions-track") {
            const state = this.itemsState()!;
            const plan = planAiPlacement({ ...state, aspectRatio: this.store.getState().projectMeta?.aspectRatio }, placement);
            if (!plan.ok) return { error: plan.error };
            return { ...this.placementCommand(timeline, plan.value), keptTracks: () => null };
        }
        const pid = this.projectId;
        const plan = planCaptionPlacement(placement.cues, timeline.tracks, { style: placement.style, ...(placement.label ? { label: placement.label } : {}) });
        const tempIds = plan.inputs.map(() => this.tempId("temp"));
        const optimistic = plan.inputs.map((input, i) => optimisticTimelineClipFromInput(input as Record<string, any>, pid, tempIds[i]));
        const previousTracks = timeline.tracks;
        // Set when a failed placement must keep its (empty) track: the store then shows what the backend has.
        let keptTracks: TimelineTrack[] | null = null;
        return {
            patch: { ...emptyPatch(), tracks: plan.tracks, clipsUpsert: optimistic },
            idempotent: false, touchesScenes: false, changed: { tracks: true, clips: tempIds }, tempClipIds: tempIds, tempSceneIds: [],
            persist: async (backend) => {
                const tracks = await this.call(() => backend.updateTracks(pid, plan.tracks), true);
                const afterTracks = this.backendCallsStarted;
                let clips;
                try {
                    clips = await this.call(() => backend.createClips(pid, plan.inputs), false);
                } catch (error) {
                    // runPersist restores only the optimistic patch; the track write needs its own answer.
                    const log = (revertError: unknown) => this.options.logger?.error("[TimelineController] ai.run could not take back its track", revertError);
                    if (backend !== this.backend) {
                        // Writes on a withoutHistory() view are not undo steps: just rewrite the tracks.
                        await backend.updateTracks(pid, previousTracks).catch(log);
                    } else if (this.backendCallsStarted === afterTracks + 1) {
                        // Only our createClips ran since the track write: one backend undo takes exactly that write back.
                        await backend.undo(pid, 1).catch(log);
                    } else {
                        // Another edit wrote in between, so an undo could take back that edit instead. Keep the empty
                        // track and fold its write into the newest undo entry, so both histories stay aligned.
                        this.attachUntrackedBackendSteps(1);
                        keptTracks = tracks;
                    }
                    throw error;
                }
                return { backendCalls: 2, tracks, createdClips: { tempIds, clips } };
            },
            keptTracks: () => keptTracks,
        };
    }

    /** An AI placement plan as one command: updateTracks, updateClips, scene writes, createClips, deleteClips. */
    private placementCommand(timeline: TimelineData, plan: AiPlacementPlan): PreparedCommand {
        const pid = this.projectId;
        const scenes = selectLiveScenes(this.store.getState());
        const tempIds = plan.creates.map(() => this.tempId("temp"));
        const optimistic = plan.creates.map((input, i) => optimisticTimelineClipFromInput(input as Record<string, any>, pid, tempIds[i]));
        const fieldOf = (value: unknown, key: string) => (value as Record<string, unknown>)[key] ?? null;
        const originalClips: TimelineClipUpdate[] = plan.clipUpdates.map((update) => {
            const was = timeline.clips.find((c) => c.id === update.clipId)!;
            return { clipId: was.id, ...Object.fromEntries(Object.keys(update).filter((key) => key !== "clipId").map((key) => [key, fieldOf(was, key)])) } as TimelineClipUpdate;
        });
        const originalScenes = plan.scenePatches.map(({ sceneId, patch }) => {
            const scene = scenes.find((sc) => sc.id === sceneId)!;
            return { sceneId, patch: Object.fromEntries(Object.keys(patch).map((key) => [key, fieldOf(scene, key)])) as Partial<SceneData> };
        });
        const clipPatch = mergeClipUpdates(timeline.clips, plan.clipUpdates);
        const { tracks: nextTracks, clipUpdates, scenePatches, creates, deleteClipIds } = plan;
        return {
            patch: {
                ...emptyPatch(), ...(nextTracks ? { tracks: nextTracks } : {}), clipsUpsert: [...clipPatch, ...optimistic], clipsRemove: deleteClipIds, sceneFieldPatches: scenePatches,
            },
            idempotent: false, touchesScenes: scenePatches.length > 0,
            changed: {
                ...(nextTracks ? { tracks: true } : {}), clips: [...clipPatch.map((c) => c.id), ...tempIds, ...deleteClipIds],
                ...(scenePatches.length > 0 ? { scenes: scenePatches.map((p) => p.sceneId) } : {}),
            },
            tempClipIds: tempIds, tempSceneIds: [],
            persist: async (backend) => {
                const mark = this.backendCallsStarted;
                // The inverse of each successful write, newest first.
                const undoSteps: Array<() => Promise<unknown>> = [];
                const scenesOut: SceneData[] = [];
                let tracksOut: TimelineTrack[] | undefined;
                let upsertClips: TimelineClip[] | undefined;
                let created: TimelineClip[] = [];
                try {
                    if (nextTracks) {
                        tracksOut = await this.call(() => backend.updateTracks(pid, nextTracks), true);
                        undoSteps.unshift(() => backend.updateTracks(pid, timeline.tracks));
                    }
                    if (clipUpdates.length > 0) {
                        const returned = await this.call(() => backend.updateClips(pid, clipUpdates), true);
                        upsertClips = Array.isArray(returned) ? returned : undefined;
                        undoSteps.unshift(() => backend.updateClips(pid, originalClips));
                    }
                    if (scenePatches.length > 0) {
                        if (backend.updateScenes) {
                            scenesOut.push(...await this.call(() => backend.updateScenes!(pid, scenePatches), true));
                            undoSteps.unshift(() => backend.updateScenes!(pid, originalScenes));
                        } else {
                            for (const [i, { sceneId, patch }] of scenePatches.entries()) {
                                scenesOut.push(await this.call(() => backend.updateScene(pid, sceneId, patch), true));
                                undoSteps.unshift(() => backend.updateScene(pid, sceneId, originalScenes[i].patch));
                            }
                        }
                    }
                    if (creates.length > 0) {
                        created = await this.call(() => backend.createClips(pid, creates), false);
                        undoSteps.unshift(() => backend.deleteClips(pid, created.map((clip) => clip.id)));
                    }
                    if (deleteClipIds.length > 0) {
                        await this.call(() => backend.deleteClips(pid, deleteClipIds), false);
                        undoSteps.unshift(() => Promise.resolve());
                    }
                } catch (error) {
                    await this.takeBackPartialWrites(backend, mark, undoSteps.length, undoSteps, "ai.run");
                    throw error;
                }
                return {
                    backendCalls: undoSteps.length, tracks: tracksOut, upsertClips, scenes: scenesOut,
                    ...(creates.length > 0 ? { createdClips: { tempIds, clips: created } } : {}),
                };
            },
        };
    }

    // The source deletes a temp clip by waiting for its pending create and deleting the
    // server id (SRC/hooks/use-timeline.ts:1558-1575, 1624-1639). Here the temp clip stays
    // visible until the create returns, then the delete runs as a normal command.
    private async deleteAfterCreate(clipIds: string[], options: ExecuteOptions): Promise<CommandResult> {
        const resolved = await Promise.all(clipIds.map((id) => this.pendingCreates.get(id) ?? Promise.resolve(id)));
        const realIds = resolved.filter((id): id is string => id !== null);
        // A failed create already rolled its temp clip back: nothing is left to delete.
        if (realIds.length === 0) return { ok: true, changed: {} };
        return this.execute({ type: "clip.delete", clipIds: realIds }, options);
    }

    private trackPendingCreates(tempIds: string[], settled: Promise<CommandResult>): void {
        tempIds.forEach((tempId, i) => {
            const realId = settled.then((result) => (result.ok ? result.createdClipIds?.[i] ?? null : null));
            this.pendingCreates.set(tempId, realId);
            void realId.then(() => {
                if (this.pendingCreates.get(tempId) === realId) this.pendingCreates.delete(tempId);
            });
        });
    }

    /** The order each command's optimistic edit was made in. */
    private readonly writeSeq = new WeakMap<PreparedCommand, number>();
    /** The newest edit of each clip and scene (by writeSeq). */
    private readonly latestWrite = new Map<string, number>();
    private writeCounter = 0;

    /**
     * Records `prep` as the newest edit of the items it touches. A save's answer describes an item as the backend had
     * it then; reconcile skips items edited again since (a late answer must not undo a newer edit on screen: two
     * sliders of the same item moved in quick succession lost the first one under load).
     */
    private markWrite(prep: PreparedCommand): void {
        const seq = ++this.writeCounter;
        this.writeSeq.set(prep, seq);
        for (const id of patchClipIds(prep.patch)) this.latestWrite.set(`c:${id}`, seq);
        for (const id of patchSceneIds(prep.patch)) this.latestWrite.set(`s:${id}`, seq);
    }

    private isStale(kind: "c" | "s", id: string, seq: number): boolean {
        return (this.latestWrite.get(`${kind}:${id}`) ?? 0) > seq;
    }

    private schedule(key: string, ms: number, command: EditorCommand, prep: PreparedCommand, before: HistorySnapshot, restore: () => void, options: ExecuteOptions): Promise<CommandResult> {
        const existing = this.pending.get(key);
        if (existing) {
            this.scheduler.clearTimeout(existing.timer);
            existing.resolve({ ok: false, changed: {}, superseded: true });
        }
        return new Promise<CommandResult>((resolve) => {
            const entry: PendingPersist = {
                timer: null,
                command,
                prepared: prep,
                before: existing?.before ?? before,
                restores: [...(existing?.restores ?? []), restore],
                resolve,
                options,
            };
            entry.timer = this.scheduler.setTimeout(() => {
                if (this.pending.get(key) !== entry) return;
                this.pending.delete(key);
                void this.runPersist(entry.command, entry.prepared, entry.before, entry.restores, entry.options).then(resolve);
            }, ms);
            this.pending.set(key, entry);
        });
    }

    private async runPersist(command: EditorCommand, prep: PreparedCommand, before: HistorySnapshot, restores: Array<() => void>, options: ExecuteOptions): Promise<CommandResult> {
        this.store.getState().beginTimelineSave();
        try {
            const outcome = await prep.persist(this.writeBackend(options));
            if (this.disposed) return { ok: true, changed: prep.changed };
            this.reconcile(outcome, this.writeSeq.get(prep) ?? Number.POSITIVE_INFINITY);
            prep.afterCommit?.(outcome);
            if (options.recordHistory !== false) this.record(before, { backendCalls: outcome.backendCalls, touchesScenes: prep.touchesScenes });
            else if (!this.backend.withoutHistory) this.attachUntrackedBackendSteps(outcome.backendCalls);
            const createdClipIds = outcome.createdClips?.clips.map((clip) => clip.id)
                ?? outcome.splitClips?.serverClips.filter((clip) => !outcome.splitClips?.clipIds.includes(clip.id)).map((clip) => clip.id);
            return {
                ok: true,
                changed: createdClipIds && outcome.createdClips ? { ...prep.changed, clips: createdClipIds } : prep.changed,
                createdClipIds,
                createdSceneIds: outcome.createdSceneIds,
                ...(prep.resultOutput !== undefined ? { output: prep.resultOutput } : {}),
            };
        } catch (error) {
            for (const restore of [...restores].reverse()) restore();
            if (options.toastOnError !== false) this.toast({ kind: "error", message: this.errorMessage(command.type) });
            this.options.logger?.error(`[TimelineController] ${command.type} failed`, error);
            return { ok: false, changed: {}, error: errorText(error) };
        } finally {
            this.store.getState().endTimelineSave();
        }
    }

    /** recordHistory:false writes must not become backend undo steps either (runHistory sums recorded calls). */
    private writeBackend(options: ExecuteOptions): TimelineBackend {
        if (options.recordHistory !== false) return this.backend;
        return this.backend.withoutHistory?.() ?? this.backend;
    }

    /**
     * Backend writes without a controller entry (a silent command on a backend that has no
     * withoutHistory, or an edit whose local snapshot did not change) are still backend
     * undo steps. They join the newest entry, so the next undo pops them with it and both
     * stacks stay aligned; that entry's `before` snapshot predates them too.
     */
    private attachUntrackedBackendSteps(calls: number): void {
        const newest = this.undoMeta[this.undoMeta.length - 1];
        if (newest && calls > 0) newest.backendCalls += calls;
    }

    /**
     * A multi-write command failed after `written` successful writes (the first one started when
     * backendCallsStarted was `mark`): take them back so no half edit stays behind (the store is restored by
     * runPersist). On a withoutHistory() view the compensating writes run (they are not undo steps). On the
     * main backend one backend undo takes exactly our writes back when nothing else wrote since; otherwise the
     * compensating writes run and fold, with the partial writes, into the newest undo entry so both histories
     * stay aligned. `compensate` lists the inverse of each successful write, newest first.
     */
    private async takeBackPartialWrites(backend: TimelineBackend, mark: number, written: number, compensate: Array<() => Promise<unknown>>, label: string): Promise<void> {
        if (written <= 0) return;
        const log = (error: unknown) => this.options.logger?.error(`[TimelineController] ${label} could not take back its partial writes`, error);
        if (backend === this.backend && this.backendCallsStarted === mark + written + 1) {
            this.backendCallsStarted += 1;
            await backend.undo(this.projectId, written).catch(log);
            return;
        }
        let done = 0;
        for (const step of compensate.slice(0, written)) {
            this.backendCallsStarted += 1;
            try {
                await step();
                done += 1;
            } catch (error) {
                log(error);
            }
        }
        if (backend === this.backend) this.attachUntrackedBackendSteps(written + done);
    }

    private async call<T>(fn: () => Promise<T>, idempotent: boolean): Promise<T> {
        this.backendCallsStarted += 1;
        try {
            return await withTimeout(fn(), this.timeoutMs, this.scheduler);
        } catch (error) {
            if (error instanceof TimelineTimeoutError && idempotent && this.retryOnTimeout) {
                return withTimeout(fn(), this.timeoutMs * 2, this.scheduler);
            }
            throw error;
        }
    }

    // ── store-only commands ───────────────────────────────
    private applyLocal(command: EditorCommand): CommandResult | null {
        const s = this.store.getState();
        const ok: CommandResult = { ok: true, changed: {} };
        switch (command.type) {
            case "playhead.seek":
                // handleSeek, nle-timeline.tsx:1795-1803 (the caller clamps to the duration)
                s.setCurrentTime(Math.max(0, command.seconds));
                s.setSeekRequest(Math.max(0, command.seconds));
                s.setShuttleSpeed(0);
                return ok;
            case "selection.set":
                if (command.sceneIds !== undefined) s.setSelection({ clipIds: command.clipIds ?? [], sceneIds: command.sceneIds });
                else if (command.clipIds !== undefined) s.setSelectedClipIds(new Set(command.clipIds));
                if (command.sceneId !== undefined) {
                    if (command.sceneId === null) s.setSelectedSceneId(null);
                    else s.selectScene(command.sceneId);
                }
                if (command.transition !== undefined) {
                    if (command.transition) s.selectTransition(command.transition);
                    else s.clearTransitionSelection();
                }
                if (command.audioTarget) s.selectAudioTarget(command.audioTarget);
                if (command.markerId !== undefined) s.setSelectedMarkerId(command.markerId);
                return ok;
            case "view.update":
                if (command.zoom !== undefined) s.setTimelineZoom(command.zoom);
                if (command.tool !== undefined) s.setToolMode(command.tool);
                if (command.snap !== undefined) s.setSnapEnabled(command.snap);
                if (command.snapToBeats !== undefined) s.setSnapToBeats(command.snapToBeats);
                return ok;
            case "playback.set":
                if (command.playing !== undefined) {
                    s.setIsPlaying(command.playing);
                    s.setPlayRequest(command.playing ? "play" : "pause");
                }
                if (command.shuttleSpeed !== undefined) s.setShuttleSpeed(command.shuttleSpeed);
                return ok;
            case "clipboard.set":
                s.setTimelineClipboard(command.clipboard);
                return ok;
            case "marker.add":
                s.addTimelineMarker(command.time, command.label);
                return ok;
            case "marker.move":
                s.moveTimelineMarker(command.markerId, command.time);
                return ok;
            case "marker.remove":
                if (command.markerId) s.removeTimelineMarker(command.markerId);
                else if (command.near !== undefined) s.removeTimelineMarkerNear(command.near, command.thresholdSeconds);
                return ok;
            case "export.start":
                return { ok: false, changed: {}, unavailable: true, error: "export.start needs @opennan/export (spec §5.8)" };
            case "export.cancel":
                return { ok: false, changed: {}, unavailable: true, error: "export.cancel needs a host exporter" };
            case "ai.run":
                return { ok: false, changed: {}, unavailable: true, error: `ai.run needs a provider for ${command.capability} (spec §5.4)` };
            default:
                return null;
        }
    }

    // ── persisted commands ────────────────────────────────
    private prepare(command: EditorCommand): Prepared {
        const pid = this.projectId;
        const timeline = this.store.getState().timelineData;
        switch (command.type) {
            case "clip.create": {
                if (!timeline) return invalid(NOT_LOADED);
                const inputs = Array.isArray(command.input) ? command.input : [command.input];
                if (inputs.length === 0) return invalid("clip.create needs at least one input");
                const tempIds = inputs.map(() => this.tempId("temp"));
                const optimistic = inputs.map((input, i) => optimisticTimelineClipFromInput(input as Record<string, any>, pid, tempIds[i]));
                // Optional new track list written first (a sticker or text on a new track): still one undo entry.
                const nextTracks = command.tracks && JSON.stringify(command.tracks) !== JSON.stringify(timeline.tracks) ? command.tracks : null;
                return persisted({
                    patch: { ...emptyPatch(), ...(nextTracks ? { tracks: nextTracks } : {}), clipsUpsert: optimistic },
                    idempotent: false, touchesScenes: false, changed: { clips: tempIds, ...(nextTracks ? { tracks: true } : {}) }, tempClipIds: tempIds, tempSceneIds: [],
                    persist: async (backend) => {
                        if (!nextTracks) {
                            return { backendCalls: 1, createdClips: { tempIds, clips: await this.call(() => backend.createClips(pid, inputs), false) } };
                        }
                        const mark = this.backendCallsStarted;
                        const tracks = await this.call(() => backend.updateTracks(pid, nextTracks), true);
                        try {
                            return { backendCalls: 2, tracks, createdClips: { tempIds, clips: await this.call(() => backend.createClips(pid, inputs), false) } };
                        } catch (error) {
                            // Take the new track back so no empty track remains.
                            await this.takeBackPartialWrites(backend, mark, 1, [() => backend.updateTracks(pid, timeline.tracks)], "clip.create");
                            throw error;
                        }
                    },
                });
            }
            case "clip.update":
            case "clip.updateMany":
            case "clip.move": {
                if (!timeline) return invalid(NOT_LOADED);
                let updates: TimelineClipUpdate[];
                if (command.type === "clip.update") {
                    updates = timeline.clips.filter((clip) => command.clipIds.includes(clip.id)).map((clip) => {
                        const next = { ...clip, ...command.patch };
                        return { clipId: clip.id, ...command.patch, startTime: next.startTime, endTime: next.endTime };
                    });
                } else if (command.type === "clip.updateMany") {
                    updates = command.updates;
                } else {
                    updates = timeline.clips.filter((clip) => command.clipIds.includes(clip.id)).map((clip) => {
                        const startTime = Math.max(0, clip.startTime + command.deltaSeconds);
                        return {
                            clipId: clip.id,
                            startTime,
                            endTime: startTime + (clip.endTime - clip.startTime),
                            trackType: command.targetTrack?.type ?? clip.trackType,
                            trackIndex: command.targetTrack?.index ?? clip.trackIndex,
                        };
                    });
                }
                if (updates.length === 0) return invalid("no matching clips");
                if (updates.some((update) => update.clipId.startsWith("temp-"))) return invalid("clip is still being created");
                updates = withCaptionWordRebase(updates, this.gestureBase?.clips ?? timeline.clips, timeline.clips);
                const next = mergeClipUpdates(timeline.clips, updates);
                return persisted({
                    patch: { ...emptyPatch(), clipsUpsert: next },
                    idempotent: true, touchesScenes: false, changed: { clips: next.map((clip) => clip.id) }, tempClipIds: [], tempSceneIds: [],
                    persist: async (backend) => {
                        const returned = await this.call(() => backend.updateClips(pid, updates), true);
                        return { backendCalls: 1, upsertClips: Array.isArray(returned) ? returned : undefined };
                    },
                });
            }
            case "clip.split": {
                if (!timeline) return invalid(NOT_LOADED);
                if (command.clipIds.some((id) => id.startsWith("temp-"))) return invalid("clip is still being created");
                const split = createOptimisticSplitTimelineData(timeline, command.clipIds, command.atSeconds);
                if (!split) return invalid("nothing to split at this time");
                const splitIds = new Set(command.clipIds);
                const lefts = split.timeline.clips.filter((clip) => splitIds.has(clip.id));
                const createdIds = split.createdClips.map((clip) => clip.id);
                return persisted({
                    patch: { ...emptyPatch(), clipsUpsert: [...lefts, ...split.createdClips] },
                    idempotent: false, touchesScenes: false, changed: { clips: [...command.clipIds, ...createdIds] }, tempClipIds: createdIds, tempSceneIds: [],
                    persist: async (backend) => ({
                        backendCalls: 1,
                        splitClips: {
                            clipIds: command.clipIds,
                            optimisticCreated: split.createdClips,
                            serverClips: await this.call(() => backend.splitClips(pid, command.clipIds, command.atSeconds), false),
                        },
                    }),
                });
            }
            case "clip.delete": {
                if (!timeline) return invalid(NOT_LOADED);
                if (command.clipIds.some((id) => id.startsWith("temp-"))) return invalid("clip is still being created");
                return persisted({
                    patch: { ...emptyPatch(), clipsRemove: command.clipIds },
                    idempotent: false, touchesScenes: false, changed: { clips: command.clipIds }, tempClipIds: [], tempSceneIds: [],
                    persist: async (backend) => {
                        await this.call(() => backend.deleteClips(pid, command.clipIds), false);
                        return { backendCalls: 1 };
                    },
                });
            }
            case "clip.batch": {
                if (!timeline) return invalid(NOT_LOADED);
                const batch = command.command;
                const tempIds = batch.creates.map(() => this.tempId("temp"));
                const created = batch.creates.map((input, i) => optimisticTimelineClipFromInput(input as Record<string, any>, pid, tempIds[i]));
                const updated = mergeClipUpdates(timeline.clips, batch.updates as TimelineClipUpdate[]);
                return persisted({
                    patch: { ...emptyPatch(), clipsUpsert: [...updated, ...created], clipsRemove: batch.deleteIds },
                    idempotent: false, touchesScenes: false,
                    changed: { clips: [...updated.map((clip) => clip.id), ...tempIds, ...batch.deleteIds] },
                    tempClipIds: tempIds, tempSceneIds: [],
                    persist: async (backend) => {
                        const result = await this.call(() => backend.commitCommand(pid, batch), false);
                        return { backendCalls: 1, createdClips: { tempIds, clips: result.created }, upsertClips: result.updated };
                    },
                });
            }
            case "clip.effect.add": {
                if (!timeline) return invalid(NOT_LOADED);
                if (!this.backend.addClipEffect) return unavailable("this backend cannot attach effects");
                if (command.targets) return this.prepareGroupEffectAdd(command);
                const owner = this.effectOwner(command.clipId, command.sceneId);
                if (!owner) return invalid(command.sceneId ? "no matching scene" : "no matching clips");
                const paramsJson = command.params ? JSON.stringify(command.params) : null;
                const rows = sortedRows(owner.effects);
                const index = Math.max(0, Math.min(rows.length, Math.trunc(command.index ?? rows.length)));
                const optimistic = buildOptimisticClipEffect(owner.clipId ?? "", command.effectId, index);
                rows.splice(index, 0, { ...optimistic, clipId: owner.clipId, sceneId: owner.sceneId, paramsJson });
                const target = owner.clipId ? { clipId: owner.clipId } : { sceneId: owner.sceneId };
                return this.effectStackCommand(owner, reorderRows(rows), false, (backend) => backend.addClipEffect!(pid, target, command.effectId, { paramsJson, index }));
            }
            case "clip.effect.update": {
                if (!timeline) return invalid(NOT_LOADED);
                if (!this.backend.updateClipEffect) return unavailable("this backend cannot edit effects");
                const owner = this.effectRowOwner(command.effectRowId);
                if (!owner) return invalid("no matching effect");
                const rows = sortedRows(owner.effects).map((e) => (e.id === command.effectRowId ? { ...e, ...command.patch } : e));
                return this.effectStackCommand(owner, rows, true, (backend) => backend.updateClipEffect!(pid, command.effectRowId, command.patch));
            }
            case "clip.effect.remove": {
                if (!timeline) return invalid(NOT_LOADED);
                if (!this.backend.removeClipEffect) return unavailable("this backend cannot remove effects");
                const owner = this.effectRowOwner(command.effectRowId);
                if (!owner) return invalid("no matching effect");
                const rows = reorderRows(sortedRows(owner.effects).filter((e) => e.id !== command.effectRowId));
                return this.effectStackCommand(owner, rows, false, (backend) => backend.removeClipEffect!(pid, command.effectRowId));
            }
            case "clip.effect.reorder": {
                if (!timeline) return invalid(NOT_LOADED);
                if (!this.backend.reorderClipEffects) return unavailable("this backend cannot reorder effects");
                const owner = this.effectOwner(command.clipId, command.sceneId);
                if (!owner) return invalid(command.sceneId ? "no matching scene" : "no matching clips");
                const byId = new Map((owner.effects ?? []).map((row) => [row.id, row]));
                const ids = command.effectRowIds;
                if (ids.length !== byId.size || new Set(ids).size !== ids.length || ids.some((id) => !byId.has(id))) {
                    return invalid("clip.effect.reorder needs every row of the stack exactly once");
                }
                const target = owner.clipId ? { clipId: owner.clipId } : { sceneId: owner.sceneId };
                return this.effectStackCommand(owner, reorderRows(ids.map((id) => byId.get(id)!)), true, (backend) => backend.reorderClipEffects!(pid, target, ids));
            }
            case "transition.set": {
                const type = normalizeTimelineTransitionType(command.transition);
                if (command.sceneId) {
                    const scenes = selectLiveScenes(this.store.getState());
                    const junction = sceneJunctions(scenes, timeline?.tracks ?? []).find((j) => j.sceneId === command.sceneId);
                    if (!junction && type === "none" && scenes.some((s) => s.id === command.sceneId)) {
                        // A transition left behind after its neighbour moved away can always be removed.
                        return this.prepare({ type: "scene.update", sceneId: command.sceneId, patch: { visualTransition: "none", visualTransitionDuration: 0 } });
                    }
                    if (!junction) return invalid("this scene has no next scene to transition to");
                    if (!junction.editable) return invalid("the track is locked or hidden");
                    const def = type === "none" ? null : transitionById(type);
                    const duration = def ? clampJunctionDuration(junction, command.duration ?? def.defaultDuration) : 0;
                    return this.prepare({ type: "scene.update", sceneId: command.sceneId, patch: { visualTransition: type, visualTransitionDuration: duration } });
                }
                if (command.clipId) {
                    if (!timeline) return invalid(NOT_LOADED);
                    const clip = timeline.clips.find((c) => c.id === command.clipId);
                    if (!clip) return invalid("no matching clips");
                    // Upper-track video/image cut (phase 10b): the transition is a centered window between the two
                    // clips (looks/windows.ts clipTransitionChains), stored on the outgoing clip like a scene's, with
                    // the scene rules (0.06 s cut tolerance, duration clamped to 2 s and both neighbours). The window
                    // replaces fades at the cut, so the clip's own fades are left alone — except fades a legacy
                    // preset wrote along with the old transition (equal to its duration), which go with it. Removing a
                    // transition from any upper-track clip follows the same rule (also after its neighbour moved away).
                    const junction = clipJunction(timeline.clips, clip.id);
                    if ((junction?.outgoingId === clip.id && transitionById(type)) || (type === "none" && isLaneClip(clip))) {
                        const def = transitionById(type);
                        const duration = def && junction ? clampJunctionDuration(junction, command.duration ?? def.defaultDuration) : 0;
                        const presetFade = (value: number | null | undefined) => normalizeTimelineTransitionType(String(clip.transitionType ?? "none")) !== "none"
                            && Number(value ?? 0) > 0 && Math.abs(Number(value) - Number(clip.transitionDuration ?? 0)) < 0.0015;
                        const patch: Partial<TimelineClip> = { transitionType: type, transitionDuration: duration, transitionParamsJson: null };
                        if (presetFade(clip.fadeInDuration)) patch.fadeInDuration = 0;
                        if (presetFade(clip.fadeOutDuration)) patch.fadeOutDuration = 0;
                        return this.prepare({ type: "clip.update", clipIds: [clip.id], patch });
                    }
                    if (type !== "none") {
                        const next = timeline.clips.find((c) => c.id !== clip.id && c.trackType === clip.trackType && c.trackIndex === clip.trackIndex && Math.abs(c.startTime - clip.endTime) <= 0.001);
                        if (clip.trackType !== "video" || !next) return invalid("this clip has no next clip to transition to");
                    }
                    const def = transitionById(type);
                    const update = getTimelineTransitionPresetUpdate(type, command.duration ?? def?.defaultDuration ?? 0.5, clip);
                    return this.prepare({ type: "clip.update", clipIds: [clip.id], patch: update });
                }
                return invalid("transition.set needs a sceneId or a clipId");
            }
            case "transition.applyAll": {
                const type = normalizeTimelineTransitionType(command.transition);
                const def = transitionById(type);
                const scenes = selectLiveScenes(this.store.getState());
                const junctions = sceneJunctions(scenes, timeline?.tracks ?? []).filter((j) => j.editable);
                if (junctions.length === 0) return invalid("there are no cuts between scenes");
                const patches = junctions.map((j) => ({
                    sceneId: j.sceneId,
                    patch: { visualTransition: type, visualTransitionDuration: def ? clampJunctionDuration(j, command.duration ?? def.defaultDuration) : 0 } as Partial<SceneData>,
                }));
                return persisted({
                    patch: { ...emptyPatch(), sceneFieldPatches: patches },
                    idempotent: true, touchesScenes: true, changed: { scenes: patches.map((p) => p.sceneId) }, tempClipIds: [], tempSceneIds: [],
                    persist: async (backend) => {
                        // One write (one undo step) where the backend supports it; per-scene calls otherwise.
                        if (backend.updateScenes) {
                            return { backendCalls: 1, scenes: await this.call(() => backend.updateScenes!(pid, patches), true) };
                        }
                        const updated: SceneData[] = [];
                        for (const { sceneId, patch } of patches) updated.push(await this.call(() => backend.updateScene(pid, sceneId, patch), true));
                        return { backendCalls: patches.length, scenes: updated };
                    },
                });
            }
            case "look.set": {
                if (command.targets) return this.prepareGroupApply(command);
                const target = command.sceneId ? this.liveScene(command.sceneId) : timeline?.clips.find((c) => c.id === command.clipId);
                if (!target) return invalid(command.sceneId ? "no matching scene" : "no matching clips");
                const lookPlan = planLookPatch(target, command.sceneId ? "scene" : "clip", command);
                if (!lookPlan.ok) return invalid(lookPlan.error);
                const patch = lookPlan.value;
                return command.sceneId
                    ? this.prepare({ type: "scene.update", sceneId: command.sceneId, patch: patch as Partial<SceneData> })
                    : this.prepare({ type: "clip.update", clipIds: [command.clipId!], patch: patch as Partial<TimelineClip> });
            }
            case "animation.set":
            case "keyframe.set":
            case "keyframe.remove":
            case "keyframe.easing":
            case "keyframe.retime": {
                if (!timeline) return invalid(NOT_LOADED);
                if (command.type === "animation.set" && command.targets) return this.prepareGroupApply(command);
                const scene = command.sceneId ? this.liveScene(command.sceneId) : undefined;
                const clip = command.sceneId ? undefined : timeline.clips.find((c) => c.id === command.clipId);
                if (command.sceneId ? !scene : !clip) return invalid(command.sceneId ? "no matching scene" : "no matching clips");
                if (command.type === "keyframe.retime" && itemOnLockedTrack(timeline.tracks, scene, clip)) return invalid("the track is locked");
                if (clip && (clip.trackType === "audio" || clip.trackType === "effect") && command.type === "animation.set") return invalid("this item cannot be animated");
                let field: "animationJson" | "keyframesJson";
                let plan;
                if (command.type === "animation.set") {
                    field = "animationJson";
                    const target = scene ? "clip" as const : motionTarget({ kind: "clip", clip: clip! });
                    plan = planAnimation(target, (scene ?? clip!).animationJson, command);
                } else {
                    field = "keyframesJson";
                    const duration = scene ? getSceneDuration(scene) : clip!.endTime - clip!.startTime;
                    plan = planKeyframes((scene ?? clip!).keyframesJson, duration, command);
                }
                if (!plan.ok) return invalid(plan.error);
                return scene
                    ? this.prepare({ type: "scene.update", sceneId: scene.id, patch: { [field]: plan.value } })
                    : this.prepare({ type: "clip.update", clipIds: [clip!.id], patch: { [field]: plan.value } });
            }
            case "mask.set": {
                if (!timeline) return invalid(NOT_LOADED);
                if (command.targets) return this.prepareGroupMask(command);
                if (!command.sceneId && !command.clipId) return invalid("mask.set needs a sceneId or a clipId");
                const scenes = command.sceneId ? selectLiveScenes(this.store.getState()) : [];
                const sceneIndex = command.sceneId ? scenes.findIndex((s) => s.id === command.sceneId) : -1;
                const scene = sceneIndex >= 0 ? scenes[sceneIndex] : undefined;
                const clip = command.sceneId ? undefined : timeline.clips.find((c) => c.id === command.clipId);
                if (command.sceneId ? !scene : !clip) return invalid(command.sceneId ? "no matching scene" : "no matching clips");
                if (clip && !clipTakesMask(clip)) return invalid("only scenes and video, image, text, and sticker clips take a mask");
                if (clip?.id.startsWith("temp-")) return invalid("clip is still being created");
                if (itemOnLockedTrack(timeline.tracks, scene, clip)) return invalid("the track is locked");
                const start = scene ? getSceneStart(scene, scenes, sceneIndex) : clip!.startTime;
                const duration = scene ? getSceneDuration(scene) : Math.max(0, clip!.endTime - clip!.startTime);
                const time = command.time ?? Math.min(duration, Math.max(0, this.store.getState().currentTime - start));
                const plan = planMask(scene ?? clip!, duration, { mask: command.mask, time, replace: command.replace });
                if (!plan.ok) return invalid(plan.error);
                const patch: Record<string, unknown> = { maskJson: plan.value.maskJson };
                if (plan.value.keyframesJson !== undefined) patch.keyframesJson = plan.value.keyframesJson;
                return scene
                    ? this.prepare({ type: "scene.update", sceneId: scene.id, patch: patch as Partial<SceneData> })
                    : this.prepare({ type: "clip.update", clipIds: [clip!.id], patch: patch as Partial<TimelineClip> });
            }
            case "text.style.set":
            case "text.template.apply":
            case "caption.style.apply": {
                if (!timeline) return invalid(NOT_LOADED);
                const plan = command.type === "text.style.set"
                    ? planTextStyle(timeline.clips, command.clipIds, command.patch)
                    : command.type === "text.template.apply"
                        ? planTextTemplate(timeline.clips, command.clipIds, command.templateId)
                        : planCaptionStyle(timeline.clips, command);
                if (!plan.ok) return invalid(plan.error);
                if (plan.value.some((u) => u.clipId.startsWith("temp-"))) return invalid("clip is still being created");
                return this.prepare({ type: "clip.updateMany", updates: plan.value });
            }
            case "speed.set": {
                if (!timeline) return invalid(NOT_LOADED);
                const base = this.gestureBase;
                if (command.sceneId) {
                    const liveScenes = selectLiveScenes(this.store.getState());
                    const scenes = base?.scenes ?? liveScenes;
                    const scene = scenes.find((sc) => sc.id === command.sceneId);
                    if (!scene) return invalid("no matching scene");
                    const plan = planSceneSpeed(scenes, base?.clips ?? timeline.clips, scene, command, { scenes: liveScenes, clips: timeline.clips });
                    if (!plan.ok) return invalid(plan.error);
                    const { patch, moves, clipUpdates } = plan.value;
                    const clipPatch = mergeClipUpdates(timeline.clips, clipUpdates);
                    // What the backend holds before this write (the state before the gesture), to take a half write back.
                    const original: Partial<SceneData> = Object.fromEntries(Object.keys(patch).map((key) => [key, (scene as unknown as Record<string, unknown>)[key] ?? null]));
                    const originalMoves: SceneMove[] = moves.map((move) => ({ sceneId: move.sceneId, timelinePositionSeconds: Number(scenes.find((sc) => sc.id === move.sceneId)?.timelinePositionSeconds) || 0 }));
                    const originalClips: TimelineClipUpdate[] = clipUpdates.map((update) => {
                        const was = (base?.clips ?? timeline.clips).find((c) => c.id === update.clipId)!;
                        return { clipId: was.id, startTime: was.startTime, endTime: was.endTime };
                    });
                    return persisted({
                        patch: { ...emptyPatch(), sceneFieldPatches: [{ sceneId: scene.id, patch }], scenePositions: moves, clipsUpsert: clipPatch },
                        idempotent: true, touchesScenes: true,
                        changed: { scenes: [scene.id, ...moves.map((m) => m.sceneId).filter((id) => id !== scene.id)], clips: clipPatch.map((c) => c.id) },
                        tempClipIds: [], tempSceneIds: [],
                        persist: async (backend) => {
                            const mark = this.backendCallsStarted;
                            const undoSteps: Array<() => Promise<unknown>> = [];
                            try {
                                const scenesOut: SceneData[] = [await this.call(() => backend.updateScene(pid, scene.id, patch), true)];
                                undoSteps.unshift(() => backend.updateScene(pid, scene.id, original));
                                if (moves.length > 0) {
                                    scenesOut.push(...await this.call(() => backend.moveScenes(pid, moves), true));
                                    undoSteps.unshift(() => backend.moveScenes(pid, originalMoves));
                                }
                                let upsertClips: TimelineClip[] | undefined;
                                if (clipUpdates.length > 0) {
                                    const returned = await this.call(() => backend.updateClips(pid, clipUpdates), true);
                                    upsertClips = Array.isArray(returned) ? returned : undefined;
                                    undoSteps.unshift(() => backend.updateClips(pid, originalClips));
                                }
                                return { backendCalls: undoSteps.length, scenes: scenesOut, upsertClips };
                            } catch (error) {
                                await this.takeBackPartialWrites(backend, mark, undoSteps.length, undoSteps, "speed.set");
                                throw error;
                            }
                        },
                    });
                }
                const ids = command.clipIds?.length ? command.clipIds : command.clipId ? [command.clipId] : [];
                if (ids.length === 0 || ids.some((id) => !timeline.clips.some((c) => c.id === id))) return invalid("no matching clips");
                if (ids.some((id) => id.startsWith("temp-"))) return invalid("clip is still being created");
                const plan = planClipSpeed(base?.clips ?? timeline.clips, ids, command, timeline.clips);
                if (!plan.ok) return invalid(plan.error);
                return this.prepare({ type: "clip.updateMany", updates: plan.value });
            }
            case "attributes.paste":
                return this.prepareAttributePaste(command);
            case "items.delete":
                return this.prepareItemsDelete(command);
            case "analysis.fillers":
                return { kind: "result", result: this.runFillers(command) };
            case "cuts.apply": {
                const state = this.itemsState();
                if (!state) return invalid(NOT_LOADED);
                if (!command.clipId && !command.sceneId) return invalid("cuts.apply needs a clipId or a sceneId");
                const plan = planCuts(state, command, command.ranges);
                if (!plan.ok) return invalid(plan.error);
                const { removed, removedSeconds, linked, ...edits } = plan.value;
                return this.editPlanCommand(edits, { removed, removedSeconds, linkedClipIds: linked.clipIds });
            }
            case "beats.set": {
                if (!timeline) return invalid(NOT_LOADED);
                const clip = timeline.clips.find((c) => c.id === command.clipId);
                if (!clip) return invalid("no matching clips");
                if (clip.trackType !== "audio") return invalid("beats belong to audio clips");
                if (clip.locked || timeline.tracks.some((t) => t.type === "audio" && t.index === clip.trackIndex && t.locked)) return invalid("the track is locked");
                const plan = planBeatsJson(command.beats);
                if (!plan.ok) return invalid(plan.error);
                if ((clip.beatsJson ?? null) === plan.value) return { kind: "result", result: { ok: true, changed: {} } };
                return this.prepare({ type: "clip.update", clipIds: [clip.id], patch: { beatsJson: plan.value } });
            }
            case "beats.autoCut": {
                const state = this.itemsState();
                if (!state) return invalid(NOT_LOADED);
                const s = this.store.getState();
                const useSelection = command.clipIds === undefined && command.sceneIds === undefined;
                const clipIds = useSelection ? [...s.selectedClipIds] : command.clipIds ?? [];
                const sceneIds = useSelection ? (s.selectedSceneIds.size > 0 ? [...s.selectedSceneIds] : s.selectedSceneId ? [s.selectedSceneId] : []) : command.sceneIds ?? [];
                // The beat clip itself is never re-timed.
                const plan = planAutoCut(state, { clipIds: clipIds.filter((id) => id !== command.beatClipId), sceneIds, beatClipId: command.beatClipId, every: command.every });
                if (!plan.ok) return invalid(plan.error);
                const { clipUpdates, scenePatches, sceneMoves, snapped, unchanged, beatClipId } = plan.value;
                if (clipUpdates.length === 0 && scenePatches.length === 0 && sceneMoves.length === 0) {
                    return { kind: "result", result: { ok: true, changed: {}, output: { snapped, unchanged, beatClipId } } };
                }
                return this.editPlanCommand({ clipUpdates, scenePatches, sceneMoves }, { snapped, unchanged, beatClipId });
            }
            case "items.duplicate":
            case "items.paste": {
                const state = this.itemsState();
                if (!state) return invalid(NOT_LOADED);
                const plan = command.type === "items.duplicate"
                    ? planItemsDuplicate(state, command.clipIds, command.sceneIds, command.at)
                    : planItemsPaste(state, command.clipboard, command.at);
                if (!plan.ok) return invalid(plan.error);
                return this.prepareItemsCreate(plan.value);
            }
            case "tracking.apply": {
                const state = this.itemsState();
                if (!state) return invalid(NOT_LOADED);
                const tracker = this.options.motionTracker;
                const plan = planTrackingApply(
                    { ...state, aspectRatio: this.store.getState().projectMeta?.aspectRatio }, command, command,
                    tracker?.anchors ? (ids) => tracker.anchors!(ids) : undefined,
                );
                if (!plan.ok) return invalid(plan.error);
                const prepared = this.itemPatchesCommand({ clipUpdates: plan.value.clipUpdates, scenePatches: plan.value.scenePatches }, true);
                if (prepared.kind === "persist") prepared.command.resultOutput = plan.value.report;
                return prepared;
            }
            case "items.transform": {
                if (!timeline) return invalid(NOT_LOADED);
                const plan = planItemsTransform(this.itemsState()!, command.clips, command.scenes);
                if (!plan.ok) return invalid(plan.error);
                return this.itemPatchesCommand(plan.value, true);
            }
            case "effect.layer.add": {
                if (!timeline) return invalid(NOT_LOADED);
                if (!this.backend.addClipEffect) return unavailable("this backend cannot attach effects");
                const plan = planEffectLayer(timeline.tracks, timeline.clips, command);
                if (!plan.ok) return invalid(plan.error);
                const { tracks: nextTracks, input } = plan.value;
                const tempId = this.tempId("temp");
                const paramsJson = command.params ? JSON.stringify(command.params) : null;
                const optimisticRow = { ...buildOptimisticClipEffect(tempId, command.effectId, 0), paramsJson };
                const optimisticClip = { ...optimisticTimelineClipFromInput(input as Record<string, any>, pid, tempId), effects: [optimisticRow] };
                return persisted({
                    patch: { ...emptyPatch(), ...(nextTracks ? { tracks: nextTracks } : {}), clipsUpsert: [optimisticClip] },
                    idempotent: false, touchesScenes: false, changed: { tracks: Boolean(nextTracks), clips: [tempId] }, tempClipIds: [tempId], tempSceneIds: [],
                    persist: async (backend) => {
                        const mark = this.backendCallsStarted;
                        // The inverse of each successful write, newest first.
                        const undoSteps: Array<() => Promise<unknown>> = [];
                        try {
                            let tracksOut: TimelineTrack[] | undefined;
                            if (nextTracks) {
                                tracksOut = await this.call(() => backend.updateTracks(pid, nextTracks), true);
                                undoSteps.unshift(() => backend.updateTracks(pid, timeline.tracks));
                            }
                            const [created] = await this.call(() => backend.createClips(pid, [input]), false);
                            undoSteps.unshift(() => backend.deleteClips(pid, [created.id]));
                            const effects = await this.call(() => backend.addClipEffect!(pid, { clipId: created.id }, command.effectId, { paramsJson, index: 0 }), false);
                            return { backendCalls: undoSteps.length + 1, tracks: tracksOut, createdClips: { tempIds: [tempId], clips: [created] }, clipEffects: { clipId: created.id, effects } };
                        } catch (error) {
                            // No empty layer or track left behind (the store is restored by runPersist).
                            await this.takeBackPartialWrites(backend, mark, undoSteps.length, undoSteps, "effect.layer.add");
                            throw error;
                        }
                    },
                });
            }
            case "track.update": {
                if (!timeline) return invalid(NOT_LOADED);
                const removed = command.removed ?? [];
                const cascaded = removed.length === 0 ? [] : timeline.clips
                    .filter((clip) => removed.some((ref) => ref.type === clip.trackType && ref.index === clip.trackIndex))
                    .map((clip) => clip.id);
                return persisted({
                    patch: { ...emptyPatch(), tracks: command.tracks, clipsRemove: cascaded },
                    idempotent: true, touchesScenes: false, changed: { tracks: true, clips: cascaded }, tempClipIds: [], tempSceneIds: [],
                    persist: async (backend) => ({
                        backendCalls: 1,
                        tracks: await this.call(() => backend.updateTracks(pid, command.tracks, command.removed), true),
                    }),
                });
            }
            case "scene.move": {
                const clipUpdates = command.clipUpdates ?? [];
                const clipPatch = timeline ? mergeClipUpdates(timeline.clips, clipUpdates) : [];
                return persisted({
                    patch: { ...emptyPatch(), scenePositions: command.moves, clipsUpsert: clipPatch },
                    idempotent: true, touchesScenes: true,
                    changed: { scenes: command.moves.map((move) => move.sceneId), clips: clipPatch.map((clip) => clip.id) },
                    tempClipIds: [], tempSceneIds: [],
                    persist: async (backend) => {
                        const scenes = await this.call(() => backend.moveScenes(pid, command.moves), true);
                        if (clipUpdates.length === 0) return { backendCalls: 1, scenes };
                        const returned = await this.call(() => backend.updateClips(pid, clipUpdates), true);
                        return { backendCalls: 2, scenes, upsertClips: Array.isArray(returned) ? returned : undefined };
                    },
                });
            }
            case "scene.trim": {
                const fieldPatch: Partial<SceneData> = command.mode === "content"
                    ? { duration: command.duration, cardConfig: command.cardConfig ?? null }
                    : command.mode === "duration" ? { duration: command.duration } : {};
                const ownMove = command.timelinePositionSeconds === undefined ? [] : [{ sceneId: command.sceneId, timelinePositionSeconds: command.timelinePositionSeconds }];
                const rippleMoves = command.ripple?.moves ?? [];
                const rippleClips = command.ripple?.clipUpdates ?? [];
                const clipPatch = timeline ? mergeClipUpdates(timeline.clips, rippleClips) : [];
                return persisted({
                    patch: {
                        ...emptyPatch(),
                        sceneFieldPatches: [{ sceneId: command.sceneId, patch: fieldPatch }],
                        scenePositions: [...ownMove, ...rippleMoves],
                        clipsUpsert: clipPatch,
                    },
                    idempotent: true, touchesScenes: true,
                    changed: { scenes: [command.sceneId, ...rippleMoves.map((m) => m.sceneId)], clips: clipPatch.map((clip) => clip.id) },
                    tempClipIds: [], tempSceneIds: [],
                    // Same order as handleUpdateSceneDuration (nle-timeline.tsx:1465-1554).
                    persist: async (backend) => {
                        let calls = 0;
                        const scenes: SceneData[] = [];
                        if (command.mode === "content") {
                            scenes.push(await this.call(() => backend.trimScene(pid, { sceneId: command.sceneId, duration: command.duration, cardConfig: command.cardConfig ?? null }), true));
                            calls += 1;
                        }
                        if (ownMove.length > 0) {
                            scenes.push(...await this.call(() => backend.moveScenes(pid, ownMove), true));
                            calls += 1;
                        }
                        if (command.mode === "duration") {
                            scenes.push(await this.call(() => backend.setSceneDuration(pid, command.sceneId, command.duration), true));
                            calls += 1;
                        }
                        if (rippleMoves.length > 0) {
                            scenes.push(...await this.call(() => backend.moveScenes(pid, rippleMoves), true));
                            calls += 1;
                        }
                        let upsertClips: TimelineClip[] | undefined;
                        if (rippleClips.length > 0) {
                            const returned = await this.call(() => backend.updateClips(pid, rippleClips), true);
                            upsertClips = Array.isArray(returned) ? returned : undefined;
                            calls += 1;
                        }
                        return { backendCalls: calls, scenes, upsertClips };
                    },
                });
            }
            case "scene.split": {
                const opt = command.optimistic;
                return persisted({
                    patch: opt
                        ? { ...emptyPatch(), sceneFieldPatches: [{ sceneId: opt.sourceSceneId, patch: opt.firstScene }], scenesAdd: [opt.secondScene] }
                        : emptyPatch(),
                    idempotent: false, touchesScenes: true, changed: { scenes: [command.sceneId] }, tempClipIds: [], tempSceneIds: opt ? [opt.tempSceneId] : [],
                    // editor-layout.tsx:993-994: select the new scene and seek to the cut.
                    afterOptimistic: opt ? () => {
                        this.store.getState().selectScene(opt.tempSceneId);
                        this.store.getState().setSeekRequest(opt.splitTime);
                    } : undefined,
                    persist: async (backend) => {
                        const scenes = await this.call(() => backend.splitScene(pid, command.sceneId, command.atSeconds), false);
                        const created = scenes.find((scene) => scene.id !== command.sceneId);
                        if (!created) throw new Error("Split scene was not created");
                        // The split bumps the order of every later scene; reload the list so the
                        // store keeps the backend's order (mergeServerScenes would append the new scene).
                        const allScenes = await this.call(() => backend.loadScenes(pid), true);
                        return {
                            backendCalls: 1,
                            allScenes,
                            sceneIdCommit: opt ? { tempId: opt.tempSceneId, realId: created.id } : undefined,
                            createdSceneIds: [created.id],
                        };
                    },
                    // editor-layout.tsx:1016; nle-timeline.tsx:1935
                    afterCommit: (outcome) => {
                        const id = outcome.createdSceneIds?.[0];
                        if (id) this.store.getState().selectScene(id);
                    },
                });
            }
            case "scene.add": {
                const opt = command.optimistic;
                return persisted({
                    patch: opt ? { ...emptyPatch(), scenesAdd: [opt] } : emptyPatch(),
                    idempotent: false, touchesScenes: true, changed: { scenes: opt ? [opt.id] : [] }, tempClipIds: [], tempSceneIds: opt ? [opt.id] : [],
                    persist: async (backend) => {
                        const scene = await this.call(() => backend.addScene(pid, command.input), false);
                        // addScene bumps the order of later scenes: reload the list (as after scene.split).
                        const allScenes = await this.call(() => backend.loadScenes(pid), true);
                        return { backendCalls: 1, allScenes, sceneIdCommit: opt ? { tempId: opt.id, realId: scene.id } : undefined, createdSceneIds: [scene.id] };
                    },
                });
            }
            case "scene.delete": {
                const rippleMoves = command.ripple?.moves ?? [];
                return persisted({
                    patch: { ...emptyPatch(), scenesRemove: [command.sceneId], scenePositions: rippleMoves },
                    idempotent: false, touchesScenes: true, changed: { scenes: [command.sceneId, ...rippleMoves.map((m) => m.sceneId)] }, tempClipIds: [], tempSceneIds: [],
                    // Delete first; ripple only after the delete succeeded (nle-timeline.tsx:2451-2486).
                    persist: async (backend) => {
                        await this.call(() => backend.deleteScene(pid, command.sceneId), false);
                        if (rippleMoves.length > 0) await this.call(() => backend.moveScenes(pid, rippleMoves), true);
                        // deleteScene lowers the order of later scenes: reload the list.
                        const allScenes = await this.call(() => backend.loadScenes(pid), true);
                        return { backendCalls: rippleMoves.length > 0 ? 2 : 1, removedSceneIds: [command.sceneId], allScenes };
                    },
                });
            }
            case "scene.duplicate":
                return persisted({
                    patch: emptyPatch(), idempotent: false, touchesScenes: true, changed: { scenes: [command.sceneId] }, tempClipIds: [], tempSceneIds: [],
                    persist: async (backend) => {
                        const scene = await this.call(() => backend.duplicateScene(pid, command.sceneId), false);
                        // duplicateScene bumps the order of later scenes: reload the list.
                        const allScenes = await this.call(() => backend.loadScenes(pid), true);
                        return { backendCalls: 1, allScenes, createdSceneIds: [scene.id] };
                    },
                });
            case "scene.update":
                return persisted({
                    patch: { ...emptyPatch(), sceneFieldPatches: [{ sceneId: command.sceneId, patch: command.patch }] },
                    idempotent: true, touchesScenes: true, changed: { scenes: [command.sceneId] }, tempClipIds: [], tempSceneIds: [],
                    persist: async (backend) => ({ backendCalls: 1, scenes: [await this.call(() => backend.updateScene(pid, command.sceneId, command.patch), true)] }),
                });
            case "scene.reorder":
                return persisted({
                    patch: emptyPatch(), idempotent: true, touchesScenes: true, changed: { scenes: command.sceneIds }, tempClipIds: [], tempSceneIds: [],
                    persist: async (backend) => {
                        await this.call(() => backend.reorderScenes(pid, command.sceneIds), true);
                        // The new list order is the timeline order: take the backend's whole list.
                        return { backendCalls: 1, allScenes: await this.call(() => backend.loadScenes(pid), true) };
                    },
                });
            case "shot.reorder": {
                if (!this.backend.reorderShots) return unavailable("this backend cannot reorder shots");
                const shots = parseRawShots(this.liveScene(command.sceneId)?.shotBreakdown);
                const valid = shots && command.order.length === shots.length && command.order.every((i) => i >= 0 && i < shots.length);
                return persisted({
                    patch: valid && shots
                        ? { ...emptyPatch(), sceneFieldPatches: [{ sceneId: command.sceneId, patch: { shotBreakdown: JSON.stringify(command.order.map((i) => shots[i])) } }] }
                        : emptyPatch(),
                    idempotent: true, touchesScenes: true, changed: { scenes: [command.sceneId] }, tempClipIds: [], tempSceneIds: [],
                    persist: async (backend) => ({ backendCalls: 1, scenes: [await this.call(() => backend.reorderShots!(pid, command.sceneId, command.order), true)] }),
                });
            }
            case "shot.delete": {
                if (!this.backend.deleteShot) return unavailable("this backend cannot delete shots");
                const shots = parseRawShots(this.liveScene(command.sceneId)?.shotBreakdown);
                const remaining = shots && command.shotIndex >= 0 && command.shotIndex < shots.length
                    ? shots.filter((_shot, i) => i !== command.shotIndex)
                    : null;
                return persisted({
                    patch: remaining
                        ? { ...emptyPatch(), sceneFieldPatches: [{ sceneId: command.sceneId, patch: { shotBreakdown: JSON.stringify(remaining) } }] }
                        : emptyPatch(),
                    idempotent: false, touchesScenes: true, changed: { scenes: [command.sceneId] }, tempClipIds: [], tempSceneIds: [],
                    persist: async (backend) => ({ backendCalls: 1, scenes: [await this.call(() => backend.deleteShot!(pid, command.sceneId, command.shotIndex), false)] }),
                });
            }
            case "shot.merge": {
                if (!this.backend.mergeShot) return unavailable("this backend cannot merge shots");
                return persisted({
                    patch: emptyPatch(), idempotent: false, touchesScenes: true,
                    changed: { scenes: [command.input.sourceSceneId, command.input.targetSceneId] }, tempClipIds: [], tempSceneIds: [],
                    persist: async (backend) => ({ backendCalls: 1, scenes: await this.call(() => backend.mergeShot!(pid, command.input), false) }),
                });
            }
            case "shot.extract": {
                if (!this.backend.extractShot) return unavailable("this backend cannot extract shots");
                return persisted({
                    patch: emptyPatch(), idempotent: false, touchesScenes: true, changed: { scenes: [command.input.sceneId] }, tempClipIds: [], tempSceneIds: [],
                    persist: async (backend) => ({ backendCalls: 1, scenes: await this.call(() => backend.extractShot!(pid, command.input), false) }),
                });
            }
            case "project.update":
                return persisted({
                    patch: { ...emptyPatch(), project: command.patch },
                    idempotent: true, touchesScenes: false, changed: {}, tempClipIds: [], tempSceneIds: [],
                    // Project settings are not timeline history: updateProject is never a backend undo step
                    // (TimelineBackend.undo), so this entry adds no backend steps to undo.
                    persist: async (backend) => ({ backendCalls: 0, project: await this.call(() => backend.updateProject(pid, command.patch), true) }),
                });
            default:
                return invalid(`unsupported command ${command.type}`);
        }
    }

    // ── optimistic apply / rollback / reconcile ───────────
    private applyPatch(patch: OptimisticPatch): () => void {
        const s = this.store.getState();
        const clipIds = patchClipIds(patch);
        const sceneIds = patchSceneIds(patch);
        const prevTimeline = s.timelineData;
        const prevClips = new Map((prevTimeline?.clips ?? []).filter((clip) => clipIds.has(clip.id)).map((clip) => [clip.id, clip]));
        const prevTracks = patch.tracks ? prevTimeline?.tracks : undefined;
        const capture = sceneIds.size > 0 ? s.captureSceneOverrides(sceneIds) : null;
        const prevProject = patch.project ? s.projectMeta : undefined;

        if (prevTimeline && (clipIds.size > 0 || patch.tracks)) {
            const remove = new Set(patch.clipsRemove);
            const upserts = new Map(patch.clipsUpsert.map((clip) => [clip.id, clip]));
            const clips = prevTimeline.clips.filter((clip) => !remove.has(clip.id)).map((clip) => upserts.get(clip.id) ?? clip);
            for (const clip of patch.clipsUpsert) if (!prevClips.has(clip.id)) clips.push(clip);
            s.setTimelineData({ ...prevTimeline, clips, tracks: patch.tracks ?? prevTimeline.tracks });
        }
        for (const { sceneId, patch: fields } of patch.sceneFieldPatches) this.store.getState().applyLocalScenePatch(sceneId, fields);
        for (const move of patch.scenePositions) {
            this.store.getState().applySceneOverrides(new Map([[move.sceneId, move.timelinePositionSeconds]]), move.trackIndex === undefined ? undefined : move.sceneId, move.trackIndex);
        }
        for (const scene of patch.scenesAdd) this.store.getState().applyOptimisticSceneAdd(scene);
        for (const id of patch.scenesRemove) this.store.getState().applyOptimisticSceneDelete(id);
        if (patch.project && s.projectMeta) s.setProjectMeta({ ...s.projectMeta, ...patch.project });

        return () => {
            const current = this.store.getState();
            if (current.timelineData && (clipIds.size > 0 || prevTracks !== undefined)) {
                const clips = current.timelineData.clips
                    .filter((clip) => !clipIds.has(clip.id) || prevClips.has(clip.id))
                    .map((clip) => prevClips.get(clip.id) ?? clip);
                for (const [id, clip] of prevClips) if (!clips.some((c) => c.id === id)) clips.push(clip);
                current.setTimelineData({ ...current.timelineData, clips, tracks: prevTracks ?? current.timelineData.tracks });
            }
            if (capture) current.restoreSceneOverrides(capture);
            if (prevProject !== undefined) current.setProjectMeta(prevProject);
        };
    }

    private reconcile(outcome: PersistOutcome, seq = Number.POSITIVE_INFINITY): void {
        const s = this.store.getState();
        let timeline: TimelineData | null = s.timelineData;
        if (timeline) {
            if (outcome.createdClips) {
                const { tempIds, clips } = outcome.createdClips;
                timeline = replacePendingClipsWithCreated(timeline, tempIds, clips);
                const idMap = new Map<string, string>();
                tempIds.forEach((tempId, i) => {
                    if (clips[i]) idMap.set(tempId, clips[i].id);
                });
                if (idMap.size > 0) {
                    this.history.mapSnapshots((snap) => ({
                        ...snap,
                        clips: snap.clips.map((clip) => (idMap.has(clip.id) ? { ...clip, id: idMap.get(clip.id) as string } : clip)),
                    }));
                }
            }
            if (outcome.splitClips) {
                const { clipIds, optimisticCreated, serverClips } = outcome.splitClips;
                timeline = replaceOptimisticSplitWithServer(timeline, clipIds, optimisticCreated, serverClips);
            }
            if (outcome.upsertClips && outcome.upsertClips.length > 0) {
                const byId = new Map(outcome.upsertClips.filter((clip) => !this.isStale("c", clip.id, seq)).map((clip) => [clip.id, clip]));
                timeline = { ...timeline, clips: timeline.clips.map((clip) => byId.get(clip.id) ?? clip) };
            }
            if (outcome.clipEffects) {
                const { clipId, effects } = outcome.clipEffects;
                timeline = { ...timeline, clips: timeline.clips.map((clip) => (clip.id === clipId ? { ...clip, effects } : clip)) };
            }
            for (const stack of outcome.effectStacks ?? []) {
                if (!stack.clipId) continue;
                timeline = { ...timeline, clips: timeline.clips.map((clip) => (clip.id === stack.clipId ? { ...clip, effects: stack.effects } : clip)) };
            }
            if (outcome.tracks) timeline = { ...timeline, tracks: outcome.tracks };
            if (timeline !== s.timelineData) s.setTimelineData(timeline);
        }
        if (outcome.sceneIdCommit) this.store.getState().commitOptimisticSceneSplit(outcome.sceneIdCommit.tempId, outcome.sceneIdCommit.realId);
        if (outcome.allScenes) this.store.getState().syncServerScenes(outcome.allScenes);
        const scenes = outcome.scenes?.filter((scene) => !this.isStale("s", scene.id, seq));
        if (scenes && scenes.length > 0) this.store.getState().mergeServerScenes(scenes);
        if (outcome.sceneEffects) {
            const { sceneId, effects } = outcome.sceneEffects;
            const scene = this.store.getState().serverScenes.find((sc) => sc.id === sceneId);
            if (scene) this.store.getState().mergeServerScenes([{ ...scene, effects }]);
        }
        for (const stack of outcome.effectStacks ?? []) {
            if (!stack.sceneId) continue;
            const scene = this.store.getState().serverScenes.find((sc) => sc.id === stack.sceneId);
            if (scene) this.store.getState().mergeServerScenes([{ ...scene, effects: stack.effects }]);
        }
        if (outcome.removedSceneIds && outcome.removedSceneIds.length > 0) this.store.getState().removeServerScenes(outcome.removedSceneIds);
        if (outcome.project) this.store.getState().setProjectMeta(outcome.project);
    }

    // ── history ───────────────────────────────────────────
    private historySnapshot(): HistorySnapshot {
        const s = this.store.getState();
        return { tracks: s.timelineData?.tracks ?? [], clips: s.timelineData?.clips ?? [], scenes: selectLiveScenes(s) };
    }

    private record(before: HistorySnapshot, meta: HistoryMeta, after: HistorySnapshot = this.historySnapshot()): boolean {
        const token = this.history.record(before, after);
        if (token === null) {
            this.attachUntrackedBackendSteps(meta.backendCalls);
            return false;
        }
        this.undoMeta.push(meta);
        this.recordedEntries += 1;
        while (this.undoMeta.length > this.historyLimit) this.undoMeta.shift();
        this.redoMeta = [];
        this.syncHistoryFlags();
        return true;
    }

    private applySnapshot(snapshot: HistorySnapshot, touchesScenes: boolean): void {
        const s = this.store.getState();
        const timeline = s.timelineData;
        s.setTimelineData({ tracks: snapshot.tracks, clips: snapshot.clips, canUndo: timeline?.canUndo ?? false, canRedo: timeline?.canRedo ?? false });
        if (touchesScenes) this.store.getState().replaceServerScenes(snapshot.scenes);
    }

    private async runHistory(isUndo: boolean, steps: number): Promise<CommandResult> {
        const source = isUndo ? this.undoMeta : this.redoMeta;
        const count = Math.min(Math.max(1, Math.floor(steps)), source.length);
        if (count === 0) return { ok: false, changed: {}, error: isUndo ? "nothing to undo" : "nothing to redo" };
        const metas = source.slice(source.length - count);
        const backendSteps = metas.reduce((sum, meta) => sum + meta.backendCalls, 0);
        const touchesScenes = metas.some((meta) => meta.touchesScenes);
        const current = this.historySnapshot();
        const target = isUndo ? this.history.undo(count) : this.history.redo(count);
        if (!target) return { ok: false, changed: {}, error: isUndo ? "nothing to undo" : "nothing to redo" };
        const moveMetas = (from: HistoryMeta[], to: HistoryMeta[], moved: HistoryMeta[]) => {
            from.splice(from.length - moved.length, moved.length);
            to.push(...[...moved].reverse());
        };
        moveMetas(source, isUndo ? this.redoMeta : this.undoMeta, metas);
        this.applySnapshot(target, touchesScenes);
        this.syncHistoryFlags();

        this.store.getState().beginTimelineSave();
        try {
            const data = await this.call(() => (isUndo ? this.backend.undo(this.projectId, backendSteps) : this.backend.redo(this.projectId, backendSteps)), false);
            this.store.getState().setTimelineData(data);
            if (touchesScenes) {
                this.store.getState().replaceServerScenes(await this.call(() => this.backend.loadScenes(this.projectId), true));
            }
            return { ok: true, changed: { clips: data.clips.map((clip) => clip.id), tracks: true, scenes: touchesScenes ? selectLiveScenes(this.store.getState()).map((s) => s.id) : undefined } };
        } catch (error) {
            if (isUndo) this.history.redo(count);
            else this.history.undo(count);
            const reverted = (isUndo ? this.redoMeta : this.undoMeta).splice(-count, count).reverse();
            (isUndo ? this.undoMeta : this.redoMeta).push(...reverted);
            this.applySnapshot(current, touchesScenes);
            this.syncHistoryFlags();
            this.toast({ kind: "error", message: this.errorMessage(isUndo ? "history.undo" : "history.redo") });
            this.options.logger?.error("[TimelineController] history failed", error);
            return { ok: false, changed: {}, error: errorText(error) };
        } finally {
            this.store.getState().endTimelineSave();
        }
    }

    private syncHistoryFlags(): void {
        this.store.getState().setUndoRedo(this.history.canUndo(), this.history.canRedo());
    }

    /**
     * attributes.paste: one persisted command whatever it writes — scene fields (updateScenes, or one updateScene
     * per scene), scene positions, clip fields and places, then per target its effect stack (old rows removed from
     * the end, copies added in order, disabled copies switched off). A failure takes every earlier write back.
     */
    private prepareAttributePaste(command: Extract<EditorCommand, { type: "attributes.paste" }>): Prepared {
        const pid = this.projectId;
        const timeline = this.store.getState().timelineData;
        if (!timeline) return invalid(NOT_LOADED);
        const scenes = selectLiveScenes(this.store.getState());
        let snapshot: AttributeSnapshot;
        if (isAttributeSnapshot(command.source)) snapshot = command.source;
        else {
            const ref = command.source ?? {};
            const scene = ref.sceneId ? scenes.find((sc) => sc.id === ref.sceneId) : undefined;
            const clip = !ref.sceneId && ref.clipId ? timeline.clips.find((c) => c.id === ref.clipId) : undefined;
            if (!scene && !clip) return invalid("no matching source to copy attributes from");
            snapshot = snapshotAttributes(scene ? { kind: "scene", scene } : { kind: "clip", clip: clip! });
        }
        if (!Array.isArray(command.targets) || command.targets.length === 0) return invalid("attributes.paste needs at least one target");
        const kinds = command.attributes ?? snapshot.kinds;
        const plan = planAttributePaste({ clips: timeline.clips, scenes, tracks: timeline.tracks }, snapshot, command.targets, kinds);
        const canEditEffects = Boolean(this.backend.addClipEffect && this.backend.removeClipEffect && this.backend.updateClipEffect);
        if (!canEditEffects && plan.effectStacks.length > 0) {
            for (const stack of plan.effectStacks) {
                const ref = stack.clipId ? { clipId: stack.clipId } : { sceneId: stack.sceneId };
                plan.skipped.push({ ...ref, kind: "effects", reason: "not-supported" });
                const entry = plan.applied.find((a) => (stack.clipId ? a.clipId === stack.clipId : a.sceneId === stack.sceneId));
                if (entry) entry.kinds = entry.kinds.filter((kind) => kind !== "effects");
            }
            plan.applied = plan.applied.filter((a) => a.kinds.length > 0);
            plan.effectStacks = [];
        }
        const report = { applied: plan.applied, skipped: plan.skipped };
        if (plan.applied.length === 0) {
            return { kind: "result", result: { ok: false, changed: {}, error: "nothing to paste onto these items", output: report } };
        }
        const { clipUpdates, scenePatches, sceneMoves, effectStacks } = plan;
        if (clipUpdates.length === 0 && scenePatches.length === 0 && sceneMoves.length === 0 && effectStacks.length === 0) {
            return { kind: "result", result: { ok: true, changed: {}, output: report } };
        }
        if (clipUpdates.some((update) => update.clipId.startsWith("temp-"))) return invalid("clip is still being created");

        // Optimistic state: fields, places, and effect stacks with temporary rows.
        const optimisticRows = (owner: { clipId?: string; sceneId?: string }, rows: typeof effectStacks[number]["rows"]): ClipEffect[] => rows.map((row, order) => ({
            ...buildOptimisticClipEffect(owner.clipId ?? "", row.effectId, order), clipId: owner.clipId ?? null, sceneId: owner.sceneId ?? null, paramsJson: row.paramsJson, enabled: row.enabled,
        }));
        const clipPatch = new Map(mergeClipUpdates(timeline.clips, clipUpdates).map((clip) => [clip.id, clip]));
        const scenePatchById = new Map(scenePatches.map((entry) => [entry.sceneId, { ...entry.patch }]));
        for (const stack of effectStacks) {
            if (stack.clipId) {
                const clip = clipPatch.get(stack.clipId) ?? timeline.clips.find((c) => c.id === stack.clipId)!;
                clipPatch.set(stack.clipId, { ...clip, effects: optimisticRows(stack, stack.rows) });
            } else if (stack.sceneId) {
                scenePatchById.set(stack.sceneId, { ...(scenePatchById.get(stack.sceneId) ?? {}), effects: optimisticRows(stack, stack.rows) });
            }
        }
        const sceneIds = new Set([...scenePatchById.keys(), ...sceneMoves.map((move) => move.sceneId)]);
        // What the backend holds before the paste, to take a half write back.
        const fieldOf = (value: unknown, key: string) => (value as Record<string, unknown>)[key] ?? null;
        const originalScenePatches = scenePatches.map(({ sceneId, patch }) => {
            const scene = scenes.find((sc) => sc.id === sceneId)!;
            return { sceneId, patch: Object.fromEntries(Object.keys(patch).map((key) => [key, fieldOf(scene, key)])) as Partial<SceneData> };
        });
        const originalMoves: SceneMove[] = sceneMoves.map((move) => ({ sceneId: move.sceneId, timelinePositionSeconds: Number(scenes.find((sc) => sc.id === move.sceneId)?.timelinePositionSeconds) || 0 }));
        const originalClips: TimelineClipUpdate[] = clipUpdates.map((update) => {
            const was = timeline.clips.find((c) => c.id === update.clipId)!;
            return { clipId: was.id, ...Object.fromEntries(Object.keys(update).filter((key) => key !== "clipId").map((key) => [key, fieldOf(was, key)])) } as TimelineClipUpdate;
        });
        const currentRows = (owner: { clipId?: string; sceneId?: string }): ClipEffect[] => sortedRows(owner.clipId
            ? timeline.clips.find((c) => c.id === owner.clipId)?.effects
            : scenes.find((sc) => sc.id === owner.sceneId)?.effects);

        return persisted({
            patch: { ...emptyPatch(), clipsUpsert: [...clipPatch.values()], sceneFieldPatches: [...scenePatchById].map(([sceneId, patch]) => ({ sceneId, patch })), scenePositions: sceneMoves },
            idempotent: false, touchesScenes: sceneIds.size > 0,
            changed: { clips: [...clipPatch.keys()], ...(sceneIds.size > 0 ? { scenes: [...sceneIds] } : {}) },
            tempClipIds: [], tempSceneIds: [],
            persist: async (backend) => {
                const mark = this.backendCallsStarted;
                // The inverse of each successful write, newest first.
                const undoSteps: Array<() => Promise<unknown>> = [];
                const scenesOut: SceneData[] = [];
                const stacksOut: NonNullable<PersistOutcome["effectStacks"]> = [];
                let upsertClips: TimelineClip[] | undefined;
                try {
                    if (scenePatches.length > 0) {
                        if (backend.updateScenes) {
                            scenesOut.push(...await this.call(() => backend.updateScenes!(pid, scenePatches), true));
                            undoSteps.unshift(() => backend.updateScenes!(pid, originalScenePatches));
                        } else {
                            for (const [i, { sceneId, patch }] of scenePatches.entries()) {
                                scenesOut.push(await this.call(() => backend.updateScene(pid, sceneId, patch), true));
                                undoSteps.unshift(() => backend.updateScene(pid, sceneId, originalScenePatches[i].patch));
                            }
                        }
                    }
                    if (sceneMoves.length > 0) {
                        scenesOut.push(...await this.call(() => backend.moveScenes(pid, sceneMoves), true));
                        undoSteps.unshift(() => backend.moveScenes(pid, originalMoves));
                    }
                    if (clipUpdates.length > 0) {
                        const returned = await this.call(() => backend.updateClips(pid, clipUpdates), true);
                        upsertClips = Array.isArray(returned) ? returned : undefined;
                        undoSteps.unshift(() => backend.updateClips(pid, originalClips));
                    }
                    for (const stack of effectStacks) {
                        const target = stack.clipId ? { clipId: stack.clipId } : { sceneId: stack.sceneId };
                        let rows = currentRows(stack);
                        for (const row of [...rows].reverse()) {
                            rows = await this.call(() => backend.removeClipEffect!(pid, row.id), false);
                            undoSteps.unshift(() => backend.addClipEffect!(pid, target, row.effectId, { paramsJson: row.paramsJson, index: row.order }));
                        }
                        for (const [index, copy] of stack.rows.entries()) {
                            const known = new Set(rows.map((row) => row.id));
                            rows = await this.call(() => backend.addClipEffect!(pid, target, copy.effectId, { paramsJson: copy.paramsJson, index }), false);
                            const created = rows.find((row) => !known.has(row.id));
                            if (!created) throw new Error("the backend did not return the new effect row");
                            undoSteps.unshift(() => backend.removeClipEffect!(pid, created.id));
                            if (!copy.enabled) {
                                rows = await this.call(() => backend.updateClipEffect!(pid, created.id, { enabled: false }), true);
                                undoSteps.unshift(() => backend.updateClipEffect!(pid, created.id, { enabled: true }));
                            }
                        }
                        stacksOut.push({ ...target, effects: rows });
                    }
                    return { backendCalls: undoSteps.length, scenes: scenesOut, upsertClips, effectStacks: stacksOut };
                } catch (error) {
                    await this.takeBackPartialWrites(backend, mark, undoSteps.length, undoSteps, "attributes.paste");
                    throw error;
                }
            },
            resultOutput: report,
        });
    }

    /**
     * A multi-write edit (cuts.apply, beats.autoCut) as one command: scene fields, scene copies (duplicate + patch),
     * scene positions, clip fields, new clips, then deletes. A failed write takes the earlier ones back.
     */
    private editPlanCommand(plan: {
        clipUpdates: TimelineClipUpdate[];
        clipCreates?: CreateClipInput[];
        clipDeletes?: string[];
        scenePatches?: Array<{ sceneId: string; patch: Partial<SceneData> }>;
        sceneMoves?: SceneMove[];
        sceneCopies?: Array<{ sourceSceneId: string; patch: Partial<SceneData>; timelinePositionSeconds: number; trackIndex: number }>;
    }, resultOutput: unknown): Prepared {
        const pid = this.projectId;
        const state = this.itemsState();
        if (!state) return invalid(NOT_LOADED);
        const clipUpdates = plan.clipUpdates;
        const creates = plan.clipCreates ?? [];
        const deletes = plan.clipDeletes ?? [];
        const scenePatches = plan.scenePatches ?? [];
        const sceneMoves = plan.sceneMoves ?? [];
        const sceneCopies = plan.sceneCopies ?? [];
        if ([...clipUpdates.map((u) => u.clipId), ...deletes].some((id) => id.startsWith("temp-"))) return invalid("clip is still being created");
        const fieldOf = (value: unknown, key: string) => (value as Record<string, unknown>)[key] ?? null;
        const originalClips: TimelineClipUpdate[] = clipUpdates.map((update) => {
            const was = state.clips.find((c) => c.id === update.clipId)!;
            return { clipId: was.id, ...Object.fromEntries(Object.keys(update).filter((key) => key !== "clipId").map((key) => [key, fieldOf(was, key)])) } as TimelineClipUpdate;
        });
        const originalScenes = scenePatches.map(({ sceneId, patch }) => {
            const scene = state.scenes.find((sc) => sc.id === sceneId)!;
            return { sceneId, patch: Object.fromEntries(Object.keys(patch).map((key) => [key, fieldOf(scene, key)])) as Partial<SceneData> };
        });
        const originalMoves: SceneMove[] = sceneMoves.map((move) => {
            const scene = state.scenes.find((sc) => sc.id === move.sceneId);
            return { sceneId: move.sceneId, timelinePositionSeconds: Number(scene?.timelinePositionSeconds) || 0 };
        });
        const tempIds = creates.map(() => this.tempId("temp"));
        const optimistic = creates.map((input, i) => optimisticTimelineClipFromInput(input as Record<string, any>, pid, tempIds[i]));
        const clipPatch = mergeClipUpdates(state.clips, clipUpdates);
        const sceneIds = new Set([...scenePatches.map((p) => p.sceneId), ...sceneMoves.map((m) => m.sceneId), ...sceneCopies.map((c) => c.sourceSceneId)]);
        const touchesScenes = sceneIds.size > 0;
        return persisted({
            patch: { ...emptyPatch(), clipsUpsert: [...clipPatch, ...optimistic], clipsRemove: deletes, sceneFieldPatches: scenePatches, scenePositions: sceneMoves },
            idempotent: false, touchesScenes,
            changed: { clips: [...clipPatch.map((c) => c.id), ...tempIds, ...deletes], ...(touchesScenes ? { scenes: [...sceneIds] } : {}) },
            tempClipIds: tempIds, tempSceneIds: [],
            persist: async (backend) => {
                const mark = this.backendCallsStarted;
                const undoSteps: Array<() => Promise<unknown>> = [];
                const scenesOut: SceneData[] = [];
                const createdSceneIds: string[] = [];
                let upsertClips: TimelineClip[] | undefined;
                let created: TimelineClip[] = [];
                const writeScenePatches = async (patches: Array<{ sceneId: string; patch: Partial<SceneData> }>, inverse: Array<{ sceneId: string; patch: Partial<SceneData> }> | null) => {
                    if (backend.updateScenes) {
                        scenesOut.push(...await this.call(() => backend.updateScenes!(pid, patches), true));
                        undoSteps.unshift(inverse ? () => backend.updateScenes!(pid, inverse) : () => Promise.resolve());
                        return;
                    }
                    for (const [i, { sceneId, patch }] of patches.entries()) {
                        scenesOut.push(await this.call(() => backend.updateScene(pid, sceneId, patch), true));
                        undoSteps.unshift(inverse ? () => backend.updateScene(pid, sceneId, inverse[i].patch) : () => Promise.resolve());
                    }
                };
                try {
                    if (scenePatches.length > 0) await writeScenePatches(scenePatches, originalScenes);
                    for (const copy of sceneCopies) {
                        const scene = await this.call(() => backend.duplicateScene(pid, copy.sourceSceneId), false);
                        createdSceneIds.push(scene.id);
                        undoSteps.unshift(() => backend.deleteScene(pid, scene.id));
                    }
                    if (sceneCopies.length > 0) await writeScenePatches(sceneCopies.map((copy, i) => ({ sceneId: createdSceneIds[i], patch: copy.patch })), null);
                    const moves: SceneMove[] = [
                        ...sceneMoves,
                        ...sceneCopies.map((copy, i) => ({ sceneId: createdSceneIds[i], timelinePositionSeconds: copy.timelinePositionSeconds, trackIndex: copy.trackIndex })),
                    ];
                    if (moves.length > 0) {
                        scenesOut.push(...await this.call(() => backend.moveScenes(pid, moves), true));
                        undoSteps.unshift(originalMoves.length > 0 ? () => backend.moveScenes(pid, originalMoves) : () => Promise.resolve());
                    }
                    if (clipUpdates.length > 0) {
                        const returned = await this.call(() => backend.updateClips(pid, clipUpdates), true);
                        upsertClips = Array.isArray(returned) ? returned : undefined;
                        undoSteps.unshift(() => backend.updateClips(pid, originalClips));
                    }
                    if (creates.length > 0) {
                        created = await this.call(() => backend.createClips(pid, creates), false);
                        undoSteps.unshift(() => backend.deleteClips(pid, created.map((clip) => clip.id)));
                    }
                    if (deletes.length > 0) {
                        await this.call(() => backend.deleteClips(pid, deletes), false);
                        undoSteps.unshift(() => Promise.resolve());
                    }
                } catch (error) {
                    await this.takeBackPartialWrites(backend, mark, undoSteps.length, undoSteps, "edit");
                    throw error;
                }
                // duplicateScene bumps the order of later scenes: reload the list.
                const allScenes = createdSceneIds.length > 0 ? await this.call(() => backend.loadScenes(pid), true) : undefined;
                return {
                    backendCalls: undoSteps.length, scenes: scenesOut, upsertClips,
                    ...(creates.length > 0 ? { createdClips: { tempIds, clips: created } } : {}),
                    ...(allScenes ? { allScenes, createdSceneIds } : {}),
                };
            },
            resultOutput,
        });
    }

    // ── multi-item commands (phase 10c) ───────────────────
    private itemsState(): ItemsState | null {
        const s = this.store.getState();
        if (!s.timelineData) return null;
        return { clips: s.timelineData.clips, scenes: selectLiveScenes(s), tracks: s.timelineData.tracks };
    }

    /**
     * Field patches on several clips and scenes as one command: one clip write and one scene write (per-scene writes
     * on backends without updateScenes); a failed later write takes the earlier ones back.
     */
    private itemPatchesCommand({ clipUpdates, scenePatches }: ItemPatches, idempotent: boolean): Prepared {
        const pid = this.projectId;
        const state = this.itemsState();
        if (!state) return invalid(NOT_LOADED);
        if (clipUpdates.some((update) => update.clipId.startsWith("temp-"))) return invalid("clip is still being created");
        const fieldOf = (value: unknown, key: string) => (value as Record<string, unknown>)[key] ?? null;
        const originalClips: TimelineClipUpdate[] = clipUpdates.map((update) => {
            const was = state.clips.find((c) => c.id === update.clipId)!;
            return { clipId: was.id, ...Object.fromEntries(Object.keys(update).filter((key) => key !== "clipId").map((key) => [key, fieldOf(was, key)])) } as TimelineClipUpdate;
        });
        const originalScenes = scenePatches.map(({ sceneId, patch }) => {
            const scene = state.scenes.find((sc) => sc.id === sceneId)!;
            return { sceneId, patch: Object.fromEntries(Object.keys(patch).map((key) => [key, fieldOf(scene, key)])) as Partial<SceneData> };
        });
        const clipPatch = mergeClipUpdates(state.clips, clipUpdates);
        return persisted({
            patch: { ...emptyPatch(), clipsUpsert: clipPatch, sceneFieldPatches: scenePatches },
            idempotent, touchesScenes: scenePatches.length > 0,
            changed: { clips: clipPatch.map((clip) => clip.id), ...(scenePatches.length > 0 ? { scenes: scenePatches.map((p) => p.sceneId) } : {}) },
            tempClipIds: [], tempSceneIds: [],
            persist: async (backend) => {
                const mark = this.backendCallsStarted;
                const undoSteps: Array<() => Promise<unknown>> = [];
                const scenesOut: SceneData[] = [];
                let upsertClips: TimelineClip[] | undefined;
                try {
                    if (clipUpdates.length > 0) {
                        const returned = await this.call(() => backend.updateClips(pid, clipUpdates), true);
                        upsertClips = Array.isArray(returned) ? returned : undefined;
                        undoSteps.unshift(() => backend.updateClips(pid, originalClips));
                    }
                    if (scenePatches.length > 0) {
                        if (backend.updateScenes) {
                            scenesOut.push(...await this.call(() => backend.updateScenes!(pid, scenePatches), true));
                            undoSteps.unshift(() => backend.updateScenes!(pid, originalScenes));
                        } else {
                            for (const [i, { sceneId, patch }] of scenePatches.entries()) {
                                scenesOut.push(await this.call(() => backend.updateScene(pid, sceneId, patch), true));
                                undoSteps.unshift(() => backend.updateScene(pid, sceneId, originalScenes[i].patch));
                            }
                        }
                    }
                    return { backendCalls: undoSteps.length, scenes: scenesOut, upsertClips };
                } catch (error) {
                    await this.takeBackPartialWrites(backend, mark, undoSteps.length, undoSteps, "items");
                    throw error;
                }
            },
        });
    }

    /** look.set / animation.set with `targets`: each item's own patch, written together (one undo step). */
    private prepareGroupApply(command: Extract<EditorCommand, { type: "look.set" | "animation.set" }>): Prepared {
        const state = this.itemsState();
        if (!state) return invalid(NOT_LOADED);
        const resolved = resolveTargets(state, command.targets ?? []);
        if (!resolved.ok) return invalid(`${command.type} ${resolved.error}`);
        const patches: ItemPatches = { clipUpdates: [], scenePatches: [] };
        for (const { clip, scene } of resolved.value) {
            let patch: Record<string, unknown>;
            if (command.type === "look.set") {
                const plan = planLookPatch((scene ?? clip)!, scene ? "scene" : "clip", command);
                if (!plan.ok) return invalid(plan.error);
                patch = plan.value;
            } else {
                if (clip && (clip.trackType === "audio" || clip.trackType === "effect")) return invalid("this item cannot be animated");
                const target = scene ? "clip" as const : motionTarget({ kind: "clip", clip: clip! });
                const plan = planAnimation(target, (scene ?? clip)!.animationJson, command);
                if (!plan.ok) return invalid(plan.error);
                patch = { animationJson: plan.value };
            }
            if (scene) patches.scenePatches.push({ sceneId: scene.id, patch: patch as Partial<SceneData> });
            else patches.clipUpdates.push({ clipId: clip!.id, ...(patch as Partial<TimelineClip>) });
        }
        return this.itemPatchesCommand(patches, true);
    }

    /**
     * mask.set with `targets` (phase 10d group mode): the patch on every maskable item (others skipped), each keyed at its
     * own playhead time, written together (one undo step).
     */
    private prepareGroupMask(command: Extract<EditorCommand, { type: "mask.set" }>): Prepared {
        const state = this.itemsState();
        if (!state) return invalid(NOT_LOADED);
        const resolved = resolveTargets(state, command.targets ?? []);
        if (!resolved.ok) return invalid(`mask.set ${resolved.error}`);
        const items = resolved.value.filter(({ clip }) => !clip || clipTakesMask(clip));
        if (items.length === 0) return invalid("none of the targets takes a mask");
        if (items.some(({ clip }) => clip?.id.startsWith("temp-"))) return invalid("clip is still being created");
        const now = this.store.getState().currentTime;
        const patches: ItemPatches = { clipUpdates: [], scenePatches: [] };
        for (const { clip, scene } of items) {
            const start = scene ? getSceneStart(scene, state.scenes, state.scenes.indexOf(scene)) : clip!.startTime;
            const duration = scene ? getSceneDuration(scene) : Math.max(0, clip!.endTime - clip!.startTime);
            const time = Math.min(duration, Math.max(0, now - start));
            const plan = planMask((scene ?? clip)!, duration, { mask: command.mask, time, replace: command.replace });
            if (!plan.ok) return invalid(plan.error);
            const patch: Record<string, unknown> = { maskJson: plan.value.maskJson };
            if (plan.value.keyframesJson !== undefined) patch.keyframesJson = plan.value.keyframesJson;
            if (scene) patches.scenePatches.push({ sceneId: scene.id, patch: patch as Partial<SceneData> });
            else patches.clipUpdates.push({ clipId: clip!.id, ...(patch as Partial<TimelineClip>) });
        }
        return this.itemPatchesCommand(patches, true);
    }

    /** clip.effect.add with `targets`: one new row per item (one write each), one undo step. */
    private prepareGroupEffectAdd(command: Extract<EditorCommand, { type: "clip.effect.add" }>): Prepared {
        const pid = this.projectId;
        const state = this.itemsState();
        if (!state) return invalid(NOT_LOADED);
        const resolved = resolveTargets(state, command.targets ?? []);
        if (!resolved.ok) return invalid(`clip.effect.add ${resolved.error}`);
        if (resolved.value.some(({ clip }) => clip?.id.startsWith("temp-"))) return invalid("clip is still being created");
        const paramsJson = command.params ? JSON.stringify(command.params) : null;
        const owners = resolved.value.map(({ clip, scene }) => {
            const rows = sortedRows((clip ?? scene)!.effects);
            const index = Math.max(0, Math.min(rows.length, Math.trunc(command.index ?? rows.length)));
            const optimistic = buildOptimisticClipEffect(clip?.id ?? "", command.effectId, index);
            rows.splice(index, 0, { ...optimistic, clipId: clip?.id ?? null, sceneId: scene?.id ?? null, paramsJson });
            return { clip, scene, index, rows: reorderRows(rows) };
        });
        const clipPatch = owners.filter((o) => o.clip).map((o) => ({ ...o.clip!, effects: o.rows }));
        const scenePatches = owners.filter((o) => o.scene).map((o) => ({ sceneId: o.scene!.id, patch: { effects: o.rows } as Partial<SceneData> }));
        return persisted({
            patch: { ...emptyPatch(), clipsUpsert: clipPatch, sceneFieldPatches: scenePatches },
            idempotent: false, touchesScenes: scenePatches.length > 0,
            changed: { clips: clipPatch.map((c) => c.id), ...(scenePatches.length > 0 ? { scenes: scenePatches.map((p) => p.sceneId) } : {}) },
            tempClipIds: [], tempSceneIds: [],
            persist: async (backend) => {
                const mark = this.backendCallsStarted;
                const undoSteps: Array<() => Promise<unknown>> = [];
                const stacksOut: NonNullable<PersistOutcome["effectStacks"]> = [];
                try {
                    for (const owner of owners) {
                        const target = owner.clip ? { clipId: owner.clip.id } : { sceneId: owner.scene!.id };
                        const known = new Set(((owner.clip ?? owner.scene)!.effects ?? []).map((row) => row.id));
                        const rows = await this.call(() => backend.addClipEffect!(pid, target, command.effectId, { paramsJson, index: owner.index }), false);
                        const created = rows.find((row) => !known.has(row.id));
                        if (created) undoSteps.unshift(() => backend.removeClipEffect?.(pid, created.id) ?? Promise.resolve());
                        else undoSteps.unshift(() => Promise.resolve());
                        stacksOut.push({ ...target, effects: rows });
                    }
                    return { backendCalls: undoSteps.length, effectStacks: stacksOut };
                } catch (error) {
                    await this.takeBackPartialWrites(backend, mark, undoSteps.length, undoSteps, "clip.effect.add");
                    throw error;
                }
            },
        });
    }

    /** items.delete: one clip delete, then each scene (deleteScene has no batch form); later scenes do not ripple. */
    private prepareItemsDelete(command: Extract<EditorCommand, { type: "items.delete" }>): Prepared {
        const pid = this.projectId;
        const state = this.itemsState();
        if (!state) return invalid(NOT_LOADED);
        const { clips, scenes } = editableItems(state, command.clipIds, command.sceneIds);
        if (clips.length === 0 && scenes.length === 0) return invalid("no editable items to delete");
        const clipIds = clips.map((clip) => clip.id);
        const sceneIds = scenes.map((scene) => scene.id);
        if (clipIds.some((id) => id.startsWith("temp-")) || sceneIds.some((id) => id.startsWith("temp-"))) return invalid("item is still being created");
        return persisted({
            patch: { ...emptyPatch(), clipsRemove: clipIds, scenesRemove: sceneIds },
            idempotent: false, touchesScenes: sceneIds.length > 0,
            changed: { clips: clipIds, ...(sceneIds.length > 0 ? { scenes: sceneIds } : {}) },
            tempClipIds: [], tempSceneIds: [],
            persist: async (backend) => {
                const mark = this.backendCallsStarted;
                let written = 0;
                try {
                    if (clipIds.length > 0) {
                        await this.call(() => backend.deleteClips(pid, clipIds), false);
                        written += 1;
                    }
                    for (const sceneId of sceneIds) {
                        await this.call(() => backend.deleteScene(pid, sceneId), false);
                        written += 1;
                    }
                } catch (error) {
                    // Deleted items cannot be recreated by hand: a backend undo takes them back when nothing else wrote since.
                    await this.takeBackPartialWrites(backend, mark, written, [], "items.delete");
                    throw error;
                }
                // deleteScene lowers the order of later scenes: reload the list.
                const allScenes = sceneIds.length > 0 ? await this.call(() => backend.loadScenes(pid), true) : undefined;
                return { backendCalls: written, ...(sceneIds.length > 0 ? { removedSceneIds: sceneIds, allScenes } : {}) };
            },
            afterOptimistic: () => {
                const s = this.store.getState();
                const clipsLeft = [...s.selectedClipIds].filter((id) => !clipIds.includes(id));
                const scenesLeft = [...s.selectedSceneIds].filter((id) => !sceneIds.includes(id));
                if (clipsLeft.length !== s.selectedClipIds.size || scenesLeft.length !== s.selectedSceneIds.size) s.setSelection({ clipIds: clipsLeft, sceneIds: scenesLeft });
            },
        });
    }

    /** items.duplicate / items.paste: the clip copies in one create, each scene copied then all moved into place in one write. */
    private prepareItemsCreate({ clipInputs, sceneCopies }: DuplicatePlan): Prepared {
        const pid = this.projectId;
        const tempIds = clipInputs.map(() => this.tempId("temp"));
        const optimistic = clipInputs.map((input, i) => optimisticTimelineClipFromInput(input as Record<string, any>, pid, tempIds[i]));
        return persisted({
            patch: { ...emptyPatch(), clipsUpsert: optimistic },
            idempotent: false, touchesScenes: sceneCopies.length > 0,
            changed: { clips: tempIds, ...(sceneCopies.length > 0 ? { scenes: sceneCopies.map((c) => c.sceneId) } : {}) },
            tempClipIds: tempIds, tempSceneIds: [],
            persist: async (backend) => {
                const mark = this.backendCallsStarted;
                const undoSteps: Array<() => Promise<unknown>> = [];
                const createdSceneIds: string[] = [];
                let createdClips: TimelineClip[] = [];
                try {
                    if (clipInputs.length > 0) {
                        createdClips = await this.call(() => backend.createClips(pid, clipInputs), false);
                        undoSteps.unshift(() => backend.deleteClips(pid, createdClips.map((clip) => clip.id)));
                    }
                    for (const copy of sceneCopies) {
                        const scene = await this.call(() => backend.duplicateScene(pid, copy.sceneId), false);
                        createdSceneIds.push(scene.id);
                        undoSteps.unshift(() => backend.deleteScene(pid, scene.id));
                    }
                    if (createdSceneIds.length > 0) {
                        const moves: SceneMove[] = sceneCopies.map((copy, i) => ({ sceneId: createdSceneIds[i], timelinePositionSeconds: copy.startTime, trackIndex: copy.trackIndex }));
                        await this.call(() => backend.moveScenes(pid, moves), true);
                        undoSteps.unshift(() => Promise.resolve());
                    }
                } catch (error) {
                    await this.takeBackPartialWrites(backend, mark, undoSteps.length, undoSteps, "items.duplicate");
                    throw error;
                }
                const allScenes = createdSceneIds.length > 0 ? await this.call(() => backend.loadScenes(pid), true) : undefined;
                return {
                    backendCalls: undoSteps.length,
                    ...(clipInputs.length > 0 ? { createdClips: { tempIds, clips: createdClips } } : {}),
                    ...(createdSceneIds.length > 0 ? { allScenes, createdSceneIds } : {}),
                };
            },
            afterCommit: (outcome) => {
                const clipIds = outcome.createdClips?.clips.map((clip) => clip.id) ?? [];
                const sceneIds = outcome.createdSceneIds ?? [];
                if (clipIds.length + sceneIds.length > 0) this.store.getState().setSelection({ clipIds, sceneIds });
            },
        });
    }

    // ── helpers ───────────────────────────────────────────
    /** A clip's or scene's stack, from the store (scenes with their optimistic overrides). */
    private effectOwner(clipId: string | undefined, sceneId: string | undefined): EffectOwner | null {
        if (clipId) {
            const clip = this.store.getState().timelineData?.clips.find((c) => c.id === clipId);
            return clip ? { clipId: clip.id, sceneId: null, effects: clip.effects ?? [] } : null;
        }
        if (sceneId) {
            const scene = this.liveScene(sceneId);
            return scene ? { clipId: null, sceneId: scene.id, effects: scene.effects ?? [] } : null;
        }
        return null;
    }

    private effectRowOwner(effectRowId: string): EffectOwner | null {
        const clip = this.store.getState().timelineData?.clips.find((c) => c.effects?.some((e) => e.id === effectRowId));
        if (clip) return { clipId: clip.id, sceneId: null, effects: clip.effects ?? [] };
        const scene = selectLiveScenes(this.store.getState()).find((sc) => sc.effects?.some((e) => e.id === effectRowId));
        return scene ? { clipId: null, sceneId: scene.id, effects: scene.effects ?? [] } : null;
    }

    /** One backend call that rewrites one stack: optimistic rows now, the backend's rows after. */
    private effectStackCommand(owner: EffectOwner, rows: ClipEffect[], idempotent: boolean, write: (backend: TimelineBackend) => Promise<ClipEffect[]>): Prepared {
        if (owner.clipId) {
            const clip = this.store.getState().timelineData!.clips.find((c) => c.id === owner.clipId)!;
            const clipId = owner.clipId;
            return persisted({
                patch: { ...emptyPatch(), clipsUpsert: [{ ...clip, effects: rows }] },
                idempotent, touchesScenes: false, changed: { clips: [clipId] }, tempClipIds: [], tempSceneIds: [],
                persist: async (backend) => ({ backendCalls: 1, clipEffects: { clipId, effects: await this.call(() => write(backend), idempotent) } }),
            });
        }
        const sceneId = owner.sceneId!;
        return persisted({
            patch: { ...emptyPatch(), sceneFieldPatches: [{ sceneId, patch: { effects: rows } }] },
            idempotent, touchesScenes: true, changed: { scenes: [sceneId] }, tempClipIds: [], tempSceneIds: [],
            persist: async (backend) => ({ backendCalls: 1, sceneEffects: { sceneId, effects: await this.call(() => write(backend), idempotent) } }),
        });
    }

    private liveScene(sceneId: string): SceneData | undefined {
        return selectLiveScenes(this.store.getState()).find((scene) => scene.id === sceneId);
    }

    private tempId(prefix: "temp"): string {
        this.tempCounter += 1;
        return `${prefix}-${Date.now()}-${this.tempCounter}`;
    }

    private errorMessage(type: EditorCommandType): string {
        return this.options.errorMessages?.[type] ?? DEFAULT_COMMAND_ERROR_MESSAGES[type] ?? DEFAULT_FALLBACK_ERROR_MESSAGE;
    }

    private toast(toast: TimelineToast): void {
        this.options.onToast?.(toast);
    }
}
