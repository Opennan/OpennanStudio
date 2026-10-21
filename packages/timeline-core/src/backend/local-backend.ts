// In-memory TimelineBackend with pluggable persistence (spec §6 LocalBackend).
import type { ClipEffect, TimelineClip, TimelineData, TimelineTrack } from "../model/timeline";
import type { EffectDef, EffectTarget } from "../model/effects";
import type { SceneData } from "../timeline/canvas/types";
import type { TimelineClipCommand } from "../lib/timeline-commits";
import { createLocalTimelineHistory, type LocalTimelineHistory } from "../lib/local-timeline-history";
import { createOptimisticSplitTimelineData, optimisticTimelineClipFromInput } from "../lib/timeline-optimistic";
import { parseShotBreakdown, totalShotDuration } from "../lib/shot-utils";
import { defaultTracks } from "../timeline/scene-helpers";
import { planSourceClipSceneSplit } from "../timeline/scene-split-plan";
import { getSceneDuration, getSceneStart } from "../timeline/scene-timing";
import type { LocalPersistence, LocalProjectState } from "./persistence";
import { builtinEffectDefs } from "../looks/effects";
import type {
    AddClipEffectOptions,
    AddSceneInput,
    ClipEffectPatch,
    CreateClipInput,
    CreateProjectInput,
    MediaKind,
    MediaLibraryBackend,
    ProjectCatalog,
    ProjectMeta,
    ProjectSummary,
    RemovedTrackRef,
    SceneMove,
    TimelineBackend,
    TimelineClipCommandResult,
    TimelineClipUpdate,
    TrimSceneInput,
    UploadOptions,
    UploadedMedia,
} from "./types";

export const LOCAL_MEDIA_URL_PREFIX = "opennan-local://media/";

type HistoryState = Pick<LocalProjectState, "tracks" | "clips" | "scenes">;
/** A history snapshot plus a per-entry stamp, so a write that changed nothing is still one entry. */
type StampedHistoryState = HistoryState & { stamp: number };

export interface LocalBackendOptions {
    persistence: LocalPersistence;
    idFactory?: () => string;
    effectCatalog?: EffectDef[];
    /** Defaults to URL.createObjectURL when the runtime has it. */
    createObjectUrl?(blob: Blob): string;
    /** Defaults to URL.revokeObjectURL when the runtime has it. */
    revokeObjectUrl?(url: string): void;
    historyLimit?: number;
    /** Clock for createdAt/updatedAt. Defaults to Date.now. */
    now?(): number;
}

/** createProject's name when none is given; the web new-project dialog shows the same placeholder. */
export const DEFAULT_PROJECT_NAME = "Untitled project";

function clone<T>(value: T): T {
    return value === undefined ? value : structuredClone(value);
}

