// TimelineBackend (spec §6) with the phase 2 deltas: projectId first, batch
// clip methods, optional shot/effect/library methods, steps on undo/redo.
import type { ClipEffect, TimelineClip, TimelineData, TimelineTrack } from "../model/timeline";
import type { EffectDef, EffectTarget } from "../model/effects";
import type { SceneData } from "../timeline/canvas/types";
import type { TimelineClipCommand, TimelineClipCreateInput, TimelineClipUpdateCommit } from "../lib/timeline-commits";

export type MediaKind = "video" | "image" | "audio";

export interface UploadedMedia {
    url: string;
    name: string;
    size: number;
    mimeType: string;
    durationSeconds?: number;
}

export interface UploadOptions {
    signal?: AbortSignal;
    onProgress?(percent: number): void;
}

export type CreateClipInput = TimelineClipCreateInput;

/** One clip's patch. Superset of TimelineClipUpdateCommit (lib/timeline-commits.ts:13-61). */
export type TimelineClipUpdate = { clipId: string } & Partial<Omit<TimelineClip, "id" | "projectId">>;

export interface TimelineClipCommandResult {
    created: TimelineClip[];
    updated: TimelineClip[];
}

export interface RemovedTrackRef {
    type: TimelineTrack["type"];
    index: number;
}

export interface SceneMove {
    sceneId: string;
    timelinePositionSeconds: number;
    trackIndex?: number;
}

export interface AddSceneInput {
    afterOrder: number;
    cardType?: string | null;
    sourceVideoUrl?: string | null;
    startImageUrl?: string | null;
    videoUrl?: string | null;
    trackIndex?: number;
    timelinePositionSeconds?: number;
    duration?: number;
    caption?: string;
}

export interface TrimSceneInput {
    sceneId: string;
    duration: number;
    cardConfig: string | null;
}

export interface MergeShotInput {
    sourceSceneId: string;
    shotIndex: number;
    targetSceneId: string;
    targetShotIndex?: number;
}

export interface ExtractShotInput {
    sceneId: string;
    shotIndex: number;
    timelinePositionSeconds: number;
    trackIndex: number;
}

export interface ProjectMeta {
    id: string;
    name: string;
    musicUrl: string | null;
    musicVolume: number;
    aspectRatio: string;
    /**
     * The project's story film (packages/story-film StoryFilm as JSON): its story, cast sheets, keyframes, clips and
     * costs, so a re-run never pays twice. Absent: none. Not timeline history (project.update records no undo step).
     */
    storyFilmJson?: string | null;
}

export interface AddClipEffectOptions {
    paramsJson?: string | null;
    /** Stack position; default the end. */
    index?: number;
}

export interface ClipEffectPatch {
    paramsJson?: string | null;
    enabled?: boolean;
    order?: number;
}

export type BackendChange =
    | { type: "timeline"; data: TimelineData }
    | { type: "scenes"; scenes: SceneData[] }
    | { type: "project"; meta: ProjectMeta };

export interface TimelineBackend {
    readonly id: string;

    // load
    loadProject(projectId: string): Promise<ProjectMeta>;
    loadTimeline(projectId: string): Promise<TimelineData>;
    loadScenes(projectId: string): Promise<SceneData[]>;
    subscribe?(projectId: string, onChange: (change: BackendChange) => void): () => void;
    updateProject(projectId: string, patch: Partial<Omit<ProjectMeta, "id">>): Promise<ProjectMeta>;

    // clips
    createClips(projectId: string, inputs: CreateClipInput[]): Promise<TimelineClip[]>;
    updateClips(projectId: string, updates: TimelineClipUpdate[]): Promise<TimelineClip[] | void>;
    deleteClips(projectId: string, clipIds: string[]): Promise<void>;
    /** Returns each split original followed by its new right half. */
    splitClips(projectId: string, clipIds: string[], atSeconds: number): Promise<TimelineClip[]>;
    commitCommand(projectId: string, command: TimelineClipCommand): Promise<TimelineClipCommandResult>;
    updateTracks(projectId: string, tracks: TimelineTrack[], removed?: RemovedTrackRef[]): Promise<TimelineTrack[]>;
    /**
     * `steps` counts write calls: every write made on this backend (not on its
     * withoutHistory() view) is exactly one undo step, even a call that changed
     * nothing. TimelineController undoes an edit by summing the calls it made.
     * updateProject, uploadFile, and saveToLibrary are not timeline writes and
     * are never undo steps.
     */
    undo(projectId: string, steps?: number): Promise<TimelineData>;
    redo(projectId: string, steps?: number): Promise<TimelineData>;
    /**
     * Optional: a view over the same projects whose writes are not undo steps
     * (commands run with recordHistory: false, e.g. preview drags). Without it
     * the controller folds those calls into its newest undo entry.
     */
    withoutHistory?(): TimelineBackend;

