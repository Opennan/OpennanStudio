// OpenNanCloudBackend: timeline-core's TimelineBackend, ProjectCatalog and MediaLibraryBackend for OpenNan cloud
// projects (Studio ids "cloud-<serverId>"), so the editor, its controller and MCP work on them unchanged. Every write
// runs on a local working copy (a LocalBackend the host gives, persisted on this device) and is synced by a
// CloudProjectSession; undo is per device. The catalog lists cloud projects (most recently edited first, paged),
// the trash, restore and permanent delete. Save to OpenNan moves a local project to the cloud; Download a local copy
// and Keep my version as a copy make new local projects with fresh ids.
import type {
    AddClipEffectOptions, AddSceneInput, BackendChange, ClipEffect, ClipEffectPatch, CreateClipInput, CreateProjectInput, EffectDef, EffectTarget, ExtractShotInput,
    LocalBackend, MediaKind, MediaLibraryBackend, MergeShotInput, ProjectCatalog, ProjectMeta, ProjectSummary, RemovedTrackRef, SceneData, SceneMove, TimelineBackend,
    TimelineClip, TimelineClipCommand, TimelineClipCommandResult, TimelineClipUpdate, TimelineData, TimelineTrack, TrimSceneInput, UploadOptions, UploadedMedia,
} from "@opennan/timeline-core";
import { CloudApiError, isCloudApiError, type CloudApi } from "./api";
import { REAL_CLOCK, type Clock } from "./clock";
import {
    ASPECT_RATIOS, IDENTITY_URLS, decodeDoc, encodeDoc, extrasJson, ingestDocument, isLocalUrl, localUrlsIn, normalizedProject, entityId, entityKind,
    CLIP_COLUMNS, SCENE_COLUMNS, TRACK_COLUMNS, type DocumentJson, type Fields, type LocalDoc, type UrlMap,
} from "./codec";
import { emptyDelta } from "./delta";
import { clone, mapStrings, type Json } from "./json";
import { MediaSync, serverIdOf, type MediaHost } from "./media";
import { cloudContentType } from "./upload";
import { ALWAYS_ONLINE, CloudProjectSession, type NetworkStatus, type RemoteGroup, type RemoteStep, type SyncRecord } from "./session";
import type { CloudStore } from "./store";
import { storageFromJson, type StorageInfo, type SyncState } from "./types";

export const CLOUD_PREFIX = "cloud-";
export const SHOT_EDITS_REFUSED = "Made on opennan.com — edit shots there.";
/** Moving shots between scenes (S5 structural commands) on a cloud project: 9b. */
export const SHOT_MOVES_LATER = "Moving shots between scenes of a cloud project comes in a later version of OpenNan Studio.";
/** After a write, the media pins are recomputed this much later (many writes in a row: once). */
export const PIN_DELAY_MS = 500;
/** A remote change is checked for new cloud files this long after it (several changes in a row are checked once). */
export const NEW_MEDIA_CHECK_MS = 300;
export const IMPORT_MAX_SCENES = 500;
export const IMPORT_MAX_CLIPS = 4_000;
export const IMPORT_MAX_BYTES = 6 * 1024 * 1024;

export function isCloudProjectId(projectId: string): boolean {
    return projectId.startsWith(CLOUD_PREFIX);
}

export function cloudProjectId(serverId: string): string {
    return `${CLOUD_PREFIX}${serverId}`;
}

export interface SaveProgress {
    stage: "checking" | "uploading" | "creating" | "syncing" | "downloading" | "done";
    /** Files done and in all (media), or 0/0. */
    done: number;
    total: number;
    /** Bytes sent of the file going up now. */
    bytes?: number;
    file?: string;
}

export class CloudStorageFullError extends Error {
    constructor(readonly neededBytes: number, readonly leftBytes: number) {
        super(`Not enough cloud storage: ${formatBytes(Math.max(0, leftBytes))} left, ${formatBytes(neededBytes)} needed. More storage is coming soon.`);
        this.name = "CloudStorageFullError";
    }
}

