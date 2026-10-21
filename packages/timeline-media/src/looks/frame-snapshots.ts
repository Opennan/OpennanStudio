// Still frames for the preview's transition windows: the outgoing scene held on its last frame, the
// incoming one on its first. Each snapshot comes from a hidden <video> of its own (or an <img>), so
// the editor's playing elements are never seeked. Bounded LRU; dispose() releases every element.
//
// Live frames (phase 10b, live transition handles): `live(url, time)` reads a moving time from ONE
// persistent hidden <video> per media (a decoder), seeking it to the latest wanted frame. It never blocks:
// it returns the frame when the decoder shows exactly that time (`exact`), else the last frame it has
// (`exact: false`) while the seek runs, and calls onReady when a seek lands. Callers decide: paused, wait
// for the exact frame; playing, show what is ready.
//
// Failures (phase 10b): a media error, or metadata / a seek that does not arrive within `timeoutMs`
// (4 s), marks the decoder or snapshot failed: onReady fires once, it returns null from then on, and
// `failed(url)` tells callers to stop waiting for it (they fall back to held frames or draw without it).
// Decoders are evicted least recently requested first, and never while requested in the current draw
// (`beginDraw()`), so more windows than the limit do not evict each other every frame.

export type SnapshotSource = HTMLCanvasElement | HTMLImageElement;

interface Entry {
    key: string;
    url: string;
    failed: boolean;
    timer: ReturnType<typeof setTimeout> | null;
    source: SnapshotSource | null;
    width: number;
    height: number;
    video?: HTMLVideoElement;
    image?: HTMLImageElement;
}

export interface FrameSnapshotsOptions {
    resolveUrl(url: string): string;
    /** Called when a requested snapshot becomes available. */
    onReady(): void;
    limit?: number;
    /** Live decoders kept at once (one per media; each window's moving side needs one). Default 4. */
    decoderLimit?: number;
    /** Milliseconds metadata or a seek may take before the media counts as failed. Default 4000. */
    timeoutMs?: number;
    /** Element factories (tests pass fakes). */
    createVideo?(): HTMLVideoElement;
    createCanvas?(): HTMLCanvasElement;
}

export interface LiveFrame {
    source: SnapshotSource;
    width: number;
    height: number;
    /** Media seconds (1/30 s grid) the frame shows. */
    time: number;
    /** The frame is the one asked for (else the decoder's last frame while it seeks). */
    exact: boolean;
}

interface Decoder {
    url: string;
    video: HTMLVideoElement;
    canvas: HTMLCanvasElement | null;
    width: number;
    height: number;
    duration: number | null;
    /** Metadata loaded: seeks can start. */
    ready: boolean;
    /** Snapped time the canvas shows, the seek in flight, and the latest wanted time. */
    shown: number | null;
    seeking: number | null;
    wanted: number | null;
    /** Errored or timed out: no frames from it (until it is evicted and made again). */
    failed: boolean;
    timer: ReturnType<typeof setTimeout> | null;
    /** The draw (beginDraw) and request order it was last asked for in. */
    draw: number;
    request: number;
}

const snap = (time: number) => Math.max(0, Math.round(time * 30) / 30);
export const DEFAULT_DECODER_LIMIT = 4;
export const DEFAULT_SNAPSHOT_TIMEOUT_MS = 4000;

export class FrameSnapshots {
    private readonly entries = new Map<string, Entry>();
    private readonly decoders = new Map<string, Decoder>();
    private readonly limit: number;
    private readonly timeoutMs: number;
    private disposed = false;
    /** The current draw (0 until beginDraw is called: no decoder is protected then) and request counter. */
    private drawId = 0;
    private requests = 0;

    constructor(private readonly options: FrameSnapshotsOptions) {
        this.limit = options.limit ?? 6;
        this.timeoutMs = options.timeoutMs ?? DEFAULT_SNAPSHOT_TIMEOUT_MS;
    }

    /** Starts a draw: decoders requested from now until the next call are not evicted for new ones. */
    beginDraw(): void {
        this.drawId += 1;
    }

    /** True when media `url` failed to load or seek (error or timeout) in a decoder or a snapshot. */
    failed(url: string): boolean {
        if (this.decoders.get(url)?.failed) return true;
        for (const entry of this.entries.values()) if (entry.failed && entry.url === url) return true;
        return false;
    }

