// One open cloud project: its working copy (a LocalBackend mirror), the server's document as last known
// ("confirmed"), the edits not on the server yet ("pending", one merged delta), the changeset in flight, and the
// per-device undo history. Writes run on the mirror at once and are diffed into server space; a flush sends one
// changeset (If-Match + Idempotency-Key, kept until it is answered, so a retry is never applied twice); a poll pulls
// the document (ETag/304). A 412 or a newer document rebases pending edits field by field; a refusal drops exactly the
// refused rows' edits as conflicts (the pre-rebase copy is kept as a snapshot); the network failing makes the
// project Offline (edits keep queuing, on disk) until it comes back. Everything is persisted in the CloudStore.
import type { BackendChange, LocalBackend } from "@opennan/timeline-core";
import { isAbortError, isCloudApiError, type CloudApi, type CloudApiError } from "./api";
import { buildChangesets, emptyBody, refusedKeys, MAX_BODY_BYTES, type ChangesetBody } from "./changeset";
import type { Clock } from "./clock";
import {
    CLIP_COLUMNS, PROJECT_COLUMNS, SCENE_COLUMNS, TRACK_COLUMNS,
    decodeDoc, encodeDoc, entityId, entityKind, ingestClip, ingestDocument, ingestProject, ingestScene, ingestTrack, localUrlsIn, normalizedProject, trackKey,
    type DocumentJson, type Fields, type LocalDoc, type ServerDoc, type UrlMap,
} from "./codec";
import { applyDelta, diffDocs, emptyDelta, isEmptyDelta, mergeDeltas, rebase, undoDelta, type Delta } from "./delta";
import { DeltaHistory } from "./history";
import { canonical, clone, mapStrings, type Json } from "./json";
import type { CloudStore } from "./store";
import type { ConflictItem, SyncState } from "./types";

export const FLUSH_DELAY_MS = 400;
export const FLUSH_MAX_DELAY_MS = 3_000;
export const POLL_VISIBLE_MS = 3_000;
export const POLL_HIDDEN_MS = 15_000;
export const POLL_FLOOR_MS = 1_500;
export const RETRY_MAX_MS = 60_000;
export const STORM_LIMIT = 3;
export const QUOTA_RETRY_MS = 5 * 60_000;
export const SNAPSHOT_DAYS = 7;
/** How long an AI step waits for the revision it names before it is given up (phase 9b). */
export const REMOTE_STEP_TIMEOUT_MS = 30_000;
export const REMOTE_STEP_LOST = "Can't undo this AI step on this device: its changes didn't arrive in time.";
/** A busy scene's shots write is tried again this often, for at most this long (phase 9c). */
export const SHOTS_RETRY_MS = 10_000;
export const SHOTS_BUSY_MAX_MS = 5 * 60_000;
export const SHOTS_BUSY = "A step is still drawing this scene: its earlier storyboard goes back once that step finishes.";
export const SHOTS_BUSY_GAVE_UP = "Can't undo the storyboard of a scene on this device: a step kept drawing it. Its panels were kept.";
export const SHOTS_VERSION_LOST = "Can't undo the storyboard of a scene on this device: OpenNan no longer keeps its earlier version. Its panels were kept.";
export const SHOTS_REFUSED = "Can't undo the storyboard of a scene on this device: OpenNan refused it. Its panels were kept.";
export const FINAL_VIDEO_CLOSED = "The project was closed before OpenNan got the export: it is sent when the project opens again.";
/** The scene field whose change an AI step records so its undo can put the shots back (the server's shots version). */
const SHOTS = "shots_version";


/** What an AI turn or pipeline task changed on the server, to undo as one step (phase 9b). */
export interface RemoteGroup {
    label: string;
    /** The revision the change landed in (the turn's last change, the task's project_revision). */
    toRevision: number;
    entities: { scenes: string[] | "all"; clips: string[] | "all"; tracks: boolean; project: boolean };
}

/** One recorded AI step: what undo shows (the working copy with it undone) and the items it changed. */
export interface RemoteStep {
    stepId: number;
    label: string;
    before: LocalDoc;
    /** The working copy with the step (what redo shows). */
    after: LocalDoc;
    changed: { scenes: string[]; clips: string[] };
}

const WRITABLE: Record<string, ReadonlySet<string>> = {
    clip: new Set([...CLIP_COLUMNS.map((c) => c.col), "effects"]),
    scene: new Set([...SCENE_COLUMNS.map((c) => c.col), "effects"]),
    project: new Set(PROJECT_COLUMNS.map((c) => c.col)),
    track: new Set(TRACK_COLUMNS.map((c) => c.col)),
};

/** Only what Studio can write back (columns, effect stacks, its own x. fields): a server-only field (a scene's shots or status) can't be undone from Studio. */
function writableOnly(delta: Delta): Delta {
    const out = emptyDelta();
    for (const [key, change] of Object.entries(delta.entities)) {
        if (change.op !== "patch") {
            out.entities[key] = change;
            continue;
        }
        const allowed = WRITABLE[entityKind(key)];
        const fields = Object.fromEntries(Object.entries(change.fields).filter(([name, value]) => name.startsWith("x.") || allowed?.has(name)
            // A scene's shots version (phase 9c): the undo puts the earlier shots back through the server.
            || (name === SHOTS && entityKind(key) === "scene" && typeof value.b === "string" && typeof value.a === "string")));
        if (Object.keys(fields).length > 0) out.entities[key] = { op: "patch", fields };
    }
    return out;
}

/**
 * `doc` with the fields only the server writes (a scene's shots, status, order…) taken from `confirmed` where `doc`
 * has none. A document built from the working copy (the target) leaves them out when the working copy shows them as
 * the server does, so decoding it alone would lose them (a scene's shots would vanish from the working copy, and the
 * next edit would pin "no shots" into Studio's extras).
 */
export function withServerOnlyFields(doc: ServerDoc, confirmed: ServerDoc): ServerDoc {
    let entities: Record<string, Fields> | null = null;
    for (const [key, fields] of Object.entries(doc.entities)) {
        const server = confirmed.entities[key];
        const writable = WRITABLE[entityKind(key)];
        if (!server || !writable) continue;
        let merged: Fields | null = null;
        for (const [name, value] of Object.entries(server)) {
            if (name in fields || name.startsWith("x.") || writable.has(name)) continue;
            merged ??= { ...fields };
            merged[name] = value;
        }
        if (merged) (entities ??= { ...doc.entities })[key] = merged;
    }
    return entities ? { ...doc, entities } : doc;
}

function groupKeys(entities: RemoteGroup["entities"], docs: ServerDoc[]): string[] {
    const sceneIds = entities.scenes === "all" ? null : new Set(entities.scenes);
    const clipIds = entities.clips === "all" ? null : new Set(entities.clips);
    const keys = new Set<string>();
    for (const doc of docs) {
        for (const key of Object.keys(doc.entities)) {
            const kind = entityKind(key);
            if (kind === "clip" && (clipIds === null || clipIds.has(entityId(key)))) keys.add(key);
            else if (kind === "scene" && (sceneIds === null || sceneIds.has(entityId(key)))) keys.add(key);
            else if (kind === "track" && entities.tracks) keys.add(key);
            else if (kind === "project" && entities.project) keys.add(key);
        }
    }
    return [...keys];
}

function changedIds(delta: Delta): RemoteStep["changed"] {
    const scenes: string[] = [];
    const clips: string[] = [];
    for (const key of Object.keys(delta.entities)) {
        const kind = entityKind(key);
        if (kind === "scene") scenes.push(entityId(key));
        else if (kind === "clip") clips.push(entityId(key));
    }
    return { scenes, clips };
}

function hasShots(fields: Fields | undefined): boolean {
    return Boolean(fields) && ((Array.isArray(fields!.shots) && fields!.shots.length > 0) || (Array.isArray(fields!.storyboard_sheets) && fields!.storyboard_sheets.length > 0));
}


/** `delta` without its shots versions (what syncs as an ordinary edit). */
function withoutShots(delta: Delta): Delta {
    const out = emptyDelta();
    for (const [key, change] of Object.entries(delta.entities)) {
        if (change.op !== "patch" || !(SHOTS in change.fields)) {
            out.entities[key] = change;
            continue;
        }
        const { [SHOTS]: _shots, ...fields } = change.fields;
        if (Object.keys(fields).length > 0) out.entities[key] = { op: "patch", fields };
    }
    return out;
}

