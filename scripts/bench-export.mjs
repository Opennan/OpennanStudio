#!/usr/bin/env node
// Export benchmark (phase 10c). Reproducible wall time and peak memory for the fixed projects in
// scripts/bench/projects.mjs on each export host:
//
//   node scripts/bench-export.mjs --project a --host native              # desktop engine: bundled LGPL ffmpeg in Node
//   node scripts/bench-export.mjs --project a --host web --engine ffmpeg  # ffmpeg.wasm in Chromium (Playwright)
//   node scripts/bench-export.mjs --project a --host web --engine gpu     # GPU compositor + WebCodecs in Chromium
//   node scripts/bench-export.mjs --project a --host chrome --engine gpu  # the same in Google Chrome (H.264, AAC)
//
// Options: --resolution 720p|1080p (default: a 1080p, b 720p), --timeout <minutes> (default 90), --headless,
// --out <file.mp4> (keep the exported file), --codec avc|vp9|av1|vp8 (GPU codec), --worker on|off (phase 10d: the GPU
// export in a worker streaming through OPFS, the default, or on the page with the file in memory, the 10c path). Needs `pnpm build` and, for browser hosts, the playground build
// (`pnpm --filter @opennan/playground build`). Media is generated once into .cache/bench-media/ (media.mjs).
// Peak memory is the sampled resident set of the whole process tree (Node + ffmpeg, or every browser process).
// Each run appends a JSON line to .cache/bench-results.jsonl.
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { ensureMedia, MEDIA_DIR, mediaPath, ROOT } from "./bench/media.mjs";
import { MEDIA_PREFIX, PROJECTS } from "./bench/projects.mjs";

const MB = 2 ** 20;

function parseArgs(argv) {
    const args = { project: "a", host: "native", engine: "ffmpeg", timeout: 90, headless: false, resolution: null, out: null };
    for (let i = 0; i < argv.length; i += 1) {
        const key = argv[i].replace(/^--/, "");
        if (key === "headless") args.headless = true;
        else args[key] = argv[++i];
    }
    if (args.host === "native") args.engine = "ffmpeg";
    args.resolution ??= args.project === "a" ? "1080p" : "720p";
    args.timeout = Number(args.timeout);
    return args;
}

/** Samples the summed RSS of `rootPid` and its descendants every 250 ms; stop() returns the peak in bytes. */
function memorySampler(rootPid) {
    let peak = 0;
    const sample = () => {
        let text;
        try {
            text = execFileSync("ps", ["-A", "-o", "pid=,ppid=,rss="], { encoding: "utf8" });
        } catch {
            return;
        }
        const children = new Map();
        const rss = new Map();
        for (const line of text.trim().split("\n")) {
            const [pid, ppid, kb] = line.trim().split(/\s+/).map(Number);
            rss.set(pid, kb * 1024);
            if (!children.has(ppid)) children.set(ppid, []);
            children.get(ppid).push(pid);
        }
        let total = 0;
        const stack = [rootPid];
        while (stack.length) {
            const pid = stack.pop();
            total += rss.get(pid) ?? 0;
            stack.push(...(children.get(pid) ?? []));
        }
        peak = Math.max(peak, total);
    };
    sample();
    const timer = setInterval(sample, 250);
    return { stop: () => (clearInterval(timer), sample(), peak) };
}

