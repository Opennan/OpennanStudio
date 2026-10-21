// An in-process stand-in for opennan.com's cloud project routes, for the sync engine's unit tests (fast and
// deterministic under a fake clock): GET /document (ETag, 304), POST /changes (If-Match 412 with details.revision,
// Idempotency-Key replay, entity_missing / clip_locked refusals with details, scene order resequenced, touched rows
// answered), plus knobs to act as another device, fail the next call, or drop an answer after applying it; phase 9c:
// each scene's shots_version and storyboard_sheets, shot writes (shots_version / clear_shots, kept snapshots, 409
// scene_busy / shots_version_unknown), a pipeline drawing a storyboard, and project.final_video_url. The
// HTTP fake server in @opennan/provider-opennan/testing covers the full contract for integration tests.
import { CloudApiError, type CloudApi, type CloudMethod, type CloudRequest, type CloudResponse } from "./api";
import type { Json } from "./json";
import { canonical, clone } from "./json";

export const CLIP_DEFAULTS: Record<string, Json> = {
    media_url: null, media_type: "uploaded", scene_id: null, label: null, thumbnail_url: null, locked: false, volume: 1, audio_pan: 0, audio_pitch: 0, audio_eq: "none",
    audio_denoise: false, audio_normalize: false, playback_speed: 1, speed_ramp: "none", reverse_playback: false, freeze_frame: false, fade_in_duration: 0,
    fade_out_duration: 0, transition_type: "none", transition_duration: 0, opacity: 1, scale: 1, position_x: 0.5, position_y: 0.5, horizontal_flip: false,
    vertical_flip: false, crop_left: 0, crop_right: 0, crop_top: 0, crop_bottom: 0, brightness: 0, contrast: 1, saturation: 1, visual_filter: "none", motion_preset: "none",
    blur_strength: 0, chroma_key_enabled: false, chroma_key_color: "0x00FF00", chroma_key_similarity: 0.1, chroma_key_blend: 0, blend_mode: "normal", mosaic_strength: 0,
    rotation_degrees: 0, keyframes_json: null, text_content: null, text_style: null, trim_start: null, trim_end: null, remotion_template_id: null, remotion_props_json: null,
    transition_params_json: null, custom_graphic_id: null, extras_json: null, effects: [],
};

export const SCENE_DEFAULTS: Record<string, Json> = {
    order: 0, caption: "", card_type: "ai_video", status: "pending", duration: 5, timeline_position_seconds: 0, track_index: 1, transition: null, visual_transition: "none",
    visual_transition_duration: 0, scene_location: null, objects_in_scene: [], overlay_text: null, audio_text: null, music_enabled: false, start_image_url: null,
    end_image_url: null, video_url: null, audio_url: null, source_video_url: null, background_url: null, shots: [], start_time: "00:00:00,000", end_time: "00:00:05,000",
    card_config: null, fit_mode: null, transform_scale: null, transform_offset_x: null, transform_offset_y: null, source_width: null, source_height: null, extras_json: null,
    effects: [], storyboard_sheets: [],
};

/** An opaque version of a scene's shots and sheets (the scene id is part of it), like the server's sv_<24 hex>. */
export function memoryShotsVersion(sceneId: string, row: Row): string {
    const text = `${sceneId}\n${canonical({ shots: row.shots ?? [], sheets: row.storyboard_sheets ?? [] })}`;
    let a = 0x811c9dc5;
    let b = 0x01000193;
    let c = 0x9e3779b9;
    for (let i = 0; i < text.length; i++) {
        const ch = text.charCodeAt(i);
        a = Math.imul(a ^ ch, 0x01000193) >>> 0;
        b = Math.imul(b ^ ch, 0x5bd1e995) >>> 0;
        c = Math.imul(c ^ ch, 0x85ebca6b) >>> 0;
    }
    return `sv_${a.toString(16).padStart(8, "0")}${b.toString(16).padStart(8, "0")}${c.toString(16).padStart(8, "0")}`;
}

