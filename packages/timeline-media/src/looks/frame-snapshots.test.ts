import { afterEach, describe, expect, it, vi } from "vitest";
import { FrameSnapshots } from "./frame-snapshots";

describe("FrameSnapshots", () => {
    it("keeps at most `limit` entries and releases evicted elements", () => {
        const snapshots = new FrameSnapshots({ resolveUrl: (u) => u, onReady: vi.fn(), limit: 2 });
        expect(snapshots.video("a.mp4", 1)).toBeNull();
        expect(snapshots.video("a.mp4", 1.001)).toBeNull();
        expect(snapshots.size).toBe(1);
        snapshots.video("b.mp4", 0);
        snapshots.image("c.png");
        expect(snapshots.size).toBe(2);
        snapshots.dispose();
        expect(snapshots.size).toBe(0);
    });

    it("reports images once loaded", () => {
        const onReady = vi.fn();
        const snapshots = new FrameSnapshots({ resolveUrl: (u) => `resolved:${u}`, onReady });
        expect(snapshots.image("c.png")).toBeNull();
        const img = (snapshots as unknown as { entries: Map<string, { image: HTMLImageElement }> }).entries.get("i|c.png")!.image;
        expect(img.src).toContain("resolved:c.png");
        Object.defineProperty(img, "naturalWidth", { value: 10 });
        Object.defineProperty(img, "naturalHeight", { value: 5 });
        img.onload?.(new Event("load"));
        expect(onReady).toHaveBeenCalledTimes(1);
        expect(snapshots.image("c.png")).toMatchObject({ width: 10, height: 5 });
    });
});

/** A stand-in <video>: records seeks, fires events on demand. */
function fakeVideo() {
    const listeners = new Map<string, Array<() => void>>();
    const video = {
        muted: false, preload: "", playsInline: false, crossOrigin: "", src: "", duration: Number.NaN, videoWidth: 0, videoHeight: 0, currentTime: 0,
        seeks: [] as number[],
        addEventListener(type: string, fn: () => void) {
            listeners.set(type, [...(listeners.get(type) ?? []), fn]);
        },
        removeAttribute(name: string) {
            if (name === "src") video.src = "";
        },
        load: vi.fn(),
        fire(type: string) {
            for (const fn of listeners.get(type) ?? []) fn();
        },
    };
    return new Proxy(video, {
        set(target, key, value) {
            if (key === "currentTime") target.seeks.push(value);
            (target as Record<string | symbol, unknown>)[key] = value;
            return true;
        },
    });
}

