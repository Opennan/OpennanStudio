import * as core from "./index";

describe("timeline-core public API", () => {
    it("exposes engine, canvas, editing, history, and sync modules", () => {
        expect(core.engine).toBeDefined();
        expect(core.canvas).toBeDefined();
        expect(core.editing).toBeDefined();
        expect(typeof core.getSceneStart).toBe("function");
        expect(typeof core.getSceneDuration).toBe("function");
        expect(core.TIMELINE_CORE_VERSION).toBe("0.14.0");
    });

    it("exposes the phase 2 runtime", () => {
        expect(typeof core.createEditorStore).toBe("function");
        expect(typeof core.selectLiveScenes).toBe("function");
        expect(typeof core.TimelineController).toBe("function");
        expect(typeof core.LocalBackend).toBe("function");
        expect(typeof core.createMemoryPersistence).toBe("function");
        expect(typeof core.createIndexedDbPersistence).toBe("function");
        expect(typeof core.resolveTimelineTheme).toBe("function");
        expect(typeof core.scenesToEngineItems).toBe("function");
        expect(typeof core.planSourceClipSceneSplit).toBe("function");
        expect(typeof core.timelineDurationSeconds).toBe("function");
        expect(core.DEFAULT_FALLBACK_ERROR_MESSAGE).toBe("Could not save your edit");
    });
});