export function formatBytes(bytes: number): string {
    if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
    if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
    if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${bytes} B`;
}

export interface OpenNanCloudBackendOptions {
    api: CloudApi;
    /** This account's store (a queue never reaches another account). */
    store: CloudStore;
    /** The working copies: a LocalBackend over this device's cloud persistence. */
    mirror: LocalBackend;
    media: MediaHost;
    /** On OpenNan's storage (the CDN), never a temporary upload. */
    isCloudUrl(url: string): boolean;
    deviceName: string;
    clock?: Clock;
    network?: NetworkStatus;
    logger?: { warn(...args: unknown[]): void };
}

interface ProjectView {
    id: string;
    name?: string;
    aspect_ratio?: string;
    created_at?: string | null;
    updated_at?: string | null;
    duration_seconds?: number;
    thumbnail_url?: string | null;
    media_bytes?: number;
    origin?: "studio" | "web";
    last_edited_device?: string | null;
    deleted_at?: string | null;
    scene_count?: number;
}

function time(value: string | null | undefined): number {
    const parsed = value ? Date.parse(value) : NaN;
    return Number.isFinite(parsed) ? parsed : 0;
}

export function summaryOf(view: ProjectView): ProjectSummary {
    return {
        id: cloudProjectId(view.id), name: view.name ?? "Untitled", aspectRatio: view.aspect_ratio ?? "16:9", createdAt: time(view.created_at),
        updatedAt: time(view.updated_at ?? view.created_at), durationSeconds: view.duration_seconds ?? 0, mediaCount: 0, kind: "cloud", origin: view.origin ?? "web",
        mediaBytes: view.media_bytes ?? 0, lastEditedDevice: view.last_edited_device ?? null, thumbnailUrl: view.thumbnail_url ?? null,
        deletedAt: view.deleted_at ? time(view.deleted_at) : null,
    };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A project with every clip, scene and effect id made new (a local copy is independent of the cloud one). */
export function withFreshIds(doc: LocalDoc, newId: () => string = () => globalThis.crypto.randomUUID(), keepUuids = false, ids = new Map<string, string>()): LocalDoc {
    const remap = (id: string) => {
        if (keepUuids && UUID.test(id)) return id;
        let next = ids.get(id);
        if (!next) ids.set(id, (next = newId()));
        return next;
    };
    const effects = (rows: ClipEffect[] | null | undefined, owner: { clipId?: string; sceneId?: string }) => rows?.map((row) => ({
        ...row, id: keepUuids && UUID.test(row.id) ? row.id : newId(), clipId: owner.clipId ?? null, sceneId: owner.clipId ? null : owner.sceneId ?? null,
    }));
    const scenes = doc.scenes.map((scene) => {
        const id = remap(scene.id);
        return { ...clone(scene), id, ...(scene.effects ? { effects: effects(scene.effects, { sceneId: id }) } : {}) };
    });
    const clips = doc.clips.map((clip) => {
        const id = remap(clip.id);
        return {
            ...clone(clip), id, sceneId: clip.sceneId ? (ids.get(clip.sceneId) ?? (keepUuids ? clip.sceneId : null)) : null,
            ...(clip.effects ? { effects: effects(clip.effects, { clipId: id }) } : {}),
        };
    });
    return { meta: clone(doc.meta), tracks: clone(doc.tracks), clips, scenes, library: clone(doc.library ?? []) };
}

/** Scenes whose shots came from opennan.com, made editable (a local copy is not a cloud project). */
export function withoutReadOnlyShots(doc: LocalDoc): LocalDoc {
    const scenes = doc.scenes.map((scene) => {
        if (!scene.shotBreakdown) return scene;
        try {
            const shots = JSON.parse(scene.shotBreakdown) as unknown;
            if (!Array.isArray(shots) || !shots.some((shot) => typeof shot === "object" && shot !== null && "readOnly" in shot)) return scene;
            return { ...scene, shotBreakdown: JSON.stringify(shots.map((shot) => {
                if (typeof shot !== "object" || shot === null) return shot;
                const { readOnly: _readOnly, ...rest } = shot as Record<string, unknown>;
                return rest;
            })) };
        } catch {
            return scene;
        }
    });
    return { ...doc, scenes };
}

function kindOf(mimeType: string): MediaKind {
    return mimeType.startsWith("video/") ? "video" : mimeType.startsWith("image/") ? "image" : "audio";
}

export class OpenNanCloudBackend implements TimelineBackend, ProjectCatalog, MediaLibraryBackend {
    readonly id = "opennan-cloud";
    readonly media: MediaSync;
    private readonly sessions = new Map<string, Promise<CloudProjectSession>>();
    private readonly closing = new Map<string, Promise<void>>();
    private readonly changeListeners = new Map<string, Set<(change: BackendChange) => void>>();
    private readonly stateListeners = new Map<string, Set<(state: SyncState) => void>>();
    private readonly noticeListeners = new Set<(message: string, projectId: string) => void>();
    private readonly states = new Map<string, SyncState>();
    private readonly clock: Clock;
    private readonly network: NetworkStatus;
    private recordsHistory = true;
    /** Cloud files each open project was seen to use (new ones are downloaded as they arrive). */
    private readonly knownMedia = new Map<string, Set<string>>();
    private readonly mediaCheckTimers = new Map<string, unknown>();
    private pinTimer: unknown = null;
    private unsubscribeMedia: () => void;
    private unsubscribeProgress: () => void;

    constructor(private readonly options: OpenNanCloudBackendOptions) {
        this.clock = options.clock ?? REAL_CLOCK;
        this.network = options.network ?? ALWAYS_ONLINE;
        this.media = new MediaSync({ host: options.media, store: options.store, clock: this.clock, isCloudUrl: options.isCloudUrl, ...(options.logger ? { logger: options.logger } : {}) });
        this.unsubscribeMedia = this.media.subscribe((mapping) => {
            const changed = [...this.sessions.values()].map((pending) => pending.then((s) => s.urlsChanged(mapping)).catch(() => undefined));
            void Promise.all(changed).then(() => this.schedulePins(0));
        });
        this.unsubscribeProgress = this.media.onProgress(() => {
            for (const [projectId, pending] of this.sessions) void pending.then((s) => this.setState(projectId, s.state())).catch(() => undefined);
        });
    }

    /** The view whose writes are not undo steps (TimelineBackend.withoutHistory). */
    withoutHistory(): OpenNanCloudBackend {
        const view = Object.create(this) as OpenNanCloudBackend;
        view.recordsHistory = false;
        return view;
    }

    // ── sync state ───────────────────────────────────────

    syncState(projectId: string): SyncState | null {
        return this.states.get(projectId) ?? null;
    }

    onSyncState(projectId: string, listener: (state: SyncState) => void): () => void {
        let set = this.stateListeners.get(projectId);
        if (!set) this.stateListeners.set(projectId, (set = new Set()));
        set.add(listener);
        const current = this.states.get(projectId);
        if (current) listener(current);
        return () => set!.delete(listener);
    }

    onNotice(listener: (message: string, projectId: string) => void): () => void {
        this.noticeListeners.add(listener);
        return () => this.noticeListeners.delete(listener);
    }

    async flush(projectId: string): Promise<void> {
        await (await this.session(projectId)).flush();
    }

    acknowledgeConflicts(projectId: string): void {
        void this.sessions.get(projectId)?.then((s) => s.acknowledgeConflicts());
    }

    /** The account signed in again: sessions stopped by a 401 go on, paused uploads too. */
    resume(): void {
        for (const pending of this.sessions.values()) void pending.then((s) => s.resume()).catch(() => undefined);
        this.media.retry();
    }

    async dispose(): Promise<void> {
        if (this.pinTimer !== null) this.clock.clearTimeout(this.pinTimer);
        this.pinTimer = null;
        this.unsubscribeMedia();
        this.unsubscribeProgress();
        this.media.dispose();
        await Promise.all([...this.sessions.values()].map((p) => p.then((s) => s.dispose()).catch(() => undefined)));
        this.sessions.clear();
        // Projects still closing persist their last record first (a migration may start once this resolves).
        await Promise.all([...this.closing.values()]);
    }

    // ── the AI director (phase 9b) ────────────────────────

    /** The API client this backend talks to the server with (the director's turns and tasks use the same one). */
    get api(): CloudApi {
        return this.options.api;
    }

    /** The server's id of a cloud project ("cloud-<id>" → "<id>"). */
    serverId(projectId: string): string {
        return serverIdOf(projectId);
    }

    /** The revision the open project's confirmed document is at (null when it is not open). */
    async revision(projectId: string): Promise<number | null> {
        const pending = this.sessions.get(projectId);
        return pending ? (await pending).revision() : null;
    }

    /** +1 when an AI turn or project task of this project starts, -1 when it ends: polls run every 1.5 s meanwhile. */
    setAiActive(projectId: string, delta: 1 | -1): void {
        void this.sessions.get(projectId)?.then((session) => session.setAiActive(delta)).catch(() => undefined);
    }

    /** A change landed on the server (a turn's project.revision event, a finished task): read the document soon. */
    pullSoon(projectId: string): void {
        void this.sessions.get(projectId)?.then((session) => session.pullSoon()).catch(() => undefined);
    }

    /** Resolves true once the open project's confirmed document is at `revision` (pulling meanwhile), false after `timeoutMs`. */
    async waitForRevision(projectId: string, revision: number, timeoutMs?: number): Promise<boolean> {
        return (await this.session(projectId)).waitForRevision(revision, timeoutMs);
    }

    async beginRemoteGroup(projectId: string): Promise<number> {
        const session = await this.session(projectId);
        // The group's base is the newest document (phase 9c: an undo must never clear a storyboard drawn elsewhere that
        // this device had not read yet).
        await session.pullNow().catch(() => undefined);
        return session.beginRemoteGroup();
    }

    async endRemoteGroup(projectId: string, groupId: number): Promise<void> {
        (await this.session(projectId)).endRemoteGroup(groupId);
    }

    /** One undo step for what an AI turn or task changed (see CloudProjectSession.recordRemoteGroup). */
    async recordRemoteGroup(projectId: string, groupId: number, group: RemoteGroup, options: { timeoutMs?: number } = {}): Promise<RemoteStep | null> {
        return (await this.session(projectId)).recordRemoteGroup(groupId, group, options);
    }

    async isNewestRemoteStep(projectId: string, stepId: number): Promise<boolean> {
        return (await this.session(projectId)).isNewestStep(stepId);
    }

    async undoRemoteStep(projectId: string, stepId: number, label: string): Promise<RemoteStep | null> {
        return (await this.session(projectId)).undoRemoteStep(stepId, label);
    }

    // ── share links (phase 9c) ───────────────────────────

    /**
     * Sets the project's latest export (`project.final_video_url`: what its share link plays) to a file on OpenNan's
     * storage (an export uploaded with the project's id); resolves once OpenNan stored it.
     */
    async setFinalVideo(projectId: string, mediaUrl: string | null): Promise<void> {
        if (mediaUrl !== null && !this.options.isCloudUrl(mediaUrl)) throw new Error("The export must be uploaded to OpenNan first.");
        await (await this.session(projectId)).setFinalVideo(mediaUrl);
    }

    private setState(projectId: string, state: SyncState): void {
        this.states.set(projectId, state);
        for (const listener of this.stateListeners.get(projectId) ?? []) listener(state);
    }

    private session(projectId: string): Promise<CloudProjectSession> {
        if (!isCloudProjectId(projectId)) return Promise.reject(new Error(`Not a cloud project: ${projectId}`));
        let pending = this.sessions.get(projectId);
        if (!pending) {
            pending = (async () => {
                await this.closing.get(projectId);
                // Another tab sharing this store may have recorded uploads or cached copies since (9a.1).
                await this.media.refresh();
                return CloudProjectSession.open({
                    projectId, serverId: serverIdOf(projectId), api: this.options.api, store: this.options.store, mirror: this.options.mirror,
                    urls: this.media.urls, clock: this.clock, network: this.network, deviceName: this.options.deviceName,
                    media: {
                        want: (id, urls) => this.media.want(id, urls),
                        unlinked: () => [],
                        linked: () => undefined,
                        progress: () => this.media.progress(),
                        message: () => this.media.progress().message,
                    },
                    onChange: (changes) => {
                        for (const change of changes) for (const listener of this.changeListeners.get(projectId) ?? []) listener(change);
                        // A remote change may bring new cloud files (an AI result, another device's media): download them (9b).
                        this.scheduleNewMediaCheck(projectId);
                    },
                    onState: (state) => this.setState(projectId, state),
                    onNotice: (message) => {
                        for (const listener of this.noticeListeners) listener(message, projectId);
                    },
                    ...(this.options.logger ? { logger: this.options.logger } : {}),
                });
            })();
            this.sessions.set(projectId, pending);
            pending.catch(() => this.sessions.delete(projectId));
            this.schedulePins(0);
            // Every cloud file the working copy uses, decoded from the server-space document with remote URLs kept (the
            // working copy holds local URLs once cached): the cache answers known files from its index and downloads
            // evicted ones again (9a.1). Server columns Studio never shows are not downloaded. What only OpenNan writes (a
            // scene's shots and storyboard sheets) is only in the confirmed document (9c.1: its images come down at open).
            void pending.then((session) => {
                const urls = this.cloudMediaOf([decodeDoc(session.current(), projectId, this.remoteUrls()), decodeDoc(session.confirmed(), projectId, this.remoteUrls())]);
                this.knownMedia.set(projectId, new Set(urls.map((u) => u.url)));
                return this.media.cacheAll(urls);
            }).catch(() => undefined);
        }
        return pending;
    }

    /** Cloud files that appeared in an open project since it opened: asked from the cache once each (debounced). */
    private scheduleNewMediaCheck(projectId: string): void {
        if (this.mediaCheckTimers.has(projectId)) return;
        this.mediaCheckTimers.set(projectId, this.clock.setTimeout(() => {
            this.mediaCheckTimers.delete(projectId);
            const pending = this.sessions.get(projectId);
            if (!pending) return;
            void pending.then((session) => {
                const known = this.knownMedia.get(projectId) ?? new Set<string>();
                // The server's document: fields Studio never writes (a scene's shots and their panels) are only there.
                const fresh = this.cloudMediaOf(decodeDoc(session.confirmed(), projectId, this.remoteUrls())).filter((u) => !known.has(u.url));
                if (fresh.length === 0) return;
                for (const u of fresh) known.add(u.url);
                this.knownMedia.set(projectId, known);
                return this.media.cacheAll(fresh);
            }).catch(() => undefined);
        }, NEW_MEDIA_CHECK_MS));
    }

    /** The server's URLs as they are (no local copies), under the cloud media allowlist: what the cache may download. */
    private remoteUrls(): UrlMap {
        return { ...IDENTITY_URLS, isCloudUrl: (url) => this.options.isCloudUrl(url) };
    }

    private cloudMediaOf(state: unknown): Array<{ url: string }> {
        const urls = new Set<string>();
        const text = JSON.stringify(state);
        for (const match of text.matchAll(/https?:\/\/[^\s"'<>\\)]+/g)) if (this.options.isCloudUrl(match[0])) urls.add(match[0]);
        return [...urls].map((url) => ({ url }));
    }

    private write<T>(projectId: string, label: string, op: (mirror: LocalBackend) => Promise<T>, undoStep = this.recordsHistory): Promise<T> {
        return this.session(projectId).then((session) => session.write(label, undoStep, () => op(this.options.mirror.withoutHistory()))).finally(() => this.schedulePins(PIN_DELAY_MS));
    }

    /** Recomputes, a moment later, the local media every open project uses, so the host's cache never evicts them. */
    private schedulePins(delayMs: number): void {
        if (!this.options.media.pin) return;
        if (this.pinTimer !== null) {
            if (delayMs > 0) return;
            this.clock.clearTimeout(this.pinTimer);
        }
        this.pinTimer = this.clock.setTimeout(() => {
            this.pinTimer = null;
            void this.pinNow().catch((error: unknown) => this.options.logger?.warn("[cloud] media pins not updated", error));
        }, delayMs);
    }

    private async pinNow(): Promise<void> {
        const urls = new Set<string>();
        for (const [projectId, pending] of [...this.sessions]) {
            try {
                const session = await pending;
                const state = await this.options.mirror.snapshot(projectId);
                // A conflict's snapshot too: Keep my version as a copy needs its files.
                const text = JSON.stringify([state.clips, state.scenes, state.meta, state.library ?? [], session.conflictSnapshot()]);
                for (const match of text.matchAll(/opennan-local:\/\/media\/[A-Za-z0-9._-]+/g)) urls.add(match[0]);
            } catch {
                // a project that failed to open uses nothing
            }
        }
        this.media.pin(urls);
    }

    // ── load ─────────────────────────────────────────────

    async loadProject(projectId: string): Promise<ProjectMeta> {
        await this.session(projectId);
        return this.options.mirror.loadProject(projectId);
    }

    async loadTimeline(projectId: string): Promise<TimelineData> {
        const session = await this.session(projectId);
        const data = await this.options.mirror.loadTimeline(projectId);
        return { ...data, canUndo: session.canUndo(), canRedo: session.canRedo() };
    }

    async loadScenes(projectId: string): Promise<SceneData[]> {
        await this.session(projectId);
        return this.options.mirror.loadScenes(projectId);
    }

    subscribe(projectId: string, onChange: (change: BackendChange) => void): () => void {
        let set = this.changeListeners.get(projectId);
        if (!set) this.changeListeners.set(projectId, (set = new Set()));
        set.add(onChange);
        return () => set!.delete(onChange);
    }

    updateProject(projectId: string, patch: Partial<Omit<ProjectMeta, "id">>): Promise<ProjectMeta> {
        if (!this.sessions.has(projectId)) return this.patchClosedProject(projectId, patch);
        return this.write(projectId, "Project settings", (m) => m.updateProject(projectId, patch), false);
    }

    private async patchClosedProject(projectId: string, patch: Partial<Omit<ProjectMeta, "id">>): Promise<ProjectMeta> {
        const body: Record<string, Json> = {};
        if (patch.name !== undefined) body.name = patch.name;
        if (patch.aspectRatio !== undefined && (ASPECT_RATIOS as readonly string[]).includes(patch.aspectRatio)) body.aspect_ratio = patch.aspectRatio;
        if (patch.musicVolume !== undefined) body.music_volume = Math.max(0, Math.min(2, patch.musicVolume));
        const answer = await this.options.api.request<ProjectView & { music_url?: string | null; music_volume?: number }>("PATCH", `/v1/projects/${encodeURIComponent(serverIdOf(projectId))}`, { body });
        return { id: projectId, name: answer.body.name ?? "Untitled", aspectRatio: answer.body.aspect_ratio ?? "16:9", musicUrl: answer.body.music_url ?? null, musicVolume: answer.body.music_volume ?? 1 };
    }

    // ── clips ────────────────────────────────────────────

    createClips(projectId: string, inputs: CreateClipInput[]): Promise<TimelineClip[]> {
        return this.write(projectId, "Add clips", (m) => m.createClips(projectId, inputs));
    }

    updateClips(projectId: string, updates: TimelineClipUpdate[]): Promise<TimelineClip[]> {
        return this.write(projectId, "Edit clips", (m) => m.updateClips(projectId, updates));
    }

    deleteClips(projectId: string, clipIds: string[]): Promise<void> {
        return this.write(projectId, "Delete clips", (m) => m.deleteClips(projectId, clipIds));
    }

    splitClips(projectId: string, clipIds: string[], atSeconds: number): Promise<TimelineClip[]> {
        return this.write(projectId, "Split", (m) => m.splitClips(projectId, clipIds, atSeconds));
    }

    commitCommand(projectId: string, command: TimelineClipCommand): Promise<TimelineClipCommandResult> {
        return this.write(projectId, "Edit", (m) => m.commitCommand(projectId, command));
    }

    updateTracks(projectId: string, tracks: TimelineTrack[], removed?: RemovedTrackRef[]): Promise<TimelineTrack[]> {
        return this.write(projectId, "Tracks", (m) => m.updateTracks(projectId, tracks, removed));
    }

    async undo(projectId: string, steps = 1): Promise<TimelineData> {
        await (await this.session(projectId)).undo(steps);
        return this.loadTimeline(projectId);
    }

    async redo(projectId: string, steps = 1): Promise<TimelineData> {
        await (await this.session(projectId)).redo(steps);
        return this.loadTimeline(projectId);
    }

    // ── scenes ───────────────────────────────────────────

    moveScenes(projectId: string, moves: SceneMove[]): Promise<SceneData[]> {
        return this.write(projectId, "Move scenes", (m) => m.moveScenes(projectId, moves));
    }

    addScene(projectId: string, input: AddSceneInput): Promise<SceneData> {
        return this.write(projectId, "Add scene", (m) => m.addScene(projectId, input));
    }

    deleteScene(projectId: string, sceneId: string): Promise<void> {
        return this.write(projectId, "Delete scene", (m) => m.deleteScene(projectId, sceneId));
    }

    duplicateScene(projectId: string, sceneId: string): Promise<SceneData> {
        return this.write(projectId, "Duplicate scene", (m) => m.duplicateScene(projectId, sceneId));
    }

    splitScene(projectId: string, sceneId: string, atSeconds: number): Promise<SceneData[]> {
        return this.write(projectId, "Split scene", (m) => m.splitScene(projectId, sceneId, atSeconds));
    }

    trimScene(projectId: string, input: TrimSceneInput): Promise<SceneData> {
        return this.write(projectId, "Trim scene", (m) => m.trimScene(projectId, input));
    }

    setSceneDuration(projectId: string, sceneId: string, seconds: number): Promise<SceneData> {
        return this.write(projectId, "Scene length", (m) => m.setSceneDuration(projectId, sceneId, seconds));
    }

    updateScene(projectId: string, sceneId: string, patch: Partial<Omit<SceneData, "id">>): Promise<SceneData> {
        return this.write(projectId, "Edit scene", async (m) => {
            if (patch.shotBreakdown !== undefined) await this.refuseServerShots(projectId, [sceneId]);
            return m.updateScene(projectId, sceneId, patch);
        });
    }

    updateScenes(projectId: string, updates: Array<{ sceneId: string; patch: Partial<Omit<SceneData, "id">> }>): Promise<SceneData[]> {
        return this.write(projectId, "Edit scenes", async (m) => {
            const shots = updates.filter((u) => u.patch.shotBreakdown !== undefined).map((u) => u.sceneId);
            if (shots.length > 0) await this.refuseServerShots(projectId, shots);
            return m.updateScenes(projectId, updates);
        });
    }

    reorderScenes(projectId: string, sceneIds: string[]): Promise<SceneData[]> {
        return this.write(projectId, "Reorder scenes", (m) => m.reorderScenes(projectId, sceneIds));
    }

    reorderShots(projectId: string, sceneId: string, order: number[]): Promise<SceneData> {
        return this.write(projectId, "Reorder shots", async (m) => {
            await this.refuseServerShots(projectId, [sceneId]);
            return m.reorderShots(projectId, sceneId, order);
        });
    }

    deleteShot(projectId: string, sceneId: string, shotIndex: number): Promise<SceneData> {
        return this.write(projectId, "Delete shot", async (m) => {
            await this.refuseServerShots(projectId, [sceneId]);
            return m.deleteShot(projectId, sceneId, shotIndex);
        });
    }

    async mergeShot(projectId: string, input: MergeShotInput): Promise<SceneData[]> {
        await this.session(projectId);
        await this.refuseServerShots(projectId, [input.sourceSceneId, input.targetSceneId]);
        throw new Error(SHOT_MOVES_LATER);
    }

    async extractShot(projectId: string, input: ExtractShotInput): Promise<SceneData[]> {
        await this.session(projectId);
        await this.refuseServerShots(projectId, [input.sceneId]);
        throw new Error(SHOT_MOVES_LATER);
    }

    /** Scenes whose shots come from opennan.com (read only in 9a): their shot structure can't change here. */
    private async refuseServerShots(projectId: string, sceneIds: string[]): Promise<void> {
        const scenes = await this.options.mirror.loadScenes(projectId);
        for (const id of sceneIds) {
            const scene = scenes.find((s) => s.id === id);
            try {
                const shots = JSON.parse(scene?.shotBreakdown || "[]") as Array<{ readOnly?: boolean }>;
                if (Array.isArray(shots) && shots.some((shot) => shot?.readOnly === true)) throw new Error(SHOT_EDITS_REFUSED);
            } catch (error) {
                if (error instanceof Error && error.message === SHOT_EDITS_REFUSED) throw error;
            }
        }
    }

    // ── effects ──────────────────────────────────────────

    addClipEffect(projectId: string, target: EffectTarget, effectId: string, options?: AddClipEffectOptions): Promise<ClipEffect[]> {
        return this.write(projectId, "Add effect", (m) => m.addClipEffect(projectId, target, effectId, options));
    }

    updateClipEffect(projectId: string, effectRowId: string, patch: ClipEffectPatch): Promise<ClipEffect[]> {
        return this.write(projectId, "Edit effect", (m) => m.updateClipEffect(projectId, effectRowId, patch));
    }

    removeClipEffect(projectId: string, effectRowId: string): Promise<ClipEffect[]> {
        return this.write(projectId, "Remove effect", (m) => m.removeClipEffect(projectId, effectRowId));
    }

    reorderClipEffects(projectId: string, target: EffectTarget, effectRowIds: string[]): Promise<ClipEffect[]> {
        return this.write(projectId, "Reorder effects", (m) => m.reorderClipEffects(projectId, target, effectRowIds));
    }

    listEffects(kind: "effect" | "transition"): Promise<EffectDef[]> {
        return this.options.mirror.listEffects(kind);
    }

    // ── media ────────────────────────────────────────────

    async uploadFile(projectId: string, file: Blob, kind: MediaKind, options: UploadOptions = {}): Promise<UploadedMedia> {
        await this.session(projectId);
        const media = await this.options.mirror.uploadFile(projectId, file, kind, options);
        this.media.want(projectId, [media.url]);
        return media;
    }

    saveToLibrary(projectId: string, media: UploadedMedia): Promise<void> {
        return this.write(projectId, "Media", (m) => m.saveToLibrary(projectId, media), false);
    }

    async listLibrary(projectId: string): Promise<UploadedMedia[]> {
        await this.session(projectId);
        return this.options.mirror.listLibrary(projectId);
    }

    removeFromLibrary(projectId: string, url: string): Promise<void> {
        return this.write(projectId, "Media", (m) => m.removeFromLibrary(projectId, url), false);
    }

    readMedia(url: string): Promise<Blob | null> {
        return this.options.mirror.readMedia(url);
    }

    /** MediaEnvironment's synchronous lookup: an object URL for media a working copy holds on this device. */
    resolveLocalUrl(url: string): string | null {
        return this.options.mirror.resolveLocalUrl(url);
    }

    // ── catalog ──────────────────────────────────────────

    async listProjects(): Promise<ProjectSummary[]> {
        return (await this.listCloudProjects()).projects;
    }

    /** Cloud projects, most recently edited first (or the trash), one page at a time. */
    async listCloudProjects(options: { state?: "active" | "deleted"; cursor?: string | null; limit?: number } = {}): Promise<{ projects: ProjectSummary[]; nextCursor: string | null }> {
        const state = options.state ?? "active";
        const answer = await this.options.api.request<{ data?: ProjectView[]; next_cursor?: string | null }>("GET", "/v1/projects", {
            query: { order: "updated", state, limit: options.limit ?? 50, cursor: options.cursor ?? undefined },
        });
        const projects = (answer.body.data ?? []).map(summaryOf);
        if (!options.cursor) await this.options.store.put("lists", state, projects);
        return { projects, nextCursor: answer.body.next_cursor ?? null };
    }

    /** The last list read (shown offline). */
    async cachedCloudProjects(state: "active" | "deleted" = "active"): Promise<ProjectSummary[]> {
        return (await this.options.store.get<ProjectSummary[]>("lists", state)) ?? [];
    }

    async hasProject(projectId: string): Promise<boolean> {
        if (!isCloudProjectId(projectId)) return false;
        if (this.sessions.has(projectId) || (await this.options.store.get("sync", projectId))) return true;
        try {
            await this.options.api.request("GET", `/v1/projects/${encodeURIComponent(serverIdOf(projectId))}`);
            return true;
        } catch (error) {
            if (isCloudApiError(error) && (error as CloudApiError).status === 404) return false;
            throw error;
        }
    }

    async createProject(input: CreateProjectInput = {}): Promise<ProjectSummary> {
        const aspect = input.aspectRatio && (ASPECT_RATIOS as readonly string[]).includes(input.aspectRatio) ? input.aspectRatio : undefined;
        const answer = await this.options.api.request<ProjectView>("POST", "/v1/projects", { body: { name: input.name?.trim() || "Untitled project", ...(aspect ? { aspect_ratio: aspect } : {}) } });
        const summary = summaryOf(answer.body);
        if (input.aspectRatio && !aspect) {
            // A canvas the server has no preset for: Studio keeps it exactly once the project opens.
            await this.updateProject(summary.id, { aspectRatio: input.aspectRatio });
        }
        return summary;
    }

    /** Moves a project to the trash (restorable for 7 days). */
    async deleteProject(projectId: string): Promise<void> {
        await this.options.api.request("DELETE", `/v1/projects/${encodeURIComponent(serverIdOf(projectId))}`);
        await this.forget(projectId);
    }

    async restoreProject(projectId: string): Promise<ProjectSummary> {
        const answer = await this.options.api.request<ProjectView>("POST", `/v1/projects/${encodeURIComponent(serverIdOf(projectId))}/restore`);
        return summaryOf(answer.body);
    }

    async deleteProjectPermanently(projectId: string): Promise<void> {
        await this.options.api.request("DELETE", `/v1/projects/${encodeURIComponent(serverIdOf(projectId))}`, { query: { permanent: true } });
        await this.forget(projectId);
    }

    closeProject(projectId: string): void {
        const pending = this.sessions.get(projectId);
        if (!pending) return;
        this.sessions.delete(projectId);
        this.knownMedia.delete(projectId);
        const timer = this.mediaCheckTimers.get(projectId);
        if (timer !== undefined) this.clock.clearTimeout(timer);
        this.mediaCheckTimers.delete(projectId);
        // A reopen waits for this close to finish, so two sessions never share one working copy and record.
        const closing = pending.then(async (session) => {
            await session.flush().catch(() => undefined);
            await session.dispose();
            if (!this.sessions.has(projectId)) this.options.mirror.closeProject(projectId);
        }).catch(() => undefined).finally(() => {
            if (this.closing.get(projectId) === closing) this.closing.delete(projectId);
        });
        this.schedulePins(0);
        this.closing.set(projectId, closing);
    }

    private async forget(projectId: string): Promise<void> {
        const pending = this.sessions.get(projectId);
        this.sessions.delete(projectId);
        if (pending) await pending.then((s) => s.dispose()).catch(() => undefined);
        this.schedulePins(0);
        await this.options.store.delete("sync", projectId);
        try {
            await this.options.mirror.detachProject(projectId);
        } catch {
            // no working copy on this device
        }
        this.states.delete(projectId);
    }

    async storage(): Promise<StorageInfo> {
        const answer = await this.options.api.request<Record<string, unknown>>("GET", "/v1/storage");
        return storageFromJson(answer.body);
    }

    // ── moving projects ──────────────────────────────────

    /** What Save to OpenNan would upload: files, bytes, and whether they fit the storage left. */
    async planSave(local: LocalBackend, localProjectId: string): Promise<{ files: number; bytes: number; storage: StorageInfo; fits: boolean; refused: string[] }> {
        const state = await local.snapshot(localProjectId);
        const urls = [...localUrlsIn({ clips: state.clips, scenes: state.scenes, meta: state.meta, library: state.library ?? [] })];
        let bytes = 0;
        const refused: string[] = [];
        for (const url of urls) {
            if (this.media.urls.toRemote(url)) continue;
            const info = await this.options.media.describe(url);
            if (!info) continue;
            const type = cloudContentType(info.contentType, info.sizeBytes);
            if ("refused" in type) refused.push(`${info.filename}: ${type.refused}`);
            bytes += info.sizeBytes;
        }
        const storage = await this.storage();
        const left = storage.mediaLimitBytes - storage.mediaBytes;
        const room = storage.state !== "pool_full" && storage.state !== "over_quota" && (storage.mediaLimitBytes === 0 || bytes <= left);
        const dataLeft = storage.projectDataLimitBytes === 0 || storage.projectDataBytes < storage.projectDataLimitBytes;
        return { files: urls.length, bytes, storage, fits: room && dataLeft && refused.length === 0, refused };
    }

    /**
     * Save to OpenNan: uploads the project's media (deduplicated; a restart resumes from the upload map), imports the
     * project keeping its ids, sends what the import could not carry as changesets, and detaches the local project
     * (its media stays on this device as the cloud project's cache). Returns the cloud project.
     */
    async saveLocalProject(local: LocalBackend, localProjectId: string, onProgress: (p: SaveProgress) => void = () => undefined, signal?: AbortSignal): Promise<ProjectSummary> {
        onProgress({ stage: "checking", done: 0, total: 0 });
        await this.media.load();
        const state = await local.snapshot(localProjectId);
        const ids = new Map<string, string>();
        const asDoc = (s: typeof state): LocalDoc => ({ meta: s.meta, tracks: s.tracks, clips: s.clips, scenes: s.scenes, library: s.library ?? [] });
        const doc = withFreshIds(asDoc(state), undefined, true, ids);
        const plan = await this.planSave(local, localProjectId);
        if (plan.refused.length > 0) throw new Error(`Some media can't go to OpenNan: ${plan.refused.join(" ")}`);
        if (!plan.fits) throw new CloudStorageFullError(plan.bytes, plan.storage.mediaLimitBytes - plan.storage.mediaBytes);
        const urls = [...localUrlsIn(doc)];
        const assetIds: string[] = [];
        let done = 0;
        for (const url of urls) {
            signal?.throwIfAborted();
            const info = await this.options.media.describe(url);
            onProgress({ stage: "uploading", done, total: urls.length, ...(info ? { file: info.filename } : {}) });
            if (info) {
                const uploaded = await this.media.uploadNow(url, null, signal ?? new AbortController().signal, (bytes) => onProgress({ stage: "uploading", done, total: urls.length, bytes, file: info.filename }));
                assetIds.push(uploaded.assetId);
            }
            done += 1;
        }
        signal?.throwIfAborted();
        onProgress({ stage: "creating", done, total: urls.length });
        const target = encodeDoc(doc, { urls: this.media.urls });
        const body = await this.importBody(target, doc);
        const answer = await this.options.api.request<{ project: ProjectView; scene_ids: Record<string, string>; clip_ids: Record<string, string> }>("POST", "/v1/projects/import", { body: body.body });
        const serverId = answer.body.project.id;
        const projectId = cloudProjectId(serverId);
        // Ids the server replaced (one already used elsewhere): the working copy takes the server's.
        const renames = new Map<string, string>();
        for (const [from, to] of [...Object.entries(answer.body.scene_ids ?? {}), ...Object.entries(answer.body.clip_ids ?? {})]) if (from !== to) renames.set(from, to);
        const finalDoc = renames.size > 0 ? mapStrings(doc, (text) => renames.get(text) ?? text) : doc;
        onProgress({ stage: "syncing", done, total: urls.length });
        const document = await this.options.api.request<DocumentJson>("GET", `/v1/projects/${encodeURIComponent(serverId)}/document`);
        const confirmed = await ingestDocument(document.body);
        await this.options.mirror.seedProject(projectId, { meta: { ...finalDoc.meta }, tracks: finalDoc.tracks, clips: finalDoc.clips, scenes: finalDoc.scenes, library: finalDoc.library ?? [] });
        const record: SyncRecord = {
            version: 1, serverId, confirmed, pending: emptyDelta(), inflight: null, conflicts: [], snapshot: null, storm: 0, label: "Save to OpenNan", savedAt: this.clock.now(),
            toLink: [...new Set(assetIds)],
        };
        await this.options.store.put("sync", projectId, record);
        const session = await this.session(projectId);
        await session.flush();
        // Edits made to the local project while it uploaded (an agent, an AI job) move with it.
        const latest = await local.snapshot(localProjectId);
        if (normalizedProject(asDoc(latest)) !== normalizedProject(asDoc(state))) {
            const fresh = mapStrings(withFreshIds(asDoc(latest), undefined, true, ids), (text) => renames.get(text) ?? text);
            await session.write("Save to OpenNan", false, () => this.options.mirror.withoutHistory().seedProject(projectId, { meta: fresh.meta, tracks: fresh.tracks, clips: fresh.clips, scenes: fresh.scenes, library: fresh.library ?? [] }));
            await session.flush();
        }
        await local.detachProject(localProjectId);
        onProgress({ stage: "done", done, total: urls.length });
        return { ...summaryOf(answer.body.project), name: finalDoc.meta.name };
    }

    private async importBody(target: { entities: Record<string, Fields> }, doc: LocalDoc): Promise<{ body: Record<string, Json> }> {
        const project = target.entities.project ?? {};
        const projectBody: Record<string, Json> = {
            name: typeof project.name === "string" ? project.name : doc.meta.name?.trim() || "Untitled project",
            ...(typeof project.aspect_ratio === "string" ? { aspect_ratio: project.aspect_ratio } : {}),
            ...(typeof project.music_url === "string" ? { music_url: project.music_url } : {}),
        };
        const extras = await extrasJson(project);
        if (extras) projectBody.extras_json = extras;
        const tracks: Json[] = [];
        const scenes: Json[] = [];
        const clips: Json[] = [];
        let bytes = JSON.stringify(projectBody).length;
        const pick = (fields: Fields, columns: typeof CLIP_COLUMNS) => {
            const out: Record<string, Json> = {};
            for (const column of columns) if (column.col !== "effects" && column.col in fields) out[column.col] = fields[column.col]!;
            return out;
        };
        for (const [key, fields] of Object.entries(target.entities)) {
            if (entityKind(key) !== "track") continue;
            const [type, index] = entityId(key).split(":");
            const row: Record<string, Json> = { type: type!, index: Number(index) };
            for (const column of TRACK_COLUMNS) if (column.col in fields) row[column.col] = fields[column.col]!;
            tracks.push(row);
        }
        for (const scene of doc.scenes) {
            const fields = target.entities[`scene:${scene.id}`];
            if (!fields || scenes.length >= IMPORT_MAX_SCENES || localUrlsIn(fields).size > 0) continue;
            const row: Record<string, Json> = { id: scene.id, ...pick(fields, SCENE_COLUMNS) };
            const x = await extrasJson(fields);
            if (x) row.extras_json = x;
            if (Array.isArray(fields.effects) && fields.effects.length > 0) row.effects = fields.effects;
            const size = JSON.stringify(row).length;
            if (bytes + size > IMPORT_MAX_BYTES) continue;
            bytes += size;
            scenes.push(row);
        }
        const imported = new Set(scenes.map((s) => (s as { id: string }).id));
        for (const clip of doc.clips) {
            const fields = target.entities[`clip:${clip.id}`];
            if (!fields || clips.length >= IMPORT_MAX_CLIPS || localUrlsIn(fields).size > 0) continue;
            const row: Record<string, Json> = { id: clip.id, ...pick(fields, CLIP_COLUMNS) };
            if (!("track_type" in row) || !("track_index" in row) || !("start_time" in row) || !("end_time" in row) || !((row.end_time as number) > (row.start_time as number))) continue;
            if (typeof row.scene_id === "string" && !imported.has(row.scene_id)) delete row.scene_id;
            const x = await extrasJson(fields);
            if (x) row.extras_json = x;
            if (Array.isArray(fields.effects) && fields.effects.length > 0) row.effects = fields.effects;
            const size = JSON.stringify(row).length;
            if (bytes + size > IMPORT_MAX_BYTES) continue;
            bytes += size;
            clips.push(row);
        }
        return { body: { project: projectBody, scenes, timeline: { tracks, clips } } };
    }

    /** Download a local copy: a new local project with fresh ids and its media copied to this device. */
    async downloadLocalCopy(projectId: string, target: LocalBackend, onProgress: (p: SaveProgress) => void = () => undefined, signal?: AbortSignal): Promise<ProjectSummary> {
        const doc = await this.currentDoc(projectId);
        return this.copyToLocal(doc, target, `${doc.meta.name} (local copy)`, onProgress, signal);
    }

    /** Keep my version as a copy: the working copy as it was before a conflict dropped edits, as a new local project. */
    async keepConflictCopy(projectId: string, target: LocalBackend, onProgress: (p: SaveProgress) => void = () => undefined): Promise<ProjectSummary> {
        const session = await this.session(projectId);
        const snapshot = session.conflictSnapshot();
        if (!snapshot) throw new Error("There is no earlier version of this project to keep.");
        // The conflict stays listed until the person presses OK (the copy is one answer to it, not the end of it).
        return this.copyToLocal(snapshot, target, `${snapshot.meta.name} (my version)`, onProgress);
    }

    private async currentDoc(projectId: string): Promise<LocalDoc> {
        if (this.sessions.has(projectId) || (await this.options.store.get("sync", projectId))) {
            await this.session(projectId);
            const state = await this.options.mirror.snapshot(projectId);
            return { meta: state.meta, tracks: state.tracks, clips: state.clips, scenes: state.scenes, library: state.library ?? [] };
        }
        await this.media.load();
        const document = await this.options.api.request<DocumentJson>("GET", `/v1/projects/${encodeURIComponent(serverIdOf(projectId))}/document`);
        return decodeDoc(await ingestDocument(document.body), projectId, this.media.urls);
    }

    private async copyToLocal(source: LocalDoc, target: LocalBackend, name: string, onProgress: (p: SaveProgress) => void, signal?: AbortSignal): Promise<ProjectSummary> {
        const summary = await target.createProject({ name, aspectRatio: source.meta.aspectRatio });
        // Shots planned on opennan.com are the local copy's own to edit.
        const fresh = withoutReadOnlyShots(withFreshIds(source));
        const urls = new Set<string>();
        const text = JSON.stringify(fresh);
        for (const match of text.matchAll(/opennan-local:\/\/media\/[A-Za-z0-9._-]+/g)) urls.add(match[0]);
        for (const match of text.matchAll(/https?:\/\/[^\s"'<>\\)]+/g)) if (this.options.isCloudUrl(match[0])) urls.add(match[0]);
        const copied = new Map<string, string>();
        let done = 0;
        const library = new Map((fresh.library ?? []).map((m) => [m.url, m]));
        for (const url of urls) {
            signal?.throwIfAborted();
            onProgress({ stage: "downloading", done, total: urls.size });
            try {
                if (this.options.media.copyToLocal) copied.set(url, await this.options.media.copyToLocal(url, target, summary.id, signal));
                else if (isLocalUrl(url)) {
                    const blob = await this.options.mirror.readMedia(url);
                    if (blob) copied.set(url, (await target.uploadFile(summary.id, blob, kindOf(library.get(url)?.mimeType ?? blob.type))).url);
                }
            } catch (error) {
                this.options.logger?.warn("[cloud] media copy failed", error);
            }
            // A downloaded copy the cache evicted meanwhile: take the file from OpenNan again (9a.1).
            const remote = isLocalUrl(url) && !copied.has(url) ? this.media.cachedRemote(url) : null;
            if (remote && this.options.media.copyToLocal) {
                try {
                    copied.set(url, await this.options.media.copyToLocal(remote, target, summary.id, signal));
                } catch (error) {
                    this.options.logger?.warn("[cloud] media copy from OpenNan failed", error);
                }
            }
            if (isLocalUrl(url) && !copied.has(url)) {
                // A local copy may never share a file with the cloud working copy (deleting the copy would delete it).
                await target.deleteProject(summary.id).catch(() => undefined);
                throw new Error("A media file of this project could not be copied to this device. Nothing was changed; try again.");
            }
            done += 1;
        }
        const local = mapStrings(fresh, (value) => {
            let next = value;
            for (const [from, to] of copied) if (next.includes(from)) next = next.split(from).join(to);
            return next;
        });
        await target.seedProject(summary.id, { meta: { ...local.meta, name }, tracks: local.tracks, clips: local.clips, scenes: local.scenes, library: local.library ?? [] });
        onProgress({ stage: "done", done, total: urls.size });
        return { ...summary, name };
    }

    // ── diagnostics ──────────────────────────────────────

    /** Canonical JSON of a cloud project's working copy (tests). */
    async normalized(projectId: string): Promise<string> {
        const state = await this.options.mirror.snapshot(projectId);
        return normalizedProject({ meta: state.meta, tracks: state.tracks, clips: state.clips, scenes: state.scenes, library: state.library ?? [] });
    }
}

export { CloudApiError };