function record(result) {
    mkdirSync(path.join(ROOT, ".cache"), { recursive: true });
    appendFileSync(path.join(ROOT, ".cache/bench-results.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), ...result })}\n`);
    const realtime = result.durationSeconds ? (result.seconds / result.durationSeconds).toFixed(2) : "?";
    process.stdout.write(`\n[bench] project ${result.project} · ${result.host}/${result.engine} · ${result.resolution}: ${result.status}`
        + `, ${result.seconds.toFixed(1)} s (${realtime}× realtime), peak ${Math.round(result.peakBytes / MB)} MB`
        + `${result.idleBytes ? ` (idle ${Math.round(result.idleBytes / MB)} MB, +${Math.round((result.peakBytes - result.idleBytes) / MB)} MB)` : ""}`
        + `${result.encoder ? `, ${result.encoder}/${result.container}` : ""}${result.note ? ` — ${result.note}` : ""}`
        + `${result.ui ? `, main thread: ${result.ui.longTasks} long tasks, ${result.ui.blockingMs} ms blocking, longest ${result.ui.maxTaskMs} ms, frame gap ≤ ${result.ui.maxFrameGapMs} ms` : ""}\n`);
}

async function withTimeout(promise, minutes, onTimeout) {
    let timer;
    const timeout = new Promise((resolve) => {
        timer = setTimeout(() => resolve(onTimeout()), minutes * 60_000);
    });
    try {
        return await Promise.race([promise, timeout]);
    } finally {
        clearTimeout(timer);
    }
}

async function runNative(args, input) {
    const { exportTimeline, createCanvasRasterizer } = await import("../packages/export/dist/index.js");
    const { createNodeRunner } = await import("../packages/export/dist/node/index.js");
    const require = createRequire(path.join(ROOT, "packages/export/package.json"));
    const { createCanvas, loadImage } = require("@napi-rs/canvas");
    const bin = path.join(ROOT, "apps/desktop/resources/ffmpeg", `${process.platform}-${process.arch}`);
    const output = args.out ?? path.join(os.tmpdir(), `opennan-bench-${process.pid}`);
    const runner = createNodeRunner({
        ffmpegPath: path.join(bin, "ffmpeg"),
        ffprobePath: path.join(bin, "ffprobe"),
        outputPath: (container) => (args.out ? args.out : `${output}.${container}`),
        mediaRoots: [MEDIA_DIR],
        resolveSource: (url) => (url.startsWith(`${MEDIA_PREFIX}/`) ? mediaPath(url) : null),
    });
    const rasterizer = createCanvasRasterizer({
        createCanvas: (w, h) => createCanvas(w, h),
        encodePng: async (canvas) => new Uint8Array(canvas.toBuffer("image/png")),
        loadImage: (url) => loadImage(Buffer.from(decodeURIComponent(url.slice(url.indexOf(",") + 1)), "utf8")),
    });
    const controller = new AbortController();
    const sampler = memorySampler(process.pid);
    const started = performance.now();
    let last = { phase: "probe", ratio: 0 };
    let lastLog = 0;
    const done = exportTimeline(input, { resolution: args.resolution }, {
        runner, rasterizer, signal: controller.signal,
        onProgress: (progress) => {
            last = progress;
            const now = performance.now();
            if (now - lastLog > 10_000) {
                lastLog = now;
                const elapsed = (now - started) / 1000;
                process.stderr.write(`[bench] ${progress.phase} ${(progress.ratio * 100).toFixed(1)}% after ${elapsed.toFixed(0)} s\n`);
            }
        },
    }).then((result) => ({ status: "done", result }), (error) => ({ status: "failed", error }));
    const outcome = await withTimeout(done, args.timeout, () => {
        controller.abort();
        return { status: "timeout" };
    });
    const seconds = (performance.now() - started) / 1000;
    const peakBytes = sampler.stop();
    const base = { project: args.project, host: "native", engine: "ffmpeg", resolution: args.resolution, seconds, peakBytes };
    if (outcome.status === "done") {
        const r = outcome.result;
        return { ...base, status: "done", durationSeconds: r.durationSeconds, encoder: r.encoder, container: r.container, warnings: r.warnings.map((w) => w.code) };
    }
    if (outcome.status === "timeout") {
        return { ...base, status: "timeout", note: `stopped after ${args.timeout} min at ${last.phase} ${(last.ratio * 100).toFixed(1)}%`, progress: last };
    }
    return { ...base, status: "failed", note: String(outcome.error?.message ?? outcome.error) };
}

function startPreviewServer() {
    const dist = path.join(ROOT, "apps/playground/dist/index.html");
    if (!existsSync(dist)) throw new Error("build the playground first: pnpm --filter @opennan/playground build");
    const server = spawn("pnpm", ["exec", "vite", "preview", "--port", "4317", "--strictPort"], { cwd: path.join(ROOT, "apps/playground"), stdio: "ignore" });
    return server;
}

async function waitForServer(url, seconds = 60) {
    const until = Date.now() + seconds * 1000;
    while (Date.now() < until) {
        try {
            const response = await fetch(url);
            if (response.ok) return;
        } catch {
            // not up yet
        }
        await new Promise((resolve) => setTimeout(resolve, 300));
    }
    throw new Error(`no server at ${url}`);
}

/** The browser to run on: Chromium/Chrome through a browser server, or Electron (the desktop renderer's engine). */
async function launch(args) {
    const require = createRequire(path.join(ROOT, "apps/playground/package.json"));
    const { chromium, _electron } = require("@playwright/test");
    if (args.host === "electron") {
        const executablePath = createRequire(path.join(ROOT, "apps/desktop/package.json"))("electron");
        const app = await _electron.launch({ executablePath, args: [path.join(ROOT, "scripts/bench/electron-main.cjs"), "http://localhost:4317/?harness=bench"] });
        const page = await app.firstWindow();
        return { page, pid: app.process().pid, close: () => app.close() };
    }
    const gpuArgs = ["--enable-gpu", "--ignore-gpu-blocklist", "--enable-unsafe-webgpu"];
    // A browser server exposes the browser's pid for the memory sampler.
    const browserServer = await chromium.launchServer({
        headless: args.headless,
        ...(args.host === "chrome" ? { channel: "chrome" } : {}),
        args: gpuArgs,
    });
    const browser = await chromium.connect(browserServer.wsEndpoint());
    const page = await browser.newPage();
    return {
        page, pid: browserServer.process().pid,
        close: async () => {
            await browser.close().catch(() => undefined);
            await browserServer.close().catch(() => undefined);
        },
    };
}

async function runBrowser(args, input) {
    const server = startPreviewServer();
    try {
        await waitForServer("http://localhost:4317/");
        const host = await launch(args);
        const { page } = host;
        const coreDir = path.join(ROOT, "apps/playground/node_modules/@ffmpeg/core/dist/esm");
        await page.route("**/ffmpeg-core/*", (route) => route.fulfill({ path: path.join(coreDir, path.basename(new URL(route.request().url()).pathname)) }));
        await page.route(`**${MEDIA_PREFIX}/*`, (route) => route.fulfill({ path: mediaPath(new URL(route.request().url()).pathname) }));
        let last = null;
        page.on("console", (message) => {
            const text = message.text();
            if (text.startsWith("[bench-progress] ")) {
                last = JSON.parse(text.slice(17));
                process.stderr.write(`[bench] ${last.phase} ${(last.ratio * 100).toFixed(1)}% after ${last.elapsed.toFixed(0)} s\n`);
            } else if (message.type() === "error") {
                process.stderr.write(`[page] ${text}\n`);
            }
        });
        await page.goto("http://localhost:4317/?harness=bench");
        await page.waitForFunction(() => "__bench" in window);
        // The page's own footprint before the export (browser, GPU, and renderer processes at rest).
        await new Promise((resolve) => setTimeout(resolve, 1500));
        const idleBytes = memorySampler(host.pid).stop();
        const sampler = memorySampler(host.pid);
        const started = performance.now();
        const spec = {
            input, resolution: args.resolution, engine: args.engine, keepOutput: Boolean(args.out), ...(args.codec ? { codecs: [args.codec] } : {}),
            worker: args.worker !== "off",
        };
        const done = page.evaluate((s) => window.__bench.run(s), spec).then((result) => ({ status: "done", result }), (error) => ({ status: "failed", error }));
        const outcome = await withTimeout(done, args.timeout, () => ({ status: "timeout" }));
        const seconds = (performance.now() - started) / 1000;
        const peakBytes = sampler.stop();
        await host.close();
        const base = { project: args.project, host: args.host, engine: args.engine, resolution: args.resolution, seconds, peakBytes, idleBytes, worker: args.worker !== "off" };
        if (outcome.status === "done") {
            const r = outcome.result;
            if (args.out && r.base64) writeFileSync(args.out, Buffer.from(r.base64, "base64"));
            return { ...base, status: "done", seconds: r.seconds, durationSeconds: r.durationSeconds, encoder: r.encoder, container: r.container, warnings: r.warnings, engineLabel: r.engine, ...(r.ui ? { ui: r.ui } : {}) };
        }
        if (outcome.status === "timeout") {
            return { ...base, status: "timeout", note: `stopped after ${args.timeout} min${last ? ` at ${last.phase} ${(last.ratio * 100).toFixed(1)}%` : ""}`, progress: last };
        }
        return { ...base, status: "failed", note: String(outcome.error?.message ?? outcome.error).slice(-1500), progress: last };
    } finally {
        server.kill();
    }
}

const args = parseArgs(process.argv.slice(2));
ensureMedia(args.project);
const input = PROJECTS[args.project]();
const result = args.host === "native" ? await runNative(args, input) : await runBrowser(args, input);
record(result);
process.exit(0);
