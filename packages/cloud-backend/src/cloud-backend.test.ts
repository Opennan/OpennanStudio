import { LocalBackend, createMemoryPersistence, type LocalPersistence } from "@opennan/timeline-core";
import { describeTimelineBackendContract } from "@opennan/timeline-core/testing";
import { startFakeOpenNan, type FakeOpenNan } from "@opennan/provider-opennan/testing";
import { createCloudApi, type CloudApi } from "./api";
import { OpenNanCloudBackend, cloudProjectId, CloudStorageFullError, SHOT_EDITS_REFUSED, SHOT_MOVES_LATER } from "./cloud-backend";
import { normalizedProject, type LocalDoc } from "./codec";
import { baseClip, richProject } from "./fixtures";
import { createBlobMediaHost } from "./media";
import { BackendRouter } from "./router";
import { createShare } from "./shares";
import { createMemoryStore } from "./store";

let fake: FakeOpenNan;
let key: string;

beforeAll(async () => {
    fake = await startFakeOpenNan();
    key = fake.mintKey();
});
afterAll(async () => fake.close());

interface Device {
    backend: OpenNanCloudBackend;
    mirror: LocalBackend;
    api: CloudApi;
    local: LocalBackend;
    localPersistence: LocalPersistence;
}

function device(name = "Test device", options: { apiKey?: string; fetch?: typeof globalThis.fetch; uploadFetch?: typeof globalThis.fetch } = {}): Device {
    const api = createCloudApi({ baseUrl: fake.url, apiKey: () => options.apiKey ?? key, ...(options.fetch ? { fetch: options.fetch } : {}) });
    // One blob store for this device: the local projects and the cloud working copies share it (as on the web).
    const localPersistence = createMemoryPersistence();
    const mirrorPersistence: LocalPersistence = {
        ...createMemoryPersistence(),
        putBlob: (id, blob) => localPersistence.putBlob(id, blob),
        getBlob: (id) => localPersistence.getBlob(id),
        deleteBlob: (id) => localPersistence.deleteBlob!(id),
    };
    const mirror = new LocalBackend({ persistence: mirrorPersistence });
    const local = new LocalBackend({ persistence: localPersistence });
    const media = createBlobMediaHost({ api, readBlob: (url) => mirror.readMedia(url), ...(options.uploadFetch ? { fetch: options.uploadFetch } : {}) });
    const backend = new OpenNanCloudBackend({
        api, store: createMemoryStore(), mirror, media, deviceName: name,
        isCloudUrl: (url) => url.startsWith(`${fake.url}/files/`) && !url.includes("/uploads/temp/"),
    });
    return { backend, mirror, api, local, localPersistence };
}

async function newCloudProject(api: CloudApi, name = "Cloud"): Promise<string> {
    const answer = await api.request<{ id: string }>("POST", "/v1/projects", { body: { name } });
    return cloudProjectId(answer.body.id);
}

async function until(check: () => boolean | Promise<boolean>, ms = 10_000): Promise<void> {
    const end = Date.now() + ms;
    while (!(await check())) {
        if (Date.now() > end) throw new Error("timed out");
        await new Promise((r) => setTimeout(r, 25));
    }
}

const serverId = (projectId: string) => projectId.slice("cloud-".length);
const serverProject = (projectId: string) => fake.cloud.state().projects.find((p) => p.id === serverId(projectId))!;

describeTimelineBackendContract("OpenNanCloudBackend (fake OpenNan)", async () => {
    const d = device();
    const projectId = await newCloudProject(d.api);
    return { backend: d.backend, projectId, cleanup: () => d.backend.dispose() };
});