describe("FrameSnapshots live frames (one hidden decoder per media)", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    function setup(limit?: number) {
        const videos: ReturnType<typeof fakeVideo>[] = [];
        const onReady = vi.fn();
        const snapshots = new FrameSnapshots({
            resolveUrl: (u) => `r:${u}`, onReady, decoderLimit: limit,
            createVideo: () => {
                const v = fakeVideo();
                videos.push(v);
                return v as unknown as HTMLVideoElement;
            },
        });
        const land = (v: ReturnType<typeof fakeVideo>) => {
            v.duration = 10;
            v.videoWidth = 64;
            v.videoHeight = 36;
            v.fire("loadedmetadata");
        };
        return { snapshots, videos, onReady, land };
    }

    it("seeks one persistent element and reports the frame as exact once it lands", () => {
        const { snapshots, videos, onReady, land } = setup();
        expect(snapshots.live("a.mp4", 1)).toBeNull();
        expect(videos).toHaveLength(1);
        expect(videos[0].src).toBe("r:a.mp4");
        land(videos[0]);
        expect(videos[0].seeks).toEqual([1]);
        videos[0].fire("seeked");
        expect(onReady).toHaveBeenCalledTimes(1);
        expect(snapshots.live("a.mp4", 1.004)).toMatchObject({ exact: true, time: 1, width: 64, height: 36 });
    });

    it("while a seek is in flight it shows the last ready frame and seeks once more to the latest wanted time", () => {
        const { snapshots, videos, land } = setup();
        snapshots.live("a.mp4", 1);
        land(videos[0]);
        videos[0].fire("seeked");
        expect(snapshots.live("a.mp4", 1.1)).toMatchObject({ exact: false, time: 1 });
        expect(snapshots.live("a.mp4", 1.2)).toMatchObject({ exact: false, time: 1 });
        expect(snapshots.live("a.mp4", 1.3)).toMatchObject({ exact: false, time: 1 });
        // One seek in flight (1.1); the latest request (1.3) follows when it lands, 1.2 is skipped.
        expect(videos[0].seeks.map((t) => Math.round(t * 30))).toEqual([30, 33]);
        videos[0].fire("seeked");
        expect(snapshots.live("a.mp4", 1.3)).toMatchObject({ exact: false, time: 1.1 });
        expect(videos[0].seeks.map((t) => Math.round(t * 30))).toEqual([30, 33, 39]);
        videos[0].fire("seeked");
        expect(snapshots.live("a.mp4", 1.3)).toMatchObject({ exact: true });
        expect(videos).toHaveLength(1);
    });

    it("clamps seeks into the media and reports its duration", () => {
        const { snapshots, videos, land } = setup();
        expect(snapshots.liveDuration("a.mp4")).toBeNull();
        snapshots.live("a.mp4", 12);
        land(videos[0]);
        expect(videos[0].seeks[0]).toBeCloseTo(9.999, 6);
        expect(snapshots.liveDuration("a.mp4")).toBe(10);
    });

    it("keeps at most `decoderLimit` decoders and releases the rest", () => {
        const { snapshots, videos } = setup(2);
        snapshots.live("a.mp4", 0);
        snapshots.live("b.mp4", 0);
        snapshots.live("c.mp4", 0);
        expect(videos.map((v) => v.src)).toEqual(["", "r:b.mp4", "r:c.mp4"]);
        snapshots.dispose();
        expect(videos.every((v) => v.src === "")).toBe(true);
    });

    it("keeps four decoders by default (two windows' live sides at once)", () => {
        const { snapshots, videos } = setup();
        for (const url of ["a.mp4", "b.mp4", "c.mp4", "d.mp4"]) snapshots.live(url, 0);
        expect(videos.map((v) => v.src)).toEqual(["r:a.mp4", "r:b.mp4", "r:c.mp4", "r:d.mp4"]);
        snapshots.live("e.mp4", 0);
        expect(videos.map((v) => v.src)).toEqual(["", "r:b.mp4", "r:c.mp4", "r:d.mp4", "r:e.mp4"]);
    });

    it("never evicts a decoder requested in the current draw: more windows than the limit stop thrashing", () => {
        const { snapshots, videos, land } = setup(2);
        const urls = ["a.mp4", "b.mp4", "c.mp4"];
        for (let draw = 0; draw < 5; draw += 1) {
            snapshots.beginDraw();
            for (const url of urls) snapshots.live(url, 1);
            if (draw === 0) videos.forEach(land);
        }
        // One decoder per media, made once, all still loaded.
        expect(videos).toHaveLength(3);
        expect(videos.every((v) => v.src.startsWith("r:"))).toBe(true);
        for (const v of videos) v.fire("seeked");
        snapshots.beginDraw();
        for (const url of urls) expect(snapshots.live(url, 1)).toMatchObject({ exact: true });
        // A draw that needs fewer trims the least recently requested ones back to the limit.
        snapshots.beginDraw();
        snapshots.live("c.mp4", 1);
        snapshots.beginDraw();
        snapshots.live("d.mp4", 1);
        expect(videos.map((v) => v.src)).toEqual(["", "", "r:c.mp4", "r:d.mp4"]);
    });

    it("evicts the least recently requested decoder (not the oldest created)", () => {
        const { snapshots, videos } = setup(2);
        snapshots.beginDraw();
        snapshots.live("a.mp4", 0);
        snapshots.beginDraw();
        snapshots.live("b.mp4", 0);
        snapshots.beginDraw();
        snapshots.live("a.mp4", 0.5);
        snapshots.beginDraw();
        snapshots.live("c.mp4", 0);
        expect(videos.map((v) => v.src)).toEqual(["r:a.mp4", "", "r:c.mp4"]);
    });

    it("a decoder whose media errors is marked failed: onReady fires, live() returns null, no more seeks", () => {
        const { snapshots, videos, onReady } = setup();
        expect(snapshots.failed("a.mp4")).toBe(false);
        snapshots.live("a.mp4", 1);
        videos[0].fire("error");
        expect(onReady).toHaveBeenCalledTimes(1);
        expect(snapshots.failed("a.mp4")).toBe(true);
        expect(snapshots.live("a.mp4", 1)).toBeNull();
        expect(videos[0].seeks).toEqual([]);
        expect(videos[0].src).toBe("");
        expect(snapshots.failed("b.mp4")).toBe(false);
    });

    it("a decoder whose metadata or seek never arrives fails after the timeout", () => {
        vi.useFakeTimers();
        const { snapshots, videos, onReady, land } = setup();
        snapshots.live("a.mp4", 1);
        vi.advanceTimersByTime(3_999);
        expect(snapshots.failed("a.mp4")).toBe(false);
        vi.advanceTimersByTime(1);
        expect(snapshots.failed("a.mp4")).toBe(true);
        expect(onReady).toHaveBeenCalledTimes(1);
        expect(snapshots.live("a.mp4", 1)).toBeNull();
        // Metadata in time, then a seek that never lands.
        snapshots.live("b.mp4", 1);
        land(videos[1]);
        expect(videos[1].seeks).toEqual([1]);
        vi.advanceTimersByTime(2_000);
        expect(snapshots.failed("b.mp4")).toBe(false);
        vi.advanceTimersByTime(2_000);
        expect(snapshots.failed("b.mp4")).toBe(true);
        expect(onReady).toHaveBeenCalledTimes(2);
        // A seek that lands in time keeps the decoder healthy.
        snapshots.live("c.mp4", 1);
        land(videos[2]);
        vi.advanceTimersByTime(3_000);
        videos[2].fire("seeked");
        vi.advanceTimersByTime(3_000);
        expect(snapshots.failed("c.mp4")).toBe(false);
        snapshots.dispose();
    });
});