export const PROJECT_DEFAULTS: Record<string, Json> = {
    name: "Untitled", description: null, aspect_ratio: "16:9", music_url: null, music_filename: null, music_volume: 1, default_audio_on: false, extras_json: null,
};

type Row = Record<string, Json>;

interface MemoryProject {
    id: string;
    revision: number;
    project: Row;
    tracks: Row[];
    clips: Map<string, Row>;
    scenes: Map<string, Row>;
    answers: Map<string, { hash: string; answer: Json }>;
    deleted: boolean;
}

export interface MemoryServerCall {
    method: string;
    path: string;
    headers: Record<string, string>;
    body?: unknown;
    status: number;
}

export class MemoryServer {
    readonly projects = new Map<string, MemoryProject>();
    readonly calls: MemoryServerCall[] = [];
    private failures: Array<{ status: number; code: string; details?: Record<string, unknown>; retryAfterSeconds?: number; path?: RegExp }> = [];
    private dropAnswers = 0;
    private storms = 0;
    /** Kept shot sets per scene (scene_shot_snapshots), by version. */
    private readonly snapshots = new Map<string, Map<string, { shots: Json; sheets: Json }>>();
    /** Scenes a tool is writing now (shot writes answer 409 scene_busy). */
    readonly busyScenes = new Set<string>();
    offline = false;
    private serial = 0;

    api(): CloudApi {
        return { baseUrl: "memory://opennan", request: (method, path, request) => this.request(method, path, request) };
    }

    createProject(id: string, name = "Cloud project"): MemoryProject {
        const project: MemoryProject = {
            id, revision: 0, project: { ...PROJECT_DEFAULTS, name }, tracks: [
                { type: "video", index: 1, label: "V1", muted: false, locked: false, visible: true, volume: 1 },
                { type: "audio", index: 1, label: "A1", muted: false, locked: false, visible: true, volume: 1 },
            ], clips: new Map(), scenes: new Map(), answers: new Map(), deleted: false,
        };
        this.projects.set(id, project);
        return project;
    }

    /** The next matching call fails with this error (status 0: the network). */
    failNext(status: number, code: string, details?: Record<string, unknown>, options: { retryAfterSeconds?: number; path?: RegExp } = {}): void {
        this.failures.push({ status, code, ...(details ? { details } : {}), ...options });
    }

    /** The next `count` changesets are applied but their answers are lost (the client sees a network error). */
    dropNextAnswers(count = 1): void {
        this.dropAnswers += count;
    }

    /** The next `count` changesets with If-Match find the project moved on (another writer bumps the revision first). */
    storm412(count: number): void {
        this.storms += count;
    }

    /** Another device's changeset (no If-Match). */
    remoteChange(projectId: string, body: Record<string, unknown>): Json {
        return this.apply(this.projects.get(projectId)!, body);
    }

    /** A pipeline draws a storyboard on a scene (the set it replaces is kept): one revision. */
    drawStoryboard(projectId: string, sceneId: string, panels = 3): { revision: number } {
        const p = this.projects.get(projectId)!;
        const scene = p.scenes.get(sceneId)!;
        this.keep(sceneId, scene);
        const image = (i: number) => `https://cdn.opennan.com/results/${sceneId}/panel-${i}.png`;
        scene.shots = Array.from({ length: panels }, (_, i) => ({ index: i, description: `Shot ${i + 1}`, duration: 2, image_url: image(i), end_image_url: null, video_url: null, dialogue: null }));
        scene.storyboard_sheets = [{ image_url: `https://cdn.opennan.com/results/${sceneId}/sheet.png`, panels: Array.from({ length: panels }, (_, i) => ({ index: i, shot_index: i, image_url: image(i) })) }];
        scene.shots_version = memoryShotsVersion(sceneId, scene);
        p.revision++;
        return { revision: p.revision };
    }