function toTimecode(seconds: number): string {
    const total = Math.max(0, seconds);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = (total % 60).toFixed(3).padStart(6, "0");
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${s}`;
}

function parseRawShots(raw: string | null | undefined): unknown[] {
    try {
        const parsed = JSON.parse(raw || "[]");
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

function mimeFallback(kind: MediaKind): string {
    return kind === "video" ? "video/mp4" : kind === "image" ? "image/png" : "audio/mpeg";
}

/** Every opennan-local:// URL a project references (clips, scenes, media bin). */
const LOCAL_URL_IN_TEXT = new RegExp(`${LOCAL_MEDIA_URL_PREFIX.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}[A-Za-z0-9._-]+`, "g");

function localMediaUrls(project: LocalProjectState): string[] {
    const urls = new Set<string>();
    const add = (value: string | null | undefined) => {
        if (value && value.startsWith(LOCAL_MEDIA_URL_PREFIX)) urls.add(value);
    };
    for (const clip of project.clips) {
        add(clip.mediaUrl);
        add(clip.thumbnailUrl);
    }
    for (const scene of project.scenes) {
        add(scene.videoUrl);
        add(scene.sourceVideoUrl);
        add(scene.startImageUrl);
        add(scene.audioUrl);
        // A scene's shots carry their own media (storyboard panels, shot videos) inside their JSON.
        if (typeof scene.shotBreakdown === "string" && scene.shotBreakdown.includes(LOCAL_MEDIA_URL_PREFIX)) {
            for (const match of scene.shotBreakdown.matchAll(LOCAL_URL_IN_TEXT)) add(match[0]);
        }
        // Its drawn storyboard (phase 9c): each sheet and its panels.
        for (const sheet of scene.storyboardSheets ?? []) {
            add(sheet?.imageUrl);
            for (const panel of sheet?.panels ?? []) add(panel?.imageUrl);
        }
    }
    for (const media of project.library ?? []) add(media.url);
    return [...urls];
}

/** Blob ids the project owns: every upload, plus every local URL it references. */
function ownedBlobIds(project: LocalProjectState): Set<string> {
    const ids = new Set(project.uploads ?? []);
    for (const url of localMediaUrls(project)) ids.add(url.slice(LOCAL_MEDIA_URL_PREFIX.length));
    return ids;
}

function summarize(project: LocalProjectState): ProjectSummary {
    const sceneEnd = project.scenes.reduce(
        (end, scene, index) => Math.max(end, getSceneStart(scene, project.scenes, index) + getSceneDuration(scene)),
        0,
    );
    const createdAt = project.createdAt ?? 0;
    return {
        id: project.meta.id,
        name: project.meta.name,
        aspectRatio: project.meta.aspectRatio,
        createdAt,
        updatedAt: project.updatedAt ?? createdAt,
        durationSeconds: project.clips.reduce((end, clip) => Math.max(end, clip.endTime), sceneEnd),
        mediaCount: project.library?.length ?? 0,
        kind: "local",
    };
}

export function createEmptyProject(projectId: string): LocalProjectState {
    return {
        meta: { id: projectId, name: "Untitled", musicUrl: null, musicVolume: 1, aspectRatio: "16:9" },
        tracks: clone(defaultTracks),
        clips: [],
        scenes: [],
    };
}

export class LocalBackend implements TimelineBackend, ProjectCatalog, MediaLibraryBackend {
    readonly id = "local";
    private readonly projects = new Map<string, LocalProjectState>();
    private readonly histories = new Map<string, LocalTimelineHistory<StampedHistoryState>>();
    // Own property on withoutHistory() views only; every other field is read
    // through the prototype, so a view shares projects, histories and persistence.
    private recordsHistory = true;
    private historyStamp = 0;
    private readonly loading = new Map<string, Promise<LocalProjectState>>();
    private readonly mediaUrls = new Map<string, string>();

    constructor(private readonly options: LocalBackendOptions) {}

    /** Sync lookup used by MediaEnvironment.resolveMediaUrl. */
    resolveLocalUrl(url: string): string | null {
        return this.mediaUrls.get(url) ?? null;
    }

    /** TimelineBackend.withoutHistory: same projects, writes are not undo steps. */
    withoutHistory(): LocalBackend {
        const view = Object.create(this) as LocalBackend;
        view.recordsHistory = false;
        return view;
    }

    /**
     * Replace a project's state (fixtures, sample projects, new projects). Clears its undo
     * history. An existing project keeps its uploads (so deleting it still deletes their
     * blobs) and its creation time.
     */
    async seedProject(
        projectId: string,
        state: Partial<HistoryState> & { meta?: Partial<Omit<ProjectMeta, "id">>; library?: UploadedMedia[] },
    ): Promise<void> {
        const existing = this.projects.get(projectId) ?? await this.options.persistence.loadProject(projectId);
        const base = createEmptyProject(projectId);
        const project: LocalProjectState = {
            meta: { ...base.meta, ...state.meta, id: projectId },
            tracks: clone(state.tracks ?? base.tracks),
            clips: clone(state.clips ?? []).map((clip) => ({ ...clip, projectId })),
            scenes: clone(state.scenes ?? []),
            library: clone(state.library ?? []),
            ...(existing?.uploads ? { uploads: [...existing.uploads] } : {}),
            ...(existing?.createdAt !== undefined ? { createdAt: existing.createdAt } : {}),
        };
        this.projects.set(projectId, project);
        this.histories.delete(projectId);
        await this.save(projectId, project);
        await this.hydrateMedia(project);
    }

    // ── project catalog (ProjectCatalog) ──────────────────
    async listProjects(): Promise<ProjectSummary[]> {
        const persistence = this.options.persistence;
        if (!persistence.listProjects) throw new Error("This persistence cannot list projects");
        const stored = await persistence.listProjects();
        return stored
            .map((state) => summarize(this.projects.get(state.meta.id) ?? state))
            .sort((a, b) => b.updatedAt - a.updatedAt);
    }

    async hasProject(projectId: string): Promise<boolean> {
        if (this.projects.has(projectId)) return true;
        return (await this.options.persistence.loadProject(projectId)) !== null;
    }

    async createProject(input: CreateProjectInput = {}): Promise<ProjectSummary> {
        const projectId = this.newId();
        await this.seedProject(projectId, {
            meta: { name: input.name?.trim() || DEFAULT_PROJECT_NAME, aspectRatio: input.aspectRatio ?? "16:9" },
        });
        return summarize(this.projects.get(projectId) as LocalProjectState);
    }

    closeProject(projectId: string): void {
        const project = this.projects.get(projectId);
        if (!project) return;
        // A write in flight still lands: mutate() holds the project object and saves it.
        for (const id of ownedBlobIds(project)) this.releaseObjectUrl(`${LOCAL_MEDIA_URL_PREFIX}${id}`);
        this.projects.delete(projectId);
        this.histories.delete(projectId);
    }

    async deleteProject(projectId: string): Promise<void> {
        const persistence = this.options.persistence;
        if (!persistence.deleteProject) throw new Error("This persistence cannot delete projects");
        const project = this.projects.get(projectId) ?? await persistence.loadProject(projectId);
        if (project) {
            for (const id of ownedBlobIds(project)) {
                this.releaseObjectUrl(`${LOCAL_MEDIA_URL_PREFIX}${id}`);
                await persistence.deleteBlob?.(id);
            }
        }
        this.projects.delete(projectId);
        this.histories.delete(projectId);
        await persistence.deleteProject(projectId);
    }

    /**
     * Removes a project's document but keeps its media blobs, and returns their ids (phase 9a: Save to OpenNan moves
     * a project to the cloud, whose working copy keeps using the same blobs).
     */
    async detachProject(projectId: string): Promise<string[]> {
        const persistence = this.options.persistence;
        if (!persistence.deleteProject) throw new Error("This persistence cannot delete projects");
        const project = this.projects.get(projectId) ?? await persistence.loadProject(projectId);
        const ids = project ? [...ownedBlobIds(project)] : [];
        if (project) for (const id of ids) this.releaseObjectUrl(`${LOCAL_MEDIA_URL_PREFIX}${id}`);
        this.projects.delete(projectId);
        this.histories.delete(projectId);
        await persistence.deleteProject(projectId);
        return ids;
    }

    /** A copy of the whole project state: document, media bin, and upload ids. */
    async snapshot(projectId: string): Promise<LocalProjectState> {
        return clone(await this.project(projectId));
    }

    // ── load ──────────────────────────────────────────────
    async loadProject(projectId: string): Promise<ProjectMeta> {
        return clone((await this.project(projectId)).meta);
    }

    async loadTimeline(projectId: string): Promise<TimelineData> {
        return this.timelineOf(projectId, await this.project(projectId));
    }

    async loadScenes(projectId: string): Promise<SceneData[]> {
        return clone((await this.project(projectId)).scenes);
    }

    async updateProject(projectId: string, patch: Partial<Omit<ProjectMeta, "id">>): Promise<ProjectMeta> {
        const project = await this.project(projectId);
        project.meta = { ...project.meta, ...patch, id: project.meta.id };
        await this.save(projectId, project);
        return clone(project.meta);
    }

    // ── clips ─────────────────────────────────────────────
    createClips(projectId: string, inputs: CreateClipInput[]): Promise<TimelineClip[]> {
        return this.mutate(projectId, (p) => {
            const created = inputs.map((input) => optimisticTimelineClipFromInput(input as Record<string, any>, projectId, this.newId()));
            p.clips = [...p.clips, ...created];
            return created;
        });
    }

    updateClips(projectId: string, updates: TimelineClipUpdate[]): Promise<TimelineClip[]> {
        return this.mutate(projectId, (p) => {
            for (const update of updates) {
                if (!p.clips.some((clip) => clip.id === update.clipId)) throw new Error(`Clip not found: ${update.clipId}`);
            }
            const byId = new Map(updates.map((update) => [update.clipId, update]));
            const changed: TimelineClip[] = [];
            p.clips = p.clips.map((clip) => {
                const update = byId.get(clip.id);
                if (!update) return clip;
                const { clipId: _clipId, ...patch } = update;
                const next = { ...clip, ...patch };
                changed.push(next);
                return next;
            });
            return changed;
        });
    }

    deleteClips(projectId: string, clipIds: string[]): Promise<void> {
        return this.mutate(projectId, (p) => {
            const remove = new Set(clipIds);
            p.clips = p.clips.filter((clip) => !remove.has(clip.id));
        });
    }

    /** Copies of effect rows for a new owner (duplicate, split): fresh row ids, owner fields set. */
    private copyEffectRows(rows: ClipEffect[], owner: { clipId: string } | { sceneId: string }): ClipEffect[] {
        return rows.map((row) => ({
            ...row,
            id: this.newId(),
            clipId: "clipId" in owner ? owner.clipId : null,
            sceneId: "sceneId" in owner ? owner.sceneId : null,
        }));
    }

    splitClips(projectId: string, clipIds: string[], atSeconds: number): Promise<TimelineClip[]> {
        return this.mutate(projectId, (p) => {
            const result = createOptimisticSplitTimelineData({ tracks: p.tracks, clips: p.clips, canUndo: false, canRedo: false }, clipIds, atSeconds);
            if (!result) throw new Error("Nothing to split at this time");
            const idMap = new Map(result.createdClips.map((clip) => [clip.id, this.newId()]));
            const clips = result.timeline.clips.map((clip) => {
                const id = idMap.get(clip.id);
                if (!id) return clip;
                return { ...clip, id, ...(clip.effects ? { effects: this.copyEffectRows(clip.effects, { clipId: id }) } : {}) };
            });
            p.clips = clips;
            const createdIds = new Set(idMap.values());
            const splitIds = new Set(clipIds);
            const out: TimelineClip[] = [];
            for (let i = 0; i < clips.length - 1; i += 1) {
                if (splitIds.has(clips[i].id) && createdIds.has(clips[i + 1].id)) out.push(clips[i], clips[i + 1]);
            }
            return out;
        });
    }

    commitCommand(projectId: string, command: TimelineClipCommand): Promise<TimelineClipCommandResult> {
        return this.mutate(projectId, (p) => {
            const remove = new Set(command.deleteIds);
            const byId = new Map(command.updates.map((update) => [update.clipId, update]));
            const updated: TimelineClip[] = [];
            p.clips = p.clips.filter((clip) => !remove.has(clip.id)).map((clip) => {
                const update = byId.get(clip.id);
                if (!update) return clip;
                const { clipId: _clipId, ...patch } = update;
                const next = { ...clip, ...patch };
                updated.push(next);
                return next;
            });
            const created = command.creates.map((input) => optimisticTimelineClipFromInput(input as Record<string, any>, projectId, this.newId()));
            p.clips = [...p.clips, ...created];
            return { created, updated };
        });
    }

    updateTracks(projectId: string, tracks: TimelineTrack[], removed: RemovedTrackRef[] = []): Promise<TimelineTrack[]> {
        return this.mutate(projectId, (p) => {
            p.tracks = clone(tracks);
            if (removed.length > 0) {
                p.clips = p.clips.filter((clip) => !removed.some((ref) => ref.type === clip.trackType && ref.index === clip.trackIndex));
            }
            return p.tracks;
        });
    }

    async undo(projectId: string, steps = 1): Promise<TimelineData> {
        return this.travel(projectId, "undo", steps);
    }

    async redo(projectId: string, steps = 1): Promise<TimelineData> {
        return this.travel(projectId, "redo", steps);
    }

    // ── scenes ────────────────────────────────────────────
    moveScenes(projectId: string, moves: SceneMove[]): Promise<SceneData[]> {
        return this.mutate(projectId, (p) => moves.map((move) => {
            const scene = this.scene(p, move.sceneId);
            scene.timelinePositionSeconds = move.timelinePositionSeconds;
            if (move.trackIndex !== undefined) scene.trackIndex = move.trackIndex;
            return scene;
        }));
    }

    addScene(projectId: string, input: AddSceneInput): Promise<SceneData> {
        return this.mutate(projectId, (p) => {
            const duration = input.duration ?? 5;
            for (const scene of p.scenes) if (scene.order > input.afterOrder) scene.order += 1;
            const scene: SceneData = {
                id: this.newId(),
                order: input.afterOrder + 1,
                caption: input.caption ?? "",
                startTime: toTimecode(0),
                endTime: toTimecode(duration),
                startImageUrl: input.startImageUrl ?? null,
                endImageUrl: null,
                videoUrl: input.videoUrl ?? null,
                sourceVideoUrl: input.sourceVideoUrl ?? null,
                status: "planned",
                transition: "cut",
                cardType: input.cardType ?? null,
                duration,
                frameConsistencyScore: null,
                audioUrl: null,
                audioText: null,
                cardConfig: null,
                shotBreakdown: "[]",
                timelinePositionSeconds: input.timelinePositionSeconds,
                trackIndex: input.trackIndex ?? 1,
            };
            p.scenes.push(scene);
            return scene;
        });
    }

    deleteScene(projectId: string, sceneId: string): Promise<void> {
        return this.mutate(projectId, (p) => {
            const scene = this.scene(p, sceneId);
            p.scenes = p.scenes.filter((s) => s.id !== sceneId);
            for (const s of p.scenes) if (s.order > scene.order) s.order -= 1;
        });
    }

    duplicateScene(projectId: string, sceneId: string): Promise<SceneData> {
        return this.mutate(projectId, (p) => {
            const source = this.scene(p, sceneId);
            const track = Number(source.trackIndex || 1);
            const trackEnd = p.scenes.reduce((end, s, i) => (
                Number(s.trackIndex || 1) === track ? Math.max(end, getSceneStart(s, p.scenes, i) + getSceneDuration(s)) : end
            ), 0);
            for (const s of p.scenes) if (s.order > source.order) s.order += 1;
            const id = this.newId();
            const copy: SceneData = { ...clone(source), id, order: source.order + 1, timelinePositionSeconds: Math.max(0.001, trackEnd) };
            if (copy.effects) copy.effects = this.copyEffectRows(copy.effects, { sceneId: id });
            p.scenes.push(copy);
            return copy;
        });
    }

    splitScene(projectId: string, sceneId: string, atSeconds: number): Promise<SceneData[]> {
        return this.mutate(projectId, (p) => {
            const plan = planSourceClipSceneSplit(p.scenes, sceneId, atSeconds, { tempSceneId: this.newId(), fallbackCaption: "" });
            if (!plan) throw new Error("Cannot split the scene at this time");
            const source = this.scene(p, sceneId);
            for (const s of p.scenes) if (s.order > source.order) s.order += 1;
            Object.assign(source, plan.firstScene, { id: source.id });
            // List order is timeline order for auto-placed scenes (scene-position.ts
            // getSceneTimelineStart), so the new scene goes right after its source.
            const second: SceneData = plan.secondScene.effects
                ? { ...plan.secondScene, effects: this.copyEffectRows(plan.secondScene.effects, { sceneId: plan.secondScene.id }) }
                : plan.secondScene;
            p.scenes.splice(p.scenes.indexOf(source) + 1, 0, second);
            return [source, second];
        });
    }

    trimScene(projectId: string, input: TrimSceneInput): Promise<SceneData> {
        return this.mutate(projectId, (p) => {
            const scene = this.scene(p, input.sceneId);
            scene.duration = input.duration;
            scene.cardConfig = input.cardConfig;
            return scene;
        });
    }

    setSceneDuration(projectId: string, sceneId: string, seconds: number): Promise<SceneData> {
        return this.mutate(projectId, (p) => {
            const scene = this.scene(p, sceneId);
            scene.duration = seconds;
            // Generative scenes take their width from the shot sum (scene-timing.ts getSceneDuration),
            // so retime the shots proportionally, as the server does (nle-timeline.tsx:1498-1500)
            // with the same rounding the client predicts (nle-timeline.tsx:1429-1444).
            const shots = parseRawShots(scene.shotBreakdown) as Array<{ duration?: unknown }>;
            const total = shots.reduce((sum, shot) => sum + (Number(shot?.duration) || 0), 0);
            if (total > 0.01) {
                const k = seconds / total;
                scene.shotBreakdown = JSON.stringify(
                    shots.map((shot) => ({ ...shot, duration: Math.round((Number(shot?.duration) || 0) * k * 1000) / 1000 })),
                );
            }
            return scene;
        });
    }

    updateScene(projectId: string, sceneId: string, patch: Partial<Omit<SceneData, "id">>): Promise<SceneData> {
        return this.mutate(projectId, (p) => Object.assign(this.scene(p, sceneId), patch, { id: sceneId }));
    }

    updateScenes(projectId: string, updates: Array<{ sceneId: string; patch: Partial<Omit<SceneData, "id">> }>): Promise<SceneData[]> {
        return this.mutate(projectId, (p) => updates.map(({ sceneId, patch }) => Object.assign(this.scene(p, sceneId), patch, { id: sceneId })));
    }

    reorderScenes(projectId: string, sceneIds: string[]): Promise<SceneData[]> {
        return this.mutate(projectId, (p) => {
            const reordered = sceneIds.map((id, index) => {
                const scene = this.scene(p, id);
                scene.order = index;
                return scene;
            });
            // Layout, playback, and export walk the list (scene-position.ts getSceneTimelineStart),
            // and OpenNan lists scenes by `order`: sort the list so the reorder reaches them.
            p.scenes.sort((x, y) => x.order - y.order);
            return reordered;
        });
    }

    reorderShots(projectId: string, sceneId: string, order: number[]): Promise<SceneData> {
        return this.mutate(projectId, (p) => {
            const scene = this.scene(p, sceneId);
            const shots = parseRawShots(scene.shotBreakdown);
            const valid = order.length === shots.length && new Set(order).size === shots.length
                && order.every((i) => Number.isInteger(i) && i >= 0 && i < shots.length);
            if (!valid) throw new Error("Invalid shot order");
            scene.shotBreakdown = JSON.stringify(order.map((i) => shots[i]));
            return scene;
        });
    }

    deleteShot(projectId: string, sceneId: string, shotIndex: number): Promise<SceneData> {
        return this.mutate(projectId, (p) => {
            const scene = this.scene(p, sceneId);
            const shots = parseRawShots(scene.shotBreakdown);
            if (shotIndex < 0 || shotIndex >= shots.length) throw new Error(`Shot not found: ${shotIndex}`);
            shots.splice(shotIndex, 1);
            scene.shotBreakdown = JSON.stringify(shots);
            const total = totalShotDuration(parseShotBreakdown(scene.shotBreakdown));
            if (total > 0) scene.duration = total;
            return scene;
        });
    }

    // ── effects ───────────────────────────────────────────
    /** The clip or scene that owns the target's stack. */
    private effectOwner(project: LocalProjectState, target: EffectTarget): TimelineClip | SceneData {
        if (target.clipId) return this.clip(project, target.clipId);
        if (target.sceneId) return this.scene(project, target.sceneId);
        throw new Error("An effect target needs a clipId or a sceneId");
    }

    /** Owner of a stack row, searched on clips and scenes. */
    private rowOwner(project: LocalProjectState, effectRowId: string): TimelineClip | SceneData {
        const owner = project.clips.find((c) => c.effects?.some((e) => e.id === effectRowId))
            ?? project.scenes.find((sc) => sc.effects?.some((e) => e.id === effectRowId));
        if (!owner?.effects) throw new Error(`Effect not found: ${effectRowId}`);
        return owner;
    }

    private static ordered(rows: ClipEffect[]): ClipEffect[] {
        return rows.map((row, order) => ({ ...row, order }));
    }

    addClipEffect(projectId: string, target: EffectTarget, effectId: string, options: AddClipEffectOptions = {}): Promise<ClipEffect[]> {
        return this.mutate(projectId, (p) => {
            const owner = this.effectOwner(p, target);
            const rows = [...(owner.effects ?? [])].sort((a, b) => a.order - b.order);
            const index = Math.max(0, Math.min(rows.length, Math.trunc(options.index ?? rows.length)));
            rows.splice(index, 0, {
                id: this.newId(),
                clipId: target.clipId ?? null,
                sceneId: target.clipId ? null : target.sceneId ?? null,
                effectId,
                order: index,
                paramsJson: options.paramsJson ?? null,
                enabled: true,
                ownerScope: "project",
            });
            const stored = LocalBackend.ordered(rows);
            owner.effects = stored;
            return clone(stored);
        });
    }

    updateClipEffect(projectId: string, effectRowId: string, patch: ClipEffectPatch): Promise<ClipEffect[]> {
        return this.mutate(projectId, (p) => {
            const owner = this.rowOwner(p, effectRowId);
            const rows = owner.effects!.map((e) => (e.id === effectRowId ? { ...e, ...patch } : e));
            owner.effects = rows;
            return clone(rows);
        });
    }

    removeClipEffect(projectId: string, effectRowId: string): Promise<ClipEffect[]> {
        return this.mutate(projectId, (p) => {
            const owner = this.rowOwner(p, effectRowId);
            const rows = LocalBackend.ordered([...owner.effects!].sort((a, b) => a.order - b.order).filter((e) => e.id !== effectRowId));
            owner.effects = rows;
            return clone(rows);
        });
    }

    reorderClipEffects(projectId: string, target: EffectTarget, effectRowIds: string[]): Promise<ClipEffect[]> {
        return this.mutate(projectId, (p) => {
            const owner = this.effectOwner(p, target);
            const rows = owner.effects ?? [];
            const byId = new Map(rows.map((row) => [row.id, row]));
            if (effectRowIds.length !== rows.length || effectRowIds.some((id) => !byId.has(id)) || new Set(effectRowIds).size !== rows.length) {
                throw new Error("reorderClipEffects needs every row of the stack exactly once");
            }
            const ordered = LocalBackend.ordered(effectRowIds.map((id) => byId.get(id)!));
            owner.effects = ordered;
            return clone(ordered);
        });
    }

    /** The configured catalog plus the built-in looks effects (built-ins win on id clashes). */
    async listEffects(kind: "effect" | "transition"): Promise<EffectDef[]> {
        const configured = (this.options.effectCatalog ?? []).filter((effect) => effect.kind === kind);
        if (kind !== "effect") return clone(configured);
        const builtins = builtinEffectDefs();
        const ids = new Set(builtins.map((d) => d.id));
        return clone([...builtins, ...configured.filter((d) => !ids.has(d.id))]);
    }

    // ── media ─────────────────────────────────────────────
    async uploadFile(projectId: string, file: Blob, kind: MediaKind, options: UploadOptions = {}): Promise<UploadedMedia> {
        if (options.signal?.aborted) throw new DOMException("Upload aborted", "AbortError");
        const project = await this.project(projectId);
        const id = this.newId();
        await this.options.persistence.putBlob(id, file);
        project.uploads = [...(project.uploads ?? []), id];
        await this.save(projectId, project);
        options.onProgress?.(100);
        const url = `${LOCAL_MEDIA_URL_PREFIX}${id}`;
        this.registerObjectUrl(url, file);
        const name = (file as Blob & { name?: string }).name ?? `${kind}-${id}`;
        return { url, name, size: file.size, mimeType: file.type || mimeFallback(kind) };
    }

    // ── media library (MediaLibraryBackend) ───────────────
    async saveToLibrary(projectId: string, media: UploadedMedia): Promise<void> {
        const project = await this.project(projectId);
        project.library = [...(project.library ?? []).filter((item) => item.url !== media.url), clone(media)];
        await this.save(projectId, project);
    }

    async listLibrary(projectId: string): Promise<UploadedMedia[]> {
        return clone((await this.project(projectId)).library ?? []);
    }

    async removeFromLibrary(projectId: string, url: string): Promise<void> {
        const project = await this.project(projectId);
        project.library = (project.library ?? []).filter((item) => item.url !== url);
        await this.save(projectId, project);
    }

    async readMedia(url: string): Promise<Blob | null> {
        if (!url.startsWith(LOCAL_MEDIA_URL_PREFIX)) return null;
        return this.options.persistence.getBlob(url.slice(LOCAL_MEDIA_URL_PREFIX.length));
    }

    // ── internals ─────────────────────────────────────────
    private newId(): string {
        const id = (this.options.idFactory ?? (() => globalThis.crypto.randomUUID()))();
        if (/^(temp-|optimistic-)/.test(id)) throw new Error(`LocalBackend id "${id}" uses a reserved prefix`);
        return id;
    }

    private history(projectId: string): LocalTimelineHistory<StampedHistoryState> {
        let history = this.histories.get(projectId);
        if (!history) {
            history = createLocalTimelineHistory<StampedHistoryState>(this.options.historyLimit ?? 50);
            this.histories.set(projectId, history);
        }
        return history;
    }

    private async project(projectId: string): Promise<LocalProjectState> {
        const cached = this.projects.get(projectId);
        if (cached) return cached;
        let pending = this.loading.get(projectId);
        if (!pending) {
            pending = (async () => {
                const stored = await this.options.persistence.loadProject(projectId);
                const project = stored ?? createEmptyProject(projectId);
                if (!stored) await this.save(projectId, project);
                this.projects.set(projectId, project);
                await this.hydrateMedia(project);
                return project;
            })();
            this.loading.set(projectId, pending);
        }
        try {
            return await pending;
        } finally {
            this.loading.delete(projectId);
        }
    }

    private async mutate<T>(projectId: string, change: (project: LocalProjectState) => T): Promise<T> {
        const project = await this.project(projectId);
        const before: HistoryState = clone({ tracks: project.tracks, clips: project.clips, scenes: project.scenes });
        const result = change(project);
        if (this.recordsHistory) {
            // One write call = one undo step, even when nothing changed (TimelineBackend.undo):
            // record() skips before === after (local-timeline-history.ts record), so the two
            // snapshots carry different stamps. travel() restores only tracks/clips/scenes.
            const stamp = ++this.historyStamp;
            this.history(projectId).record(
                { ...before, stamp: -stamp },
                { tracks: project.tracks, clips: project.clips, scenes: project.scenes, stamp },
            );
        }
        await this.save(projectId, project);
        return clone(result);
    }

    private async travel(projectId: string, direction: "undo" | "redo", steps: number): Promise<TimelineData> {
        const project = await this.project(projectId);
        const history = this.history(projectId);
        const snapshot = direction === "undo" ? history.undo(steps) : history.redo(steps);
        if (!snapshot) throw new Error(direction === "undo" ? "Nothing to undo" : "Nothing to redo");
        project.tracks = snapshot.tracks;
        project.clips = snapshot.clips;
        project.scenes = snapshot.scenes;
        await this.save(projectId, project);
        return this.timelineOf(projectId, project);
    }

    /** Every persisted write goes through here so project lists can sort by last edit. */
    private async save(projectId: string, project: LocalProjectState): Promise<void> {
        const now = (this.options.now ?? Date.now)();
        project.createdAt ??= now;
        project.updatedAt = now;
        await this.options.persistence.saveProject(projectId, project);
    }

    private timelineOf(projectId: string, project: LocalProjectState): TimelineData {
        const history = this.history(projectId);
        return clone({ tracks: project.tracks, clips: project.clips, canUndo: history.canUndo(), canRedo: history.canRedo() });
    }

    private scene(project: LocalProjectState, sceneId: string): SceneData {
        const scene = project.scenes.find((s) => s.id === sceneId);
        if (!scene) throw new Error(`Scene not found: ${sceneId}`);
        return scene;
    }

    private clip(project: LocalProjectState, clipId: string): TimelineClip {
        const clip = project.clips.find((c) => c.id === clipId);
        if (!clip) throw new Error(`Clip not found: ${clipId}`);
        return clip;
    }

    private registerObjectUrl(url: string, blob: Blob): void {
        const create = this.options.createObjectUrl
            ?? (typeof URL !== "undefined" && typeof URL.createObjectURL === "function" ? (b: Blob) => URL.createObjectURL(b) : null);
        if (create) this.mediaUrls.set(url, create(blob));
    }

    private releaseObjectUrl(url: string): void {
        const objectUrl = this.mediaUrls.get(url);
        if (!objectUrl) return;
        this.mediaUrls.delete(url);
        const revoke = this.options.revokeObjectUrl
            ?? (typeof URL !== "undefined" && typeof URL.revokeObjectURL === "function" ? (u: string) => URL.revokeObjectURL(u) : null);
        revoke?.(objectUrl);
    }

    /** Object URLs over the stored Blobs. getBlob returns disk-backed Blobs, so nothing is read into memory here. */
    private async hydrateMedia(project: LocalProjectState): Promise<void> {
        const urls = localMediaUrls(project).filter((url) => !this.mediaUrls.has(url));
        for (const url of urls) {
            const blob = await this.options.persistence.getBlob(url.slice(LOCAL_MEDIA_URL_PREFIX.length));
            if (blob) this.registerObjectUrl(url, blob);
        }
    }
}
