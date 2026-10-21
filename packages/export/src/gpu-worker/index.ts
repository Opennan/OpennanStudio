// @opennan/export/gpu-worker: the GPU export worker script (phase 10d). Bundle it as a module worker, e.g. with Vite
// `import GpuExportWorker from "@opennan/export/gpu-worker?worker"`, and pass `() => new GpuExportWorker()` to
// createBrowserGpuExport's `worker.create`. Outside a dedicated worker, importing it only exposes the helpers.
import { serveGpuExportWorker } from "../gpu/worker/entry";

export { serveGpuExportWorker, workerGpuOptions, workerWebGl2, loadWorkerFonts } from "../gpu/worker/entry";

declare const WorkerGlobalScope: (abstract new () => object) | undefined;
if (typeof WorkerGlobalScope !== "undefined" && typeof self !== "undefined" && self instanceof WorkerGlobalScope) {
    serveGpuExportWorker(self as unknown as Parameters<typeof serveGpuExportWorker>[0]);
}