export interface SessionMedia {
    /** What holds uploads back, in Studio's words (shown with "Syncing"). */
    message?(): string | null;
    /** The local media URLs the project uses now: uploads start for any not uploaded yet. */
    want(projectId: string, urls: Set<string>): void;
    /** Asset ids uploaded for this project and not linked into its media bin yet. */
    unlinked(projectId: string): string[];
    linked(projectId: string, assetIds: string[]): void;
    progress(): { uploading: number; uploaded: number; blocked: null | "storage" | "pool-full" };
}

export interface NetworkStatus {
    online(): boolean;
    visible(): boolean;
    subscribe(listener: () => void): () => void;
}

export const ALWAYS_ONLINE: NetworkStatus = { online: () => true, visible: () => true, subscribe: () => () => undefined };

export interface SessionDeps {
    /** Studio id ("cloud-<serverId>"): the mirror's project id. */
    projectId: string;
    serverId: string;
    api: CloudApi;
    store: CloudStore;
    mirror: LocalBackend;
    urls: UrlMap;
    media: SessionMedia;
    clock: Clock;
    network: NetworkStatus;
    deviceName: string;
    onChange(changes: BackendChange[]): void;
    onState(state: SyncState): void;
    onNotice?(message: string): void;
    logger?: { warn(...args: unknown[]): void };
}

/** A scene's shots put back by an undo or redo (phase 9c): the version to restore, or a clear. */
interface ShotWrite {
    id: string;
    /** The version to put back (as the history holds it). */
    target: string;
    /** Send clear_shots instead: that version is a scene without shots (OpenNan never keeps an empty set). */
    clear: boolean;
    firstBusyAt: number | null;
    notBefore: number;
}

/** Fields only the server's routes take from Studio, outside the working copy (phase 9c), sent in a changeset of their own. */
interface ServerWrites {
    finalVideo?: { id: string; url: string | null };
    shots?: Record<string, ShotWrite>;
}

interface Inflight {
    key: string;
    body: ChangesetBody;
    keys: string[];
    sent: Delta;
    ifMatch: boolean;
    /** A server-writes changeset: what it carries. */
    server?: ServerWrites;
}

export interface SyncRecord {
    version: 1;
    serverId: string;
    confirmed: ServerDoc;
    pending: Delta;
    inflight: Inflight | null;
    conflicts: ConflictItem[];
    snapshot: { at: number; doc: LocalDoc } | null;
    storm: number;
    label: string;
    savedAt: number | null;
    /** Uploaded files to link into the project's media bin with the next changeset (Save to OpenNan). */
    toLink?: string[];
    /** Server writes not answered yet (phase 9c: the final video, shots put back). */
    serverWrites?: ServerWrites;
}

export const EDITED_ELSEWHERE = "Some changes were edited elsewhere and were kept.";

function uuid(): string {
    return globalThis.crypto.randomUUID();
}

function pick(delta: Delta, keys: Iterable<string>): Delta {
    const out = emptyDelta();
    for (const key of keys) if (delta.entities[key]) out.entities[key] = delta.entities[key]!;
    return out;
}

function without(delta: Delta, keys: Iterable<string>): Delta {
    const drop = new Set(keys);
    const out = emptyDelta();
    for (const [key, change] of Object.entries(delta.entities)) if (!drop.has(key)) out.entities[key] = change;
    return out;
}

function sameDoc(a: ServerDoc, b: ServerDoc): boolean {
    const keys = new Set([...Object.keys(a.entities), ...Object.keys(b.entities)]);
    for (const key of keys) {
        const x = a.entities[key];
        const y = b.entities[key];
        if (!x || !y) return false;
        // Columns a write left unsent are "as the server holds them": compare only what both sides carry.
        for (const name of new Set([...Object.keys(x), ...Object.keys(y)])) {
            const inX = name in x;
            const inY = name in y;
            if (inX && inY ? canonical(x[name]) !== canonical(y[name]) : name.startsWith("x.")) return false;
        }
    }
    return true;
}

function describeEntity(key: string, fields: Fields | undefined): { entity: ConflictItem["entity"]; id: string; label: string } {
    const kind = entityKind(key);
    const entity = kind === "media" as string ? "project" : (kind as ConflictItem["entity"]);
    const label = typeof fields?.label === "string" && fields.label ? fields.label
        : typeof fields?.text_content === "string" && fields.text_content ? fields.text_content.slice(0, 40)
        : typeof fields?.caption === "string" && fields.caption ? fields.caption.slice(0, 40)
        : kind === "clip" ? "A clip" : kind === "scene" ? "A scene" : kind === "track" ? "A track" : "The project";
    return { entity, id: kind === "project" ? "project" : entityId(key), label };
}

const REASON_TEXT: Record<ConflictItem["reason"], string> = {
    deleted: "it was deleted on another device",
    locked: "it is locked on OpenNan",
    "id-in-use": "its id is already used on OpenNan",
    refused: "OpenNan refused it",
};

export class CloudProjectSession {
    readonly projectId: string;
    private record!: SyncRecord;
    private target!: ServerDoc;
    private readonly history = new DeltaHistory(100);
    private chain: Promise<unknown> = Promise.resolve();
    private sending: Promise<void> | null = null;
    private flushTimer: unknown = null;
    private flushDeadline: number | null = null;
    private pollTimer: unknown = null;
    private retryTimer: unknown = null;
    private persistTimer: unknown = null;
    private failures = 0;
    private lastPollAt = 0;
    /** Bytes a changeset body may take (halved after a 413). */
    private bodyLimit = MAX_BODY_BYTES;
    /** The next pull reads the whole document (after a send without If-Match moved past other devices' edits). */
    private fullPull = false;
    /** No request before this time (a 429's Retry-After). */
    private notBefore = 0;
    private offlineSince: number | null = null;
    private signedOut = false;
    private projectGone = false;
    private quota: "project-data" | null = null;
    private lastState = "";
    private disposed = false;
    private unsubscribeNetwork: (() => void) | null = null;
    private idleWaiters: Array<() => void> = [];
    /** Turns and project tasks of this project running now (phase 9b): the poll runs every 1.5 s meanwhile. */
    private aiActive = 0;
    /** Open AI groups: the confirmed document when each began, with this device's own sent changes folded in. */
    private readonly groups = new Map<number, ServerDoc>();
    private readonly steps = new Map<number, { delta: Delta; label: string }>();
    private nextId = 1;
    private revisionWaiters: Array<{ revision: number; done(reached: boolean): void }> = [];
    /**
     * The newest revision the confirmed document is known to hold in full: a full read, or this device's own change
     * answered right after it. An answer that skipped revisions (other writers in between) does not move it; the
     * full read that follows does.
     */
    private complete = 0;
    /** Shot sets seen in AI steps, by version (phase 9c): what a scene shows while its earlier shots are being put back. */
    private readonly shotSets = new Map<string, { shots: Json; sheets: Json }>();
    /** Callers waiting for the final video's changeset (phase 9c), by write id. */
    private readonly finalWaiters = new Map<string, { resolve(): void; reject(error: Error): void }>();

    private constructor(private readonly deps: SessionDeps) {
        this.projectId = deps.projectId;
    }

    /** Opens a project: from its saved record (recovering any write the record missed), or from the server's document. */
    static async open(deps: SessionDeps): Promise<CloudProjectSession> {
        const session = new CloudProjectSession(deps);
        await session.load();
        session.unsubscribeNetwork = deps.network.subscribe(() => session.onNetwork());
        session.schedulePoll(POLL_FLOOR_MS);
        session.emitState();
        session.deps.media.want(session.projectId, localUrlsIn(session.target));
        if (!isEmptyDelta(session.record.pending) || session.record.inflight || session.record.serverWrites) session.scheduleFlush(0);
        return session;
    }

    // ── reads ─────────────────────────────────────────────

