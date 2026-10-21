import { LocalBackend } from "../backend/local-backend";
import { createMemoryPersistence } from "../backend/persistence";
import { createEditorStore } from "../store/editor-store";
import { TimelineController, type TimelineControllerOptions } from "./timeline-controller";

async function controllerWith(onExport?: TimelineControllerOptions["onExport"]) {
    const controller = new TimelineController({
        backend: new LocalBackend({ persistence: createMemoryPersistence() }), store: createEditorStore(), projectId: "p1", onExport,
    });
    await controller.load();
    return controller;
}

describe("export.start", () => {
    it("is unavailable without an onExport handler", async () => {
        const result = await (await controllerWith()).execute({ type: "export.start", options: {} });
        expect(result).toMatchObject({ ok: false, unavailable: true });
    });

    it("passes options and the snapshot to onExport and returns its job id", async () => {
        const onExport = vi.fn(async () => ({ jobId: "job-1" }));
        const controller = await controllerWith(onExport);
        const result = await controller.execute({ type: "export.start", options: { resolution: "1080p" } });
        expect(result).toEqual({ ok: true, changed: {}, jobId: "job-1" });
        expect(onExport).toHaveBeenCalledWith({ resolution: "1080p" }, expect.objectContaining({ projectId: "p1", clips: [] }));
    });

    it("reports handler errors and unavailability", async () => {
        expect(await (await controllerWith(async () => ({ error: "disk full" }))).execute({ type: "export.start", options: {} }))
            .toEqual({ ok: false, changed: {}, error: "disk full" });
        expect(await (await controllerWith(async () => { throw new Error("boom"); })).execute({ type: "export.start", options: {} }))
            .toMatchObject({ ok: false, error: "boom" });
        expect(await (await controllerWith(async () => ({ unavailable: true, error: "no exporter" }))).execute({ type: "export.start", options: {} }))
            .toMatchObject({ ok: false, unavailable: true, error: "no exporter" });
    });
});

describe("export.cancel", () => {
    const withCancel = async (onExportCancel?: TimelineControllerOptions["onExportCancel"]) => {
        const controller = new TimelineController({
            backend: new LocalBackend({ persistence: createMemoryPersistence() }), store: createEditorStore(), projectId: "p1", onExportCancel,
        });
        await controller.load();
        return controller;
    };

    it("is unavailable without a host handler", async () => {
        expect(await (await withCancel()).execute({ type: "export.cancel" })).toMatchObject({ ok: false, unavailable: true });
    });

    it("passes the job id to the host and reports its answer (no undo entry)", async () => {
        const onExportCancel = vi.fn(async (jobId: string | undefined) => (jobId === "job-1" ? {} : { error: `No running export ${jobId}.` }));
        const controller = await withCancel(onExportCancel);
        expect(await controller.execute({ type: "export.cancel", jobId: "job-1" })).toEqual({ ok: true, changed: {}, jobId: "job-1" });
        expect(await controller.execute({ type: "export.cancel", jobId: "job-2" })).toEqual({ ok: false, changed: {}, error: "No running export job-2." });
        expect(controller.historyDepth()).toMatchObject({ undo: 0 });
    });
});
