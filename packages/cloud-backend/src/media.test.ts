import { CloudApiError } from "./api";
import { FakeClock } from "./clock";
import { MediaSync, UPLOAD_BLOCKED_STORAGE, UPLOAD_DAILY_LIMIT, urlKey, type MediaHost } from "./media";
import { createMemoryStore } from "./store";
import type { UploadResult } from "./upload";

const LOCAL = (n: number) => `opennan-local://media/0000000${n}-0000-4000-8000-000000000000`;
const result = (n: number): UploadResult => ({ assetId: `a${n}`, mediaUrl: `https://cdn.opennan.com/m${n}.mp4`, contentType: "video/mp4", sizeBytes: 10, sha256: "a".repeat(64), deduplicated: false });

function setup(outcomes: Array<UploadResult | Error>) {
    const calls: string[] = [];
    const host: MediaHost = {
        describe: async () => ({ filename: "f.mp4", contentType: "video/mp4", sizeBytes: 10 }),
        upload: async (url) => {
            calls.push(url);
            const next = outcomes.shift();
            if (!next) throw new Error("no more outcomes");
            if (next instanceof Error) throw next;
            return next;
        },
    };
    const clock = new FakeClock();
    const store = createMemoryStore();
    const media = new MediaSync({ host, store, clock, isCloudUrl: (u) => u.startsWith("https://cdn.opennan.com/") });
    const mappings: Array<{ local: string; remote: string }> = [];
    media.subscribe((m) => mappings.push(...m));
    return { media, clock, calls, store, mappings };
}