    state(): SyncState {
        // Items waiting (a clip, a scene, a track, the project), not fields.
        const writes = this.record.serverWrites;
        const serverCount = (writes?.finalVideo ? 1 : 0) + Object.keys(writes?.shots ?? {}).length;
        const inflight = this.record.inflight && !this.record.inflight.server ? Math.max(1, Object.keys(this.record.inflight.sent.entities).length) : 0;
        const pending = Object.keys(this.record.pending.entities).length + inflight + serverCount;
        if (this.record.conflicts.length > 0) return { kind: "conflict", items: clone(this.record.conflicts), pending };
        if (this.signedOut) return { kind: "signed-out", pending };
        if (this.offlineSince !== null) return { kind: "offline", pending, since: this.offlineSince };
        const media = this.deps.media.progress();
        if (this.quota) return { kind: "over-quota", reason: "project-data", pending };
        if (media.blocked) return { kind: "over-quota", reason: media.blocked, pending };
        if (pending > 0 || media.uploading > 0 || this.sending) {
            const message = this.deps.media.message?.() ?? null;
            return { kind: "syncing", pending, uploading: media.uploading, uploaded: media.uploaded, ...(message ? { message } : {}) };
        }
        return { kind: "saved", at: this.record.savedAt ?? this.deps.clock.now() };
    }

    canUndo(): boolean {
        return this.history.canUndo();
    }

    canRedo(): boolean {
        return this.history.canRedo();
    }

    conflictSnapshot(): LocalDoc | null {
        const snapshot = this.record.snapshot;
        if (!snapshot) return null;
        if (this.deps.clock.now() - snapshot.at > SNAPSHOT_DAYS * 86_400_000) return null;
        return clone(snapshot.doc);
    }

    revision(): number {
        return this.record.confirmed.revision;
    }

    /** The server's document as last read (no pending edits). */
    confirmed(): ServerDoc {
        return this.record.confirmed;
    }

    /** The server-space document Studio holds now (confirmed + pending), for tests and diagnostics. */
    current(): ServerDoc {
        return clone(this.target);
    }

    // ── writes ────────────────────────────────────────────

    /** Runs a write on the mirror and queues its delta; `recordHistory` false for withoutHistory() writes. */
    write<T>(label: string, recordHistory: boolean, op: () => Promise<T>): Promise<T> {
        return this.exclusive(async () => {
            try {
                return await op();
            } finally {
                const delta = await this.captureWrite(label);
                if (recordHistory) this.history.record(delta);
            }
        });
    }

    undo(steps: number): Promise<void> {
        return this.travel("undo", steps);
    }

    redo(steps: number): Promise<void> {
        return this.travel("redo", steps);
    }

    /** Sends everything now and resolves once nothing is queued, in flight, or the project can't sync right now. */
    async flush(): Promise<void> {
        await this.chain.catch(() => undefined);
        this.flushDeadline = null;
        this.clearTimer("flushTimer");
        await this.sendLoop();
    }

    acknowledgeConflicts(): void {
        this.record.conflicts = [];
        this.persistSoon();
        this.emitState();
    }

    /** The account signed in again (a 401 stopped syncing): try again. */
    resume(): void {
        if (!this.signedOut) return;
        this.signedOut = false;
        this.failures = 0;
        this.emitState();
        this.scheduleFlush(0);
        this.schedulePoll(0);
    }

    /** A local URL got its upload (or a cloud URL its cached copy): re-encode and re-decode the working copy. */
    urlsChanged(mapping?: Array<{ local: string; remote: string }>): Promise<void> {
        return this.exclusive(async () => {
            if (mapping?.length) {
                const rewrite = (text: string) => mapping.reduce((t, m) => (t.includes(m.local) ? t.split(m.local).join(m.remote) : t), text);
                this.rewriteHistory(rewrite);
                this.record.pending = mapStrings(this.record.pending, rewrite);
            }
            const local = await this.readLocal();
            const decoded = decodeDoc(this.shownDoc(this.target), this.projectId, this.deps.urls);
            if (canonical(decoded) !== canonical(local)) await this.writeMirror(decoded, true);
            await this.captureWrite(this.record.label || "Edit");
            this.scheduleFlush(0);
        });
    }

    async pullNow(): Promise<void> {
        await this.pull();
    }

    /**
     * Sets the project's latest export (`project.final_video_url`, phase 9c: what its share link plays) in a changeset
     * of its own once pending edits are sent; resolves when OpenNan answered it, rejects with its reason on a refusal.
     * Persisted: a project closed first sends it when it opens again.
     */
    async setFinalVideo(url: string | null): Promise<void> {
        let waiter!: Promise<void>;
        await this.exclusive(async () => {
            const id = uuid();
            const writes = (this.record.serverWrites ??= {});
            const replaced = writes.finalVideo ? this.finalWaiters.get(writes.finalVideo.id) : undefined;
            if (writes.finalVideo) this.finalWaiters.delete(writes.finalVideo.id);
            replaced?.reject(new Error("A newer export replaced it."));
            writes.finalVideo = { id, url };
            waiter = new Promise<void>((resolve, reject) => this.finalWaiters.set(id, { resolve, reject }));
            waiter.catch(() => undefined);
            await this.persist();
            this.emitState();
            this.scheduleFlush(0);
        });
        return waiter;
    }

    /** Rewrites strings in every history entry and keeps the AI steps pointing at their (rewritten) entries. */
    private rewriteHistory(map: (text: string) => string): void {
        const replaced = this.history.rewrite(map);
        for (const [id, step] of this.steps) {
            const delta = replaced.get(step.delta) ?? mapStrings(step.delta, map);
            if (delta !== step.delta) this.steps.set(id, { ...step, delta });
        }
    }

    /** Whether a version is known to be a scene without shots or a storyboard. */
    private isEmptySet(version: string): boolean {
        const set = this.shotSets.get(version);
        return Boolean(set) && (!Array.isArray(set!.shots) || set!.shots.length === 0) && (!Array.isArray(set!.sheets) || set!.sheets.length === 0);
    }

    /** Keeps a scene's shot set by its version (bounded: the oldest go first). */
    private keepShotSet(fields: Fields | undefined): void {
        const version = fields?.[SHOTS];
        if (!fields || typeof version !== "string") return;
        this.shotSets.delete(version);
        this.shotSets.set(version, { shots: clone(fields.shots ?? []) as Json, sheets: clone(fields.storyboard_sheets ?? []) as Json });
        while (this.shotSets.size > 200) this.shotSets.delete(this.shotSets.keys().next().value!);
    }

    /** `doc` with each named scene showing the shot set of the version given (an earlier storyboard, or none for a clear). */
    private withShotSets(doc: ServerDoc, versions: Iterable<[string, { target: string; clear: boolean }]>): ServerDoc {
        let entities: Record<string, Fields> | null = null;
        for (const [sceneId, { target, clear }] of versions) {
            const key = `scene:${sceneId}`;
            const fields = (entities ?? doc.entities)[key];
            if (!fields) continue;
            const set = clear ? { shots: [], sheets: [] } : this.shotSets.get(target);
            if (!set) continue;
            (entities ??= { ...doc.entities })[key] = { ...fields, shots: clone(set.shots), storyboard_sheets: clone(set.sheets) };
        }
        return entities ? { ...doc, entities } : doc;
    }

    /** What the working copy shows: `doc` with the server's own fields, and scenes whose earlier shots are being put back showing them. */
    private shownDoc(doc: ServerDoc): ServerDoc {
        const shots = Object.entries(this.record.serverWrites?.shots ?? {}).map(([id, w]) => [id, { target: w.target, clear: w.clear }] as [string, { target: string; clear: boolean }]);
        return this.withShotSets(withServerOnlyFields(doc, this.record.confirmed), shots);
    }

    /** The document undo and redo compare with: the working copy, the server's own fields, and shots versions queued to be put back. */
    private historyDoc(): ServerDoc {
        const doc = withServerOnlyFields(this.target, this.record.confirmed);
        const shots = this.record.serverWrites?.shots;
        if (!shots || Object.keys(shots).length === 0) return doc;
        const entities = { ...doc.entities };
        for (const [sceneId, write] of Object.entries(shots)) {
            const key = `scene:${sceneId}`;
            if (entities[key]) entities[key] = { ...entities[key], [SHOTS]: write.target };
        }
        return { ...doc, entities };
    }