describe("FrameSnapshots still frames that cannot load", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    function setup() {
        const videos: ReturnType<typeof fakeVideo>[] = [];
        const onReady = vi.fn();
        const snapshots = new FrameSnapshots({
            resolveUrl: (u) => `r:${u}`, onReady,
            createVideo: () => {
                const v = fakeVideo();
                videos.push(v);
                return v as unknown as HTMLVideoElement;
            },
        });
        return { snapshots, videos, onReady };
    }

    it("a held frame whose media errors fails: onReady fires and video() stays null without reloading", () => {
        const { snapshots, videos, onReady } = setup();
        expect(snapshots.video("a.mp4", 2)).toBeNull();
        expect(videos).toHaveLength(1);
        videos[0].fire("error");
        expect(onReady).toHaveBeenCalledTimes(1);
        expect(snapshots.failed("a.mp4")).toBe(true);
        expect(snapshots.video("a.mp4", 2)).toBeNull();
        expect(videos).toHaveLength(1);
        expect(videos[0].src).toBe("");
    });

    it("a held frame that never seeks fails after the timeout", () => {
        vi.useFakeTimers();
        const { snapshots, onReady } = setup();
        snapshots.video("a.mp4", 2);
        vi.advanceTimersByTime(4_000);
        expect(onReady).toHaveBeenCalledTimes(1);
        expect(snapshots.failed("a.mp4")).toBe(true);
    });

    it("an image that errors fails", () => {
        const { snapshots, onReady } = setup();
        snapshots.image("c.png");
        const img = (snapshots as unknown as { entries: Map<string, { image: HTMLImageElement }> }).entries.get("i|c.png")!.image;
        img.onerror?.(new Event("error"));
        expect(onReady).toHaveBeenCalledTimes(1);
        expect(snapshots.failed("c.png")).toBe(true);
        expect(snapshots.image("c.png")).toBeNull();
    });
});