describe("OpenNanCloudBackend against the fake OpenNan server", () => {
    it("saves a 10d/11-era local project to OpenNan and opens it on another device, byte for byte", async () => {
        const a = device("MacBook");
        const blob = new Blob([new Uint8Array(4096).fill(3)], { type: "video/mp4" });
        const media = await a.local.uploadFile("trip", blob, "video");
        const project = richProject(media.url);
        await a.local.seedProject("trip", { meta: project.meta, tracks: project.tracks, clips: project.clips, scenes: project.scenes, library: project.library });
        const original = await a.local.snapshot("trip");
        const progress: string[] = [];
        const summary = await a.backend.saveLocalProject(a.local, "trip", (p) => progress.push(p.stage));
        expect(progress).toEqual(expect.arrayContaining(["checking", "uploading", "creating", "syncing", "done"]));
        expect(summary.kind).toBe("cloud");
        expect(await a.local.hasProject("trip")).toBe(false);
        // This device keeps playing its own file.
        expect((await a.backend.loadTimeline(summary.id)).clips.find((c) => c.label === "Intro.mp4")!.mediaUrl).toBe(media.url);
        await a.backend.flush(summary.id);
        expect(serverProject(summary.id)).toMatchObject({ origin: "studio" });

        const b = device("Phone");
        await b.backend.loadProject(summary.id);
        const remote = fake.cloud.state().assets[0]!.media_url;
        const seen = await b.mirror.snapshot(summary.id);
        const asDoc = (s: typeof original): LocalDoc => ({ meta: s.meta, tracks: s.tracks, clips: s.clips, scenes: s.scenes, library: s.library ?? [] });
        expect(normalizedProject(asDoc(seen)).split(remote).join(media.url)).toBe(normalizedProject(asDoc(original)));
        await a.backend.dispose();
        await b.backend.dispose();
    });

    it("deduplicates the same file across projects (no second upload)", async () => {
        const a = device();
        const bytes = new Uint8Array(2048).fill(9);
        for (const id of ["one", "two"]) {
            const media = await a.local.uploadFile(id, new Blob([bytes], { type: "audio/wav" }), "audio");
            await a.local.createClips(id, [baseClip("x", { trackType: "audio", trackIndex: 1, mediaType: "audio", mediaUrl: media.url })].map(({ id: _id, projectId: _p, ...c }) => c));
            await a.backend.saveLocalProject(a.local, id);
        }
        const assets = fake.cloud.state().assets.filter((asset) => asset.size_bytes === 2048);
        expect(assets).toHaveLength(1);
        expect(assets[0]!.project_ids.length).toBeGreaterThanOrEqual(1);
        await a.backend.dispose();
    });

    it("sends a file over the single-PUT limit in parts with their ETags", async () => {
        const a = device();
        fake.cloud.setUploadLimits({ single_put_max_bytes: 1024, part_size: 512 });
        try {
            const media = await a.local.uploadFile("parts", new Blob([new Uint8Array(1500).fill(5)], { type: "video/mp4" }), "video");
            await a.local.saveToLibrary("parts", media);
            await a.backend.saveLocalProject(a.local, "parts");
            const upload = fake.cloud.state().uploads.find((u) => u.size_bytes === 1500)!;
            expect(upload).toMatchObject({ completed: true, transport: "multipart" });
            expect(fake.cloud.state().assets.find((asset) => asset.size_bytes === 1500)).toBeTruthy();
        } finally {
            fake.cloud.setUploadLimits({ single_put_max_bytes: 95 * 1024 * 1024, part_size: 32 * 1024 * 1024 });
            await a.backend.dispose();
        }
    });

    it("refuses Save to OpenNan when the media doesn't fit the storage left", async () => {
        const a = device();
        fake.cloud.setStorage({ media_limit_bytes: 1000 });
        try {
            const media = await a.local.uploadFile("big", new Blob([new Uint8Array(5000)], { type: "video/mp4" }), "video");
            await a.local.saveToLibrary("big", media);
            await expect(a.backend.saveLocalProject(a.local, "big")).rejects.toBeInstanceOf(CloudStorageFullError);
            expect(await a.local.hasProject("big")).toBe(true);
        } finally {
            fake.cloud.setStorage({ media_limit_bytes: 2 * 1024 ** 3 });
        }
    });

    it("merges two devices editing one project at once", async () => {
        const a = device("A");
        const b = device("B");
        const projectId = await newCloudProject(a.api, "Shared");
        const [clip] = await a.backend.createClips(projectId, [{ trackType: "text", trackIndex: 1, startTime: 0, endTime: 4, mediaType: "text", textContent: "Hello" }]);
        await a.backend.flush(projectId);
        await b.backend.loadProject(projectId);
        await a.backend.updateClips(projectId, [{ clipId: clip!.id, opacity: 0.4 }]);
        await b.backend.updateClips(projectId, [{ clipId: clip!.id, textContent: "Bonjour" }]);
        await Promise.all([a.backend.flush(projectId), b.backend.flush(projectId)]);
        await a.backend.flush(projectId);
        const row = serverProject(projectId).clips.find((c) => c.id === clip!.id)!;
        expect(row).toMatchObject({ opacity: 0.4, text_content: "Bonjour" });
        await until(async () => (await a.backend.loadTimeline(projectId)).clips[0]!.textContent === "Bonjour");
        await a.backend.dispose();
        await b.backend.dispose();
    });

    it("downloads a local copy with fresh ids that works with the server gone", async () => {
        const a = device();
        const media = await a.local.uploadFile("src", new Blob([new Uint8Array(1024).fill(1)], { type: "image/png" }), "image");
        await a.local.createClips("src", [{ trackType: "video", trackIndex: 2, startTime: 0, endTime: 3, mediaType: "image", mediaUrl: media.url }]);
        const cloud = await a.backend.saveLocalProject(a.local, "src");
        const copy = await a.backend.downloadLocalCopy(cloud.id, a.local);
        expect(copy.name).toMatch(/\(local copy\)$/);
        const original = await a.backend.loadTimeline(cloud.id);
        const local = await a.local.loadTimeline(copy.id);
        expect(local.clips[0]!.id).not.toBe(original.clips[0]!.id);
        expect(local.clips[0]!.mediaUrl).not.toBe(media.url);
        expect(await a.local.readMedia(local.clips[0]!.mediaUrl!)).not.toBeNull();
        await a.backend.dispose();
    });

    it("lists cloud projects most recently edited first, pages them, and trashes and restores", async () => {
        const a = device();
        const ids = [await newCloudProject(a.api, "L1"), await newCloudProject(a.api, "L2"), await newCloudProject(a.api, "L3")];
        await a.backend.updateProject(ids[0]!, { name: "L1 edited" });
        const first = await a.backend.listCloudProjects({ limit: 2 });
        expect(first.projects[0]!.name).toBe("L1 edited");
        expect(first.nextCursor).not.toBeNull();
        const second = await a.backend.listCloudProjects({ limit: 2, cursor: first.nextCursor });
        expect(second.projects.length).toBeGreaterThan(0);
        await a.backend.deleteProject(ids[1]!);
        expect((await a.backend.listCloudProjects({ limit: 100 })).projects.map((p) => p.id)).not.toContain(ids[1]);
        const trash = await a.backend.listCloudProjects({ state: "deleted", limit: 100 });
        expect(trash.projects.find((p) => p.id === ids[1])!.deletedAt).toBeGreaterThan(0);
        await a.backend.restoreProject(ids[1]!);
        expect((await a.backend.listCloudProjects({ limit: 100 })).projects.map((p) => p.id)).toContain(ids[1]);
        await a.backend.deleteProjectPermanently(ids[2]!);
        expect((await a.backend.listCloudProjects({ state: "deleted", limit: 100 })).projects.map((p) => p.id)).not.toContain(ids[2]);
        await a.backend.dispose();
    });

    it("reads the storage meter", async () => {
        const a = device();
        const storage = await a.backend.storage();
        expect(storage.mediaLimitBytes).toBe(2 * 1024 ** 3);
        expect(storage.projectDataLimitBytes).toBe(250 * 1024 ** 2);
    });

    it("keeps my version as a local copy after a conflict", async () => {
        const a = device();
        const projectId = await newCloudProject(a.api, "Conflicted");
        const [clip] = await a.backend.createClips(projectId, [{ trackType: "text", trackIndex: 1, startTime: 0, endTime: 4, mediaType: "text", textContent: "Mine" }]);
        await a.backend.flush(projectId);
        fake.cloud.deleteEntity(serverId(projectId), "clip", clip!.id);
        await a.backend.updateClips(projectId, [{ clipId: clip!.id, textContent: "Edited" }]);
        await a.backend.flush(projectId);
        expect(a.backend.syncState(projectId)!.kind).toBe("conflict");
        const copy = await a.backend.keepConflictCopy(projectId, a.local);
        expect((await a.local.loadTimeline(copy.id)).clips[0]!.textContent).toBe("Edited");
        expect(a.backend.syncState(projectId)!.kind).toBe("conflict");
        a.backend.acknowledgeConflicts(projectId);
        await until(() => a.backend.syncState(projectId)!.kind !== "conflict");
        await a.backend.dispose();
    });
});