    /** Queues a shots write for every scene whose version `result` changed from `view`; the changes made. */
    private queueShotWrites(view: ServerDoc, result: ServerDoc): Array<{ sceneId: string; from: string; to: string }> {
        const made: Array<{ sceneId: string; from: string; to: string }> = [];
        for (const [key, fields] of Object.entries(result.entities)) {
            if (entityKind(key) !== "scene") continue;
            const to = fields[SHOTS];
            const from = view.entities[key]?.[SHOTS];
            if (typeof to !== "string" || typeof from !== "string" || to === from) continue;
            const sceneId = entityId(key);
            const shots = ((this.record.serverWrites ??= {}).shots ??= {});
            const inflight = this.record.inflight?.server?.shots?.[sceneId];
            if (!inflight && to === this.record.confirmed.entities[key]?.[SHOTS]) delete shots[sceneId];
            else shots[sceneId] = { id: uuid(), target: to, clear: this.isEmptySet(to), firstBusyAt: null, notBefore: 0 };
            made.push({ sceneId, from, to });
        }
        if (made.length > 0) {
            this.persistSoon();
            this.scheduleFlush();
        }
        return made;
    }

    /** The server writes changeset, when nothing else waits to be sent. Runs inside exclusive(). */
    private async prepareServer(): Promise<Inflight | null> {
        const writes = this.record.serverWrites;
        if (!writes) return null;
        const body = emptyBody("Studio", this.deps.deviceName);
        const server: ServerWrites = {};
        // The final video goes alone, shots writes together: a refusal of one never drops the other.
        if (writes.finalVideo) {
            body.project = { final_video_url: writes.finalVideo.url };
            server.finalVideo = { ...writes.finalVideo };
        }
        const now = this.deps.clock.now();
        let wait = Number.POSITIVE_INFINITY;
        for (const [sceneId, write] of Object.entries(writes.finalVideo ? {} : writes.shots ?? {})) {
            if (!this.record.confirmed.entities[`scene:${sceneId}`]) {
                // The scene is gone: nothing to put back.
                delete writes.shots![sceneId];
                continue;
            }
            if (write.notBefore > now) {
                wait = Math.min(wait, write.notBefore - now);
                continue;
            }
            body.label = "Undo storyboard";
            body.scenes.patch.push(write.clear ? { id: sceneId, clear_shots: true } : { id: sceneId, [SHOTS]: write.target });
            (server.shots ??= {})[sceneId] = { ...write };
        }
        if (Number.isFinite(wait)) this.scheduleFlush(wait);
        if (writes.finalVideo) body.label = "Export for sharing";
        if (!server.finalVideo && !server.shots) {
            if (!writes.finalVideo && Object.keys(writes.shots ?? {}).length === 0) delete this.record.serverWrites;
            return null;
        }
        const inflight: Inflight = { key: uuid(), body, keys: [], sent: emptyDelta(), ifMatch: this.record.storm < STORM_LIMIT, server };
        this.record.inflight = inflight;
        await this.persist();
        return inflight;
    }

    /** A server writes changeset was answered: done writes are dropped, waiters resolved, shots versions followed. */
    private settleServerWrites(sent: ServerWrites, answer: Record<string, unknown>): void {
        const writes = this.record.serverWrites;
        if (sent.finalVideo) {
            if (writes?.finalVideo?.id === sent.finalVideo.id) delete writes.finalVideo;
            this.finalWaiters.get(sent.finalVideo.id)?.resolve();
            this.finalWaiters.delete(sent.finalVideo.id);
        }
        const rows = (answer.scenes as Array<Record<string, unknown>> | undefined) ?? [];
        for (const [sceneId, write] of Object.entries(sent.shots ?? {})) {
            const row = rows.find((r) => String(r.id) === sceneId);
            const version = row?.[SHOTS];
            if (row) this.keepShotSet(row as Fields);
            // The history names the version as it asked for it: from now on it names what the scene holds.
            if (typeof version === "string" && version !== write.target) this.rewriteHistory((text) => (text === write.target ? version : text));
            if (writes?.shots?.[sceneId]?.id === write.id) delete writes.shots[sceneId];
        }
        if (writes && !writes.finalVideo && Object.keys(writes.shots ?? {}).length === 0) delete this.record.serverWrites;
    }

    /**
     * Refusals of a server writes changeset; true when another send may follow at once, null for the common handling
     * (412, a reused key, quota, and the network, auth, rate-limit and server answers). A server writes changeset never
     * goes through the edit-refusal branches: it carries no edit.
     */
    private async onServerSendError(inflight: Inflight, e: CloudApiError): Promise<boolean | null> {
        if (!e.fromServer || e.status === 412 || e.status === 401 || e.status === 429 || e.status >= 500 || e.status === 0) return null;
        if (["idempotency_key_reused", "project_data_quota_exceeded", "project_too_large"].includes(e.code)) return null;
        if (e.status === 404 && (e.code === "not_found" || e.code === "project_not_found")) return null;
        const sent = inflight.server!;
        const writes = this.record.serverWrites ?? {};
        const ids = e.details && e.details.kind === "scene" && Array.isArray(e.details.ids) ? (e.details.ids as unknown[]).filter((id): id is string => typeof id === "string") : [];
        const named = ids.filter((id) => sent.shots?.[id]);
        const mine = named.filter((id) => writes.shots?.[id]?.id === sent.shots![id]!.id);
        const now = this.deps.clock.now();
        let dropped = false;
        if (e.code === "scene_busy" && named.length > 0) {
            let first = false;
            for (const id of mine) {
                const write = writes.shots![id]!;
                if (write.firstBusyAt === null) {
                    write.firstBusyAt = now;
                    first = true;
                }
                if (now - write.firstBusyAt >= SHOTS_BUSY_MAX_MS) {
                    delete writes.shots![id];
                    dropped = true;
                    this.deps.onNotice?.(SHOTS_BUSY_GAVE_UP);
                } else {
                    write.notBefore = now + SHOTS_RETRY_MS;
                }
            }
            if (first) this.deps.onNotice?.(SHOTS_BUSY);
        } else if (e.code === "shots_version_unknown" && named.length > 0) {
            for (const id of mine) {
                delete writes.shots![id];
                dropped = true;
                this.deps.onNotice?.(SHOTS_VERSION_LOST);
            }
        } else if (e.code === "entity_missing" && named.length > 0) {
            // The scene is gone: nothing to put back.
            for (const id of mine) delete writes.shots![id];
        } else {
            // OpenNan refused the writes themselves: they are dropped (an edit never rides with them).
            if (sent.finalVideo && writes.finalVideo?.id === sent.finalVideo.id) {
                delete writes.finalVideo;
                this.finalWaiters.get(sent.finalVideo.id)?.reject(new Error(e.message));
                this.finalWaiters.delete(sent.finalVideo.id);
            }
            for (const [id, write] of Object.entries(sent.shots ?? {})) {
                if (writes.shots?.[id]?.id !== write.id) continue;
                delete writes.shots[id];
                dropped = true;
            }
            if (dropped) this.deps.onNotice?.(SHOTS_REFUSED);
        }
        if (this.record.serverWrites && !writes.finalVideo && Object.keys(writes.shots ?? {}).length === 0) delete this.record.serverWrites;
        this.record.inflight = null;
        // A storyboard that could not be put back: the working copy shows what OpenNan kept.
        if (dropped) await this.reconcile(this.record.confirmed);
        await this.persist();
        return true;
    }

    // ── the AI director (phase 9b) ────────────────────────

    /** One more (+1) or one fewer (-1) AI job running on this project; while any runs, the poll runs every 1.5 s. */
    setAiActive(delta: number): void {
        const was = this.aiActive;
        this.aiActive = Math.max(0, this.aiActive + delta);
        if (was === 0 && this.aiActive > 0 && this.pollTimer !== null) this.schedulePoll(POLL_FLOOR_MS);
    }

    /** Reads the document as soon as the 1.5 s floor (and any Retry-After) allows. */
    pullSoon(): void {
        this.schedulePoll(0);
    }

