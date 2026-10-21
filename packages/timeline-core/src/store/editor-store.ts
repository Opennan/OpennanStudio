// Vanilla editor store (spec §5.1). Slices, field names, and action semantics are
// copied from opennan frontend stores/editor-store.ts:48-521 so moved components
// keep their selectors. Removed: panel tabs and their writes inside selection
// actions (editor-store.ts:242-243,260,293,301,325,354), recent generated audio,
// scroll-to-shot (host-only). Added: document slices and the optimistic scene
// overrides moved out of editor-layout.tsx:595-1033.
import { createStore, type StoreApi } from "zustand/vanilla";
import { subscribeWithSelector } from "zustand/middleware";
import type { AudioTarget } from "../model/editor";
import type { TimelineData } from "../model/timeline";
import type { SceneData, TimelineMarker } from "../timeline/canvas/types";
import type { ProjectMeta } from "../backend/types";
import { DEFAULT_TIMELINE_ZOOM, getNearestTimelineMarkerId, type TimelineClipboard } from "../lib/timeline-editing";
import type { AttributeSnapshot, AttributeTarget } from "../attributes/attributes";
import type { SourceSize } from "../tracking/plan";
import type { TrackRegion, TrackSample } from "../tracking/tracker";

/** The item a motion track belongs to (phase 10d). */
export type TrackingOwner = { clipId: string } | { sceneId: string };

/** The Track tab's region box: source fractions of the item's picture, top-left + size. */
export interface TrackingRegionState {
    owner: TrackingOwner;
    region: TrackRegion;
}

/** The last tracking.run result of an item (view state, not persisted). */
export interface TrackingResultState {
    owner: TrackingOwner;
    samples: TrackSample[];
    source: SourceSize | null;
    fps: number;
}

/** The ranges a silences / fillers preview would cut (timeline seconds), drawn as ghosts over the timeline (phase 11). */
export interface AiCutPreview {
    ranges: Array<{ start: number; end: number }>;
    kind: "silences" | "fillers";
}

/** An AI job running on a clip or scene (phase 11): the timeline draws its progress along the item. */
export interface AiActivity {
    /** 0..1; absent while the job has no measurable progress. */
    progress?: number;
    /** The AI director just changed this item (phase 9b): drawn as an outline with an "AI" tag instead of a progress line. */
    changed?: boolean;
}

export type SelectedTransition = { kind: "clip" | "scene"; id: string };
export type AddTextClipPreset = "text" | "caption" | "subtitle";
export type AddTextClipRequest = { id: number; preset: AddTextClipPreset };
export type TimelineToolMode = "select" | "hand" | "blade";
export type FrameStepDirection = -1 | 1;
export type FrameStepRequest = { id: number; direction: FrameStepDirection; targetTime: number | null };

export type SelectedKeyframe = { clipId: string; sceneId?: undefined; time: number } | { sceneId: string; clipId?: undefined; time: number };
export interface KeyframeGraphState {
    open: boolean;
    channel: string | null;
}

/** A selected keyframe belongs to the single selected clip or the selected scene. */
export function keyframeSelectionValid(state: Pick<EditorState, "selectedClipId" | "selectedClipIds" | "selectedSceneId" | "selectedSceneIds">, keyframe: SelectedKeyframe): boolean {
    if (keyframe.clipId) {
        return state.selectedClipId === keyframe.clipId && state.selectedClipIds.size === 1 && state.selectedClipIds.has(keyframe.clipId)
            && state.selectedSceneIds.size === 0;
    }
    return Boolean(keyframe.sceneId) && state.selectedSceneId === keyframe.sceneId && state.selectedClipId === null && state.selectedClipIds.size === 0
        && state.selectedSceneIds.size <= 1;
}

/** A clip or a scene, as multi-selection actions name items. */
export type SelectionItem = { clipId: string; sceneId?: undefined } | { sceneId: string; clipId?: undefined };

export interface OptimisticSceneSplit {
    sourceSceneId: string;
    tempSceneId: string;
    firstScene: Partial<SceneData>;
    secondScene: SceneData;
    splitTime: number;
}

export interface SceneOverridesCapture {
    positions: Map<string, number | undefined>;
    tracks: Map<string, number | undefined>;
    optimistic: Map<string, SceneData | undefined>;
    fields: Map<string, Partial<SceneData> | undefined>;
    deleted: Map<string, boolean>;
}

export interface EditorState {
    // selection (editor-store.ts:49-81)
    selectedSceneId: string | null;
    /** False when the scene was only synced to the playhead (syncActiveScene), not picked by the user (phase 10b: no preview handles then). */
    sceneSelectedByUser: boolean;
    setSelectedSceneId(id: string | null): void;
    selectScene(id: string): void;
    syncActiveScene(id: string | null): void;
    selectedTransition: SelectedTransition | null;
    selectTransition(transition: SelectedTransition): void;
    clearTransitionSelection(): void;
    selectedClipIds: Set<string>;
    setSelectedClipIds(ids: Set<string>): void;
    toggleClipInSelection(id: string): void;
    selectedClipId: string | null;
    setSelectedClipId(id: string | null): void;
    selectClip(id: string): void;
    clearSelection(): void;
    selectedAudioTarget: AudioTarget | null;
    selectAudioTarget(target: AudioTarget): void;
    // multi-item selection (phase 10c)
    /**
     * Every scene the user selected (main and upper tracks), in selection order; empty for a scene only synced to
     * the playhead. With clips selected too, `selectedSceneId` stays null and `selectedClipId` is the primary item.
     */
    selectedSceneIds: Set<string>;
    /** Replaces the selected scenes and keeps the selected clips (the same set changes nothing). */
    setSelectedSceneIds(ids: Set<string>): void;
    /** Replaces the whole selection with these clips and scenes (omitted: none); clears transition and audio picks. */
    setSelection(selection: { clipIds?: Iterable<string>; sceneIds?: Iterable<string> }): void;
    /** Adds the item to the selection or removes it (Shift/Cmd/Ctrl+click). */
    toggleItemInSelection(item: SelectionItem): void;

