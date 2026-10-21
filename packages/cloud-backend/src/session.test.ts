import { LocalBackend, createMemoryPersistence, type BackendChange } from "@opennan/timeline-core";
import { FakeClock } from "./clock";
import { IDENTITY_URLS, type UrlMap } from "./codec";
import { MemoryServer } from "./memory-server";
import { CloudProjectSession, EDITED_ELSEWHERE, REMOTE_STEP_LOST, SHOTS_BUSY, SHOTS_BUSY_GAVE_UP, SHOTS_VERSION_LOST, type NetworkStatus, type RemoteStep, type SessionMedia } from "./session";
import { createMemoryStore, type CloudStore } from "./store";
import type { SyncState } from "./types";

const PID = "cloud-p1";
const textClip = (start = 0, end = 4) => ({ trackType: "text", trackIndex: 1, startTime: start, endTime: end, mediaType: "text", textContent: "Hi" });

function network(): NetworkStatus & { set(online: boolean): void; hide(hidden: boolean): void } {
    let isOnline = true;
    let isVisible = true;
    const listeners = new Set<() => void>();
    return {
        online: () => isOnline, visible: () => isVisible,
        subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        set(value) {
            isOnline = value;
            for (const l of listeners) l();
        },
        hide(hidden) {
            isVisible = !hidden;
            for (const l of listeners) l();
        },
    };
}

const media: SessionMedia = { want: () => undefined, unlinked: () => [], linked: () => undefined, progress: () => ({ uploading: 0, uploaded: 0, blocked: null }) };

/** OpenNan's storage as the cloud media allowlist sees it (9c.1: storyboard images are taken only from there). */
const OPENNAN_STORAGE: UrlMap = { ...IDENTITY_URLS, isCloudUrl: (url) => url.startsWith("https://cdn.opennan.com/") && !url.includes("/uploads/temp/") };

async function setup(options: { store?: CloudStore; server?: MemoryServer; clock?: FakeClock; net?: ReturnType<typeof network>; urls?: UrlMap } = {}) {
    const server = options.server ?? new MemoryServer();
    if (!server.projects.has("p1")) server.createProject("p1");
    const clock = options.clock ?? new FakeClock();
    const store = options.store ?? createMemoryStore();
    const net = options.net ?? network();
    const mirror = new LocalBackend({ persistence: createMemoryPersistence() });
    const states: SyncState[] = [];
    const changes: BackendChange[][] = [];
    const notices: string[] = [];
    const opening = CloudProjectSession.open({
        projectId: PID, serverId: "p1", api: server.api(), store, mirror, urls: options.urls ?? IDENTITY_URLS, media, clock, network: net, deviceName: "Test device",
        onChange: (c) => changes.push(c), onState: (s) => states.push(s), onNotice: (m) => notices.push(m),
    });
    await clock.advance(0);
    const session = await opening;
    const view = mirror.withoutHistory();
    const write = <T>(label: string, op: () => Promise<T>) => session.write(label, true, op);
    return { server, clock, store, net, mirror, view, session, states, changes, notices, write };
}