    /** Resolves true once the confirmed document is at `revision` or newer, false after `timeoutMs`. */
    waitForRevision(revision: number, timeoutMs = REMOTE_STEP_TIMEOUT_MS): Promise<boolean> {
        if (this.complete >= revision) return Promise.resolve(true);
        return new Promise((resolve) => {
            let timer: unknown = null;
            const waiter = {
                revision,
                done: (reached: boolean) => {
                    if (timer !== null) this.deps.clock.clearTimeout(timer);
                    this.revisionWaiters = this.revisionWaiters.filter((w) => w !== waiter);
                    resolve(reached);
                },
            };
            timer = this.deps.clock.setTimeout(() => {
                timer = null;
                waiter.done(false);
            }, timeoutMs);
            this.revisionWaiters.push(waiter);
            this.pullSoon();
        });
    }

    /** Starts an AI group: its changes are measured from the document as it is now. */
    beginRemoteGroup(): number {
        const id = this.nextId++;
        this.groups.set(id, this.record.confirmed);
        return id;
    }

    endRemoteGroup(groupId: number): void {
        this.groups.delete(groupId);
    }

    /**
     * Records what the AI changed since the group began, restricted to `group.entities`, as one undo step, once the
     * confirmed document reached `group.toRevision`. null when nothing Studio can write back changed, or when the
     * revision never arrived (a notice says the step can't be undone here).
     */
    async recordRemoteGroup(groupId: number, group: RemoteGroup, options: { timeoutMs?: number } = {}): Promise<RemoteStep | null> {
        if (!this.groups.has(groupId)) return null;
        const reached = await this.waitForRevision(group.toRevision, options.timeoutMs ?? REMOTE_STEP_TIMEOUT_MS);
        if (!reached) {
            this.groups.delete(groupId);
            this.deps.onNotice?.(REMOTE_STEP_LOST);
            return null;
        }
        return this.exclusive(async () => {
            const base = this.groups.get(groupId);
            this.groups.delete(groupId);
            if (!base) return null;
            const confirmed = this.record.confirmed;
            const delta = writableOnly(diffDocs(base, confirmed, groupKeys(group.entities, [base, confirmed])));
            if (isEmptyDelta(delta)) return null;
            const restored: Array<[string, { target: string; clear: boolean }]> = [];
            for (const [key, change] of Object.entries(delta.entities)) {
                const shots = change.op === "patch" ? change.fields[SHOTS] : undefined;
                if (!shots || typeof shots.b !== "string") continue;
                this.keepShotSet(base.entities[key]);
                this.keepShotSet(confirmed.entities[key]);
                restored.push([entityId(key), { target: shots.b, clear: !hasShots(base.entities[key]) }]);
            }
            this.history.record(delta);
            const stepId = this.nextId++;
            this.steps.set(stepId, { delta, label: group.label });
            // What undo shows: the step taken back, its scenes with their earlier storyboard.
            const before = decodeDoc(this.withShotSets(withServerOnlyFields(undoDelta(this.target, delta).doc, confirmed), restored), this.projectId, this.deps.urls);
            return { stepId, label: group.label, before, after: await this.readLocal(), changed: changedIds(delta) };
        });
    }

    /** Whether the next undo takes back exactly this AI step. */
    isNewestStep(stepId: number): boolean {
        const step = this.steps.get(stepId);
        return Boolean(step && this.history.newest() === step.delta);
    }

    /**
     * Undoes an AI step that is not the newest (the turn card's Undo): its inverse, where fields still hold what the
     * AI wrote, applied as a new step of its own (so it can be undone in turn) and synced as an ordinary changeset.
     */
    undoRemoteStep(stepId: number, label: string): Promise<RemoteStep | null> {
        return this.exclusive(async () => {
            const step = this.steps.get(stepId);
            if (!step) return null;
            const before = await this.readLocal();
            const view = this.historyDoc();
            const result = undoDelta(view, step.delta);
            if (result.skipped.length > 0) this.deps.onNotice?.(EDITED_ELSEWHERE);
            const shots = this.queueShotWrites(view, result.doc);
            await this.writeMirror(decodeDoc(this.shownDoc(result.doc), this.projectId, this.deps.urls), true);
            const local = await this.readLocal();
            const next = encodeDoc(local, { urls: this.deps.urls, confirmed: this.shownDoc(this.record.confirmed), previous: result.doc });
            const edits = diffDocs(this.target, next);
            this.target = next;
            // The step of its own also puts the shots back when it is undone in turn.
            const delta = mergeDeltas([edits]);
            for (const { sceneId, from, to } of shots) {
                const key = `scene:${sceneId}`;
                const entity = (delta.entities[key] ??= { op: "patch", fields: {} });
                if (entity.op === "patch") entity.fields[SHOTS] = { b: from, a: to };
            }
            if (isEmptyDelta(delta)) return null;
            this.record.pending = mergeDeltas([this.record.pending, withoutShots(delta)]);
            this.record.label = label;
            this.persistSoon();
            this.scheduleFlush();
            this.history.record(delta);
            const newId = this.nextId++;
            this.steps.set(newId, { delta, label });
            this.emitState();
            return { stepId: newId, label, before, after: local, changed: changedIds(delta) };
        });
    }

    private settleRevisionWaiters(): void {
        const revision = this.complete;
        for (const waiter of [...this.revisionWaiters]) if (revision >= waiter.revision) waiter.done(true);
    }

    async dispose(): Promise<void> {
        this.disposed = true;
        for (const waiter of this.finalWaiters.values()) waiter.reject(new Error(FINAL_VIDEO_CLOSED));
        this.finalWaiters.clear();
        for (const waiter of [...this.revisionWaiters]) waiter.done(false);
        for (const name of ["flushTimer", "pollTimer", "retryTimer", "persistTimer"] as const) this.clearTimer(name);
        this.unsubscribeNetwork?.();
        await this.chain.catch(() => undefined);
        await this.persist();
    }

    // ── internals: load and capture ───────────────────────

    private async load(): Promise<void> {
        const stored = await this.deps.store.get<SyncRecord>("sync", this.projectId);
        if (stored && stored.version === 1 && stored.serverId === this.deps.serverId) {
            this.record = stored;
            this.complete = stored.confirmed.revision;
            const expected = rebase(stored.confirmed, [...(stored.inflight ? [stored.inflight.sent] : []), stored.pending]).doc;
            if (!(await this.deps.mirror.hasProject(this.projectId))) {
                // The working copy is gone but the record is not: rebuild it from the record. Diffing an empty
                // project against it would send a delete of every row.
                await this.writeMirror(decodeDoc(expected, this.projectId, this.deps.urls), false);
            }
            const local = await this.readLocal();
            this.target = encodeDoc(local, { urls: this.deps.urls, confirmed: stored.confirmed, previous: expected });
            // A write that reached the mirror but not the record (a crash in between) is recovered here.
            const missed = diffDocs(expected, this.target);
            if (!isEmptyDelta(missed)) this.record.pending = mergeDeltas([this.record.pending, missed]);
            return;
        }
        const answer = await this.deps.api.request<DocumentJson>("GET", `/v1/projects/${encodeURIComponent(this.deps.serverId)}/document`);
        const confirmed = await ingestDocument(answer.body);
        this.complete = confirmed.revision;
        this.record = { version: 1, serverId: this.deps.serverId, confirmed, pending: emptyDelta(), inflight: null, conflicts: [], snapshot: null, storm: 0, label: "Edit", savedAt: this.deps.clock.now() };
        const local = decodeDoc(confirmed, this.projectId, this.deps.urls);
        if (await this.deps.mirror.hasProject(this.projectId)) {
            // A working copy without its record (a failed write): it may hold edits the server never got. The server's
            // document wins, and this device's version stays available as "Keep my version as a copy".
            const found = await this.readLocal();
            if (normalizedProject(found) !== normalizedProject(local)) {
                this.record.snapshot = { at: this.deps.clock.now(), doc: found };
                this.record.conflicts.push({
                    entity: "project", id: "project", label: "This project", reason: "refused", at: this.deps.clock.now(),
                    message: "This device had a version of this project that may include edits OpenNan never got. Keep it as a copy to compare.",
                });
            }
        }
        await this.writeMirror(local, false);
        this.target = encodeDoc(await this.readLocal(), { urls: this.deps.urls, confirmed, previous: confirmed });
        const drift = diffDocs(confirmed, this.target);
        if (!isEmptyDelta(drift)) this.record.pending = drift;
        await this.persist();
    }