    /** The frame of `url` at `time` from its live decoder (see the header); null until it has any frame. */
    live(url: string, time: number): LiveFrame | null {
        if (this.disposed) return null;
        const target = snap(time);
        const decoder = this.decoder(url);
        if (decoder.failed) return null;
        const exact = decoder.shown !== null && Math.abs(decoder.shown - target) < 1e-6;
        if (!exact) {
            decoder.wanted = target;
            this.seek(decoder);
        }
        if (!decoder.canvas || decoder.shown === null) return null;
        return { source: decoder.canvas, width: decoder.width, height: decoder.height, time: decoder.shown, exact };
    }

    /** The media length a live decoder found (seconds), or null before its metadata loads. */
    liveDuration(url: string): number | null {
        return this.decoders.get(url)?.duration ?? null;
    }

    private decoder(url: string): Decoder {
        const existing = this.decoders.get(url);
        if (existing) {
            existing.draw = this.drawId;
            existing.request = ++this.requests;
            return existing;
        }
        const video = this.options.createVideo?.() ?? document.createElement("video");
        const decoder: Decoder = {
            url, video, canvas: null, width: 0, height: 0, duration: null, ready: false, shown: null, seeking: null, wanted: null,
            failed: false, timer: null, draw: this.drawId, request: ++this.requests,
        };
        this.decoders.set(url, decoder);
        this.evictDecoders();
        video.muted = true;
        video.preload = "auto";
        video.playsInline = true;
        video.crossOrigin = "anonymous";
        const current = () => !this.disposed && this.decoders.get(url) === decoder && !decoder.failed;
        video.addEventListener("error", () => {
            if (current()) this.failDecoder(decoder);
        });
        this.armDecoder(decoder);
        video.addEventListener("loadedmetadata", () => {
            if (!current()) return;
            this.disarm(decoder);
            decoder.duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : null;
            decoder.ready = true;
            this.seek(decoder);
        });
        video.addEventListener("seeked", () => {
            if (!current() || decoder.seeking === null) return;
            this.disarm(decoder);
            const landed = decoder.seeking;
            decoder.seeking = null;
            if (video.videoWidth > 0 && video.videoHeight > 0) {
                const canvas = decoder.canvas ?? this.options.createCanvas?.() ?? document.createElement("canvas");
                if (canvas.width !== video.videoWidth) canvas.width = video.videoWidth;
                if (canvas.height !== video.videoHeight) canvas.height = video.videoHeight;
                canvas.getContext?.("2d")?.drawImage(video, 0, 0);
                decoder.canvas = canvas;
                decoder.width = video.videoWidth;
                decoder.height = video.videoHeight;
                decoder.shown = landed;
            }
            this.options.onReady();
            this.seek(decoder);
        });
        video.src = this.options.resolveUrl(url);
        return decoder;
    }

    /** Starts a seek to the latest wanted time unless one is in flight, the metadata is missing, or it is shown. */
    private seek(decoder: Decoder): void {
        const wanted = decoder.wanted;
        if (wanted === null || decoder.seeking !== null || !decoder.ready) return;
        if (decoder.shown !== null && Math.abs(decoder.shown - wanted) < 1e-6) {
            decoder.wanted = null;
            return;
        }
        decoder.wanted = null;
        decoder.seeking = wanted;
        this.armDecoder(decoder);
        decoder.video.currentTime = Math.max(0, decoder.duration === null ? wanted : Math.min(wanted, decoder.duration - 0.001));
    }

    /**
     * Over the limit: evicts decoders least recently requested first, skipping those requested in the current
     * draw (beginDraw) — the limit is exceeded until a later draw no longer needs them.
     */
    private evictDecoders(): void {
        const limit = this.options.decoderLimit ?? DEFAULT_DECODER_LIMIT;
        if (this.decoders.size <= limit) return;
        const candidates = [...this.decoders.values()]
            .filter((d) => this.drawId === 0 || d.draw !== this.drawId)
            .sort((a, b) => a.request - b.request);
        for (const decoder of candidates) {
            if (this.decoders.size <= limit) break;
            this.releaseDecoder(decoder);
            this.decoders.delete(decoder.url);
        }
    }

    /** Starts (or restarts) the decoder's timeout for the metadata or seek it waits for. */
    private armDecoder(decoder: Decoder): void {
        this.disarm(decoder);
        decoder.timer = setTimeout(() => {
            decoder.timer = null;
            if (!this.disposed && this.decoders.get(decoder.url) === decoder && !decoder.failed) this.failDecoder(decoder);
        }, this.timeoutMs);
    }

    private disarm(target: { timer: ReturnType<typeof setTimeout> | null }): void {
        if (target.timer !== null) clearTimeout(target.timer);
        target.timer = null;
    }