describe("OpenNanCloudBackend review fixes", () => {
    it("a quick close and reopen never runs two sessions on one working copy", async () => {
        const a = device();
        const projectId = await newCloudProject(a.api, "Reopen");
        await a.backend.createClips(projectId, [{ trackType: "text", trackIndex: 1, startTime: 0, endTime: 2, mediaType: "text", textContent: "one" }]);
        a.backend.closeProject(projectId);
        await a.backend.createClips(projectId, [{ trackType: "text", trackIndex: 1, startTime: 3, endTime: 4, mediaType: "text", textContent: "two" }]);
        await a.backend.flush(projectId);
        expect(serverProject(projectId).clips.map((c) => c.text_content).sort()).toEqual(["one", "two"]);
        expect((await a.backend.loadTimeline(projectId)).clips).toHaveLength(2);
        await a.backend.dispose();
    });

    it("Save to OpenNan names files OpenNan can't take, and starts nothing", async () => {
        const a = device();
        const media = await a.local.uploadFile("mkv", new Blob([new Uint8Array(10)], { type: "video/x-matroska" }), "video");
        await a.local.saveToLibrary("mkv", media);
        const plan = await a.backend.planSave(a.local, "mkv");
        expect(plan.fits).toBe(false);
        expect(plan.refused[0]).toMatch(/Convert it to MP4/);
        await expect(a.backend.saveLocalProject(a.local, "mkv")).rejects.toThrow(/can't go to OpenNan/);
        expect(await a.local.hasProject("mkv")).toBe(true);
    });

    it("edits made to the local project while it uploads move with it", async () => {
        let edit: (() => Promise<void>) | null = null;
        const uploadFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
            if (edit) {
                const run = edit;
                edit = null;
                await run();
            }
            return fetch(input, init);
        }) as typeof fetch;
        const a = device("x", { uploadFetch });
        const media = await a.local.uploadFile("busy", new Blob([new Uint8Array(64).fill(2)], { type: "audio/wav" }), "audio");
        await a.local.saveToLibrary("busy", media);
        edit = async () => {
            await a.local.createClips("busy", [{ trackType: "text", trackIndex: 1, startTime: 0, endTime: 2, mediaType: "text", textContent: "added during the upload" }]);
        };
        const summary = await a.backend.saveLocalProject(a.local, "busy");
        expect(serverProject(summary.id).clips.map((c) => c.text_content)).toEqual(["added during the upload"]);
        await a.backend.dispose();
    });

    it("a local copy never keeps a file it could not copy", async () => {
        const a = device();
        const media = await a.local.uploadFile("src2", new Blob([new Uint8Array(32).fill(4)], { type: "image/png" }), "image");
        await a.local.createClips("src2", [{ trackType: "video", trackIndex: 2, startTime: 0, endTime: 1, mediaType: "image", mediaUrl: media.url }]);
        const cloud = await a.backend.saveLocalProject(a.local, "src2");
        (a.backend as unknown as { options: { media: { copyToLocal?: unknown } } }).options.media.copyToLocal = async () => {
            throw new Error("disk full");
        };
        const before = (await a.local.listProjects()).length;
        await expect(a.backend.downloadLocalCopy(cloud.id, a.local)).rejects.toThrow(/could not be copied/);
        expect((await a.local.listProjects()).length).toBe(before);
        expect(await a.local.readMedia(media.url)).not.toBeNull();
        await a.backend.dispose();
    });
});