    private async readLocal(): Promise<LocalDoc> {
        const state = await this.deps.mirror.snapshot(this.projectId);
        return { meta: state.meta, tracks: state.tracks, clips: state.clips, scenes: state.scenes, library: state.library ?? [] };
    }

    private async writeMirror(doc: LocalDoc, notify: boolean): Promise<void> {
        await this.deps.mirror.seedProject(this.projectId, { meta: doc.meta, tracks: doc.tracks, clips: doc.clips, scenes: doc.scenes, library: doc.library ?? [] });
        if (notify) this.notifyMirror();
    }

    private notifyMirror(): void {
        void (async () => {
            const local = await this.readLocal();
            this.deps.onChange([
                { type: "project", meta: local.meta },
                { type: "timeline", data: { tracks: local.tracks, clips: local.clips, canUndo: this.history.canUndo(), canRedo: this.history.canRedo() } },
                { type: "scenes", scenes: local.scenes },
            ]);
        })().catch((error) => this.deps.logger?.warn("[cloud] notify failed", error));
    }

    /** Re-encodes the mirror, queues what changed, and returns that delta. Runs inside exclusive(). */
    private async captureWrite(label: string): Promise<Delta> {
        const local = await this.readLocal();
        const next = encodeDoc(local, { urls: this.deps.urls, confirmed: this.shownDoc(this.record.confirmed), previous: this.target });
        const delta = diffDocs(this.target, next);
        this.target = next;
        if (!isEmptyDelta(delta)) {
            this.record.pending = mergeDeltas([this.record.pending, delta]);
            this.record.label = label;
            this.persistSoon();
            this.deps.media.want(this.projectId, localUrlsIn(next));
            this.scheduleFlush();
        }
        this.emitState();
        return delta;
    }

    private travel(direction: "undo" | "redo", steps: number): Promise<void> {
        return this.exclusive(async () => {
            const view = this.historyDoc();
            const result = direction === "undo" ? this.history.undo(view, steps) : this.history.redo(view, steps);
            this.queueShotWrites(view, result.doc);
            await this.writeMirror(decodeDoc(this.shownDoc(result.doc), this.projectId, this.deps.urls), false);
            const local = await this.readLocal();
            const next = encodeDoc(local, { urls: this.deps.urls, confirmed: this.shownDoc(this.record.confirmed), previous: result.doc });
            const delta = diffDocs(this.target, next);
            this.target = next;
            if (!isEmptyDelta(delta)) {
                this.record.pending = mergeDeltas([this.record.pending, delta]);
                this.record.label = direction === "undo" ? "Undo" : "Redo";
                this.persistSoon();
                this.scheduleFlush();
            }
            if (result.skipped.length > 0) this.deps.onNotice?.(EDITED_ELSEWHERE);
            this.emitState();
        });
    }

    /** `confirmed` as the server's newest document: pending edits rebased onto it, the mirror updated when it differs. */
    private async reconcile(confirmed: ServerDoc, extraPending: Delta[] = []): Promise<void> {
        const before = this.target;
        const result = rebase(confirmed, [...extraPending, this.record.pending]);
        this.record.confirmed = confirmed;
        this.record.pending = mergeDeltas(result.pending);
        if (result.conflicts.length > 0) {
            await this.keepSnapshot();
            for (const conflict of result.conflicts) this.addConflict(conflict.key, "deleted", before.entities[conflict.key]);
        }
        // Compared as Studio sees them: a change only in a field Studio never writes (a scene's status or shots) is a
        // change too, and the working copy must show it, or the next edit would pin the old value back.
        const decoded = decodeDoc(this.shownDoc(result.doc), this.projectId, this.deps.urls);
        if (sameDoc(before, result.doc) && normalizedProject(decoded) === normalizedProject(await this.readLocal())) {
            this.target = { ...result.doc, entities: { ...before.entities } };
            this.settleRevisionWaiters();
            return;
        }
        await this.writeMirror(decoded, true);
        const local = await this.readLocal();
        // Encoded against what the working copy shows (a storyboard being put back), so the shown shots are never pinned.
        this.target = encodeDoc(local, { urls: this.deps.urls, confirmed: this.shownDoc(confirmed), previous: result.doc });
        const drift = diffDocs(result.doc, this.target);
        if (!isEmptyDelta(drift)) this.record.pending = mergeDeltas([this.record.pending, drift]);
        this.settleRevisionWaiters();
    }

    private async keepSnapshot(): Promise<void> {
        this.record.snapshot = { at: this.deps.clock.now(), doc: await this.readLocal() };
    }

    private addConflict(key: string, reason: ConflictItem["reason"], fields: Fields | undefined, message?: string): void {
        const { entity, id, label } = describeEntity(key, fields);
        this.record.conflicts.push({
            entity, id, label, reason, at: this.deps.clock.now(),
            message: message ?? `Your edit of ${label} wasn't applied: ${REASON_TEXT[reason]}.`,
        });
    }

    // ── internals: sending ────────────────────────────────

    private scheduleFlush(delay?: number): void {
        if (this.disposed) return;
        const now = this.deps.clock.now();
        if (delay === undefined) {
            this.flushDeadline ??= now + FLUSH_MAX_DELAY_MS;
            delay = Math.max(0, Math.min(FLUSH_DELAY_MS, this.flushDeadline - now));
        }
        this.clearTimer("flushTimer");
        this.flushTimer = this.deps.clock.setTimeout(() => {
            this.flushTimer = null;
            this.flushDeadline = null;
            void this.sendLoop();
        }, delay);
    }

    private sendLoop(): Promise<void> {
        if (this.sending) return this.sending;
        this.sending = (async () => {
            try {
                while (!this.disposed && (await this.sendOne())) {
                    // keep going while there is more to send
                }
            } finally {
                this.sending = null;
                this.emitState();
                for (const resolve of this.idleWaiters.splice(0)) resolve();
            }
        })();
        this.emitState();
        return this.sending;
    }

    private blocked(): boolean {
        return this.signedOut || this.projectGone || this.quota !== null || this.offlineSince !== null || !this.deps.network.online();
    }

    /** Sends one changeset; true when another may follow at once. */
    private async sendOne(): Promise<boolean> {
        if (this.deps.clock.now() < this.notBefore) {
            this.retryLater(this.notBefore - this.deps.clock.now());
            return false;
        }
        if (this.blocked()) {
            if (!this.deps.network.online() && this.offlineSince === null) this.goOffline();
            return false;
        }
        const inflight = await this.exclusive(() => this.prepare());
        if (!inflight) return false;
        try {
            const answer = await this.deps.api.request<Record<string, unknown>>("POST", `/v1/projects/${encodeURIComponent(this.deps.serverId)}/changes`, {
                body: inflight.body,
                headers: { "Idempotency-Key": inflight.key, ...(inflight.ifMatch ? { "If-Match": `"r${this.record.confirmed.revision}"` } : {}) },
            });
            await this.exclusive(() => this.applyAnswer(inflight, answer.body));
            this.failures = 0;
            this.wentOnline();
            return true;
        } catch (error) {
            if (isAbortError(error)) return false;
            return this.exclusive(() => this.onSendError(inflight, error));
        }
    }