    // view (editor-store.ts:71-77,108-109)
    toolMode: TimelineToolMode;
    setToolMode(mode: TimelineToolMode): void;
    snapEnabled: boolean;
    setSnapEnabled(value: boolean): void;
    /** Beat times of audio clips join the snap points (phase 11, view.update { snapToBeats }). */
    snapToBeats: boolean;
    setSnapToBeats(value: boolean): void;
    /** Ranges a silences / fillers panel would cut, drawn as ghosts (phase 11); null when no preview is shown. */
    aiCutPreview: AiCutPreview | null;
    setAiCutPreview(value: AiCutPreview | null): void;
    /** AI jobs by clip or scene id (phase 11): progress lines on the timeline. */
    aiActivity: Record<string, AiActivity>;
    /** Sets (null removes) the activity of a clip or scene. */
    setAiActivity(id: string, value: AiActivity | null): void;
    /** The inspector's Mask tab is open: the preview shows the selected item's mask handles (phase 10c). */
    maskEditing: boolean;
    setMaskEditing(value: boolean): void;
    /** The inspector's Track tab is open (phase 10d): the preview draws and edits this region box; null otherwise. */
    trackingRegion: TrackingRegionState | null;
    setTrackingRegion(value: TrackingRegionState | null): void;
    /** The last motion track of an item, for the preview's path and the Track tab's Apply (not persisted). */
    trackingResult: TrackingResultState | null;
    setTrackingResult(value: TrackingResultState | null): void;
    timelineZoom: number;
    setTimelineZoom(zoom: number): void;

    // playback (editor-store.ts:83-89,102-106,127-128,141-145)
    isPlaying: boolean;
    setIsPlaying(value: boolean): void;
    currentTime: number;
    setCurrentTime(time: number): void;
    shuttleSpeed: number;
    setShuttleSpeed(speed: number): void;
    frameStepRequest: FrameStepRequest | null;
    setFrameStepRequest(direction: FrameStepDirection | null, targetTime?: number | null): void;
    seekRequest: number | null;
    setSeekRequest(time: number | null): void;
    playRequest: "play" | "pause" | null;
    setPlayRequest(request: "play" | "pause" | null): void;
    musicVolume: number;
    setMusicVolume(volume: number): void;

    // markers (editor-store.ts:111-123)
    timelineMarkers: TimelineMarker[];
    addTimelineMarker(time: number, label?: string): void;
    removeTimelineMarker(id: string): void;
    moveTimelineMarker(id: string, time: number): void;
    removeTimelineMarkerNear(time: number, thresholdSeconds?: number): void;
    clearTimelineMarkers(): void;
    setTimelineMarkers(markers: TimelineMarker[]): void;
    selectedMarkerId: string | null;
    setSelectedMarkerId(id: string | null): void;

    // clipboard (editor-store.ts:124-125)
    timelineClipboard: TimelineClipboard | null;
    setTimelineClipboard(clipboard: TimelineClipboard | null): void;
    /** Copy attributes (phase 10c): the copied item's attribute values (attributes/attributes.ts snapshotAttributes). */
    attributeClipboard: AttributeSnapshot | null;
    setAttributeClipboard(snapshot: AttributeSnapshot | null): void;
    /** The open "Paste attributes" picker and the items it pastes onto; null when closed. */
    attributePastePicker: { targets: AttributeTarget[] } | null;
    setAttributePastePicker(picker: { targets: AttributeTarget[] } | null): void;

    // source durations (editor-store.ts:135-139)
    sourceDurations: Map<string, number>;
    setSourceDuration(id: string, seconds: number): void;

    // active saves (editor-store.ts:117-121)
    activeTimelineSaves: number;
    beginTimelineSave(): void;
    endTimelineSave(): void;

    // history flags (editor-store.ts:165-168); written only by TimelineController
    canUndo: boolean;
    canRedo: boolean;
    setUndoRedo(canUndo: boolean, canRedo: boolean): void;

    // request slices kept for the port (editor-store.ts:147-159)
    addTextRequest: AddTextClipRequest | null;
    setAddTextRequest(request: AddTextClipRequest | number | null): void;
    addImageRequest: string | null;
    setAddImageRequest(url: string | null): void;
    deleteSelectionRequest: number | null;
    setDeleteSelectionRequest(id: number | null): void;

    // keyframe UX (phase 10c)
    /** The keyframe picked on the timeline or the graph editor (item-local seconds); only for the single selected item. */
    selectedKeyframe: SelectedKeyframe | null;
    /** Ignored unless the clip (alone) or the scene is the current selection; cleared when the selection changes. */
    selectKeyframe(keyframe: SelectedKeyframe | null): void;
    /** The keyframe graph editor drawer in the inspector and the channel it plots. */
    keyframeGraph: KeyframeGraphState;
    setKeyframeGraph(patch: Partial<KeyframeGraphState>): void;