describe("OpenNanCloudBackend media cache pins (9a.1)", () => {
    it("tells the media host which local files open projects use, and lets go of a closed project's", async () => {
        const api = createCloudApi({ baseUrl: fake.url, apiKey: () => key });
        const mirror = new LocalBackend({ persistence: createMemoryPersistence() });
        const pins: string[][] = [];
        const media = createBlobMediaHost({ api, readBlob: async () => null, pin: (urls) => pins.push([...urls].sort()) });
        const backend = new OpenNanCloudBackend({ api, store: createMemoryStore(), mirror, media, deviceName: "Pins", isCloudUrl: () => false });
        const a = await newCloudProject(api, "A");
        const b = await newCloudProject(api, "B");
        await backend.loadProject(a);
        await backend.loadProject(b);
        const cached = (n: number) => `opennan-local://media/c-${n}`;
        await backend.createClips(a, [{ trackType: "video", trackIndex: 2, startTime: 0, endTime: 2, mediaType: "video", mediaUrl: cached(1) }]);
        await backend.createClips(b, [{ trackType: "video", trackIndex: 2, startTime: 0, endTime: 2, mediaType: "video", mediaUrl: cached(2) }]);
        await until(() => JSON.stringify(pins.at(-1)) === JSON.stringify([cached(1), cached(2)]));
        backend.closeProject(a);
        await until(() => JSON.stringify(pins.at(-1)) === JSON.stringify([cached(2)]));
        await backend.dispose();
    });
});

describe("OpenNanCloudBackend cache re-check on open (9a.1)", () => {
    it("asks the cache again for every cloud file when a project opens, and follows a file downloaded again under a new id", async () => {
        const api = createCloudApi({ baseUrl: fake.url, apiKey: () => key });
        const mirror = new LocalBackend({ persistence: createMemoryPersistence() });
        const answers = ["opennan-local://media/c-first", "opennan-local://media/c-second"];
        const asked: string[] = [];
        const media = createBlobMediaHost({
            api, readBlob: async () => null,
            cache: async (url) => {
                asked.push(url);
                return answers.length > 1 ? answers.shift()! : answers[0]!;
            },
        });
        const isCloudUrl = (url: string) => url.startsWith(`${fake.url}/files/`);
        const backend = new OpenNanCloudBackend({ api, store: createMemoryStore(), mirror, media, deviceName: "Cache", isCloudUrl });
        const projectId = await newCloudProject(api, "Cached");
        const remote = `${fake.url}/files/results/cached-${Date.now()}.mp4`;
        fake.cloud.remoteChange(serverId(projectId), { clips: { create: [{ id: globalThis.crypto.randomUUID(), track_type: "video", track_index: 2, start_time: 0, end_time: 2, media_url: remote }] } });
        const mediaUrl = async () => (await mirror.snapshot(projectId)).clips[0]?.mediaUrl;
        await backend.loadProject(projectId);
        await until(async () => (await mediaUrl()) === "opennan-local://media/c-first");
        backend.closeProject(projectId);
        await new Promise((r) => setTimeout(r, 50));
        // The cache evicted the first copy meanwhile: opening again asks for it and takes the new one.
        await backend.loadProject(projectId);
        await until(async () => (await mediaUrl()) === "opennan-local://media/c-second");
        expect(asked).toEqual([remote, remote]);
        await backend.dispose();
    });
});