    private failDecoder(decoder: Decoder): void {
        decoder.failed = true;
        decoder.seeking = null;
        decoder.wanted = null;
        this.releaseDecoder(decoder);
        this.options.onReady();
    }

    private releaseDecoder(decoder: Decoder): void {
        this.disarm(decoder);
        decoder.video.removeAttribute("src");
        decoder.video.load();
    }

    /** The frame of `url` at `time` seconds (snapped to 1/30 s), or null while it loads. */
    video(url: string, time: number): { source: SnapshotSource; width: number; height: number } | null {
        const snapped = Math.max(0, Math.round(time * 30) / 30);
        const key = `v|${url}|${snapped.toFixed(4)}`;
        const entry = this.touch(key) ?? this.loadVideo(key, url, snapped);
        return entry.source && !entry.failed ? { source: entry.source, width: entry.width, height: entry.height } : null;
    }

    image(url: string): { source: SnapshotSource; width: number; height: number } | null {
        const key = `i|${url}`;
        const entry = this.touch(key) ?? this.loadImage(key, url);
        return entry.source && !entry.failed ? { source: entry.source, width: entry.width, height: entry.height } : null;
    }

    private touch(key: string): Entry | undefined {
        const entry = this.entries.get(key);
        if (entry) {
            this.entries.delete(key);
            this.entries.set(key, entry);
        }
        return entry;
    }

    private add(entry: Entry): Entry {
        this.entries.set(entry.key, entry);
        while (this.entries.size > this.limit) {
            const [oldest] = this.entries.keys();
            this.release(this.entries.get(oldest)!);
            this.entries.delete(oldest);
        }
        return entry;
    }

    private release(entry: Entry): void {
        this.disarm(entry);
        if (entry.video) {
            entry.video.removeAttribute("src");
            entry.video.load();
        }
        if (entry.image) entry.image.src = "";
    }

    /** The snapshot failed (error or timeout): no frame from it; callers stop waiting (failed(url)). */
    private failEntry(entry: Entry): void {
        if (this.disposed || entry.failed || entry.source || this.entries.get(entry.key) !== entry) return;
        entry.failed = true;
        this.release(entry);
        entry.video = undefined;
        entry.image = undefined;
        this.options.onReady();
    }

    private armEntry(entry: Entry): void {
        entry.timer = setTimeout(() => {
            entry.timer = null;
            this.failEntry(entry);
        }, this.timeoutMs);
    }

    private loadVideo(key: string, url: string, time: number): Entry {
        const video = this.options.createVideo?.() ?? document.createElement("video");
        const entry = this.add({ key, url, failed: false, timer: null, source: null, width: 0, height: 0, video });
        video.muted = true;
        video.preload = "auto";
        video.playsInline = true;
        video.crossOrigin = "anonymous";
        const capture = () => {
            if (this.disposed || entry.failed || this.entries.get(key) !== entry || video.videoWidth <= 0) return;
            this.disarm(entry);
            const canvas = this.options.createCanvas?.() ?? document.createElement("canvas");
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            canvas.getContext("2d")?.drawImage(video, 0, 0);
            entry.source = canvas;
            entry.width = canvas.width;
            entry.height = canvas.height;
            entry.video = undefined;
            video.removeAttribute("src");
            video.load();
            this.options.onReady();
        };
        video.addEventListener("loadedmetadata", () => {
            const duration = Number.isFinite(video.duration) ? video.duration : time;
            video.currentTime = Math.max(0, Math.min(time, duration - 0.001));
        }, { once: true });
        video.addEventListener("seeked", capture, { once: true });
        video.addEventListener("error", () => this.failEntry(entry), { once: true });
        this.armEntry(entry);
        video.src = this.options.resolveUrl(url);
        return entry;
    }

    private loadImage(key: string, url: string): Entry {
        const image = new Image();
        const entry = this.add({ key, url, failed: false, timer: null, source: null, width: 0, height: 0, image });
        image.crossOrigin = "anonymous";
        image.onerror = () => this.failEntry(entry);
        this.armEntry(entry);
        image.onload = () => {
            if (this.disposed || entry.failed || this.entries.get(key) !== entry) return;
            this.disarm(entry);
            entry.source = image;
            entry.width = image.naturalWidth;
            entry.height = image.naturalHeight;
            this.options.onReady();
        };
        image.src = this.options.resolveUrl(url);
        return entry;
    }

    get size(): number {
        return this.entries.size;
    }

    dispose(): void {
        this.disposed = true;
        for (const entry of this.entries.values()) this.release(entry);
        this.entries.clear();
        for (const decoder of this.decoders.values()) this.releaseDecoder(decoder);
        this.decoders.clear();
    }
}