    /** Forgets every kept shot set of a scene (older than the server keeps them). */
    forgetShots(sceneId: string): void {
        this.snapshots.delete(sceneId);
    }

    private keep(sceneId: string, scene: Row): void {
        // As the server: an empty shot set is never kept (a client clears instead).
        if ((!Array.isArray(scene.shots) || scene.shots.length === 0) && (!Array.isArray(scene.storyboard_sheets) || scene.storyboard_sheets.length === 0)) return;
        const version = memoryShotsVersion(sceneId, scene);
        let kept = this.snapshots.get(sceneId);
        if (!kept) this.snapshots.set(sceneId, (kept = new Map()));
        kept.set(version, { shots: clone(scene.shots ?? []), sheets: clone(scene.storyboard_sheets ?? []) });
    }

    document(projectId: string): Json {
        const p = this.projects.get(projectId)!;
        const scenes = [...p.scenes.values()].sort((a, b) => (a.order as number) - (b.order as number));
        return {
            object: "project_document", revision: p.revision, project: { id: p.id, ...clone(p.project) }, tracks: clone(p.tracks), clips: clone([...p.clips.values()]),
            scenes: clone(scenes), media: [],
        };
    }

    changeCalls(): MemoryServerCall[] {
        return this.calls.filter((c) => c.path.endsWith("/changes"));
    }