describe("OpenNanCloudBackend review fixes (9a.1)", () => {
    function cachingDevice(copy: (url: string) => Promise<string>, cache: (url: string) => Promise<string>) {
        const api = createCloudApi({ baseUrl: fake.url, apiKey: () => key });
        const mirror = new LocalBackend({ persistence: createMemoryPersistence() });
        const local = new LocalBackend({ persistence: createMemoryPersistence() });
        const asked: string[] = [];
        const media = createBlobMediaHost({
            api, readBlob: async () => null,
            cache: async (url) => {
                asked.push(url);
                return cache(url);
            },
            copyToLocal: async (url) => copy(url),
        });
        const isCloudUrl = (url: string) => url.startsWith(`${fake.url}/files/`);
        const backend = new OpenNanCloudBackend({ api, store: createMemoryStore(), mirror, media, deviceName: "Review", isCloudUrl });
        return { api, mirror, local, backend, asked };
    }

    it("downloads a cloud file that arrives while the project is open (an AI result, another device's edit) and shows it from the cache (9b)", async () => {
        const d = cachingDevice(async (url) => url, async (url) => `opennan-local://media/c-${url.length}`);
        const projectId = await newCloudProject(d.api, "Arriving");
        await d.backend.loadProject(projectId);
        const sceneId = globalThis.crypto.randomUUID();
        const panel = `${fake.url}/files/results/panel-${Date.now()}.png`;
        fake.cloud.remoteChange(serverId(projectId), { scenes: { create: [{ id: sceneId, caption: "Night" }] } });
        fake.cloud.setShots(serverId(projectId), sceneId, [{ index: 0, description: "wide", duration: 2, image_url: panel }]);
        fake.cloud.bump(serverId(projectId));
        d.backend.pullSoon(projectId);
        await until(() => d.asked.includes(panel), 15_000);
        await until(async () => ((await d.mirror.snapshot(projectId)).scenes[0]?.shotBreakdown ?? "").includes(`opennan-local://media/c-${panel.length}`), 15_000);
        await d.backend.dispose();
    });

    it("an undo on a project whose scenes have shots from OpenNan keeps those shots (never writes them into Studio's extras)", async () => {
        const d = cachingDevice(async (url) => url, async (url) => `opennan-local://media/c-${url.length}`);
        const projectId = await newCloudProject(d.api, "Planned shots");
        const sceneId = globalThis.crypto.randomUUID();
        fake.cloud.remoteChange(serverId(projectId), { scenes: { create: [{ id: sceneId, caption: "Planned" }] } });
        fake.cloud.setShots(serverId(projectId), sceneId, [{ index: 0, description: "wide", duration: 2 }, { index: 1, description: "close", duration: 3 }]);
        fake.cloud.bump(serverId(projectId));
        await d.backend.loadProject(projectId);
        const shotsOf = async () => JSON.parse((await d.mirror.snapshot(projectId)).scenes.find((s) => s.id === sceneId)?.shotBreakdown ?? "[]") as unknown[];
        await until(async () => (await shotsOf()).length === 2);
        await d.backend.createClips(projectId, [{ trackType: "text", trackIndex: 1, startTime: 0, endTime: 2, mediaType: "text", textContent: "x" }]);
        await d.backend.undo(projectId, 1);
        expect(await shotsOf()).toHaveLength(2);
        await d.backend.flush(projectId);
        expect(String(serverProject(projectId).scenes[0]!.extras_json ?? "")).not.toContain("shotBreakdown");
        await d.backend.dispose();
    });

    it("a local copy takes an evicted cache file from OpenNan again instead of failing", async () => {
        let evicted = false;
        const d = cachingDevice(
            async (url) => {
                if (url === "opennan-local://media/c-old" && evicted) throw new Error("This media file is not on this device.");
                return url.startsWith("http") ? "opennan-local://media/copied-from-remote" : "opennan-local://media/copied-from-cache";
            },
            async () => "opennan-local://media/c-old",
        );
        const projectId = await newCloudProject(d.api, "Evicted");
        const remote = `${fake.url}/files/results/evicted-${Date.now()}.mp4`;
        fake.cloud.remoteChange(serverId(projectId), { clips: { create: [{ id: globalThis.crypto.randomUUID(), track_type: "video", track_index: 2, start_time: 0, end_time: 2, media_url: remote }] } });
        await d.backend.loadProject(projectId);
        await until(async () => (await d.mirror.snapshot(projectId)).clips[0]?.mediaUrl === "opennan-local://media/c-old");
        evicted = true;
        const copy = await d.backend.downloadLocalCopy(projectId, d.local);
        expect((await d.local.snapshot(copy.id)).clips[0]!.mediaUrl).toBe("opennan-local://media/copied-from-remote");
        await d.backend.dispose();
    });

    it("a local copy of web-planned shots can edit them (readOnly is dropped)", async () => {
        const d = cachingDevice(async (url) => url, async () => "opennan-local://media/c-x");
        const projectId = await newCloudProject(d.api, "Planned");
        const sceneId = globalThis.crypto.randomUUID();
        fake.cloud.remoteChange(serverId(projectId), { scenes: { create: [{ id: sceneId, caption: "Web" }] } });
        fake.cloud.setShots(serverId(projectId), sceneId, [{ index: 0, description: "wide", duration: 2 }]);
        const copy = await d.backend.downloadLocalCopy(projectId, d.local);
        const shots = JSON.parse((await d.local.snapshot(copy.id)).scenes[0]!.shotBreakdown!) as Array<Record<string, unknown>>;
        expect(shots).toEqual([{ duration: 2, prompt: "wide" }]);
        await d.backend.dispose();
    });

    it("asks the cache only for files the working copy uses (not every URL column the server sends)", async () => {
        const d = cachingDevice(async (url) => url, async (url) => `opennan-local://media/c-${url.length}`);
        const projectId = await newCloudProject(d.api, "Columns");
        const used = `${fake.url}/files/results/used-${Date.now()}.mp4`;
        const unused = `${fake.url}/files/results/background-${Date.now()}.png`;
        fake.cloud.remoteChange(serverId(projectId), {
            scenes: { create: [{ id: globalThis.crypto.randomUUID(), caption: "S", background_url: unused }] },
            clips: { create: [{ id: globalThis.crypto.randomUUID(), track_type: "video", track_index: 2, start_time: 0, end_time: 2, media_url: used }] },
        });
        expect(serverProject(projectId).scenes.map((scene) => scene.background_url)).toEqual([unused]);
        await d.backend.loadProject(projectId);
        await until(() => d.asked.length > 0);
        await new Promise((r) => setTimeout(r, 50));
        expect(d.asked).toEqual([used]);
        await d.backend.dispose();
    });

    it("dispose waits for projects still closing (their last record lands before a migration may start)", async () => {
        const api = createCloudApi({ baseUrl: fake.url, apiKey: () => key });
        const mirror = new LocalBackend({ persistence: createMemoryPersistence() });
        const store = createMemoryStore();
        let puts = 0;
        const counting = { ...store, put: async (namespace: Parameters<typeof store.put>[0], k: string, value: unknown) => {
            puts += 1;
            return store.put(namespace, k, value);
        } };
        const backend = new OpenNanCloudBackend({ api, store: counting, mirror, media: createBlobMediaHost({ api, readBlob: async () => null }), deviceName: "Dispose", isCloudUrl: () => false });
        const projectId = await newCloudProject(api, "Closing");
        await backend.loadProject(projectId);
        await backend.createClips(projectId, [{ trackType: "text", trackIndex: 1, startTime: 0, endTime: 1, mediaType: "text", textContent: "Last" }]);
        backend.closeProject(projectId);
        await backend.dispose();
        const after = puts;
        await new Promise((r) => setTimeout(r, 100));
        expect(puts).toBe(after);
        const record = await store.get<{ pending: { entities: Record<string, unknown> } }>("sync", projectId);
        expect(Object.keys(record!.pending.entities)).toEqual([]);
    });
});

