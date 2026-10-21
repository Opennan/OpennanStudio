// BackendRouter: one StudioBackend for the editor shell over two backends. Projects with a "cloud-" id go to the
// cloud backend (created only once someone opens or lists a cloud project); every other project goes to the local
// backend, and never touches the network.
import type {
    AddClipEffectOptions, AddSceneInput, BackendChange, ClipEffect, ClipEffectPatch, CreateClipInput, CreateProjectInput, EffectDef, EffectTarget, ExtractShotInput,
    LocalBackend, MediaKind, MediaLibraryBackend, MergeShotInput, ProjectCatalog, ProjectMeta, ProjectSummary, RemovedTrackRef, SceneData, SceneMove, TimelineBackend,
    TimelineClip, TimelineClipCommand, TimelineClipCommandResult, TimelineClipUpdate, TimelineData, TimelineTrack, TrimSceneInput, UploadOptions, UploadedMedia,
} from "@opennan/timeline-core";
import { isCloudProjectId, type OpenNanCloudBackend } from "./cloud-backend";

export type StudioBackendLike = TimelineBackend & ProjectCatalog & MediaLibraryBackend;

export const CLOUD_SIGN_IN_NEEDED = "Sign in with OpenNan to open cloud projects.";

export class BackendRouter implements TimelineBackend, ProjectCatalog, MediaLibraryBackend {
    readonly id = "studio";

    /**
     * `cloud` gives the cloud backend of the signed-in account, or null when signed out. It is called only for cloud
     * project ids, so a session that never opens a cloud project never builds one.
     */
    constructor(
        readonly local: LocalBackend,
        private readonly cloud: () => OpenNanCloudBackend | null,
        private readonly history = true,
    ) {}

    private pick(projectId: string): StudioBackendLike {
        if (!isCloudProjectId(projectId)) return this.history ? this.local : this.local.withoutHistory();
        const cloud = this.cloud();
        if (!cloud) throw new Error(CLOUD_SIGN_IN_NEEDED);
        return this.history ? cloud : cloud.withoutHistory();
    }

    private async route<T>(projectId: string, call: (backend: StudioBackendLike) => Promise<T>): Promise<T> {
        return call(this.pick(projectId));
    }

    withoutHistory(): BackendRouter {
        return new BackendRouter(this.local, this.cloud, false);
    }

    /** MediaEnvironment.resolveMediaUrl's synchronous lookup of local blobs. */
    resolveLocalUrl(url: string): string | null {
        return this.local.resolveLocalUrl(url);
    }

    // load
    loadProject(projectId: string): Promise<ProjectMeta> { return this.route(projectId, (b) => b.loadProject(projectId)); }
    loadTimeline(projectId: string): Promise<TimelineData> { return this.route(projectId, (b) => b.loadTimeline(projectId)); }
    loadScenes(projectId: string): Promise<SceneData[]> { return this.route(projectId, (b) => b.loadScenes(projectId)); }
    subscribe(projectId: string, onChange: (change: BackendChange) => void): () => void {
        if (!isCloudProjectId(projectId)) return () => undefined;
        const cloud = this.cloud();
        return cloud ? cloud.subscribe(projectId, onChange) : () => undefined;
    }
    updateProject(projectId: string, patch: Partial<Omit<ProjectMeta, "id">>): Promise<ProjectMeta> { return this.route(projectId, (b) => b.updateProject(projectId, patch)); }

    // clips
    createClips(projectId: string, inputs: CreateClipInput[]): Promise<TimelineClip[]> { return this.route(projectId, (b) => b.createClips(projectId, inputs)); }
    updateClips(projectId: string, updates: TimelineClipUpdate[]): Promise<TimelineClip[] | void> { return this.route(projectId, (b) => b.updateClips(projectId, updates)); }
    deleteClips(projectId: string, clipIds: string[]): Promise<void> { return this.route(projectId, (b) => b.deleteClips(projectId, clipIds)); }
    splitClips(projectId: string, clipIds: string[], atSeconds: number): Promise<TimelineClip[]> { return this.route(projectId, (b) => b.splitClips(projectId, clipIds, atSeconds)); }
    commitCommand(projectId: string, command: TimelineClipCommand): Promise<TimelineClipCommandResult> { return this.route(projectId, (b) => b.commitCommand(projectId, command)); }
    updateTracks(projectId: string, tracks: TimelineTrack[], removed?: RemovedTrackRef[]): Promise<TimelineTrack[]> { return this.route(projectId, (b) => b.updateTracks(projectId, tracks, removed)); }
    undo(projectId: string, steps?: number): Promise<TimelineData> { return this.route(projectId, (b) => b.undo(projectId, steps)); }
    redo(projectId: string, steps?: number): Promise<TimelineData> { return this.route(projectId, (b) => b.redo(projectId, steps)); }