    private async request<T>(method: CloudMethod, path: string, request: CloudRequest = {}): Promise<CloudResponse<T>> {
        await Promise.resolve();
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(request.headers ?? {})) headers[k.toLowerCase()] = v;
        const record = (status: number) => this.calls.push({ method, path, headers, ...(request.body !== undefined ? { body: clone(request.body) } : {}), status });
        if (this.offline) {
            record(0);
            throw new CloudApiError(0, "network", "Can't reach OpenNan.");
        }
        const failure = this.failures.findIndex((f) => !f.path || f.path.test(path));
        if (failure >= 0) {
            const f = this.failures.splice(failure, 1)[0]!;
            record(f.status);
            throw new CloudApiError(f.status, f.code, f.code, { ...(f.details ? { details: f.details } : {}), ...(f.retryAfterSeconds !== undefined ? { retryAfterSeconds: f.retryAfterSeconds } : {}), fromServer: f.status > 0 });
        }
        const match = /^\/v1\/projects\/([^/]+)\/(document|changes)$/.exec(path);
        const project = match ? this.projects.get(match[1]!) : undefined;
        if (!match || !project || project.deleted) {
            record(404);
            throw new CloudApiError(404, "not_found", "No such project on this account.", { fromServer: true });
        }
        if (match[2] === "document" && method === "GET") {
            const etag = `"r${project.revision}"`;
            if (headers["if-none-match"] === etag) {
                record(304);
                return { status: 304, body: null as T, etag };
            }
            record(200);
            return { status: 200, body: this.document(project.id) as T, etag };
        }
        const key = headers["idempotency-key"];
        if (!key) {
            record(400);
            throw new CloudApiError(400, "invalid_request", "Send an Idempotency-Key header.", { fromServer: true });
        }
        const hash = canonical(request.body);
        const stored = project.answers.get(key);
        if (stored) {
            if (stored.hash !== hash) {
                record(409);
                throw new CloudApiError(409, "idempotency_key_reused", "reused", { fromServer: true });
            }
            record(200);
            return { status: 200, body: clone(stored.answer) as T, etag: `"r${(stored.answer as { revision: number }).revision}"` };
        }
        if (headers["if-match"] !== undefined && this.storms > 0) {
            this.storms--;
            project.revision++;
        }
        const wanted = headers["if-match"] === undefined ? null : Number(headers["if-match"].replace(/^W\//, "").replace(/"/g, "").replace(/^r/, ""));
        if (wanted !== null && wanted !== project.revision) {
            record(412);
            throw new CloudApiError(412, "timeline_changed", "The project changed.", { details: { revision: project.revision }, fromServer: true });
        }
        let answer: Json;
        try {
            answer = this.apply(project, request.body as Record<string, unknown>);
        } catch (error) {
            record((error as CloudApiError).status);
            throw error;
        }
        project.answers.set(key, { hash, answer });
        if (this.dropAnswers > 0) {
            this.dropAnswers--;
            record(0);
            throw new CloudApiError(0, "network", "Can't reach OpenNan.");
        }
        record(200);
        return { status: 200, body: clone(answer) as T, etag: `"r${project.revision}"` };
    }

    private apply(p: MemoryProject, body: Record<string, unknown>): Json {
        const scenes = (body.scenes ?? {}) as { create?: Row[]; patch?: Row[]; delete?: string[] };
        const clips = (body.clips ?? {}) as { create?: Row[]; patch?: Row[]; delete?: string[] };
        const tracks = body.tracks as { put?: Row[]; removed?: Row[] } | undefined;
        const missing = (kind: string, ids: string[]) => new CloudApiError(404, "entity_missing", "missing", { details: { kind, ids: [...new Set(ids)].sort() }, fromServer: true });
        const sceneMissing = [...(scenes.delete ?? []), ...(scenes.patch ?? []).map((r) => r.id as string)].filter((id) => !p.scenes.has(id));
        if (sceneMissing.length) throw missing("scene", sceneMissing);
        const clipMissing = [...(clips.delete ?? []), ...(clips.patch ?? []).map((r) => r.id as string)].filter((id) => !p.clips.has(id));
        if (clipMissing.length) throw missing("clip", clipMissing);
        const locked = [...(clips.delete ?? []), ...(clips.patch ?? []).map((r) => r.id as string)].filter((id) => p.clips.get(id)?.locked === true);
        if (locked.length) throw new CloudApiError(409, "clip_locked", "locked", { details: { kind: "clip", ids: [...new Set(locked)].sort() }, fromServer: true });
        // A clip naming a scene the project won't have (as the real server answers).
        const knownScenes = new Set([...[...p.scenes.keys()].filter((id) => !(scenes.delete ?? []).includes(id)), ...(scenes.create ?? []).map((r) => r.id as string)]);
        const unknownScenes = [...(clips.create ?? []), ...(clips.patch ?? [])].map((r) => r.scene_id).filter((id): id is string => typeof id === "string" && !knownScenes.has(id));
        if (unknownScenes.length) throw missing("scene", unknownScenes);
        const taken = [...(clips.create ?? []), ...(scenes.create ?? [])].map((r) => r.id as string).filter((id) => [...this.projects.values()].some((q) => q.clips.has(id) || q.scenes.has(id)));
        if (taken.length) throw new CloudApiError(409, "id_in_use", "taken", { details: { kind: "clip", ids: taken }, fromServer: true });
        const shotWrites = (scenes.patch ?? []).filter((r) => r.clear_shots === true || typeof r.shots_version === "string");
        const busy = shotWrites.map((r) => r.id as string).filter((id) => this.busyScenes.has(id));
        if (busy.length) throw new CloudApiError(409, "scene_busy", "busy", { details: { kind: "scene", ids: busy.sort() }, fromServer: true });
        const unknown = shotWrites.filter((r) => typeof r.shots_version === "string" && r.shots_version !== memoryShotsVersion(r.id as string, p.scenes.get(r.id as string)!)
            && !this.snapshots.get(r.id as string)?.has(r.shots_version)).map((r) => r.id as string);
        if (unknown.length) throw new CloudApiError(409, "shots_version_unknown", "unknown", { details: { kind: "scene", ids: unknown.sort() }, fromServer: true });

        const touchedClips = new Set<string>();
        const touchedScenes = new Set<string>();
        let changed = false;
        for (const put of tracks?.put ?? []) {
            const index = p.tracks.findIndex((t) => t.type === put.type && t.index === put.index);
            const row = { label: `${String(put.type)[0]!.toUpperCase()}${put.index}`, muted: false, locked: false, visible: true, volume: 1, ...clone(put) };
            if (index >= 0) p.tracks[index] = row;
            else p.tracks.push(row);
            changed = true;
        }
        for (const id of scenes.delete ?? []) {
            p.scenes.delete(id);
            for (const clip of p.clips.values()) if (clip.scene_id === id) clip.scene_id = null;
            changed = true;
        }
        for (const [i, row] of (scenes.create ?? []).entries()) {
            const { effects, ...rest } = row;
            const scene = { ...clone(SCENE_DEFAULTS), order: 100_000 + i, ...clone(rest), effects: clone(effects ?? []) } as Row;
            scene.shots_version = memoryShotsVersion(row.id as string, scene);
            p.scenes.set(row.id as string, scene);
            touchedScenes.add(row.id as string);
            changed = true;
        }
        for (const row of scenes.patch ?? []) {
            const { shots_version: version, clear_shots: clear, ...fields } = row;
            const scene = p.scenes.get(row.id as string)!;
            Object.assign(scene, clone(fields));
            if (clear === true || (typeof version === "string" && version !== memoryShotsVersion(scene.id as string, scene))) {
                const wanted = clear === true ? { shots: [], sheets: [] } : this.snapshots.get(scene.id as string)!.get(version as string)!;
                this.keep(scene.id as string, scene);
                scene.shots = clone(wanted.shots);
                scene.storyboard_sheets = clone(wanted.sheets);
            }
            scene.shots_version = memoryShotsVersion(scene.id as string, scene);
            touchedScenes.add(row.id as string);
            changed = true;
        }
        for (const id of clips.delete ?? []) {
            p.clips.delete(id);
            changed = true;
        }
        for (const row of clips.create ?? []) {
            p.clips.set(row.id as string, { ...clone(CLIP_DEFAULTS), ...clone(row), effects: clone(row.effects ?? []) } as Row);
            touchedClips.add(row.id as string);
            changed = true;
        }
        for (const row of clips.patch ?? []) {
            const clip = p.clips.get(row.id as string)!;
            Object.assign(clip, clone(row));
            if (row.effects === null) clip.effects = [];
            touchedClips.add(row.id as string);
            changed = true;
        }
        const removedClips: string[] = [];
        for (const ref of tracks?.removed ?? []) {
            p.tracks = p.tracks.filter((t) => !(t.type === ref.type && t.index === ref.index));
            for (const [id, clip] of p.clips) {
                if (clip.track_type === ref.type && clip.track_index === ref.index) {
                    p.clips.delete(id);
                    removedClips.push(id);
                }
            }
            changed = true;
        }
        const project = body.project as Row | undefined;
        if (project) {
            Object.assign(p.project, clone(project));
            changed = true;
        }
        // Normalise: resequence scene order.
        [...p.scenes.values()].sort((a, b) => (a.order as number) - (b.order as number)).forEach((scene, i) => {
            if (scene.order !== i) {
                scene.order = i;
                touchedScenes.add(scene.id as string);
            }
        });
        if (changed) p.revision++;
        this.serial++;
        return {
            object: "project_change", revision: p.revision, etag: `"r${p.revision}"`,
            clips: clone([...touchedClips].filter((id) => p.clips.has(id)).map((id) => p.clips.get(id)!)),
            scenes: clone([...touchedScenes].filter((id) => p.scenes.has(id)).map((id) => p.scenes.get(id)!)),
            tracks: tracks ? clone(p.tracks) : null,
            project: project ? { id: p.id, ...clone(p.project) } : null,
            deleted: { clips: [...(clips.delete ?? []), ...removedClips].sort(), scenes: [...(scenes.delete ?? [])].sort() },
        };
    }
}