describe("OpenNanCloudBackend shots made on opennan.com (9a.1)", () => {
    it("keeps them read only and says where to edit them; Studio scenes' shot moves say they come later", async () => {
        const d = device("Shots");
        const projectId = await newCloudProject(d.api, "Web shots");
        const web = globalThis.crypto.randomUUID();
        const studio = globalThis.crypto.randomUUID();
        fake.cloud.remoteChange(serverId(projectId), { scenes: { create: [{ id: web, caption: "Planned on the web" }, { id: studio, caption: "Studio" }] } });
        fake.cloud.setShots(serverId(projectId), web, [{ index: 0, description: "wide", duration: 2 }, { index: 1, description: "close", duration: 3 }]);
        await d.backend.loadProject(projectId);
        const scenes = await d.backend.loadScenes(projectId);
        expect(JSON.parse(scenes.find((s) => s.id === web)!.shotBreakdown!)[0]).toMatchObject({ readOnly: true });
        await expect(d.backend.reorderShots(projectId, web, [1, 0])).rejects.toThrow(SHOT_EDITS_REFUSED);
        await expect(d.backend.deleteShot(projectId, web, 0)).rejects.toThrow(SHOT_EDITS_REFUSED);
        await expect(d.backend.mergeShot(projectId, { sourceSceneId: web, shotIndex: 0, targetSceneId: studio })).rejects.toThrow(SHOT_EDITS_REFUSED);
        await expect(d.backend.extractShot(projectId, { sceneId: web, shotIndex: 0, timelinePositionSeconds: 0, trackIndex: 1 })).rejects.toThrow(SHOT_EDITS_REFUSED);
        await expect(d.backend.mergeShot(projectId, { sourceSceneId: studio, shotIndex: 0, targetSceneId: studio })).rejects.toThrow(SHOT_MOVES_LATER);
        expect(SHOT_EDITS_REFUSED).toBe("Made on opennan.com — edit shots there.");
        await d.backend.dispose();
    });
});