describe("MediaSync", () => {
    it("logs a storyboard image from another host quietly: once per host, the host only (9c.1)", () => {
        const warn = vi.fn();
        const media = new MediaSync({ host: {} as MediaHost, store: createMemoryStore(), clock: new FakeClock(), isCloudUrl: (u) => u.startsWith("https://cdn.opennan.com/"), logger: { warn } });
        media.urls.ignored!("https://evil.example/a.png?token=secret");
        media.urls.ignored!("https://evil.example/b.png");
        media.urls.ignored!("https://other.example/c.png");
        media.urls.ignored!("not a url");
        expect(warn.mock.calls).toEqual([
            ["[cloud] ignored a storyboard file that is not on OpenNan's storage: evil.example"],
            ["[cloud] ignored a storyboard file that is not on OpenNan's storage: other.example"],
            ["[cloud] ignored a storyboard file that is not on OpenNan's storage: (not a URL)"],
        ]);
    });

    it("uploads each local file once, remembers the mapping on disk, and tells the projects", async () => {
        const { media, clock, calls, store, mappings } = setup([result(1)]);
        media.want("cloud-p", [LOCAL(1), LOCAL(1), "https://cdn.opennan.com/x.mp4"]);
        await clock.advance(0);
        expect(calls).toEqual([LOCAL(1)]);
        expect(media.urls.toRemote(LOCAL(1))).toBe("https://cdn.opennan.com/m1.mp4");
        expect(media.urls.toLocal("https://cdn.opennan.com/m1.mp4")).toBe(LOCAL(1));
        expect(mappings).toEqual([{ local: LOCAL(1), remote: "https://cdn.opennan.com/m1.mp4" }]);
        expect((await store.keys("urls")).length).toBe(1);
        media.want("cloud-q", [LOCAL(1)]);
        await clock.advance(0);
        expect(calls).toHaveLength(1);
    });

    it("pauses uploads when storage is full (edits still sync) and tries again later", async () => {
        const { media, clock, calls } = setup([new CloudApiError(403, "storage_quota_exceeded", "full"), result(1)]);
        media.want("cloud-p", [LOCAL(1)]);
        await clock.advance(0);
        expect(media.progress()).toMatchObject({ blocked: "storage", message: UPLOAD_BLOCKED_STORAGE, uploading: 1 });
        await clock.advance(4 * 60_000);
        expect(calls).toHaveLength(1);
        await clock.advance(60_000);
        expect(calls).toHaveLength(2);
        expect(media.progress()).toMatchObject({ blocked: null, uploading: 0, uploaded: 1 });
    });

    it("waits for the daily limit's Retry-After", async () => {
        const { media, clock, calls } = setup([new CloudApiError(429, "upload_daily_limit", "limit", { retryAfterSeconds: 3600 }), result(1)]);
        media.want("cloud-p", [LOCAL(1)]);
        await clock.advance(0);
        expect(media.progress().message).toBe(UPLOAD_DAILY_LIMIT);
        await clock.advance(3_599_000);
        expect(calls).toHaveLength(1);
        await clock.advance(2_000);
        expect(calls).toHaveLength(2);
    });

    it("retries the network and the gateway with backoff, and gives up on a file the server can't take", async () => {
        const { media, clock, calls } = setup([new CloudApiError(0, "network", "x"), new CloudApiError(503, "upload_gateway_unavailable", "x"), result(1), new CloudApiError(0, "unsupported_type", "Convert it first")]);
        media.want("cloud-p", [LOCAL(1)]);
        await clock.advance(0);
        await clock.advance(1_500);
        await clock.advance(3_000);
        expect(calls).toHaveLength(3);
        expect(media.urls.toRemote(LOCAL(1))).toBeDefined();
        media.want("cloud-p", [LOCAL(2)]);
        await clock.advance(0);
        expect(media.progress().message).toBe("Convert it first");
        media.want("cloud-p", [LOCAL(2)]);
        await clock.advance(60_000);
        expect(calls).toHaveLength(4);
    });

    it("keeps the storage-full wait and a backoff on separate timers, and waits for a sign-in after a 401", async () => {
        const { media, clock, calls } = setup([new CloudApiError(403, "storage_quota_exceeded", "full"), new CloudApiError(0, "network", "x"), result(1), new CloudApiError(401, "invalid_api_key", "x"), result(2)]);
        media.want("cloud-p", [LOCAL(1)]);
        await clock.advance(0);
        expect(media.progress().blocked).toBe("storage");
        media.retry();
        await clock.advance(0);
        expect(calls).toHaveLength(2);
        await clock.advance(2_000);
        expect(calls).toHaveLength(3);
        media.want("cloud-p", [LOCAL(2)]);
        await clock.advance(0);
        expect(calls).toHaveLength(4);
        await clock.advance(120_000);
        expect(calls).toHaveLength(4);
        media.retry();
        await clock.advance(0);
        expect(calls).toHaveLength(5);
        expect(media.urls.toRemote(LOCAL(2))).toBeDefined();
    });

    describe("the download cache (9a.1)", () => {
        const REMOTE = "https://cdn.opennan.com/c1.mp4";
        const CACHED = (n: number) => `opennan-local://media/c-${n}`;

        function cacheSetup(answers: string[]) {
            const calls: string[] = [];
            const pins: string[][] = [];
            const host: MediaHost = {
                describe: async () => null,
                upload: async () => result(9),
                cache: async (url) => {
                    calls.push(url);
                    return answers.length > 1 ? answers.shift()! : answers[0]!;
                },
                pin: (urls) => pins.push([...urls].sort()),
            };
            const clock = new FakeClock();
            const store = createMemoryStore();
            const make = () => new MediaSync({ host, store, clock, isCloudUrl: (u) => u.startsWith("https://cdn.opennan.com/") });
            const media = make();
            const mappings: number[] = [];
            media.subscribe(() => mappings.push(1));
            return { media, make, calls, pins, store, mappings };
        }

        it("asks the host again for a cached file on every open (it refreshes its use) without re-recording an unchanged answer", async () => {
            const { media, calls, store, mappings } = cacheSetup([CACHED(1)]);
            await media.load();
            await media.cacheAll([{ url: REMOTE }]);
            expect(media.urls.toLocal(REMOTE)).toBe(CACHED(1));
            expect(mappings).toHaveLength(1);
            await media.cacheAll([{ url: REMOTE }]);
            expect(calls).toEqual([REMOTE, REMOTE]);
            expect(mappings).toHaveLength(1);
            const records = Object.values(store.dump().urls ?? {});
            expect(records).toEqual([{ local: CACHED(1), remote: REMOTE, cache: true }]);
        });

        it("re-records a file the host downloaded again under a new id (evicted) and keeps the old URL for encoding only", async () => {
            const { media, make, store, mappings } = cacheSetup([CACHED(1), CACHED(2)]);
            await media.load();
            await media.cacheAll([{ url: REMOTE }]);
            await media.cacheAll([{ url: REMOTE }]);
            expect(media.urls.toLocal(REMOTE)).toBe(CACHED(2));
            expect(media.urls.toRemote(CACHED(1))).toBe(REMOTE);
            expect(media.urls.toRemote(CACHED(2))).toBe(REMOTE);
            expect(mappings).toHaveLength(2);
            expect(Object.values(store.dump().urls ?? {})).toEqual(expect.arrayContaining([
                { local: CACHED(1), remote: REMOTE, cache: true, stale: true }, { local: CACHED(2), remote: REMOTE, cache: true },
            ]));
            // After a restart the stale record still encodes, and never decodes.
            const again = make();
            await again.load();
            expect(again.urls.toLocal(REMOTE)).toBe(CACHED(2));
            expect(again.urls.toRemote(CACHED(1))).toBe(REMOTE);
        });

        it("never asks the cache for a file this device uploaded (its original is the local file)", async () => {
            const { media, calls } = cacheSetup([CACHED(1)]);
            await media.load();
            await media.record(LOCAL(1), result(1));
            await media.cacheAll([{ url: "https://cdn.opennan.com/m1.mp4" }]);
            expect(calls).toEqual([]);
            expect(media.urls.toLocal("https://cdn.opennan.com/m1.mp4")).toBe(LOCAL(1));
        });

        it("treats a 9a record without assetId as a cache record", async () => {
            const { media, make, store, calls } = cacheSetup([CACHED(3)]);
            await store.put("urls", "u-old", { local: CACHED(1), remote: REMOTE, sizeBytes: 5 });
            const fresh = make();
            await fresh.load();
            await fresh.cacheAll([{ url: REMOTE }]);
            expect(calls).toEqual([REMOTE]);
            expect(fresh.urls.toLocal(REMOTE)).toBe(CACHED(3));
            expect(fresh.urls.toRemote(CACHED(1))).toBe(REMOTE);
            void media;
        });

        it("reads records another tab wrote (refresh) and never uploads a file the store already maps (review)", async () => {
            const { media, make, store } = cacheSetup([CACHED(1)]);
            await media.load();
            // Another tab (same store) downloaded a copy under a new name.
            const other = make();
            await other.load();
            await store.put("urls", "u-other", { local: CACHED(9), remote: REMOTE, cache: true });
            expect(media.urls.toRemote(CACHED(9))).toBeUndefined();
            await media.refresh();
            expect(media.urls.toRemote(CACHED(9))).toBe(REMOTE);
            // A record written after the refresh is still found before an upload starts.
            const uploads: string[] = [];
            const host: MediaHost = { describe: async () => ({ filename: "f", contentType: "video/mp4", sizeBytes: 1 }), upload: async (url) => (uploads.push(url), result(1)) };
            const clock = new FakeClock();
            const late = new MediaSync({ host, store, clock, isCloudUrl: (u) => u.startsWith("https://cdn.opennan.com/") });
            await late.load();
            await store.put("urls", urlKey(CACHED(10)), { local: CACHED(10), remote: REMOTE, cache: true });
            late.want("cloud-p", [CACHED(10)]);
            await clock.advance(0);
            await clock.advance(0);
            expect(uploads).toEqual([]);
            expect(late.urls.toRemote(CACHED(10))).toBe(REMOTE);
        });

        it("hands the host the cache URLs open projects pin", async () => {
            const { media, pins } = cacheSetup([CACHED(1)]);
            media.pin([CACHED(2), CACHED(1), CACHED(1)]);
            expect(pins.at(-1)).toEqual([CACHED(1), CACHED(2)]);
        });
    });
});
