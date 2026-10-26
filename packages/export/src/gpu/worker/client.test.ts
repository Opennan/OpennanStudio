// The page side of the GPU export worker with a scripted fake worker: media requests and fonts in the start
// message, progress, mux requests run on the page's runner, results, fallbacks, errors, an unavailable worker,
// and Cancel settling at once (the worker is told, then terminated).
import { clip, input, scene } from "../../compile/test-helpers";
import type { ExportRunner } from "../../runner";
import { ExportError } from "../../types";
import { documentFontSources, exportTimelineGpuInWorker, type GpuWorkerHost } from "./client";
import { serveGpuExportWorker } from "./entry";
import { bytesTransfer, type PageToWorker, type WorkerToPage } from "./protocol";

class FakeWorker extends EventTarget {
    readonly sent: PageToWorker[] = [];
    readonly transfers: Array<Transferable[] | undefined> = [];
    terminated = false;
    constructor(private readonly script: (message: PageToWorker, worker: FakeWorker) => void) {
        super();
    }
    postMessage(message: PageToWorker, transfer?: Transferable[]) {
        this.sent.push(message);
        this.transfers.push(transfer);
        queueMicrotask(() => this.script(message, this));
    }
    reply(message: WorkerToPage) {
        this.dispatchEvent(new MessageEvent("message", { data: message }));
    }
    terminate() {
        this.terminated = true;
    }
}

const timeline = () => input({
    project: { aspectRatio: "16:9", musicUrl: "/m/music.mp3", musicVolume: 1 },
    scenes: [scene("a", 0, 1, { sourceVideoUrl: "/m/a.webm" })],
    clips: [clip("g", { trackType: "remotion", trackIndex: 1, startTime: 0, endTime: 1, remotionTemplateId: "lower-third" })],
});

const result = { output: { kind: "bytes" as const, data: new Uint8Array([1]) }, container: "mp4" as const, mimeType: "video/mp4", encoder: "webcodecs-avc", durationSeconds: 1, width: 1280, height: 720, warnings: [], engine: "gpu" as const };

function setup(script: (message: PageToWorker, worker: FakeWorker) => void, patch: Partial<GpuWorkerHost> = {}) {
    let worker: FakeWorker | null = null;
    const host: GpuWorkerHost = {
        create: () => (worker = new FakeWorker(script)) as unknown as Worker,
        request: async (url) => (url.endsWith(".mp3") ? null : { url: `https://cdn.test${url}`, headers: { Authorization: "x" }, credentials: "same-origin" }),
        fonts: async () => [{ family: "Inter", weight: "700", style: "normal", src: 'url("https://app.test/inter-700.woff2")' }],
        ...patch,
    };
    const mux = vi.fn(async () => ({ kind: "bytes" as const, data: new Uint8Array([9]) }));
    const runner = { kind: "wasm", supportsGl: false, maxResolution: "1080p", probe: vi.fn(), chooseEncoder: vi.fn(), run: vi.fn(), mux } as unknown as ExportRunner;
    return { host, runner, mux, worker: () => worker! };
}

const gpu = { loadMediabunny: vi.fn(), createSource: vi.fn(), fetchBlob: vi.fn(), createRenderer: vi.fn() } as never;