    private async prepare(): Promise<Inflight | null> {
        if (this.record.inflight) return this.record.inflight;
        const mediaAdd = [...new Set([...(this.record.toLink ?? []), ...this.deps.media.unlinked(this.projectId)])];
        if (isEmptyDelta(this.record.pending) && mediaAdd.length === 0) return this.prepareServer();
        const built = await buildChangesets(this.record.pending, this.target, { label: this.record.label || "Edit", device: this.deps.deviceName, mediaAdd, maxBytes: this.bodyLimit });
        if (built.refused.length > 0) {
            await this.keepSnapshot();
            for (const refused of built.refused) this.addConflict(refused.key, "refused", this.target.entities[refused.key], `${describeEntity(refused.key, this.target.entities[refused.key]).label}: ${refused.message}`);
            this.record.pending = without(this.record.pending, built.refused.map((r) => r.key));
            await this.reconcile(this.record.confirmed);
            if (built.bodies.length === 0) return this.prepareServer();
        }
        // Changes nothing will ever carry (a track Studio dropped but whose clips it kept) are done, not pending.
        const carried = new Set([...built.keys.flat(), ...built.held, ...built.refused.map((r) => r.key)]);
        const idle = Object.keys(this.record.pending.entities).filter((key) => !carried.has(key));
        if (idle.length > 0) this.record.pending = without(this.record.pending, idle);
        if (built.bodies.length === 0) {
            this.persistSoon();
            // Edits wait (a media upload): server writes don't.
            return this.prepareServer();
        }
        const keys = built.keys[0]!;
        const entityKeys = keys.filter((k) => !k.startsWith("media:"));
        const inflight: Inflight = {
            key: uuid(), body: built.bodies[0]!, keys, sent: pick(this.record.pending, entityKeys), ifMatch: this.record.storm < STORM_LIMIT,
        };
        this.record.pending = without(this.record.pending, entityKeys);
        this.record.inflight = inflight;
        await this.persist();
        return inflight;
    }

    private async applyAnswer(inflight: Inflight, answer: Record<string, unknown>): Promise<void> {
        // This device's own edits are never part of an AI step: they join the open groups' base documents.
        for (const [id, base] of this.groups) this.groups.set(id, applyDelta(base, inflight.sent));
        let confirmed = applyDelta(this.record.confirmed, inflight.sent);
        const entities = { ...confirmed.entities };
        const order = { clip: [...(confirmed.order?.clip ?? [])], scene: [...(confirmed.order?.scene ?? [])] };
        for (const row of (answer.clips as Array<Record<string, unknown>> | undefined) ?? []) {
            const id = String(row.id);
            entities[`clip:${id}`] = await ingestClip(row);
            if (!order.clip.includes(id)) order.clip.push(id);
        }
        for (const row of (answer.scenes as Array<Record<string, unknown>> | undefined) ?? []) {
            const id = String(row.id);
            entities[`scene:${id}`] = await ingestScene(row);
            if (!order.scene.includes(id)) order.scene.push(id);
        }
        if (Array.isArray(answer.tracks)) {
            for (const key of Object.keys(entities)) if (key.startsWith("track:")) delete entities[key];
            for (const row of answer.tracks as Array<Record<string, unknown>>) entities[trackKey(String(row.type), Number(row.index))] = ingestTrack(row);
        }
        if (answer.project && typeof answer.project === "object") entities.project = await ingestProject(answer.project as Record<string, unknown>);
        const deleted = (answer.deleted ?? {}) as { clips?: string[]; scenes?: string[] };
        for (const id of deleted.clips ?? []) delete entities[`clip:${id}`];
        for (const id of deleted.scenes ?? []) delete entities[`scene:${id}`];
        order.clip = order.clip.filter((id) => entities[`clip:${id}`]);
        order.scene = order.scene.filter((id) => entities[`scene:${id}`]);
        const previousRevision = this.record.confirmed.revision;
        confirmed = { revision: typeof answer.revision === "number" ? answer.revision : confirmed.revision, entities, order };
        if (inflight.ifMatch && confirmed.revision === previousRevision + 1 && this.complete === previousRevision) this.complete = confirmed.revision;
        // Other writers landed between our last read and this change (a send without If-Match): the revision we now
        // hold says more than the document does, so read it in full.
        if (!inflight.ifMatch || confirmed.revision > previousRevision + 1) {
            this.fullPull = true;
            this.schedulePoll(0);
        }
        this.record.inflight = null;
        this.record.storm = 0;
        if (inflight.server) this.settleServerWrites(inflight.server, answer);
        const linked = inflight.keys.filter((k) => k.startsWith("media:")).map((k) => k.slice("media:".length));
        if (linked.length > 0) {
            this.record.toLink = (this.record.toLink ?? []).filter((id) => !linked.includes(id));
            this.deps.media.linked(this.projectId, linked);
        }
        await this.reconcile(confirmed);
        if (isEmptyDelta(this.record.pending)) this.record.savedAt = this.deps.clock.now();
        await this.persist();
    }

    private async onSendError(inflight: Inflight, error: unknown): Promise<boolean> {
        if (!isCloudApiError(error)) {
            this.deps.logger?.warn("[cloud] send failed", error);
            this.retryLater();
            return false;
        }
        const e = error as CloudApiError;
        if (inflight.server && e.status !== 412) {
            const handled = await this.onServerSendError(inflight, e);
            if (handled !== null) return handled;
        }
        if (e.status === 412) {
            this.record.storm += 1;
            this.record.inflight = null;
            try {
                const confirmed = await this.fetchDocument();
                this.complete = Math.max(this.complete, confirmed.revision);
                await this.reconcile(confirmed, [inflight.sent]);
            } catch (pullError) {
                // The pull failed: keep the edits queued (in order) and let the error decide.
                this.record.pending = mergeDeltas([inflight.sent, this.record.pending]);
                await this.persist();
                return this.onTransportError(pullError);
            }
            await this.persist();
            return true;
        }
        if (["entity_missing", "clip_locked", "id_in_use", "invalid_change"].includes(e.code)) {
            let keys = refusedKeys(inflight.body, e.details);
            // A clip naming a scene the server no longer has (deleted on another device): the clip stays, without
            // that scene link.
            const missingScenes = keys.filter((k) => k.startsWith("scene:") && !inflight.keys.includes(k)).map((k) => k.slice("scene:".length));
            if (missingScenes.length > 0) {
                const unlinked = this.unlinkScenes(inflight.sent, missingScenes);
                keys = keys.filter((k) => !(k.startsWith("scene:") && missingScenes.includes(k.slice("scene:".length))));
                if (unlinked.length > 0) {
                    this.record.inflight = null;
                    await this.keepSnapshot();
                    for (const key of unlinked) this.addConflict(key, "deleted", this.target.entities[key], `${describeEntity(key, this.target.entities[key]).label} was kept, but the scene it belonged to was deleted on another device.`);
                    await this.reconcile(this.record.confirmed, [inflight.sent]);
                    await this.persist();
                    return true;
                }
            }
            // Only rows this changeset carries can be dropped; a refusal naming nothing it carries drops it whole.
            keys = keys.filter((k) => inflight.keys.includes(k));
            const reason: ConflictItem["reason"] = e.code === "entity_missing" ? "deleted" : e.code === "clip_locked" ? "locked" : e.code === "id_in_use" ? "id-in-use" : "refused";
            const entityKeys = keys.filter((k) => !k.startsWith("media:"));
            const mediaKeys = keys.filter((k) => k.startsWith("media:"));
            this.record.inflight = null;
            if (keys.length === 0) return this.dropWhole(inflight, e);
            if (entityKeys.length > 0) {
                await this.keepSnapshot();
                for (const key of entityKeys) this.addConflict(key, reason, this.target.entities[key] ?? inflight.sent.entities[key] as unknown as Fields);
            }
            if (mediaKeys.length > 0) {
                const gone = mediaKeys.map((k) => k.slice("media:".length));
                this.record.toLink = (this.record.toLink ?? []).filter((id) => !gone.includes(id));
                this.deps.media.linked(this.projectId, gone);
            }
            const rest = without(inflight.sent, entityKeys);
            await this.reconcile(this.record.confirmed, [rest]);
            await this.persist();
            return true;
        }
        if (e.code === "idempotency_key_reused") {
            this.record.inflight = { ...inflight, key: uuid() };
            await this.persist();
            return true;
        }
        if (e.code === "project_data_quota_exceeded" || e.code === "project_too_large") {
            // Nothing was stored: the edits go back in the queue (later ones, deletes that make room, join them).
            this.record.inflight = null;
            this.record.pending = mergeDeltas([inflight.sent, this.record.pending]);
            await this.persist();
            this.quota = "project-data";
            this.emitState();
            this.retryLater(QUOTA_RETRY_MS, () => {
                this.quota = null;
            });
            return false;
        }
        if (e.status === 413 && this.bodyLimit > 64 * 1024) {
            // Larger than the server takes (text that is many bytes per character): split smaller and send again.
            this.bodyLimit = Math.floor(this.bodyLimit / 2);
            this.record.inflight = null;
            this.record.pending = mergeDeltas([inflight.sent, this.record.pending]);
            await this.persist();
            return true;
        }
        if (e.status === 400 || e.status === 413 || e.status === 422) {
            this.record.inflight = null;
            return this.dropWhole(inflight, e);
        }
        return this.onTransportError(e);
    }

