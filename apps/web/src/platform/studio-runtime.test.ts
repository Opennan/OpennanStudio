import { createMemoryPersistence } from "@opennan/timeline-core";
import { createStudioRuntime } from "./studio-runtime";

describe("studio runtime", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it("closes a project one task after the last editor holding it is gone", () => {
        vi.useFakeTimers();
        const runtime = createStudioRuntime({ persistence: createMemoryPersistence(), storage: null });
        const close = vi.spyOn(runtime.backend, "closeProject");
        // StrictMode mounts, unmounts, and mounts again: the project stays open.
        runtime.retainProject("p1")();
        const release = runtime.retainProject("p1");
        vi.runAllTimers();
        expect(close).not.toHaveBeenCalled();
        release();
        release();
        vi.runAllTimers();
        expect(close).toHaveBeenCalledTimes(1);
        expect(close).toHaveBeenCalledWith("p1");
    });

    it("describes the web platform", () => {
        const runtime = createStudioRuntime({ persistence: createMemoryPersistence(), storage: null });
        expect(runtime.platform).toBe("web");
        expect(runtime.exportPlatform.resolutions).toEqual(["720p", "1080p"]);
        expect(runtime.maxMediaBytes).toBe(2 * 1024 ** 3);
        expect(runtime.ui).toEqual({});
        expect(runtime.providers.providers().map((p) => p.info.id)).toEqual(["opennan"]);
        expect(runtime.providers.route("image.generate")?.info.id).toBe("opennan");
        // Phase 11: on the web, OpenNan cloud captions are the only transcription engine.
        expect(runtime.providers.route("audio.transcribe")?.info.id).toBe("opennan");
        expect(runtime.account.consoleOrigin).toBe("https://opennan.com");
    });

    it("adds fal.ai while its key is stored and follows saved routing", async () => {
        const runtime = createStudioRuntime({ persistence: createMemoryPersistence(), storage: null });
        await new Promise((r) => setTimeout(r, 0));
        expect(runtime.providerSettings.keys()).toEqual([{ id: "fal", name: "fal.ai", set: false }]);
        await runtime.providerSettings.setKey("fal", "fal-key-0123456789");
        expect(runtime.providers.get("fal")?.info.name).toBe("fal.ai");
        await runtime.providerSettings.setRouting({ overrides: { "image.generate": "fal" }, opennanDefault: true });
        expect(runtime.providers.route("image.generate")?.info.id).toBe("fal");
        await runtime.providerSettings.removeKey("fal");
        expect(runtime.providers.get("fal")).toBeUndefined();
        expect(runtime.providers.route("image.generate")?.info.id).toBe("opennan");
        await runtime.providerSettings.setRouting({ overrides: {}, opennanDefault: true });
    });
});