    // scenes
    moveScenes(projectId: string, moves: SceneMove[]): Promise<SceneData[]>;
    addScene(projectId: string, input: AddSceneInput): Promise<SceneData>;
    deleteScene(projectId: string, sceneId: string): Promise<void>;
    duplicateScene(projectId: string, sceneId: string): Promise<SceneData>;
    /** Returns the updated source scene and the created scene. */
    splitScene(projectId: string, sceneId: string, atSeconds: number): Promise<SceneData[]>;
    trimScene(projectId: string, input: TrimSceneInput): Promise<SceneData>;
    setSceneDuration(projectId: string, sceneId: string, seconds: number): Promise<SceneData>;
    updateScene(projectId: string, sceneId: string, patch: Partial<Omit<SceneData, "id">>): Promise<SceneData>;
    /** Optional: several scene patches as one write (one undo step). Returns the updated scenes in input order. */
    updateScenes?(projectId: string, updates: Array<{ sceneId: string; patch: Partial<Omit<SceneData, "id">> }>): Promise<SceneData[]>;
    reorderScenes(projectId: string, sceneIds: string[]): Promise<SceneData[]>;
    reorderShots?(projectId: string, sceneId: string, order: number[]): Promise<SceneData>;
    mergeShot?(projectId: string, input: MergeShotInput): Promise<SceneData[]>;
    extractShot?(projectId: string, input: ExtractShotInput): Promise<SceneData[]>;
    deleteShot?(projectId: string, sceneId: string, shotIndex: number): Promise<SceneData>;

    // effects (rows return the owner's whole stack, in order)
    addClipEffect?(projectId: string, target: EffectTarget, effectId: string, options?: AddClipEffectOptions): Promise<ClipEffect[]>;
    updateClipEffect?(projectId: string, effectRowId: string, patch: ClipEffectPatch): Promise<ClipEffect[]>;
    removeClipEffect?(projectId: string, effectRowId: string): Promise<ClipEffect[]>;
    /** `effectRowIds` is the owner's full stack in the new order. */
    reorderClipEffects?(projectId: string, target: EffectTarget, effectRowIds: string[]): Promise<ClipEffect[]>;
    listEffects?(kind: "effect" | "transition", options?: { signal?: AbortSignal }): Promise<EffectDef[]>;

    // media
    uploadFile(projectId: string, file: Blob, kind: MediaKind, options?: UploadOptions): Promise<UploadedMedia>;
    saveToLibrary?(projectId: string, media: UploadedMedia): Promise<void>;
}

/** One row of a project list (web project screen, desktop library). */
export interface ProjectSummary {
    id: string;
    name: string;
    aspectRatio: string;
    createdAt: number;
    updatedAt: number;
    /** Latest scene or clip end, in seconds. */
    durationSeconds: number;
    /** Media bin entries. */
    mediaCount: number;
    /** Where the project lives (phase 9a): on this device, or an OpenNan cloud project (id "cloud-<id>"). Absent: local. */
    kind?: "local" | "cloud";
    /** A cloud project made in Studio, or on opennan.com. */
    origin?: "studio" | "web";
    /** Cloud: bytes of media the project uses. */
    mediaBytes?: number;
    /** Cloud: the device that made the last edit. */
    lastEditedDevice?: string | null;
    /** Cloud: a poster of the first scene, on OpenNan's storage. */
    thumbnailUrl?: string | null;
    /** Cloud trash: when the project was moved to the trash (epoch ms). */
    deletedAt?: number | null;
}

export interface CreateProjectInput {
    name?: string;
    aspectRatio?: string;
}

/**
 * The projects a host app lists and opens. LocalBackend implements it (phase 3);
 * the desktop store (phase 6) and a project connected to OpenNan (phase 8) provide
 * their own, so app screens depend on this interface, not on a backend class.
 */
export interface ProjectCatalog {
    /** Most recently edited first. */
    listProjects(): Promise<ProjectSummary[]>;
    /** Unlike TimelineBackend.loadProject, never creates the project. */
    hasProject(projectId: string): Promise<boolean>;
    createProject(input?: CreateProjectInput): Promise<ProjectSummary>;
    updateProject(projectId: string, patch: Partial<Omit<ProjectMeta, "id">>): Promise<ProjectMeta>;
    /** Deletes the project and every media blob it owns. */
    deleteProject(projectId: string): Promise<void>;
    /** The host left the project: drop its in-memory state and object URLs. The next read loads it again. */
    closeProject(projectId: string): void;
}

/** A project's media bin. LocalBackend implements it; app screens depend on this, not on the class. */
export interface MediaLibraryBackend {
    uploadFile(projectId: string, file: Blob, kind: MediaKind, options?: UploadOptions): Promise<UploadedMedia>;
    /** Adds a bin entry; the same url replaces the earlier one. Never an undo step. */
    saveToLibrary(projectId: string, media: UploadedMedia): Promise<void>;
    listLibrary(projectId: string): Promise<UploadedMedia[]>;
    /** Removes the bin entry only; clips that use the media keep it. */
    removeFromLibrary(projectId: string, url: string): Promise<void>;
    /** The stored media behind a URL this backend issued (disk-backed for IndexedDB), else null. */
    readMedia(url: string): Promise<Blob | null>;
}

export type { TimelineClipCommand, TimelineClipCreateInput, TimelineClipUpdateCommit };