    // document (new)
    projectMeta: ProjectMeta | null;
    setProjectMeta(meta: ProjectMeta | null): void;
    timelineData: TimelineData | null;
    timelineLoading: boolean;
    setTimelineData(data: TimelineData | null): void;
    setTimelineLoading(loading: boolean): void;
    serverScenes: SceneData[];
    replaceServerScenes(scenes: SceneData[]): void;
    /** Replace server scenes but keep optimistic overrides that have not converged (refetch path). */
    syncServerScenes(scenes: SceneData[]): void;
    mergeServerScenes(scenes: SceneData[]): void;
    removeServerScenes(sceneIds: string[]): void;

    // optimistic scene overrides (editor-layout.tsx:595-602)
    scenePositionOverrides: Map<string, number>;
    sceneTrackOverrides: Map<string, number>;
    optimisticScenes: Map<string, SceneData>;
    sceneFieldOverrides: Map<string, Partial<SceneData>>;
    deletedSceneIds: Set<string>;
    applySceneOverrides(updates: Map<string, number>, trackChangeSceneId?: string, trackChangeIndex?: number): void;
    applyOptimisticSceneDelete(sceneId: string, restore?: boolean): void;
    applyLocalScenePatch(sceneId: string, patch: Partial<SceneData>): void;
    applyOptimisticSceneSplit(split: OptimisticSceneSplit): void;
    applyOptimisticSceneAdd(tempScene: SceneData): void;
    commitOptimisticSceneSplit(tempSceneId: string, createdSceneId: string): void;
    rollbackOptimisticSceneSplit(sourceSceneId: string, sceneId: string): void;
    captureSceneOverrides(sceneIds: Iterable<string>): SceneOverridesCapture;
    restoreSceneOverrides(capture: SceneOverridesCapture): void;

    resetForProject(): void;
}

// Spelled out instead of Mutate<StoreApi<EditorState>, [["zustand/subscribeWithSelector", never]]>:
// that form needs zustand/middleware's StoreMutators augmentation, which the bundled .d.ts
// drops, so dist consumers saw EditorStore as never. Same shape as WithSelectorSubscribe.
export type EditorStore = Omit<StoreApi<EditorState>, "subscribe"> & {
    subscribe: {
        (listener: (state: EditorState, previousState: EditorState) => void): () => void;
        <U>(
            selector: (state: EditorState) => U,
            listener: (selectedState: U, previousSelectedState: U) => void,
            options?: { equalityFn?: (a: U, b: U) => boolean; fireImmediately?: boolean },
        ): () => void;
    };
};

function sameSet(a: Set<string>, b: Set<string>): boolean {
    if (a === b) return true;
    if (a.size !== b.size) return false;
    for (const value of a) if (!b.has(value)) return false;
    return true;
}

const firstOf = (ids: Set<string>): string | null => (ids.size > 0 ? ids.values().next().value ?? null : null);

/**
 * The state for a selection of clips and scenes: the first clip is the primary item; with no clip the first scene is
 * the primary scene. Transition and audio picks are dropped. Returns `s` when nothing changes.
 */
function multiSelection(s: EditorState, clipIds: Set<string>, sceneIds: Set<string>): EditorState | Partial<EditorState> {
    const clipId = firstOf(clipIds);
    const sceneId = clipId === null ? firstOf(sceneIds) : null;
    // An emptied scene set keeps a scene that was only synced to the playhead.
    const keepSynced = clipId === null && sceneIds.size === 0 && s.selectedSceneIds.size === 0 && !s.sceneSelectedByUser;
    const nextSceneId = keepSynced ? s.selectedSceneId : sceneId;
    const byUser = keepSynced ? s.sceneSelectedByUser : sceneIds.size > 0;
    if (
        sameSet(s.selectedClipIds, clipIds) && sameSet(s.selectedSceneIds, sceneIds) && s.selectedClipId === clipId
        && s.selectedSceneId === nextSceneId && s.sceneSelectedByUser === byUser && s.selectedTransition === null && s.selectedAudioTarget === null
    ) return s;
    return {
        selectedClipIds: clipIds, selectedSceneIds: sceneIds, selectedClipId: clipId, selectedSceneId: nextSceneId,
        sceneSelectedByUser: byUser, selectedTransition: null, selectedAudioTarget: null,
    };
}

function sameAudioTarget(a: AudioTarget | null, b: AudioTarget | null): boolean {
    if (a === b) return true;
    if (!a || !b || typeof a !== typeof b) return false;
    if (typeof a === "string" || typeof b === "string") return a === b;
    return a.sceneId === b.sceneId && a.type === b.type;
}

// editor-layout.tsx:837-858
/** Effect stacks match by content: optimistic rows carry temp ids the backend replaces. */
function effectStackKey(rows: unknown): string {
    if (!Array.isArray(rows)) return "[]";
    return JSON.stringify(rows.map((row: { effectId?: unknown; order?: unknown; enabled?: unknown; paramsJson?: unknown }) => [row.effectId, row.order, row.enabled, row.paramsJson ?? null]));
}