describe("BackendRouter", () => {
    it("keeps local projects 100% local: no network call, no cloud backend built", async () => {
        let calls = 0;
        const spy = (async (...args: Parameters<typeof fetch>) => {
            calls += 1;
            return fetch(...args);
        }) as typeof fetch;
        let built = 0;
        const d = device("x", { fetch: spy });
        const router = new BackendRouter(d.local, () => {
            built += 1;
            return d.backend;
        });
        const project = await router.createProject({ name: "Local only" });
        const [clip] = await router.createClips(project.id, [{ trackType: "text", trackIndex: 1, startTime: 0, endTime: 2, mediaType: "text", textContent: "hi" }]);
        await router.updateClips(project.id, [{ clipId: clip!.id, opacity: 0.2 }]);
        await router.undo(project.id, 1);
        const media = await router.uploadFile(project.id, new Blob([new Uint8Array(8)], { type: "image/png" }), "image");
        await router.saveToLibrary(project.id, media);
        await router.listProjects();
        await router.loadTimeline(project.id);
        expect(router.subscribe(project.id, () => undefined)).toBeTypeOf("function");
        await router.deleteProject(project.id);
        expect(calls).toBe(0);
        expect(built).toBe(0);
    });

    it("sends cloud ids to the cloud backend", async () => {
        const d = device();
        const projectId = await newCloudProject(d.api, "Routed");
        const router = new BackendRouter(d.local, () => d.backend);
        expect((await router.loadProject(projectId)).name).toBe("Routed");
        await router.createClips(projectId, [{ trackType: "text", trackIndex: 1, startTime: 0, endTime: 2, mediaType: "text", textContent: "hi" }]);
        await d.backend.flush(projectId);
        expect(serverProject(projectId).clips).toHaveLength(1);
        await d.backend.dispose();
    });
});

describe("OpenNanCloudBackend and the AI director (phase 9b)", () => {
    it("records an AI change as one undo step that backend.undo takes back and syncs", async () => {
        const d = device();
        const projectId = await newCloudProject(d.api, "Directed");
        const [clip] = await d.backend.createClips(projectId, [{ trackType: "text", trackIndex: 1, mediaType: "text", textContent: "Hi", startTime: 0, endTime: 3 }]);
        await d.backend.flush(projectId);
        const group = await d.backend.beginRemoteGroup(projectId);
        d.backend.setAiActive(projectId, 1);
        const { revision } = fake.cloud.remoteChange(serverId(projectId), { clips: { patch: [{ id: clip!.id, text_content: "From the director" }] } }, "OpenNan director");
        d.backend.pullSoon(projectId);
        const step = await d.backend.recordRemoteGroup(projectId, group, { label: "AI: Retitle", toRevision: revision, entities: { scenes: [], clips: [clip!.id], tracks: false, project: false } });
        d.backend.setAiActive(projectId, -1);
        expect(step).toMatchObject({ label: "AI: Retitle", changed: { clips: [clip!.id] } });
        expect(step!.before.clips[0]!.textContent).toBe("Hi");
        expect(await d.backend.isNewestRemoteStep(projectId, step!.stepId)).toBe(true);
        expect(await d.backend.revision(projectId)).toBe(revision);
        const data = await d.backend.undo(projectId, 1);
        expect(data.clips[0]!.textContent).toBe("Hi");
        await d.backend.flush(projectId);
        expect(serverProject(projectId).clips[0]!.text_content).toBe("Hi");
        await d.backend.dispose();
    });
});

