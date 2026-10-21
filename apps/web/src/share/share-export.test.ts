// Export and share's export step (phase 9c): the editor's own exporter (the GPU path when it can run), 720p MP4, its
// progress followed, Cancel stopping it, its failure in its own words; the dialog's download never fires for it.
import type { ExportResult, ExportSessionState } from "@opennan/export";
import { exportForShare, SHARE_EXPORT_RESOLUTION } from "./share-export";

function fakeExporter() {
    let state: ExportSessionState = { status: "idle" };
    const listeners = new Set<() => void>();
    const set = (next: ExportSessionState) => {
        state = next;
        for (const l of listeners) l();
    };
    const session = {
        getState: () => state,
        subscribe: (l: () => void) => (listeners.add(l), () => listeners.delete(l)),
        cancel: vi.fn(() => set({ status: "cancelled" })),
        reset: vi.fn(() => set({ status: "idle" })),
    };
    const start = vi.fn(async (request: { resolution: string; format?: string }) => {
        void request;
        set({ status: "running", progress: { phase: "render", ratio: 0 } as never });
    });
    return { exporter: { session, start }, set, start, session };
}

const result = { output: { kind: "bytes", data: new Uint8Array(4) }, container: "mp4", mimeType: "video/mp4", engine: "gpu" } as unknown as ExportResult;

describe("exportForShare", () => {
    it("starts a 720p video export and resolves with its result, reporting progress", async () => {
        const { exporter, set, start } = fakeExporter();
        const ratios: number[] = [];
        const running = exportForShare(exporter, { signal: new AbortController().signal, onProgress: (r) => ratios.push(r) });
        await Promise.resolve();
        expect(start).toHaveBeenCalledWith({ resolution: SHARE_EXPORT_RESOLUTION });
        expect(SHARE_EXPORT_RESOLUTION).toBe("720p");
        set({ status: "running", progress: { phase: "render", ratio: 0.4 } as never });
        set({ status: "done", result });
        expect(await running).toBe(result);
        expect(ratios).toContain(0.4);
    });

    it("Cancel stops the export (AbortError); a failure rejects with its message", async () => {
        const a = fakeExporter();
        const abort = new AbortController();
        const running = exportForShare(a.exporter, { signal: abort.signal, onProgress: () => undefined });
        await Promise.resolve();
        abort.abort();
        await expect(running).rejects.toMatchObject({ name: "AbortError" });
        expect(a.session.cancel).toHaveBeenCalled();

        const b = fakeExporter();
        const failing = exportForShare(b.exporter, { signal: new AbortController().signal, onProgress: () => undefined });
        await Promise.resolve();
        b.set({ status: "error", code: "empty-timeline", message: "Nothing to export." } as never);
        await expect(failing).rejects.toThrow("Nothing to export.");
    });

    it("refuses while another export runs (it never takes over the person's export)", async () => {
        const { exporter, set, start } = fakeExporter();
        set({ status: "running", progress: { phase: "render", ratio: 0.1 } as never });
        await expect(exportForShare(exporter, { signal: new AbortController().signal, onProgress: () => undefined })).rejects.toThrow(/already running/);
        expect(start).not.toHaveBeenCalled();
    });
});