describe("exportTimelineGpuInWorker", () => {
    it("sends the project with media requests and fonts, forwards progress, runs the mux on the page, and resolves the result", async () => {
        const progress: string[] = [];
        const { host, runner, mux, worker } = setup((message, w) => {
            if (message.type === "start") {
                w.reply({ type: "progress", progress: { phase: "render", ratio: 0.5 } });
                w.reply({ type: "mux", id: 0, step: "mux", plan: { inputs: [] } as never, video: { kind: "bytes", data: new Uint8Array([1]) }, container: "mp4" });
            } else if (message.type === "mux-done") {
                w.reply({ type: "done", result: { ...result, output: message.output } });
            }
        });
        const outcome = await exportTimelineGpuInWorker(timeline(), { resolution: "720p" }, { runner, gpu, onProgress: (p) => progress.push(`${p.phase}:${p.engine}`) }, host);
        expect(outcome).toMatchObject({ kind: "done", result: { output: { data: new Uint8Array([9]) } } });
        const start = worker().sent[0] as Extract<PageToWorker, { type: "start" }>;
        expect(start.media["/m/a.webm"]).toEqual({ url: "https://cdn.test/m/a.webm", headers: { Authorization: "x" }, credentials: "same-origin" });
        // The music could not be requested here: the worker's probe finds it missing and falls back.
        expect(start.media["/m/music.mp3"]).toBeUndefined();
        expect(start.fonts).toHaveLength(1);
        expect(progress).toEqual(["render:gpu"]);
        expect(mux).toHaveBeenCalledTimes(1);
        // The muxed file's bytes are transferred to the worker, not copied.
        const muxDone = worker().sent.findIndex((m) => m.type === "mux-done");
        expect(worker().transfers[muxDone]).toHaveLength(1);
        expect(worker().terminated).toBe(true);
    });

    it("passes fallbacks and errors through, and reports an unavailable worker", async () => {
        const fallback = setup((m, w) => m.type === "start" && w.reply({ type: "fallback", reason: "a clip plays in reverse" }));
        await expect(exportTimelineGpuInWorker(timeline(), { resolution: "720p" }, { runner: fallback.runner, gpu }, fallback.host)).resolves.toEqual({ kind: "fallback", reason: "a clip plays in reverse" });
        const failing = setup((m, w) => m.type === "start" && w.reply({ type: "error", code: "media-read-failed", message: "nope" }));
        await expect(exportTimelineGpuInWorker(timeline(), { resolution: "720p" }, { runner: failing.runner, gpu }, failing.host)).rejects.toMatchObject({ code: "media-read-failed" });
        const unavailable = setup((m, w) => m.type === "start" && w.reply({ type: "unavailable", reason: "no WebGL2 in workers" }));
        await expect(exportTimelineGpuInWorker(timeline(), { resolution: "720p" }, { runner: unavailable.runner, gpu }, unavailable.host)).resolves.toMatchObject({ kind: "unavailable" });
        const crashed = setup((m, w) => m.type === "start" && w.dispatchEvent(new Event("error")));
        await expect(exportTimelineGpuInWorker(timeline(), { resolution: "720p" }, { runner: crashed.runner, gpu }, crashed.host)).resolves.toMatchObject({ kind: "unavailable" });
    });

    it("falls back when a GPU worker stops reporting progress", async () => {
        vi.useFakeTimers();
        const controller = new AbortController();
        const completed = vi.fn();
        const { host, runner, worker } = setup((m, w) => m.type === "start" && w.reply({ type: "progress", progress: { phase: "render", ratio: 0.01 } }));
        const pending = exportTimelineGpuInWorker(timeline(), { resolution: "720p" }, { runner, gpu, signal: controller.signal }, host);
        void pending.then(completed, () => undefined);
        try {
            await vi.waitFor(() => expect(worker().sent.length).toBe(1));
            await vi.advanceTimersByTimeAsync(61_000);
            expect(completed).toHaveBeenCalledWith({ kind: "fallback", reason: expect.stringContaining("stopped responding") });
            expect(worker().sent.at(-1)).toEqual({ type: "cancel" });
            await vi.advanceTimersByTimeAsync(1500);
            expect(worker().terminated).toBe(true);
        } finally {
            controller.abort();
            await pending.catch(() => undefined);
            vi.useRealTimers();
        }
    });

    it("keeps active workers and a slow host mux running", async () => {
        vi.useFakeTimers();
        const controller = new AbortController();
        const completed = vi.fn();
        const { host, runner, mux, worker } = setup((m, w) => {
            if (m.type === "start") w.reply({ type: "progress", progress: { phase: "render", ratio: 0.1 } });
            if (m.type === "mux-done") w.reply({ type: "done", result });
        });
        let finishMux!: () => void;
        mux.mockImplementation(() => new Promise((resolve) => { finishMux = () => resolve({ kind: "bytes", data: new Uint8Array([9]) }); }));
        const pending = exportTimelineGpuInWorker(timeline(), { resolution: "720p" }, { runner, gpu, signal: controller.signal }, host);
        void pending.then(completed, () => undefined);
        try {
            await vi.waitFor(() => expect(worker().sent.length).toBe(1));
            await vi.advanceTimersByTimeAsync(45_000);
            worker().reply({ type: "progress", progress: { phase: "render", ratio: 0.5 } });
            await vi.advanceTimersByTimeAsync(45_000);
            expect(completed).not.toHaveBeenCalled();
            worker().reply({ type: "mux", id: 0, step: "mux", plan: { inputs: [] } as never, video: { kind: "bytes", data: new Uint8Array([1]) }, container: "mp4" });
            await vi.advanceTimersByTimeAsync(120_000);
            expect(completed).not.toHaveBeenCalled();
            finishMux();
            await expect(pending).resolves.toMatchObject({ kind: "done" });
        } finally {
            controller.abort();
            await pending.catch(() => undefined);
            vi.useRealTimers();
        }
    });

    it("runs the GIF step on the page's runner for GIF exports", async () => {
        const { host, runner } = setup((message, w) => {
            if (message.type === "start") w.reply({ type: "mux", id: 1, step: "gif", plan: { format: { width: 640, height: 360, fps: 15 }, durationSeconds: 1 }, video: { kind: "bytes", data: new Uint8Array([1]) }, container: "mp4" });
            if (message.type === "mux-done") w.reply({ type: "done", result: { ...result, container: "gif", output: message.output } as never });
        });
        const gif = vi.fn(async () => ({ kind: "bytes" as const, data: new Uint8Array([7]) }));
        (runner as { gif?: unknown }).gif = gif;
        const phases: string[] = [];
        const outcome = await exportTimelineGpuInWorker(timeline(), { resolution: "720p", format: "gif" }, { runner, gpu, onProgress: (p) => phases.push(p.phase) }, host);
        expect(outcome).toMatchObject({ kind: "done", result: { output: { data: new Uint8Array([7]) } } });
        expect(gif).toHaveBeenCalledWith({ format: { width: 640, height: 360, fps: 15 }, durationSeconds: 1 }, expect.anything(), expect.objectContaining({ container: "mp4" }));
    });

    it("reports a page mux failure back to the worker", async () => {
        const { host, runner, mux } = setup((message, w) => {
            if (message.type === "start") w.reply({ type: "mux", id: 3, step: "mux", plan: { inputs: [] } as never, video: { kind: "bytes", data: new Uint8Array([1]) }, container: "mp4" });
            if (message.type === "mux-error") w.reply({ type: "fallback", reason: `mux ${message.code}` });
        });
        mux.mockRejectedValueOnce(new ExportError("ffmpeg-failed", "refused"));
        await expect(exportTimelineGpuInWorker(timeline(), { resolution: "720p" }, { runner, gpu }, host)).resolves.toEqual({ kind: "fallback", reason: "mux ffmpeg-failed" });
    });

    it("settles at once on Cancel, tells the worker, and terminates it after the grace period", async () => {
        vi.useFakeTimers();
        try {
            const controller = new AbortController();
            const { host, runner, worker } = setup((m, w) => m.type === "start" && w.reply({ type: "progress", progress: { phase: "render", ratio: 0.1 } }), { cancelGraceMs: 500 });
            const pending = exportTimelineGpuInWorker(timeline(), { resolution: "720p" }, { runner, gpu, signal: controller.signal }, host);
            await vi.waitFor(() => expect(worker().sent.length).toBe(1));
            controller.abort();
            await expect(pending).rejects.toMatchObject({ code: "cancelled" });
            expect(worker().sent.at(-1)).toEqual({ type: "cancel" });
            expect(worker().terminated).toBe(false);
            vi.advanceTimersByTime(600);
            expect(worker().terminated).toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });
});

describe("the worker side", () => {
    it("answers unavailable where WebCodecs or OffscreenCanvas WebGL2 is missing (here: Node)", async () => {
        const replies: WorkerToPage[] = [];
        const target = new EventTarget();
        serveGpuExportWorker({ postMessage: (m) => replies.push(m), addEventListener: (type, listener) => target.addEventListener(type, listener as never) });
        const channel = new MessageChannel();
        target.dispatchEvent(new MessageEvent("message", { data: { type: "start", input: timeline(), settings: { resolution: "720p" }, media: {}, fonts: [], opfs: false, rasterPort: channel.port2 } }));
        await vi.waitFor(() => expect(replies).toEqual([{ type: "unavailable", reason: expect.any(String) }]));
        channel.port1.close();
        channel.port2.close();
    });
});

describe("bytesTransfer", () => {
    it("transfers whole-buffer bytes and nothing else", () => {
        const data = new Uint8Array(8);
        expect(bytesTransfer({ kind: "bytes", data })).toEqual([data.buffer]);
        expect(bytesTransfer({ kind: "bytes", data: data.subarray(2) })).toEqual([]);
        expect(bytesTransfer({ kind: "file" })).toEqual([]);
        expect(bytesTransfer(null)).toEqual([]);
    });
});

describe("documentFontSources", () => {
    it("lists matching @font-face rules with absolute URLs", () => {
        class Rule {
            constructor(private readonly props: Record<string, string>) {}
            style = { getPropertyValue: (key: string) => this.props[key] ?? "" };
        }
        (globalThis as { CSSFontFaceRule?: unknown }).CSSFontFaceRule = Rule;
        try {
            const doc = {
                baseURI: "https://app.test/editor/",
                styleSheets: [{
                    href: "https://app.test/assets/index.css",
                    cssRules: [
                        new Rule({ "font-family": '"Inter"', "font-weight": "700", "font-style": "normal", src: 'url(./inter-700.woff2) format("woff2")', "unicode-range": "U+0000-00FF" }),
                        new Rule({ "font-family": "Inter", "font-weight": "500", "font-style": "normal", src: "url(./inter-500.woff2)" }),
                        new Rule({ "font-family": "Poppins", "font-weight": "700", src: "url(./p.woff2)" }),
                    ],
                }],
            } as unknown as Document;
            expect(documentFontSources([{ family: "Inter", weight: 700, style: "normal" }], doc)).toEqual([
                { family: "Inter", weight: "700", style: "normal", src: 'url("https://app.test/assets/inter-700.woff2") format("woff2")', unicodeRange: "U+0000-00FF" },
            ]);
        } finally {
            delete (globalThis as { CSSFontFaceRule?: unknown }).CSSFontFaceRule;
        }
    });
});