    // scenes
    moveScenes(projectId: string, moves: SceneMove[]): Promise<SceneData[]> { return this.route(projectId, (b) => b.moveScenes(projectId, moves)); }
    addScene(projectId: string, input: AddSceneInput): Promise<SceneData> { return this.route(projectId, (b) => b.addScene(projectId, input)); }
    deleteScene(projectId: string, sceneId: string): Promise<void> { return this.route(projectId, (b) => b.deleteScene(projectId, sceneId)); }
    duplicateScene(projectId: string, sceneId: string): Promise<SceneData> { return this.route(projectId, (b) => b.duplicateScene(projectId, sceneId)); }
    splitScene(projectId: string, sceneId: string, atSeconds: number): Promise<SceneData[]> { return this.route(projectId, (b) => b.splitScene(projectId, sceneId, atSeconds)); }
    trimScene(projectId: string, input: TrimSceneInput): Promise<SceneData> { return this.route(projectId, (b) => b.trimScene(projectId, input)); }
    setSceneDuration(projectId: string, sceneId: string, seconds: number): Promise<SceneData> { return this.route(projectId, (b) => b.setSceneDuration(projectId, sceneId, seconds)); }
    updateScene(projectId: string, sceneId: string, patch: Partial<Omit<SceneData, "id">>): Promise<SceneData> { return this.route(projectId, (b) => b.updateScene(projectId, sceneId, patch)); }
    updateScenes(projectId: string, updates: Array<{ sceneId: string; patch: Partial<Omit<SceneData, "id">> }>): Promise<SceneData[]> { return this.route(projectId, (b) => b.updateScenes!(projectId, updates)); }
    reorderScenes(projectId: string, sceneIds: string[]): Promise<SceneData[]> { return this.route(projectId, (b) => b.reorderScenes(projectId, sceneIds)); }
    reorderShots(projectId: string, sceneId: string, order: number[]): Promise<SceneData> { return this.route(projectId, (b) => b.reorderShots!(projectId, sceneId, order)); }
    mergeShot(projectId: string, input: MergeShotInput): Promise<SceneData[]> { return this.route(projectId, (b) => (b.mergeShot ? b.mergeShot(projectId, input) : Promise.reject(new Error("Merging shots is not available here.")))); }
    extractShot(projectId: string, input: ExtractShotInput): Promise<SceneData[]> { return this.route(projectId, (b) => (b.extractShot ? b.extractShot(projectId, input) : Promise.reject(new Error("Extracting shots is not available here.")))); }
    deleteShot(projectId: string, sceneId: string, shotIndex: number): Promise<SceneData> { return this.route(projectId, (b) => b.deleteShot!(projectId, sceneId, shotIndex)); }

    // effects
    addClipEffect(projectId: string, target: EffectTarget, effectId: string, options?: AddClipEffectOptions): Promise<ClipEffect[]> { return this.route(projectId, (b) => b.addClipEffect!(projectId, target, effectId, options)); }
    updateClipEffect(projectId: string, effectRowId: string, patch: ClipEffectPatch): Promise<ClipEffect[]> { return this.route(projectId, (b) => b.updateClipEffect!(projectId, effectRowId, patch)); }
    removeClipEffect(projectId: string, effectRowId: string): Promise<ClipEffect[]> { return this.route(projectId, (b) => b.removeClipEffect!(projectId, effectRowId)); }
    reorderClipEffects(projectId: string, target: EffectTarget, effectRowIds: string[]): Promise<ClipEffect[]> { return this.route(projectId, (b) => b.reorderClipEffects!(projectId, target, effectRowIds)); }
    listEffects(kind: "effect" | "transition"): Promise<EffectDef[]> { return this.local.listEffects(kind); }

    // media
    uploadFile(projectId: string, file: Blob, kind: MediaKind, options?: UploadOptions): Promise<UploadedMedia> { return this.route(projectId, (b) => b.uploadFile(projectId, file, kind, options)); }
    saveToLibrary(projectId: string, media: UploadedMedia): Promise<void> { return this.route(projectId, (b) => b.saveToLibrary(projectId, media)); }
    listLibrary(projectId: string): Promise<UploadedMedia[]> { return this.route(projectId, (b) => b.listLibrary(projectId)); }
    removeFromLibrary(projectId: string, url: string): Promise<void> { return this.route(projectId, (b) => b.removeFromLibrary(projectId, url)); }
    async readMedia(url: string): Promise<Blob | null> { return this.local.readMedia(url); }

    // catalog: the local list (the cloud list is OpenNanCloudBackend.listCloudProjects)
    listProjects(): Promise<ProjectSummary[]> { return this.local.listProjects(); }
    hasProject(projectId: string): Promise<boolean> { return this.route(projectId, (b) => b.hasProject(projectId)); }
    createProject(input?: CreateProjectInput): Promise<ProjectSummary> { return this.local.createProject(input); }
    deleteProject(projectId: string): Promise<void> { return this.route(projectId, (b) => b.deleteProject(projectId)); }
    closeProject(projectId: string): void {
        if (!isCloudProjectId(projectId)) return this.local.closeProject(projectId);
        this.cloud()?.closeProject(projectId);
    }
}