    /** Clears the scene link of every clip in `delta` naming one of `sceneIds`; the clip keys it changed. */
    private unlinkScenes(delta: Delta, sceneIds: string[]): string[] {
        const changed: string[] = [];
        for (const [key, change] of Object.entries(delta.entities)) {
            if (!key.startsWith("clip:") || change.op === "delete") continue;
            const link = change.fields.scene_id;
            const current = link && "a" in link ? link.a : this.target.entities[key]?.scene_id;
            if (typeof current === "string" && sceneIds.includes(current)) {
                change.fields.scene_id = { ...(link && "b" in link ? { b: link.b! } : {}), a: null };
                changed.push(key);
            }
        }
        return changed;
    }

    private async dropWhole(inflight: Inflight, error: CloudApiError): Promise<boolean> {
        const count = Object.keys(inflight.sent.entities).length;
        this.deps.logger?.warn(`[cloud] OpenNan refused ${count} edits (${error.code}): ${error.message}`);
        await this.keepSnapshot();
        this.record.conflicts.push({
            entity: "project", id: "project", label: "Edits", reason: "refused", at: this.deps.clock.now(),
            message: `Couldn't save ${count} edit${count === 1 ? "" : "s"}: OpenNan refused them.`,
        });
        await this.reconcile(this.record.confirmed);
        await this.persist();
        return true;
    }

    /** Network, server, rate-limit, auth, and gone answers (a send or a pull). */
    private onTransportError(error: unknown): boolean {
        if (!isCloudApiError(error)) {
            this.retryLater();
            return false;
        }
        const e = error as CloudApiError;
        if (e.status === 0) {
            this.goOffline();
            this.retryLater();
            return false;
        }
        if (e.status === 401) {
            this.signedOut = true;
            this.emitState();
            return false;
        }
        if (e.status === 404 && (e.code === "not_found" || e.code === "project_not_found")) {
            if (!this.projectGone) {
                this.projectGone = true;
                this.record.conflicts.push({
                    entity: "project", id: "project", label: "This project", reason: "deleted", at: this.deps.clock.now(),
                    message: "This project was deleted or moved to the trash on another device. Your edits are kept on this device.",
                });
                this.persistSoon();
            }
            this.emitState();
            return false;
        }
        if (e.status === 429) {
            const wait = (e.retryAfterSeconds ?? 30) * 1000;
            this.notBefore = this.deps.clock.now() + wait;
            this.retryLater(wait);
            return false;
        }
        this.retryLater();
        return false;
    }

    private retryLater(ms?: number, before?: () => void): void {
        if (this.disposed) return;
        this.failures += 1;
        const delay = ms ?? Math.min(RETRY_MAX_MS, 1000 * 2 ** Math.min(6, this.failures - 1)) * (0.75 + this.deps.clock.random() * 0.5);
        this.clearTimer("retryTimer");
        this.retryTimer = this.deps.clock.setTimeout(() => {
            this.retryTimer = null;
            before?.();
            if (this.offlineSince !== null && this.deps.network.online()) void this.probe();
            else void this.sendLoop();
        }, delay);
        this.emitState();
    }

    private goOffline(): void {
        if (this.offlineSince === null) this.offlineSince = this.deps.clock.now();
        this.emitState();
    }

    private wentOnline(): void {
        if (this.offlineSince === null) return;
        this.offlineSince = null;
        this.emitState();
    }

    private onNetwork(): void {
        if (this.deps.network.online()) {
            if (this.offlineSince !== null) void this.probe();
            // Shown again: look now. Hidden: the slower cadence.
            else this.schedulePoll(this.deps.network.visible() ? 0 : undefined);
        } else {
            this.goOffline();
        }
    }

    /** Back online (or maybe): pull, then flush. */
    private async probe(): Promise<void> {
        const ok = await this.pull();
        if (ok) await this.sendLoop();
    }

    // ── internals: pulling ────────────────────────────────

    private async fetchDocument(): Promise<ServerDoc> {
        const answer = await this.deps.api.request<DocumentJson>("GET", `/v1/projects/${encodeURIComponent(this.deps.serverId)}/document`);
        return ingestDocument(answer.body);
    }

    private schedulePoll(delay?: number): void {
        if (this.disposed) return;
        const base = this.aiActive > 0 ? POLL_FLOOR_MS : this.deps.network.visible() ? POLL_VISIBLE_MS : POLL_HIDDEN_MS;
        const now = this.deps.clock.now();
        const wait = Math.max(delay ?? base, this.lastPollAt + POLL_FLOOR_MS - now, this.notBefore - now);
        this.clearTimer("pollTimer");
        this.pollTimer = this.deps.clock.setTimeout(() => {
            this.pollTimer = null;
            void this.pollTick();
        }, wait);
    }

    private async pollTick(): Promise<void> {
        if (this.disposed) return;
        if (this.signedOut || this.projectGone || this.offlineSince !== null || !this.deps.network.online()) {
            this.schedulePoll();
            return;
        }
        if (this.sending || this.record.inflight) {
            this.schedulePoll(1_000);
            return;
        }
        const ok = await this.pull();
        if (ok) this.schedulePoll();
    }

    /** One conditional GET of the document; true when it answered (200 or 304). */
    private async pull(): Promise<boolean> {
        if (this.signedOut || this.projectGone) return false;
        this.lastPollAt = this.deps.clock.now();
        try {
            const full = this.fullPull;
            const answer = await this.deps.api.request<DocumentJson>("GET", `/v1/projects/${encodeURIComponent(this.deps.serverId)}/document`, {
                ...(full ? {} : { headers: { "If-None-Match": `"r${this.record.confirmed.revision}"` } }),
            });
            this.failures = 0;
            this.wentOnline();
            if (answer.status === 304) return true;
            const confirmed = await ingestDocument(answer.body);
            await this.exclusive(async () => {
                if (this.record.inflight || this.sending) return; // the answer of our own changeset will bring it
                // A read answered after a newer change of ours (it left before the flush) is older than what we hold.
                const current = this.record.confirmed.revision;
                if (confirmed.revision < current || (confirmed.revision === current && !full)) return;
                if (full) this.fullPull = false;
                this.complete = Math.max(this.complete, confirmed.revision);
                await this.reconcile(confirmed);
                await this.persist();
            });
            this.emitState();
            if (!isEmptyDelta(this.record.pending)) this.scheduleFlush(0);
            return true;
        } catch (error) {
            if (isAbortError(error)) return false;
            this.onTransportError(error);
            if (!this.signedOut && !this.projectGone && this.offlineSince === null) {
                // A server error or a 429 already set a retry; keep polling slower.
                this.schedulePoll(Math.min(RETRY_MAX_MS, POLL_VISIBLE_MS * 2 ** Math.min(4, this.failures)));
            }
            return false;
        }
    }

    // ── internals: plumbing ───────────────────────────────

    private exclusive<T>(work: () => Promise<T>): Promise<T> {
        const run = this.chain.then(work, work);
        this.chain = run.catch(() => undefined);
        return run;
    }

    private clearTimer(name: "flushTimer" | "pollTimer" | "retryTimer" | "persistTimer"): void {
        if (this[name] !== null) {
            this.deps.clock.clearTimeout(this[name]);
            this[name] = null;
        }
    }

    private persistSoon(): void {
        if (this.persistTimer !== null || this.disposed) return;
        this.persistTimer = this.deps.clock.setTimeout(() => {
            this.persistTimer = null;
            void this.persist();
        }, 250);
    }

    private async persist(): Promise<void> {
        this.clearTimer("persistTimer");
        await this.deps.store.put("sync", this.projectId, this.record);
    }

    private emitState(): void {
        const state = this.state();
        const text = canonical(state.kind === "saved" ? { kind: "saved" } : state);
        if (text === this.lastState) return;
        this.lastState = text;
        this.deps.onState(state);
    }
}