function localFieldMatchesServer(key: string, localVal: unknown, serverVal: unknown): boolean {
    if (key === "effects") return effectStackKey(localVal) === effectStackKey(serverVal);
    if (typeof localVal === "number") return Math.abs(Number(serverVal || 0) - localVal) < 0.05;
    if (key === "shotBreakdown" && typeof localVal === "string" && typeof serverVal === "string") {
        const total = (raw: string) => {
            try {
                const shots = JSON.parse(raw);
                return Array.isArray(shots)
                    ? shots.reduce((sum: number, shot: { duration?: unknown }) => sum + (Number(shot?.duration) || 0), 0)
                    : Number.NaN;
            } catch {
                return Number.NaN;
            }
        };
        const a = total(localVal);
        const b = total(serverVal);
        return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < 0.05;
    }
    return serverVal === localVal;
}

type OverrideSlices = Pick<EditorState,
    "scenePositionOverrides" | "sceneTrackOverrides" | "optimisticScenes" | "sceneFieldOverrides" | "deletedSceneIds">;

// Convergence rules from editor-layout.tsx:722-803.
function convergeOverrides(state: OverrideSlices, serverScenes: SceneData[]): Partial<OverrideSlices> {
    const byId = new Map(serverScenes.map((scene) => [scene.id, scene]));
    const out: Partial<OverrideSlices> = {};

    let positions: Map<string, number> | null = null;
    for (const [id, local] of state.scenePositionOverrides) {
        const server = byId.get(id);
        if (server && Math.abs(Number(server.timelinePositionSeconds || 0) - local) < 0.05) {
            positions ??= new Map(state.scenePositionOverrides);
            positions.delete(id);
        }
    }
    if (positions) out.scenePositionOverrides = positions;

    let tracks: Map<string, number> | null = null;
    for (const [id, local] of state.sceneTrackOverrides) {
        const server = byId.get(id);
        if (server && Number(server.trackIndex || 1) === local) {
            tracks ??= new Map(state.sceneTrackOverrides);
            tracks.delete(id);
        }
    }
    if (tracks) out.sceneTrackOverrides = tracks;

    let fields: Map<string, Partial<SceneData>> | null = null;
    for (const [id, local] of state.sceneFieldOverrides) {
        const server = byId.get(id) as Record<string, unknown> | undefined;
        if (!server) continue;
        const caughtUp = Object.entries(local).every(([key, value]) => localFieldMatchesServer(key, value, server[key]));
        if (caughtUp) {
            fields ??= new Map(state.sceneFieldOverrides);
            fields.delete(id);
        }
    }
    if (fields) out.sceneFieldOverrides = fields;

    let optimistic: Map<string, SceneData> | null = null;
    for (const id of state.optimisticScenes.keys()) {
        if (byId.has(id)) {
            optimistic ??= new Map(state.optimisticScenes);
            optimistic.delete(id);
        }
    }
    if (optimistic) out.optimisticScenes = optimistic;

    let deleted: Set<string> | null = null;
    for (const id of state.deletedSceneIds) {
        if (!byId.has(id)) {
            deleted ??= new Set(state.deletedSceneIds);
            deleted.delete(id);
        }
    }
    if (deleted) out.deletedSceneIds = deleted;

    return out;
}

function patchWithoutServerMatches(
    current: Partial<SceneData> | undefined,
    patch: Partial<SceneData>,
    serverScene: SceneData | undefined,
): Partial<SceneData> {
    const merged: Record<string, unknown> = { ...(current || {}) };
    for (const [key, value] of Object.entries(patch)) {
        const serverValue = serverScene ? (serverScene as unknown as Record<string, unknown>)[key] : undefined;
        if (value === undefined || localFieldMatchesServer(key, value, serverValue)) delete merged[key];
        else merged[key] = value;
    }
    return merged as Partial<SceneData>;
}

const EMPTY_OVERRIDES = (): OverrideSlices => ({
    scenePositionOverrides: new Map(),
    sceneTrackOverrides: new Map(),
    optimisticScenes: new Map(),
    sceneFieldOverrides: new Map(),
    deletedSceneIds: new Set(),
});