describe("OpenNanCloudBackend share links and storyboard undo (phase 9c)", () => {
    it("sets the project's final video (OpenNan files only) and a link can then be made", async () => {
        const d = device();
        const projectId = await newCloudProject(d.api, "Export me");
        await d.backend.loadProject(projectId);
        const site = {};
        const empty = await createShare(d.api, serverId(projectId), {}, site).catch((e: unknown) => e);
        expect((empty as { code?: string }).code).toBe("share_nothing_to_show");
        await expect(d.backend.setFinalVideo(projectId, "https://elsewhere.example/v.mp4")).rejects.toThrow(/OpenNan/);
        await d.backend.setFinalVideo(projectId, `${fake.url}/files/results/export.mp4`);
        expect(serverProject(projectId).final_video_url).toBe(`${fake.url}/files/results/export.mp4`);
        const { link } = await createShare(d.api, serverId(projectId), { expiresInDays: 7 }, site);
        expect(link.status).toBe("active");
        await d.backend.dispose();
    });

    it("undoing an AI storyboard puts the scene's earlier shots back on OpenNan, and redo draws them again", async () => {
        const d = device();
        const projectId = await newCloudProject(d.api, "Boards");
        const scene = await d.backend.addScene(projectId, { afterOrder: -1, caption: "Opening", duration: 6 } as never);
        await d.backend.flush(projectId);
        const group = await d.backend.beginRemoteGroup(projectId);
        const png = `${fake.url}/files/generated.png`;
        fake.cloud.setShots(serverId(projectId), scene.id, [{ description: "A", duration: 3, image_url: png }, { description: "B", duration: 3, image_url: png }], [
            { image_url: `${png}?sheet=1`, panels: [{ index: 0, shot_index: 0, image_url: png }, { index: 1, shot_index: 1, image_url: png }] },
        ]);
        const { revision } = fake.cloud.bump(serverId(projectId));
        d.backend.pullSoon(projectId);
        const step = await d.backend.recordRemoteGroup(projectId, group, { label: "AI: Storyboard", toRevision: revision, entities: { scenes: [scene.id], clips: [], tracks: false, project: false } });
        expect(step?.changed.scenes).toEqual([scene.id]);
        expect((await d.backend.loadScenes(projectId))[0]!.storyboardSheets?.[0]?.panels).toHaveLength(2);
        await d.backend.undo(projectId, 1);
        await d.backend.flush(projectId);
        expect(serverProject(projectId).scenes[0]).toMatchObject({ shots: [], storyboard_sheets: [] });
        await d.backend.redo(projectId, 1);
        await d.backend.flush(projectId);
        expect((serverProject(projectId).scenes[0]!.storyboard_sheets as unknown[]).length).toBe(1);
        await d.backend.dispose();
    });

    it("downloads a drawn storyboard's images from OpenNan's storage only: another host's are never shown or fetched, and logged once (9c.1)", async () => {
        const api = createCloudApi({ baseUrl: fake.url, apiKey: () => key });
        const mirror = new LocalBackend({ persistence: createMemoryPersistence() });
        const cached: string[] = [];
        const media = { ...createBlobMediaHost({ api, readBlob: (url) => mirror.readMedia(url) }), cache: async (url: string) => (cached.push(url), null) };
        const warn = vi.fn();
        const backend = new OpenNanCloudBackend({
            api, store: createMemoryStore(), mirror, media, deviceName: "Sheets", logger: { warn },
            isCloudUrl: (url) => url.startsWith(`${fake.url}/files/`) && !url.includes("/uploads/temp/"),
        });
        const projectId = await newCloudProject(api, "Hosts");
        const sceneId = crypto.randomUUID();
        fake.cloud.remoteChange(serverId(projectId), { scenes: { create: [{ id: sceneId, caption: "One", duration: 4 }] } });
        const ours = `${fake.url}/files/results/sheet.png`;
        fake.cloud.setShots(serverId(projectId), sceneId, [{ description: "A", duration: 4 }], [
            { image_url: "https://evil.example/sheet.png", panels: [{ index: 0, shot_index: 0, image_url: ours }, { index: 1, shot_index: 1, image_url: "https://evil.example/p.png" }] },
        ]);
        await fetch(`${fake.url}/__test/cloud/sheet-views`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ unfiltered: true }) });
        fake.cloud.bump(serverId(projectId));
        await backend.loadProject(projectId);
        const sheets = (await backend.loadScenes(projectId))[0]!.storyboardSheets;
        expect(sheets).toEqual([{ imageUrl: null, panels: [{ index: 0, shotIndex: 0, imageUrl: ours }] }]);
        await until(() => cached.includes(ours));
        expect(cached.filter((url) => url.includes("evil.example"))).toEqual([]);
        expect(warn.mock.calls.map((c) => c[0]).filter((line) => /storyboard file/.test(String(line)))).toEqual(["[cloud] ignored a storyboard file that is not on OpenNan's storage: evil.example"]);
        await backend.dispose();
    });
});