describe("CloudProjectSession", () => {
    it("opens from the server's document and starts saved", async () => {
        const { session, mirror, server } = await setup();
        expect((await mirror.loadProject(PID)).name).toBe("Cloud project");
        expect(session.state().kind).toBe("saved");
        expect(server.calls[0]).toMatchObject({ method: "GET", path: "/v1/projects/p1/document" });
    });

    it("sends a write 400 ms later as one changeset with If-Match and an Idempotency-Key", async () => {
        const { session, view, write, clock, server } = await setup();
        const [clip] = await write("Add text", () => view.createClips(PID, [textClip()]));
        expect(session.state().kind).toBe("syncing");
        await clock.advance(399);
        expect(server.changeCalls()).toHaveLength(0);
        await clock.advance(1);
        const [call] = server.changeCalls();
        expect(call!.headers["if-match"]).toBe('"r0"');
        expect(call!.headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
        expect((call!.body as { label: string; device: string }).label).toBe("Add text");
        expect(server.projects.get("p1")!.clips.get(clip!.id)).toMatchObject({ text_content: "Hi", track_type: "text" });
        expect(session.revision()).toBe(1);
        expect(session.state().kind).toBe("saved");
    });

    it("flushes at most 3 s after the first of a run of writes, and merges them", async () => {
        const { view, write, clock, server } = await setup();
        const [clip] = await write("Add", () => view.createClips(PID, [textClip()]));
        for (let i = 1; i <= 10; i++) {
            await clock.advance(300);
            await write("Move", () => view.updateClips(PID, [{ clipId: clip!.id, startTime: i / 10, endTime: 4 }]));
        }
        expect(server.changeCalls().length).toBe(1);
        expect(server.projects.get("p1")!.clips.get(clip!.id)!.start_time).toBe(0.9);
        await clock.advance(400);
        expect(server.projects.get("p1")!.clips.get(clip!.id)!.start_time).toBe(1);
    });

    it("replays a changeset whose answer was lost with the same Idempotency-Key, applied once", async () => {
        const { session, view, write, clock, server } = await setup();
        server.dropNextAnswers(1);
        await write("Add", () => view.createClips(PID, [textClip()]));
        await clock.advance(400);
        expect(session.state().kind).toBe("offline");
        await clock.advance(1_500);
        const calls = server.changeCalls();
        expect(calls.length).toBe(2);
        expect(calls[1]!.headers["idempotency-key"]).toBe(calls[0]!.headers["idempotency-key"]);
        expect(server.projects.get("p1")!.clips.size).toBe(1);
        expect(server.projects.get("p1")!.revision).toBe(1);
        expect(session.state().kind).toBe("saved");
    });

    it("rebases on 412: a remote edit of another field and the local edit both stand", async () => {
        const { session, view, write, clock, server, mirror } = await setup();
        const [clip] = await write("Add", () => view.createClips(PID, [textClip()]));
        await clock.advance(400);
        server.remoteChange("p1", { clips: { patch: [{ id: clip!.id, opacity: 0.3 }] } });
        await write("Move", () => view.updateClips(PID, [{ clipId: clip!.id, startTime: 1, endTime: 5 }]));
        await clock.advance(400);
        const statuses = server.changeCalls().map((c) => c.status);
        expect(statuses).toEqual([200, 412, 200]);
        expect(server.projects.get("p1")!.clips.get(clip!.id)).toMatchObject({ opacity: 0.3, start_time: 1, end_time: 5 });
        expect((await mirror.loadTimeline(PID)).clips[0]).toMatchObject({ opacity: 0.3, startTime: 1 });
        expect(session.state().kind).toBe("saved");
    });

    it("sends without If-Match after three 412s in a row on one changeset", async () => {
        const { view, write, clock, server } = await setup();
        server.storm412(5);
        await write("Add", () => view.createClips(PID, [textClip()]));
        await clock.advance(400);
        const calls = server.changeCalls();
        expect(calls.map((c) => c.status)).toEqual([412, 412, 412, 200]);
        expect(calls[3]!.headers["if-match"]).toBeUndefined();
    });

    it("turns an edit of a row deleted elsewhere into a conflict, keeping a snapshot", async () => {
        const { session, view, write, clock, server, mirror } = await setup();
        const [a, b] = await write("Add", () => view.createClips(PID, [textClip(), textClip(5, 6)]));
        await clock.advance(400);
        server.remoteChange("p1", { clips: { delete: [a!.id] } });
        await write("Move both", () => view.updateClips(PID, [{ clipId: a!.id, startTime: 2, endTime: 4 }, { clipId: b!.id, startTime: 6, endTime: 7 }]));
        await clock.advance(400);
        const state = session.state();
        expect(state.kind).toBe("conflict");
        expect(state.kind === "conflict" && state.items[0]).toMatchObject({ entity: "clip", id: a!.id, reason: "deleted" });
        expect(server.projects.get("p1")!.clips.get(b!.id)!.start_time).toBe(6);
        expect((await mirror.loadTimeline(PID)).clips.map((c) => c.id)).toEqual([b!.id]);
        expect(session.conflictSnapshot()!.clips.map((c) => c.id)).toContain(a!.id);
        session.acknowledgeConflicts();
        expect(session.state().kind).toBe("saved");
    });

    it("drops only the locked clip's edit on clip_locked and sends the rest", async () => {
        const { session, view, write, clock, server } = await setup();
        const [a, b] = await write("Add", () => view.createClips(PID, [textClip(), textClip(5, 6)]));
        await clock.advance(400);
        server.projects.get("p1")!.clips.get(a!.id)!.locked = true;
        await write("Move", () => view.updateClips(PID, [{ clipId: a!.id, startTime: 2, endTime: 4 }, { clipId: b!.id, startTime: 6, endTime: 7 }]));
        await clock.advance(400);
        expect(server.changeCalls().map((c) => c.status)).toEqual([200, 409, 200]);
        expect(server.projects.get("p1")!.clips.get(b!.id)!.start_time).toBe(6);
        expect(server.projects.get("p1")!.clips.get(a!.id)!.start_time).toBe(0);
        const state = session.state();
        expect(state.kind === "conflict" && state.items.map((i) => i.reason)).toEqual(["locked"]);
    });

    it("keeps editing offline, persists the queue, and drains it after a restart once online", async () => {
        const store = createMemoryStore();
        const server = new MemoryServer();
        const net = network();
        const first = await setup({ store, server, net });
        await first.write("Add", () => first.view.createClips(PID, [textClip()]));
        net.set(false);
        await first.write("Add more", () => first.view.createClips(PID, [textClip(5, 6)]));
        await first.clock.advance(5_000);
        expect(first.session.state()).toMatchObject({ kind: "offline" });
        expect(server.projects.get("p1")!.clips.size).toBe(0);
        await first.session.dispose();
        // Restart: a new session over the same store and the persisted mirror.
        const mirror = first.mirror;
        const clock = new FakeClock();
        const states: SyncState[] = [];
        const opening = CloudProjectSession.open({
            projectId: PID, serverId: "p1", api: server.api(), store, mirror, urls: IDENTITY_URLS, media, clock, network: net, deviceName: "Test",
            onChange: () => undefined, onState: (s) => states.push(s),
        });
        await clock.advance(0);
        const second = await opening;
        await clock.advance(1_000);
        expect(server.projects.get("p1")!.clips.size).toBe(0);
        net.set(true);
        await clock.advance(2_000);
        expect(server.projects.get("p1")!.clips.size).toBe(2);
        expect(second.state().kind).toBe("saved");
    });

    it("recovers a write that reached the mirror but not the record", async () => {
        const store = createMemoryStore();
        const server = new MemoryServer();
        const first = await setup({ store, server });
        await first.view.createClips(PID, [textClip()]); // straight on the mirror: no session write, no record
        await first.session.dispose();
        const clock = new FakeClock();
        const opening = CloudProjectSession.open({
            projectId: PID, serverId: "p1", api: server.api(), store, mirror: first.mirror, urls: IDENTITY_URLS, media, clock, network: network(), deviceName: "T",
            onChange: () => undefined, onState: () => undefined,
        });
        await clock.advance(0);
        await opening;
        await clock.advance(1_000);
        expect(server.projects.get("p1")!.clips.size).toBe(1);
    });

    it("polls with If-None-Match: 304 when nothing changed, a remote edit reaches the mirror and the controller", async () => {
        const { view, write, clock, server, mirror, changes, net } = await setup();
        const [clip] = await write("Add", () => view.createClips(PID, [textClip()]));
        await clock.advance(400);
        const reads = () => server.calls.filter((c) => c.path.endsWith("/document"));
        await clock.advance(3_000);
        expect(reads().at(-1)).toMatchObject({ status: 304, headers: { "if-none-match": '"r1"' } });
        server.remoteChange("p1", { clips: { patch: [{ id: clip!.id, text_content: "From the phone" }] } });
        await clock.advance(3_000);
        expect(reads().at(-1)!.status).toBe(200);
        expect((await mirror.loadTimeline(PID)).clips[0]!.textContent).toBe("From the phone");
        await clock.advance(0);
        expect(changes.flat().some((c) => c.type === "timeline" && c.data.clips[0]!.textContent === "From the phone")).toBe(true);
        // Hidden: every 15 s.
        net.hide(true);
        const before = reads().length;
        await clock.advance(14_000);
        expect(reads().length).toBe(before);
        await clock.advance(2_000);
        expect(reads().length).toBe(before + 1);
    });

    it("backs off after failures and honours Retry-After on a 429", async () => {
        const { clock, server } = await setup();
        const reads = () => server.calls.filter((c) => c.path.endsWith("/document")).length;
        server.failNext(429, "rate_limited", undefined, { retryAfterSeconds: 20, path: /document/ });
        await clock.advance(3_000);
        const after429 = reads();
        await clock.advance(15_000);
        expect(reads()).toBe(after429);
        await clock.advance(10_000);
        expect(reads()).toBeGreaterThan(after429);
    });

    it("undoes only its own fields and syncs the undo forward", async () => {
        const { session, view, write, clock, server, notices } = await setup();
        const [clip] = await write("Add", () => view.createClips(PID, [textClip()]));
        await write("Edit", () => view.updateClips(PID, [{ clipId: clip!.id, opacity: 0.5, textContent: "Mine" }]));
        await clock.advance(400);
        server.remoteChange("p1", { clips: { patch: [{ id: clip!.id, text_content: "Theirs" }] } });
        await clock.advance(3_000);
        await session.undo(1);
        await clock.advance(400);
        expect(server.projects.get("p1")!.clips.get(clip!.id)).toMatchObject({ opacity: 1, text_content: "Theirs" });
        expect(notices).toEqual([EDITED_ELSEWHERE]);
        await session.redo(1);
        await clock.advance(400);
        expect(server.projects.get("p1")!.clips.get(clip!.id)).toMatchObject({ opacity: 0.5 });
        expect(server.calls.some((c) => c.path.includes("/timeline/undo"))).toBe(false);
    });

    it("stops on 401 with the queue kept, and resumes after sign-in", async () => {
        const { session, view, write, clock, server } = await setup();
        server.failNext(401, "invalid_api_key");
        await write("Add", () => view.createClips(PID, [textClip()]));
        await clock.advance(400);
        expect(session.state()).toMatchObject({ kind: "signed-out", pending: 1 });
        session.resume();
        await clock.advance(10);
        expect(server.projects.get("p1")!.clips.size).toBe(1);
    });

    it("shows Storage full on project data quota and keeps the edits", async () => {
        const { session, view, write, clock, server } = await setup();
        server.failNext(403, "project_data_quota_exceeded");
        await write("Add", () => view.createClips(PID, [textClip()]));
        await clock.advance(400);
        expect(session.state()).toMatchObject({ kind: "over-quota", reason: "project-data", pending: 1 });
        await clock.advance(5 * 60_000);
        expect(server.projects.get("p1")!.clips.size).toBe(1);
    });

    it("drops a changeset the server refuses as a whole, and says so", async () => {
        const { session, view, write, clock, server, mirror } = await setup();
        server.failNext(400, "invalid_request", undefined, { path: /changes/ });
        await write("Add", () => view.createClips(PID, [textClip()]));
        await clock.advance(400);
        const state = session.state();
        expect(state.kind === "conflict" && state.items[0]!.message).toBe("Couldn't save 1 edit: OpenNan refused them.");
        expect((await mirror.loadTimeline(PID)).clips).toEqual([]);
        expect(session.conflictSnapshot()!.clips).toHaveLength(1);
        expect(server.projects.get("p1")!.clips.size).toBe(0);
    });

    it("does not keep a track removal the server can't take as pending forever", async () => {
        const { session, view, write, clock, server, mirror } = await setup();
        const tracks = (await mirror.loadTimeline(PID)).tracks;
        await write("Add track", () => view.updateTracks(PID, [...tracks, { type: "text", index: 1, label: "T1", muted: false, locked: false, visible: true, volume: 1 }]));
        await write("Add", () => view.createClips(PID, [textClip()]));
        await clock.advance(400);
        await write("Drop track, keep clip", () => view.updateTracks(PID, tracks));
        await clock.advance(400);
        expect(server.projects.get("p1")!.tracks.some((t) => t.type === "text")).toBe(true);
        expect(server.projects.get("p1")!.clips.size).toBe(1);
        expect(session.state().kind).toBe("saved");
    });

    it("rebuilds a lost working copy from the record instead of deleting the project", async () => {
        const store = createMemoryStore();
        const server = new MemoryServer();
        const first = await setup({ store, server });
        await first.write("Add", () => first.view.createClips(PID, [textClip(), textClip(5, 6)]));
        await first.clock.advance(400);
        expect(server.projects.get("p1")!.clips.size).toBe(2);
        await first.session.dispose();
        // The working copy's document is gone (cleared site data, a failed write) but the sync record survived.
        const mirror = new LocalBackend({ persistence: createMemoryPersistence() });
        const clock = new FakeClock();
        const opening = CloudProjectSession.open({
            projectId: PID, serverId: "p1", api: server.api(), store, mirror, urls: IDENTITY_URLS, media, clock, network: network(), deviceName: "T",
            onChange: () => undefined, onState: () => undefined,
        });
        await clock.advance(0);
        await opening;
        await clock.advance(5_000);
        expect(server.projects.get("p1")!.clips.size).toBe(2);
        expect((await mirror.loadTimeline(PID)).clips).toHaveLength(2);
    });

    it("keeps a working copy found without its record as a conflict snapshot before taking the server's", async () => {
        const server = new MemoryServer();
        server.createProject("p1");
        const mirror = new LocalBackend({ persistence: createMemoryPersistence() });
        await mirror.createClips(PID, [textClip()]); // edits on this device the record never saw
        const clock = new FakeClock();
        const opening = CloudProjectSession.open({
            projectId: PID, serverId: "p1", api: server.api(), store: createMemoryStore(), mirror, urls: IDENTITY_URLS, media, clock, network: network(), deviceName: "T",
            onChange: () => undefined, onState: () => undefined,
        });
        await clock.advance(0);
        const session = await opening;
        expect((await mirror.loadTimeline(PID)).clips).toHaveLength(0);
        expect(session.state().kind).toBe("conflict");
        expect(session.conflictSnapshot()!.clips).toHaveLength(1);
    });

    describe("review findings", () => {
        const SID = "11111111-2222-4333-8444-555555555555";

        it("a clip naming a scene deleted elsewhere becomes one conflict, not a loop", async () => {
            const server = new MemoryServer();
            server.createProject("p1");
            server.remoteChange("p1", { scenes: { create: [{ id: SID, caption: "S" }] } });
            const { session, view, write, clock } = await setup({ server });
            server.remoteChange("p1", { scenes: { delete: [SID] } });
            await write("Add", () => view.createClips(PID, [{ ...textClip(), sceneId: SID } as never]));
            await clock.advance(400);
            for (let i = 0; i < 20; i++) await clock.advance(10);
            expect(server.changeCalls().length).toBeLessThan(5);
            const state = session.state();
            expect(state.kind).toBe("conflict");
        });

        it("shows a remote change of a field Studio never writes, and never pins the old value back", async () => {
            const server = new MemoryServer();
            server.createProject("p1");
            server.remoteChange("p1", { scenes: { create: [{ id: SID, caption: "S" }] } });
            const { session, view, write, mirror } = await setup({ server });
            const p = server.projects.get("p1")!;
            Object.assign(p.scenes.get(SID)!, { status: "video_ready" });
            p.revision++;
            await session.pullNow();
            expect((await mirror.loadScenes(PID))[0]!.status).toBe("video_ready");
            await write("Add", () => view.createClips(PID, [textClip()]));
            await session.flush();
            expect(p.scenes.get(SID)!.extras_json ?? null).toBeNull();
        });

        it("ignores a pull answered after a newer changeset", async () => {
            const server = new MemoryServer();
            server.createProject("p1");
            const base = server.api();
            let release: (() => void) | null = null;
            let holdNext = false;
            const api = { ...base, request: async (m: never, path: string, req: { headers?: Record<string, string> } = {}) => {
                const answer = await base.request(m, path, req as never);
                if (holdNext && path.endsWith("/document") && req.headers?.["If-None-Match"]) {
                    holdNext = false;
                    await new Promise<void>((r) => (release = r));
                }
                return answer;
            } };
            const clock = new FakeClock();
            const mirror = new LocalBackend({ persistence: createMemoryPersistence() });
            const opening = CloudProjectSession.open({
                projectId: PID, serverId: "p1", api: api as never, store: createMemoryStore(), mirror, urls: IDENTITY_URLS, media, clock, network: network(), deviceName: "t",
                onChange: () => undefined, onState: () => undefined,
            });
            await clock.advance(0);
            const session = await opening;
            server.remoteChange("p1", { project: { name: "Renamed on the phone" } });
            holdNext = true;
            const pulling = session.pullNow();
            await clock.advance(0);
            await session.write("Add", true, () => mirror.withoutHistory().createClips(PID, [textClip()]));
            await session.flush();
            release!();
            await pulling;
            expect((await mirror.loadTimeline(PID)).clips).toHaveLength(1);
            expect(session.revision()).toBe(server.projects.get("p1")!.revision);
        });

        it("a project data refusal puts the edits back in the queue: later edits still go when room returns", async () => {
            const { session, view, write, clock, server } = await setup();
            server.failNext(403, "project_data_quota_exceeded", undefined, { path: /changes/ });
            await write("Add", () => view.createClips(PID, [textClip()]));
            await clock.advance(400);
            expect(session.state()).toMatchObject({ kind: "over-quota", reason: "project-data" });
            await write("Add more", () => view.createClips(PID, [textClip(5, 6)]));
            await clock.advance(5 * 60_000);
            await clock.advance(1_000);
            expect(server.projects.get("p1")!.clips.size).toBe(2);
            expect(server.changeCalls().filter((c) => c.status === 200)).toHaveLength(1);
        });

        it("pulls in full after a send without If-Match moved the revision more than one step", async () => {
            const { session, view, write, clock, server, mirror } = await setup();
            const [clip] = await write("Add", () => view.createClips(PID, [textClip()]));
            await clock.advance(400);
            server.remoteChange("p1", { clips: { patch: [{ id: clip!.id, text_content: "Theirs" }] } });
            server.storm412(3);
            await write("Move", () => view.updateClips(PID, [{ clipId: clip!.id, opacity: 0.5 }]));
            await clock.advance(400);
            await clock.advance(5_000);
            expect((await mirror.loadTimeline(PID)).clips[0]).toMatchObject({ textContent: "Theirs", opacity: 0.5 });
            expect(session.revision()).toBe(server.projects.get("p1")!.revision);
        });
    });
});

describe("CloudProjectSession and the AI director (phase 9b)", () => {
    const reads = (server: MemoryServer) => server.calls.filter((c) => c.path.endsWith("/document")).length;

    async function withTwoClips() {
        const env = await setup();
        const [a, b] = await env.write("Add", () => env.view.createClips(PID, [textClip(0, 4), textClip(5, 9)]));
        await env.clock.advance(400);
        expect(env.session.revision()).toBe(1);
        return { ...env, a: a!, b: b! };
    }

    it("polls every 1.5 s while AI runs and every 3 s again after", async () => {
        const { session, clock, server } = await setup();
        await clock.advance(3_000);
        const start = reads(server);
        session.setAiActive(1);
        await clock.advance(1_500);
        await clock.advance(1_500);
        await clock.advance(1_500);
        expect(reads(server) - start).toBeGreaterThanOrEqual(3);
        session.setAiActive(-1);
        await clock.advance(1_500);
        const after = reads(server);
        await clock.advance(2_999);
        expect(reads(server)).toBe(after);
        await clock.advance(1);
        expect(reads(server)).toBe(after + 1);
    });

    it("pullSoon reads at once but never twice inside 1.5 s", async () => {
        const { session, clock, server } = await setup();
        await clock.advance(3_000);
        const start = reads(server);
        session.pullSoon();
        await clock.advance(0);
        expect(reads(server)).toBe(start + 1);
        session.pullSoon();
        await clock.advance(1_000);
        expect(reads(server)).toBe(start + 1);
        await clock.advance(500);
        expect(reads(server)).toBe(start + 2);
    });

    it("an AI turn is one undo step: undo keeps a later human edit and restores the rest", async () => {
        const { session, clock, server, mirror, write, view, a, b } = await withTwoClips();
        const group = session.beginRemoteGroup();
        const { revision } = server.remoteChange("p1", { clips: { patch: [{ id: a.id, text_content: "AI a", opacity: 0.5 }, { id: b.id, text_content: "AI b" }] } }) as { revision: number };
        const recording = session.recordRemoteGroup(group, { label: "AI: Retitle", toRevision: revision, entities: { scenes: [], clips: [a.id, b.id], tracks: false, project: false } });
        await clock.advance(0);
        const step = await recording;
        expect(step).toMatchObject({ label: "AI: Retitle", changed: { clips: expect.arrayContaining([a.id, b.id]), scenes: [] } });
        expect(step!.before.clips.find((c) => c.id === a.id)!.textContent).toBe("Hi");
        expect((await mirror.loadTimeline(PID)).clips.find((c) => c.id === b.id)!.textContent).toBe("AI b");
        // The person edits clip a's text after the AI.
        await write("Edit", () => view.updateClips(PID, [{ clipId: a.id, textContent: "Mine" }]));
        await clock.advance(400);
        // Undo the person's edit, then the AI step.
        await session.undo(1);
        await session.undo(1);
        await clock.advance(400);
        const clips = (await mirror.loadTimeline(PID)).clips;
        expect(clips.find((c) => c.id === b.id)!.textContent).toBe("Hi");
        expect(clips.find((c) => c.id === a.id)!.textContent).toBe("Hi");
        expect(server.projects.get("p1")!.clips.get(a.id)!.opacity).toBe(1);
        expect(server.projects.get("p1")!.clips.get(b.id)!.text_content).toBe("Hi");
    });

    it("forward rule: a field edited after the AI (and not undone) is kept, with the notice", async () => {
        const { session, clock, server, mirror, write, view, a, notices } = await withTwoClips();
        const group = session.beginRemoteGroup();
        const { revision } = server.remoteChange("p1", { clips: { patch: [{ id: a.id, text_content: "AI a", opacity: 0.5 }] } }) as { revision: number };
        const recording = session.recordRemoteGroup(group, { label: "AI: x", toRevision: revision, entities: { scenes: [], clips: [a.id], tracks: false, project: false } });
        await clock.advance(0);
        const step = await recording;
        await write("Edit", () => view.updateClips(PID, [{ clipId: a.id, textContent: "Mine" }]));
        await clock.advance(400);
        // The AI step is not the newest: undo it by its id.
        expect(session.isNewestStep(step!.stepId)).toBe(false);
        const undone = await session.undoRemoteStep(step!.stepId, "Undo AI: x");
        expect(undone).not.toBeNull();
        await clock.advance(400);
        const clip = (await mirror.loadTimeline(PID)).clips.find((c) => c.id === a.id)!;
        expect(clip.textContent).toBe("Mine");
        expect(clip.opacity).toBe(1);
        expect(notices).toContain(EDITED_ELSEWHERE);
        // The undo is itself one step: undoing it brings the AI's opacity back.
        await session.undo(1);
        expect((await mirror.loadTimeline(PID)).clips.find((c) => c.id === a.id)!.opacity).toBe(0.5);
    });

    it("this device's own changes during the turn are never part of the AI step", async () => {
        const { session, clock, server, mirror, write, view, a, b } = await withTwoClips();
        const group = session.beginRemoteGroup();
        await write("Mine", () => view.updateClips(PID, [{ clipId: a.id, textContent: "Mine" }]));
        await clock.advance(400);
        const { revision } = server.remoteChange("p1", { clips: { patch: [{ id: b.id, text_content: "AI b" }] } }) as { revision: number };
        const recording = session.recordRemoteGroup(group, { label: "AI", toRevision: revision, entities: { scenes: [], clips: [a.id, b.id], tracks: false, project: false } });
        await clock.advance(0);
        const step = await recording;
        expect(step!.changed.clips).toEqual([b.id]);
        await session.undo(1);
        const clips = (await mirror.loadTimeline(PID)).clips;
        expect(clips.find((c) => c.id === a.id)!.textContent).toBe("Mine");
        expect(clips.find((c) => c.id === b.id)!.textContent).toBe("Hi");
    });

    it("a clip the AI made is deleted by the undo; a clip it deleted comes back", async () => {
        const { session, clock, server, mirror, a } = await withTwoClips();
        const group = session.beginRemoteGroup();
        const made = globalThis.crypto.randomUUID();
        const { revision } = server.remoteChange("p1", { clips: { create: [{ id: made, track_type: "text", track_index: 1, start_time: 10, end_time: 12, media_type: "text", text_content: "Title" }], delete: [a.id] } }) as { revision: number };
        const recording = session.recordRemoteGroup(group, { label: "AI", toRevision: revision, entities: { scenes: [], clips: [made, a.id], tracks: false, project: false } });
        await clock.advance(0);
        await recording;
        expect((await mirror.loadTimeline(PID)).clips.map((c) => c.id)).toContain(made);
        await session.undo(1);
        await clock.advance(400);
        const ids = (await mirror.loadTimeline(PID)).clips.map((c) => c.id);
        expect(ids).not.toContain(made);
        expect(ids).toContain(a.id);
        expect(server.projects.get("p1")!.clips.has(made)).toBe(false);
        expect(server.projects.get("p1")!.clips.has(a.id)).toBe(true);
    });

    it("gives up with a notice when the revision never arrives, and records nothing for an empty step", async () => {
        const { session, clock, notices, a } = await withTwoClips();
        const group = session.beginRemoteGroup();
        const recording = session.recordRemoteGroup(group, { label: "AI", toRevision: 99, entities: { scenes: [], clips: [a.id], tracks: false, project: false } });
        await clock.advance(30_000);
        expect(await recording).toBeNull();
        expect(notices).toContain(REMOTE_STEP_LOST);
        const empty = session.beginRemoteGroup();
        const nothing = session.recordRemoteGroup(empty, { label: "AI", toRevision: 1, entities: { scenes: [], clips: [a.id], tracks: false, project: false } });
        await clock.advance(0);
        expect(await nothing).toBeNull();
        expect(session.canUndo()).toBe(true); // the person's own "Add" only
    });

    it("a revision this device's own answer skipped is not taken as arrived: the step waits for the full read", async () => {
        const server = new MemoryServer();
        server.createProject("p1");
        const inner = server.api();
        let aiRevision = 0;
        let clipId = "";
        let onAi: (revision: number) => void = () => undefined;
        server.api = () => ({
            baseUrl: inner.baseUrl,
            async request(method, path, request) {
                // The AI writes just before this device's send without If-Match (after a 412 storm) lands.
                if (method === "POST" && path.endsWith("/changes") && !request?.headers?.["If-Match"] && clipId && !aiRevision) {
                    aiRevision = (server.remoteChange("p1", { clips: { patch: [{ id: clipId, opacity: 0.25 }] } }) as { revision: number }).revision;
                    onAi(aiRevision);
                }
                return inner.request(method, path, request);
            },
        });
        const env = await setup({ server });
        const [a, b] = await env.write("Add", () => env.view.createClips(PID, [textClip(0, 4), textClip(5, 9)]));
        await env.clock.advance(400);
        clipId = b!.id;
        const group = env.session.beginRemoteGroup();
        let step: Promise<RemoteStep | null> | null = null;
        // The host waits for the AI's revision while this device's own answer comes back past it.
        onAi = (revision) => {
            step = env.session.recordRemoteGroup(group, { label: "AI", toRevision: revision, entities: { scenes: [], clips: [a!.id, b!.id], tracks: false, project: false } });
        };
        server.storm412(3);
        await env.write("Mine", () => env.view.updateClips(PID, [{ clipId: a!.id, textContent: "Mine" }]));
        await env.clock.advance(400);
        await env.clock.advance(5_000);
        expect(aiRevision).toBeGreaterThan(0);
        const recorded = await step!;
        expect(recorded?.changed.clips).toEqual([b!.id]);
    });
});

describe("CloudProjectSession server writes and storyboard undo (phase 9c)", () => {
    const sceneRow = (server: MemoryServer, id: string) => server.projects.get("p1")!.scenes.get(id)!;
    const shotWrites = (server: MemoryServer) => server.changeCalls().map((c) => (c.body as { scenes?: { patch?: Array<Record<string, unknown>> } }).scenes?.patch ?? [])
        .flat().filter((p) => "shots_version" in p || "clear_shots" in p);

    /** A scene, then an AI storyboard drawn on it recorded as one step (base: the scene before). */
    async function withDrawnScene(options: { drawBefore?: boolean } = {}) {
        const env = await setup({ urls: OPENNAN_STORAGE });
        const scene = await env.write("Add scene", () => env.view.addScene(PID, { afterOrder: -1, caption: "Opening", duration: 6 } as never));
        await env.clock.advance(400);
        if (options.drawBefore) {
            const { revision } = env.server.drawStoryboard("p1", scene!.id, 2);
            const waiting = env.session.waitForRevision(revision);
            await env.clock.advance(1_500);
            await waiting;
        }
        const base = sceneRow(env.server, scene!.id).shots_version as string;
        const group = env.session.beginRemoteGroup();
        const { revision } = env.server.drawStoryboard("p1", scene!.id, 3);
        const recording = env.session.recordRemoteGroup(group, { label: "AI: Storyboard", toRevision: revision, entities: { scenes: [scene!.id], clips: [], tracks: false, project: false } });
        await env.clock.advance(0);
        const step = await recording;
        const drawn = sceneRow(env.server, scene!.id).shots_version as string;
        return { ...env, sceneId: scene!.id, base, drawn, step };
    }

    it("a storyboard-only AI step is one undo step; undo puts the earlier shots back, redo the drawn ones", async () => {
        const { session, clock, server, mirror, sceneId, base, drawn, step } = await withDrawnScene();
        expect(step).toMatchObject({ label: "AI: Storyboard", changed: { scenes: [sceneId], clips: [] } });
        // What undo shows (the controller's "before") is the scene without its storyboard.
        expect(step!.before.scenes[0]!.storyboardSheets).toBeUndefined();
        expect(step!.after.scenes[0]!.storyboardSheets?.[0]?.panels).toHaveLength(3);
        expect((await mirror.loadScenes(PID))[0]!.storyboardSheets?.[0]?.panels).toHaveLength(3);
        await session.undo(1);
        // Shown at once, before OpenNan answers.
        expect((await mirror.loadScenes(PID))[0]!.storyboardSheets).toBeUndefined();
        await clock.advance(400);
        // The scene had no storyboard (OpenNan never keeps an empty one): the undo clears.
        expect(shotWrites(server)).toEqual([{ id: sceneId, clear_shots: true }]);
        expect(sceneRow(server, sceneId)).toMatchObject({ shots: [], storyboard_sheets: [], shots_version: base });
        // The working copy never pins its shown shots into Studio's extras.
        expect(String(sceneRow(server, sceneId).extras_json ?? "")).not.toMatch(/keyframe_url|panel-/);
        expect((await mirror.loadScenes(PID))[0]!.storyboardSheets).toBeUndefined();
        await session.redo(1);
        await clock.advance(400);
        expect(sceneRow(server, sceneId).shots_version).toBe(drawn);
        expect((await mirror.loadScenes(PID))[0]!.storyboardSheets?.[0]?.panels).toHaveLength(3);
        // A Studio-made scene shows OpenNan's shots (its own empty breakdown never hides them).
        expect(JSON.parse((await mirror.loadScenes(PID))[0]!.shotBreakdown!)).toHaveLength(3);
        expect(String(sceneRow(server, sceneId).extras_json ?? "")).not.toMatch(/keyframe_url|panel-/);
        expect(session.state().kind).toBe("saved");
        // An undo again (the empty version is still never kept) clears again.
        await session.undo(1);
        await clock.advance(400);
        expect(sceneRow(server, sceneId)).toMatchObject({ shots: [], shots_version: base });
    });

    it("an edit made while a storyboard is being put back never pins the shown shots", async () => {
        const { session, clock, server, sceneId, write, view } = await withDrawnScene();
        server.busyScenes.add(sceneId);
        await session.undo(1);
        await write("Caption", () => view.updateScene(PID, sceneId, { caption: "Mine" }));
        await clock.advance(400);
        expect(sceneRow(server, sceneId).caption).toBe("Mine");
        expect(String(sceneRow(server, sceneId).extras_json ?? "")).not.toMatch(/keyframe_url|panel-/);
        server.busyScenes.delete(sceneId);
        await clock.advance(10_000);
        expect(sceneRow(server, sceneId).shots).toEqual([]);
        expect(String(sceneRow(server, sceneId).extras_json ?? "")).not.toMatch(/keyframe_url|panel-/);
    });

    it("a base that had shots and is no longer kept leaves the panels, with a notice; other edits still sync", async () => {
        const { session, clock, server, sceneId, drawn, notices, mirror } = await withDrawnScene({ drawBefore: true });
        server.forgetShots(sceneId);
        await session.undo(1);
        await clock.advance(400);
        expect(sceneRow(server, sceneId).shots_version).toBe(drawn);
        expect(notices).toContain(SHOTS_VERSION_LOST);
        expect(session.state().kind).toBe("saved");
        // The working copy shows what OpenNan kept (the drawing), not the storyboard it could not put back.
        expect((await mirror.loadScenes(PID))[0]!.storyboardSheets?.[0]?.panels).toHaveLength(3);
        expect(String(sceneRow(server, sceneId).extras_json ?? "")).not.toMatch(/keyframe_url|panel-/);
    });

    it("a busy scene's shots go back once its step finishes (tried every 10 s), and are given up after 5 minutes", async () => {
        const { session, clock, server, sceneId, base, notices } = await withDrawnScene();
        server.busyScenes.add(sceneId);
        await session.undo(1);
        await clock.advance(400);
        expect(notices).toContain(SHOTS_BUSY);
        expect(sceneRow(server, sceneId).shots_version).not.toBe(base);
        await clock.advance(10_000);
        expect(shotWrites(server).length).toBeGreaterThanOrEqual(2);
        server.busyScenes.delete(sceneId);
        await clock.advance(10_000);
        expect(sceneRow(server, sceneId).shots_version).toBe(base);

        const again = await withDrawnScene();
        again.server.busyScenes.add(again.sceneId);
        await again.session.undo(1);
        await again.clock.advance(5 * 60_000 + 20_000);
        expect(again.notices).toContain(SHOTS_BUSY_GAVE_UP);
        const tries = shotWrites(again.server).length;
        await again.clock.advance(60_000);
        expect(shotWrites(again.server).length).toBe(tries);
        expect(again.session.state().kind).toBe("saved");
    });

    it("forward rule: a storyboard drawn again after the AI's (elsewhere) is kept, with the edited-elsewhere notice", async () => {
        const { session, clock, server, sceneId, notices } = await withDrawnScene();
        const { revision } = server.drawStoryboard("p1", sceneId, 4);
        const waiting = session.waitForRevision(revision);
        await clock.advance(1_500);
        await waiting;
        const redrawn = sceneRow(server, sceneId).shots_version;
        await session.undo(1);
        await clock.advance(400);
        expect(shotWrites(server)).toEqual([]);
        expect(sceneRow(server, sceneId).shots_version).toBe(redrawn);
        expect(notices).toContain(EDITED_ELSEWHERE);
    });

    it("the card's Undo of an older storyboard step restores the shots and is itself undoable", async () => {
        const { session, clock, server, sceneId, base, drawn, step, write, view } = await withDrawnScene();
        await write("Caption", () => view.updateScene(PID, sceneId, { caption: "Mine" }));
        await clock.advance(400);
        expect(session.isNewestStep(step!.stepId)).toBe(false);
        const undone = await session.undoRemoteStep(step!.stepId, "Undo AI: Storyboard");
        expect(undone).not.toBeNull();
        // The step of its own shows the storyboard gone (so the editor records it as an undo step).
        expect(undone!.before.scenes[0]!.storyboardSheets).toBeDefined();
        expect(undone!.after.scenes[0]!.storyboardSheets).toBeUndefined();
        await clock.advance(400);
        expect(sceneRow(server, sceneId)).toMatchObject({ shots_version: base, caption: "Mine" });
        await session.undo(1);
        await clock.advance(400);
        expect(sceneRow(server, sceneId).shots_version).toBe(drawn);
    });

    it("queues the project's final video in a changeset of its own after the pending edits, and resolves when it is answered", async () => {
        const { session, clock, server, write, view } = await setup();
        await write("Add", () => view.createClips(PID, [textClip()]));
        const url = "https://cdn.opennan.com/uploads/media/0123456789abcdef01234567/export.mp4";
        let done = false;
        const setting = session.setFinalVideo(url).then(() => (done = true));
        await clock.advance(0);
        await clock.advance(400);
        await setting;
        expect(done).toBe(true);
        const bodies = server.changeCalls().map((c) => c.body as Record<string, unknown>);
        expect(bodies).toHaveLength(2);
        expect(bodies[0]!.project).toBeUndefined();
        expect(bodies[1]).toMatchObject({ project: { final_video_url: url }, scenes: { patch: [] }, clips: { create: [] } });
        expect(server.projects.get("p1")!.project.final_video_url).toBe(url);
        expect(session.state().kind).toBe("saved");
    });

    it("sends the final video and a storyboard being put back in separate changesets (a refusal of one never drops the other)", async () => {
        const { session, clock, server, sceneId } = await withDrawnScene();
        await session.undo(1);
        server.failNext(422, "invalid_request", undefined, { path: /\/changes$/ });
        const setting = session.setFinalVideo("https://cdn.opennan.com/uploads/media/x/e.mp4");
        setting.catch(() => undefined);
        await clock.advance(400);
        await expect(setting).rejects.toThrow();
        await clock.advance(400);
        expect(sceneRow(server, sceneId).shots).toEqual([]);
        const bodies = server.changeCalls().map((c) => c.body as { project?: unknown; scenes: { patch: unknown[] } });
        expect(bodies.every((b) => !(b.project && b.scenes.patch.length > 0))).toBe(true);
    });

    it("sends the final video while edits wait for a media upload", async () => {
        const { session, clock, server, write, view } = await setup();
        await write("Add", () => view.createClips(PID, [{ trackType: "video", trackIndex: 1, startTime: 0, endTime: 2, mediaUrl: "opennan-local://media/not-uploaded", mediaType: "video" }]));
        const setting = session.setFinalVideo("https://cdn.opennan.com/uploads/media/x/e.mp4");
        await clock.advance(400);
        await setting;
        expect(server.projects.get("p1")!.project.final_video_url).toBe("https://cdn.opennan.com/uploads/media/x/e.mp4");
    });

    it("a refused final video rejects with OpenNan's reason and never drops an edit; a queued one survives a restart", async () => {
        const env = await setup();
        env.server.failNext(400, "invalid_request", undefined, { path: /\/changes$/ });
        const refused = env.session.setFinalVideo("https://cdn.opennan.com/uploads/media/x/e.mp4");
        refused.catch(() => undefined);
        await env.clock.advance(0);
        await expect(refused).rejects.toThrow();
        expect(env.session.state().kind).toBe("saved");

        const store = createMemoryStore();
        const server = new MemoryServer();
        const net = network();
        const first = await setup({ store, server, net });
        net.set(false);
        const pending = first.session.setFinalVideo("https://cdn.opennan.com/uploads/media/x/later.mp4");
        pending.catch(() => undefined);
        await first.clock.advance(400);
        expect(first.session.state()).toMatchObject({ kind: "offline", pending: 1 });
        await first.session.dispose();
        await expect(pending).rejects.toThrow(/closed/);
        net.set(true);
        const second = await setup({ store, server, net });
        await second.clock.advance(400);
        expect(server.projects.get("p1")!.project.final_video_url).toBe("https://cdn.opennan.com/uploads/media/x/later.mp4");
    });
});