export function createEditorStore(): EditorStore {
    let frameStepRequestId = 0;

    const store = createStore<EditorState>()(subscribeWithSelector((set, get) => ({
        // ── selection ──────────────────────────────────────────
        selectedSceneId: null,
        sceneSelectedByUser: false,
        setSelectedSceneId: (id) => set((s) => {
            if (id === null) {
                return s.selectedSceneId === null && s.selectedTransition === null && s.selectedSceneIds.size === 0
                    ? s
                    : { selectedSceneId: null, selectedTransition: null, sceneSelectedByUser: false, selectedSceneIds: new Set() };
            }
            if (
                s.selectedSceneId === id && s.sceneSelectedByUser && s.selectedTransition === null && s.selectedClipId === null
                && s.selectedClipIds.size === 0 && s.selectedAudioTarget === null && sameSet(s.selectedSceneIds, new Set([id]))
            ) return s;
            return {
                selectedSceneId: id, sceneSelectedByUser: true, selectedTransition: null, selectedClipId: null, selectedClipIds: new Set(),
                selectedAudioTarget: null, selectedSceneIds: new Set([id]),
            };
        }),
        selectScene: (id) => set((s) => {
            if (
                s.selectedSceneId === id && s.sceneSelectedByUser && s.selectedTransition === null && s.selectedClipId === null
                && s.selectedClipIds.size === 0 && s.selectedAudioTarget === null && sameSet(s.selectedSceneIds, new Set([id]))
            ) return s;
            return {
                selectedSceneId: id, sceneSelectedByUser: true, selectedTransition: null, selectedClipId: null, selectedClipIds: new Set(),
                selectedAudioTarget: null, selectedSceneIds: new Set([id]),
            };
        }),
        syncActiveScene: (id) => set((s) => {
            if (
                s.selectedSceneId !== null || s.selectedClipIds.size > 0 || s.selectedClipId !== null
                || s.selectedTransition !== null || s.selectedAudioTarget !== null
            ) return s;
            if (s.selectedSceneId === id) return s;
            return { selectedSceneId: id, sceneSelectedByUser: false };
        }),
        selectedTransition: null,
        selectTransition: (transition) => set((s) => {
            if (
                s.selectedTransition?.kind === transition.kind && s.selectedTransition.id === transition.id
                && s.selectedSceneId === null && s.selectedClipId === null && s.selectedClipIds.size === 0
                && s.selectedAudioTarget === null && s.selectedSceneIds.size === 0
            ) return s;
            return { selectedTransition: transition, selectedSceneId: null, selectedClipId: null, selectedClipIds: new Set(), selectedAudioTarget: null, selectedSceneIds: new Set() };
        }),
        clearTransitionSelection: () => set((s) => (s.selectedTransition === null ? s : { selectedTransition: null })),
        selectedClipIds: new Set(),
        setSelectedClipIds: (ids) => {
            const first = ids.size > 0 ? ids.values().next().value ?? null : null;
            set((s) => {
                if (
                    sameSet(s.selectedClipIds, ids) && s.selectedClipId === first && s.selectedSceneId === null
                    && s.selectedTransition === null && s.selectedAudioTarget === null && s.selectedSceneIds.size === 0
                ) return s;
                return { selectedClipIds: ids, selectedClipId: first, selectedSceneId: null, selectedTransition: null, selectedAudioTarget: null, selectedSceneIds: new Set() };
            });
        },
        toggleClipInSelection: (id) => set((s) => {
            const next = new Set(s.selectedClipIds);
            if (next.has(id)) next.delete(id); else next.add(id);
            const first = next.size > 0 ? next.values().next().value ?? null : null;
            return { selectedClipIds: next, selectedClipId: first, selectedSceneId: null, selectedTransition: null, selectedAudioTarget: null, selectedSceneIds: new Set() };
        }),
        selectedClipId: null,
        setSelectedClipId: (id) => set((s) => (
            s.selectedClipId === id && s.selectedTransition === null && s.selectedSceneId === null
            && s.selectedAudioTarget === null && s.selectedSceneIds.size === 0
            && ((id && sameSet(s.selectedClipIds, new Set([id]))) || (!id && s.selectedClipIds.size === 0))
                ? s
                : { selectedClipId: id, selectedTransition: null, selectedSceneId: null, selectedAudioTarget: null, selectedClipIds: id ? new Set([id]) : new Set(), selectedSceneIds: new Set() }
        )),
        selectClip: (id) => set((s) => {
            if (
                s.selectedClipId === id && sameSet(s.selectedClipIds, new Set([id])) && s.selectedSceneId === null
                && s.selectedTransition === null && s.selectedAudioTarget === null && s.selectedSceneIds.size === 0
            ) return s;
            return { selectedClipId: id, selectedClipIds: new Set([id]), selectedSceneId: null, selectedTransition: null, selectedAudioTarget: null, selectedSceneIds: new Set() };
        }),
        clearSelection: () => set((s) => (
            s.selectedSceneId === null && s.selectedTransition === null && s.selectedClipId === null
            && s.selectedClipIds.size === 0 && s.selectedAudioTarget === null && s.selectedSceneIds.size === 0
                ? s
                : { selectedSceneId: null, selectedTransition: null, selectedClipId: null, selectedClipIds: new Set(), selectedAudioTarget: null, selectedSceneIds: new Set() }
        )),
        selectedAudioTarget: null,
        selectAudioTarget: (target) => set((s) => {
            if (
                sameAudioTarget(s.selectedAudioTarget, target) && s.selectedSceneId === null
                && s.selectedTransition === null && s.selectedClipId === null && s.selectedClipIds.size === 0 && s.selectedSceneIds.size === 0
            ) return s;
            return { selectedAudioTarget: target, selectedSceneId: null, selectedTransition: null, selectedClipId: null, selectedClipIds: new Set(), selectedSceneIds: new Set() };
        }),

        // ── multi-item selection (phase 10c) ───────────────────
        selectedSceneIds: new Set(),
        setSelectedSceneIds: (ids) => set((s) => (sameSet(s.selectedSceneIds, ids) ? s : multiSelection(s, s.selectedClipIds, ids))),
        setSelection: (selection) => set((s) => multiSelection(s, new Set(selection.clipIds ?? []), new Set(selection.sceneIds ?? []))),
        toggleItemInSelection: (item) => set((s) => {
            if (item.clipId) {
                const clips = new Set(s.selectedClipIds);
                if (clips.has(item.clipId)) clips.delete(item.clipId); else clips.add(item.clipId);
                return multiSelection(s, clips, s.selectedSceneIds);
            }
            const scenes = new Set(s.selectedSceneIds);
            if (scenes.has(item.sceneId!)) scenes.delete(item.sceneId!); else scenes.add(item.sceneId!);
            return multiSelection(s, s.selectedClipIds, scenes);
        }),

        // ── view ───────────────────────────────────────────────
        toolMode: "select",
        setToolMode: (mode) => set((s) => (s.toolMode === mode ? s : { toolMode: mode })),
        snapEnabled: true,
        setSnapEnabled: (value) => set((s) => (s.snapEnabled === value ? s : { snapEnabled: value })),
        snapToBeats: false,
        setSnapToBeats: (value) => set((s) => (s.snapToBeats === value ? s : { snapToBeats: value })),
        aiCutPreview: null,
        setAiCutPreview: (value) => set((s) => (s.aiCutPreview === value ? s : { aiCutPreview: value })),
        aiActivity: {},
        setAiActivity: (id, value) => set((s) => {
            const current = s.aiActivity[id];
            if (value === null) {
                if (!current) return s;
                const { [id]: _removed, ...rest } = s.aiActivity;
                return { aiActivity: rest };
            }
            if (current && current.progress === value.progress && current.changed === value.changed) return s;
            return { aiActivity: { ...s.aiActivity, [id]: { ...value } } };
        }),
        maskEditing: false,
        setMaskEditing: (value) => set((s) => (s.maskEditing === value ? s : { maskEditing: value })),
        trackingRegion: null,
        setTrackingRegion: (value) => set((s) => (s.trackingRegion === value ? s : { trackingRegion: value })),
        trackingResult: null,
        setTrackingResult: (value) => set((s) => (s.trackingResult === value ? s : { trackingResult: value })),
        timelineZoom: DEFAULT_TIMELINE_ZOOM,
        setTimelineZoom: (zoom) => set((s) => (Object.is(s.timelineZoom, zoom) ? s : { timelineZoom: zoom })),

        // ── playback ───────────────────────────────────────────
        isPlaying: false,
        setIsPlaying: (value) => set((s) => (s.isPlaying === value ? s : { isPlaying: value })),
        currentTime: 0,
        setCurrentTime: (time) => set((s) => (Object.is(s.currentTime, time) ? s : { currentTime: time })),
        shuttleSpeed: 0,
        setShuttleSpeed: (speed) => set((s) => (s.shuttleSpeed === speed ? s : { shuttleSpeed: speed })),
        frameStepRequest: null,
        setFrameStepRequest: (direction, targetTime = null) => set(() => {
            if (direction === null) return { frameStepRequest: null };
            frameStepRequestId += 1;
            return {
                frameStepRequest: {
                    id: frameStepRequestId,
                    direction,
                    targetTime: typeof targetTime === "number" && Number.isFinite(targetTime) ? targetTime : null,
                },
            };
        }),
        seekRequest: null,
        setSeekRequest: (time) => set((s) => (Object.is(s.seekRequest, time) ? s : { seekRequest: time })),
        playRequest: null,
        setPlayRequest: (request) => set((s) => (s.playRequest === request ? s : { playRequest: request })),
        musicVolume: 1,
        setMusicVolume: (value) => {
            const volume = Math.max(0, Math.min(1, value));
            set((s) => (Object.is(s.musicVolume, volume) ? s : { musicVolume: volume }));
        },

        // ── markers (editor-store.ts:394-447) ──────────────────
        timelineMarkers: [],
        addTimelineMarker: (time, label) => set((s) => {
            const clampedTime = Math.max(0, time);
            const rangeEndpointLabel = label === "In" || label === "Out" ? label : null;
            const kept = rangeEndpointLabel
                ? s.timelineMarkers.filter((marker) => marker.label !== rangeEndpointLabel)
                : s.timelineMarkers;
            if (kept.some((marker) => Math.abs(marker.time - clampedTime) < 0.05)) return s;
            const markerNumber = kept.reduce((max, marker) => {
                const match = /^M(\d+)$/.exec(marker.label || "");
                return match ? Math.max(max, Number(match[1])) : max;
            }, 0) + 1;
            const marker: TimelineMarker = { id: `marker-${Date.now()}-${markerNumber}`, time: clampedTime, label: label || `M${markerNumber}` };
            return { timelineMarkers: [...kept, marker].sort((a, b) => a.time - b.time) };
        }),
        removeTimelineMarker: (id) => set((s) => ({
            timelineMarkers: s.timelineMarkers.filter((marker) => marker.id !== id),
            selectedMarkerId: s.selectedMarkerId === id ? null : s.selectedMarkerId,
        })),
        moveTimelineMarker: (id, time) => set((s) => {
            const clamped = Math.max(0, time);
            let changed = false;
            const next = s.timelineMarkers.map((marker) => {
                if (marker.id !== id || Math.abs(marker.time - clamped) < 0.0005) return marker;
                changed = true;
                return { ...marker, time: clamped };
            });
            return changed ? { timelineMarkers: next.sort((a, b) => a.time - b.time) } : s;
        }),
        removeTimelineMarkerNear: (time, thresholdSeconds = 0.15) => set((s) => {
            const nearestId = getNearestTimelineMarkerId(s.timelineMarkers, time, thresholdSeconds);
            return nearestId ? { timelineMarkers: s.timelineMarkers.filter((marker) => marker.id !== nearestId) } : s;
        }),
        clearTimelineMarkers: () => set((s) => (s.timelineMarkers.length === 0 ? s : { timelineMarkers: [] })),
        setTimelineMarkers: (markers) => set({ timelineMarkers: [...markers].sort((a, b) => a.time - b.time) }),
        selectedMarkerId: null,
        setSelectedMarkerId: (id) => set((s) => (s.selectedMarkerId === id ? s : { selectedMarkerId: id })),

        // ── clipboard, durations, saves, history, requests ─────
        timelineClipboard: null,
        setTimelineClipboard: (clipboard) => set((s) => (s.timelineClipboard === clipboard ? s : { timelineClipboard: clipboard })),
        attributeClipboard: null,
        setAttributeClipboard: (snapshot) => set((s) => (s.attributeClipboard === snapshot ? s : { attributeClipboard: snapshot })),
        attributePastePicker: null,
        setAttributePastePicker: (picker) => set((s) => (s.attributePastePicker === picker ? s : { attributePastePicker: picker })),
        sourceDurations: new Map(),
        setSourceDuration: (id, seconds) => set((s) => {
            if (!Number.isFinite(seconds) || seconds <= 0 || s.sourceDurations.get(id) === seconds) return s;
            const next = new Map(s.sourceDurations);
            next.set(id, seconds);
            return { sourceDurations: next };
        }),
        activeTimelineSaves: 0,
        beginTimelineSave: () => set((s) => ({ activeTimelineSaves: s.activeTimelineSaves + 1 })),
        endTimelineSave: () => set((s) => ({ activeTimelineSaves: Math.max(0, s.activeTimelineSaves - 1) })),
        canUndo: false,
        canRedo: false,
        setUndoRedo: (canUndo, canRedo) => set((s) => (s.canUndo === canUndo && s.canRedo === canRedo ? s : { canUndo, canRedo })),
        addTextRequest: null,
        setAddTextRequest: (request) => {
            const normalized = typeof request === "number" ? { id: request, preset: "text" as const } : request;
            set((s) => (
                s.addTextRequest?.id === normalized?.id && s.addTextRequest?.preset === normalized?.preset ? s : { addTextRequest: normalized }
            ));
        },
        addImageRequest: null,
        setAddImageRequest: (url) => set((s) => (s.addImageRequest === url ? s : { addImageRequest: url })),
        deleteSelectionRequest: null,
        setDeleteSelectionRequest: (id) => set((s) => (s.deleteSelectionRequest === id ? s : { deleteSelectionRequest: id })),

        // ── keyframe UX (phase 10c) ────────────────────────────
        selectedKeyframe: null,
        selectKeyframe: (keyframe) => set((s) => {
            if (keyframe === null || !Number.isFinite(keyframe.time) || !keyframeSelectionValid(s, keyframe)) {
                return s.selectedKeyframe === null ? s : { selectedKeyframe: null };
            }
            const current = s.selectedKeyframe;
            if (current && current.clipId === keyframe.clipId && current.sceneId === keyframe.sceneId && current.time === keyframe.time) return s;
            return { selectedKeyframe: keyframe.clipId ? { clipId: keyframe.clipId, time: keyframe.time } : { sceneId: keyframe.sceneId!, time: keyframe.time } };
        }),
        keyframeGraph: { open: false, channel: null },
        setKeyframeGraph: (patch) => set((s) => {
            const next = { ...s.keyframeGraph, ...patch };
            return next.open === s.keyframeGraph.open && next.channel === s.keyframeGraph.channel ? s : { keyframeGraph: next };
        }),

        // ── document ───────────────────────────────────────────
        projectMeta: null,
        setProjectMeta: (meta) => set({ projectMeta: meta }),
        timelineData: null,
        timelineLoading: false,
        setTimelineData: (data) => set((s) => (s.timelineData === data ? s : { timelineData: data })),
        setTimelineLoading: (loading) => set((s) => (s.timelineLoading === loading ? s : { timelineLoading: loading })),
        serverScenes: [],
        replaceServerScenes: (scenes) => set({ serverScenes: scenes, ...EMPTY_OVERRIDES() }),
        syncServerScenes: (scenes) => set((s) => ({ serverScenes: scenes, ...convergeOverrides(s, scenes) })),
        mergeServerScenes: (scenes) => set((s) => {
            if (scenes.length === 0) return s;
            const incoming = new Map(scenes.map((scene) => [scene.id, scene]));
            const merged = s.serverScenes.map((scene) => incoming.get(scene.id) ?? scene);
            for (const scene of scenes) if (!s.serverScenes.some((existing) => existing.id === scene.id)) merged.push(scene);
            return { serverScenes: merged, ...convergeOverrides(s, merged) };
        }),
        removeServerScenes: (sceneIds) => set((s) => {
            const remove = new Set(sceneIds);
            const remaining = s.serverScenes.filter((scene) => !remove.has(scene.id));
            return { serverScenes: remaining, ...convergeOverrides(s, remaining) };
        }),

        // ── optimistic scene overrides (editor-layout.tsx:805-1033) ──
        ...EMPTY_OVERRIDES(),
        applySceneOverrides: (updates, trackChangeSceneId, trackChangeIndex) => set((s) => {
            const positions = new Map(s.scenePositionOverrides);
            for (const [id, position] of updates) positions.set(id, position);
            if (!trackChangeSceneId || trackChangeIndex === undefined) return { scenePositionOverrides: positions };
            const tracks = new Map(s.sceneTrackOverrides);
            tracks.set(trackChangeSceneId, trackChangeIndex);
            return { scenePositionOverrides: positions, sceneTrackOverrides: tracks };
        }),
        applyOptimisticSceneDelete: (sceneId, restore = false) => set((s) => {
            const next = new Set(s.deletedSceneIds);
            if (restore) next.delete(sceneId); else next.add(sceneId);
            return { deletedSceneIds: next };
        }),
        applyLocalScenePatch: (sceneId, patch) => set((s) => {
            const serverScene = s.serverScenes.find((scene) => scene.id === sceneId);
            const merged = patchWithoutServerMatches(s.sceneFieldOverrides.get(sceneId), patch, serverScene);
            const next = new Map(s.sceneFieldOverrides);
            if (Object.keys(merged).length === 0) next.delete(sceneId); else next.set(sceneId, merged);
            return { sceneFieldOverrides: next };
        }),
        applyOptimisticSceneSplit: (split) => {
            set((s) => {
                const fields = new Map(s.sceneFieldOverrides);
                fields.set(split.sourceSceneId, split.firstScene);
                const optimistic = new Map(s.optimisticScenes);
                optimistic.set(split.tempSceneId, split.secondScene);
                return { sceneFieldOverrides: fields, optimisticScenes: optimistic };
            });
            get().selectScene(split.tempSceneId);
            get().setSeekRequest(split.splitTime);
        },
        applyOptimisticSceneAdd: (tempScene) => set((s) => {
            const optimistic = new Map(s.optimisticScenes);
            optimistic.set(tempScene.id, tempScene);
            return { optimisticScenes: optimistic };
        }),
        commitOptimisticSceneSplit: (tempSceneId, createdSceneId) => {
            set((s) => {
                const optimistic = s.optimisticScenes.get(tempSceneId);
                if (!optimistic) return s;
                const next = new Map(s.optimisticScenes);
                next.delete(tempSceneId);
                next.set(createdSceneId, { ...optimistic, id: createdSceneId });
                return { optimisticScenes: next };
            });
            get().selectScene(createdSceneId);
        },
        rollbackOptimisticSceneSplit: (sourceSceneId, sceneId) => set((s) => {
            const fields = new Map(s.sceneFieldOverrides);
            fields.delete(sourceSceneId);
            const optimistic = new Map(s.optimisticScenes);
            optimistic.delete(sceneId);
            return { sceneFieldOverrides: fields, optimisticScenes: optimistic };
        }),
        captureSceneOverrides: (sceneIds) => {
            const s = get();
            const capture: SceneOverridesCapture = {
                positions: new Map(), tracks: new Map(), optimistic: new Map(), fields: new Map(), deleted: new Map(),
            };
            for (const id of sceneIds) {
                capture.positions.set(id, s.scenePositionOverrides.get(id));
                capture.tracks.set(id, s.sceneTrackOverrides.get(id));
                capture.optimistic.set(id, s.optimisticScenes.get(id));
                capture.fields.set(id, s.sceneFieldOverrides.get(id));
                capture.deleted.set(id, s.deletedSceneIds.has(id));
            }
            return capture;
        },
        restoreSceneOverrides: (capture) => set((s) => {
            const restoreMap = <V,>(current: Map<string, V>, saved: Map<string, V | undefined>) => {
                const next = new Map(current);
                for (const [id, value] of saved) {
                    if (value === undefined) next.delete(id); else next.set(id, value);
                }
                return next;
            };
            const deleted = new Set(s.deletedSceneIds);
            for (const [id, wasDeleted] of capture.deleted) {
                if (wasDeleted) deleted.add(id); else deleted.delete(id);
            }
            return {
                scenePositionOverrides: restoreMap(s.scenePositionOverrides, capture.positions),
                sceneTrackOverrides: restoreMap(s.sceneTrackOverrides, capture.tracks),
                optimisticScenes: restoreMap(s.optimisticScenes, capture.optimistic),
                sceneFieldOverrides: restoreMap(s.sceneFieldOverrides, capture.fields),
                deletedSceneIds: deleted,
            };
        }),

        // ── lifecycle (editor-store.ts:506-521 plus the document slices) ──
        resetForProject: () => set({
            selectedSceneId: null,
            selectedTransition: null,
            selectedClipId: null,
            selectedClipIds: new Set(),
            selectedSceneIds: new Set(),
            selectedAudioTarget: null,
            isPlaying: false,
            currentTime: 0,
            seekRequest: null,
            playRequest: null,
            frameStepRequest: null,
            shuttleSpeed: 0,
            musicVolume: 1,
            timelineMarkers: [],
            timelineClipboard: null,
            attributeClipboard: null,
            attributePastePicker: null,
            projectMeta: null,
            timelineData: null,
            serverScenes: [],
            canUndo: false,
            canRedo: false,
            ...EMPTY_OVERRIDES(),
        }),
    })));
    // A selection change drops the keyframe of the item that is no longer selected (one rule for every selection action).
    store.subscribe((state) => {
        if (state.selectedKeyframe && !keyframeSelectionValid(state, state.selectedKeyframe)) store.setState({ selectedKeyframe: null });
    });
    return store;
}
